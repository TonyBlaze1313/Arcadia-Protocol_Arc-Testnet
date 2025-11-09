# backend/app/timelock_api.py
# Production-focused timelock encode + opId + signed-opid endpoint with S3-backed audit log and signer-info endpoint

from fastapi import APIRouter, HTTPException, Request, Depends
from pydantic import BaseModel
import os
import json
from dotenv import load_dotenv
from web3 import Web3
from typing import Optional, List, Any
from eth_abi import encode_abi
from eth_utils import keccak, to_checksum_address
from datetime import datetime, timezone, timedelta
import logging
import boto3
import uuid

from .signer import make_signer if False else None  # placeholder to avoid linter; real import below

# real import
from .signer import LocalSigner, KMSSigner, SignResult, BaseSigner, make_signer if False else None  # will be resolved at runtime

# Note: above line uses `if False` trick to keep static analysis quiet; real runtime import will use `make_signer` factory below.

load_dotenv()
logger = logging.getLogger("arcadia.timelock_api")
logger.setLevel(logging.INFO)

router = APIRouter()

# Environment and config
ARC_RPC = os.getenv("ARC_RPC", "http://127.0.0.1:8545")
TIMELock_ADDR = os.getenv("ARCADIA_TIMELOCK")  # optional
ADMIN_API_KEY = os.getenv("ADMIN_API_KEY", "devkey")
AUDIT_LOG_LOCAL = os.getenv("AUDIT_LOG_LOCAL", os.path.join(os.path.dirname(__file__), "..", "logs", "timelock_audit.log"))
AUDIT_S3_BUCKET = os.getenv("AUDIT_S3_BUCKET")
AUDIT_S3_PREFIX = os.getenv("AUDIT_S3_PREFIX", "timelock-audit/")
AUDIT_S3_SSE = os.getenv("AUDIT_S3_SSE", "AES256")
AUDIT_S3_OBJECT_LOCK = os.getenv("AUDIT_S3_OBJECT_LOCK", "false").lower() == "true"
AUDIT_S3_RETENTION_DAYS = int(os.getenv("AUDIT_S3_RETENTION_DAYS", "365"))

w3 = Web3(Web3.HTTPProvider(ARC_RPC))

# minimal timelock ABI for status calls
TIMELOCK_ABI = [
  {"inputs":[{"internalType":"bytes32","name":"id","type":"bytes32"}],"name":"isOperationPending","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"bytes32","name":"id","type":"bytes32"}],"name":"isOperationReady","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"bytes32","name":"id","type":"bytes32"}],"name":"isOperationDone","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"}
]

# signer instance factory: create either LocalSigner or KMSSigner depending on env
def make_signer_instance():
    from .signer import LocalSigner, KMSSigner
    signer_type = os.getenv("SIGNER_TYPE", "local")
    if signer_type == "kms":
        key_id = os.getenv("KMS_KEY_ID")
        endpoint = os.getenv("AWS_ENDPOINT_URL")
        region = os.getenv("AWS_REGION", "us-east-1")
        if not key_id:
            raise RuntimeError("KMS_KEY_ID not set for SIGNER_TYPE=kms")
        return KMSSigner(key_id, region_name=region, endpoint_url=endpoint)
    else:
        private_key = os.getenv("ADMIN_PRIVATE_KEY")
        return LocalSigner(private_key)

_signer = make_signer_instance()

# S3 client for audit upload (if configured)
def _s3_client():
    endpoint = os.getenv("AWS_ENDPOINT_URL")
    region = os.getenv("AWS_REGION", "us-east-1")
    try:
        if endpoint:
            return boto3.client("s3", endpoint_url=endpoint, region_name=region)
        return boto3.client("s3", region_name=region)
    except Exception as e:
        logger.exception("failed to create s3 client: %s", e)
        return None

def audit_log(entry: dict):
    entry["ts"] = datetime.now(timezone.utc).isoformat()
    try:
        os.makedirs(os.path.dirname(AUDIT_LOG_LOCAL), exist_ok=True)
        with open(AUDIT_LOG_LOCAL, "a") as f:
            f.write(json.dumps(entry, separators=(",", ":")) + "\n")
    except Exception:
        logger.exception("failed to write local audit log")

    if AUDIT_S3_BUCKET:
        s3 = _s3_client()
        if not s3:
            logger.error("S3 client not available; skipping audit upload")
            return
        key = AUDIT_S3_PREFIX.rstrip("/") + "/" + datetime.utcnow().strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex + ".jsonl"
        body = json.dumps(entry)
        extra = {}
        if AUDIT_S3_SSE and AUDIT_S3_SSE.lower() == "aws:kms":
            extra["ServerSideEncryption"] = "aws:kms"
        else:
            extra["ServerSideEncryption"] = "AES256"
        try:
            s3.put_object(Bucket=AUDIT_S3_BUCKET, Key=key, Body=body.encode("utf-8"), **extra)
            if AUDIT_S3_OBJECT_LOCK:
                try:
                    retention = {
                        'Mode': 'GOVERNANCE',
                        'RetainUntilDate': datetime.utcnow() + timedelta(days=AUDIT_S3_RETENTION_DAYS)
                    }
                    s3.put_object_retention(Bucket=AUDIT_S3_BUCKET, Key=key, Retention=retention)
                except Exception as ex:
                    logger.exception("put_object_retention failed: %s", ex)
        except Exception:
            logger.exception("failed to upload audit log to s3")

# --- encoding / opid / signing code (similar to previous implementation) ---
import re

def _split_types(types_raw: str) -> List[str]:
    types = []
    buf = ""
    depth = 0
    for ch in types_raw:
        if ch == "," and depth == 0:
            if buf.strip():
                types.append(buf.strip())
            buf = ""
            continue
        buf += ch
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
    if buf.strip():
        types.append(buf.strip())
    return types

def parse_signature(signature: str):
    if "(" not in signature or not signature.endswith(")"):
        raise ValueError("invalid signature format")
    name = signature.split("(")[0].strip()
    types_raw = signature[len(name) + 1:-1].strip()
    if types_raw == "":
        types = []
    else:
        types = _split_types(types_raw)
    return name, types

def _canonical_type(t: str) -> str:
    t2 = re.sub(r'\buint\b', 'uint256', t)
    t2 = re.sub(r'\bint\b', 'int256', t2)
    return t2

def coerce_arg(arg_type: str, value: Any):
    if arg_type.endswith("[]"):
        base = arg_type[:-2]
        if not isinstance(value, (list, tuple)):
            raise ValueError(f"{arg_type} expects array value")
        return [coerce_arg(base, v) for v in value]

    if arg_type.startswith("(") or arg_type.startswith("tuple"):
        inner = arg_type
        if arg_type.startswith("tuple"):
            inner = arg_type[arg_type.find("("):]
        if not inner.startswith("(") or not inner.endswith(")"):
            raise ValueError("invalid tuple type")
        inner_types_raw = inner[1:-1]
        inner_types = _split_types(inner_types_raw)
        if not isinstance(value, (list, tuple)):
            raise ValueError("tuple value must be array-like")
        if len(inner_types) != len(value):
            raise ValueError(f"tuple expects {len(inner_types)} elements, got {len(value)}")
        coerced = []
        for t, v in zip(inner_types, value):
            coerced.append(coerce_arg(t, v))
        return tuple(coerced)

    if arg_type.startswith("address"):
        if not isinstance(value, str) or not Web3.is_address(value):
            raise ValueError(f"invalid address: {value}")
        return to_checksum_address(value)
    if arg_type == "bool":
        if isinstance(value, bool): return value
        if isinstance(value, str):
            v = value.lower()
            if v in ("true","1"): return True
            if v in ("false","0"): return False
        if isinstance(value, (int,float)): return bool(value)
        raise ValueError("invalid bool")
    if arg_type.startswith("uint") or arg_type.startswith("int"):
        try:
            return int(value)
        except Exception:
            raise ValueError(f"invalid integer for {arg_type}: {value}")
    if arg_type.startswith("bytes"):
        if isinstance(value, str) and value.startswith("0x"):
            hexs = value[2:]
            if len(hexs) % 2 != 0:
                hexs = "0" + hexs
            return bytes.fromhex(hexs)
        if isinstance(value, (bytes, bytearray)):
            return bytes(value)
        if isinstance(value, str):
            return value.encode()
        raise ValueError("invalid bytes value")
    if arg_type == "string":
        if not isinstance(value, str): return str(value)
        return value
    return value

def encode_function_call(signature: str, args: List[Any]):
    name, types = parse_signature(signature)
    if len(types) != len(args):
        raise ValueError("signature expects %d args, got %d" % (len(types), len(args)))
    coerced = []
    canonical_types = []
    for t, a in zip(types, args):
        coerced_val = coerce_arg(t, a)
        coerced.append(coerced_val)
        canonical_types.append(_canonical_type(t))
    selector = keccak(text=signature)[:4]
    try:
        encoded_args = encode_abi(canonical_types, coerced)
    except Exception as e:
        raise ValueError(f"eth_abi.encode error: {e}")
    data_bytes = selector + encoded_args
    return {"data": "0x" + data_bytes.hex(), "selector": "0x"+selector.hex(), "types": types, "coerced_args": coerced, "data_bytes": data_bytes}

def _bytes32_from_hex_or_default(val: Optional[str]):
    if not val:
        return b"\x00" * 32
    if isinstance(val, str) and val.startswith("0x"):
        h = val[2:]
        if len(h) != 64:
            h = h.rjust(64, "0")[:64]
        return bytes.fromhex(h)
    raise ValueError("predecessor/salt must be hex string")

def compute_opid_single(target: str, value: int, data_bytes: bytes, predecessor_hex: Optional[str], salt_hex: Optional[str]):
    predecessor = _bytes32_from_hex_or_default(predecessor_hex)
    if salt_hex:
        salt = _bytes32_from_hex_or_default(salt_hex)
    else:
        encoded = encode_abi(["bytes", "address", "uint256", "bytes32"], [data_bytes, to_checksum_address(target), int(value), predecessor])
        salt = keccak(encoded)
        salt_hex = "0x" + salt.hex()
    inner_hash = keccak(data_bytes)
    encoded_top = encode_abi(["address","uint256","bytes32","bytes32","bytes32"], [to_checksum_address(target), int(value), inner_hash, predecessor, salt])
    opid = keccak(encoded_top)
    return "0x" + opid.hex(), salt_hex

def compute_opid_batch(targets: List[str], values: List[int], datas: List[bytes], predecessor_hex: Optional[str], salt_hex: Optional[str]):
    predecessor = _bytes32_from_hex_or_default(predecessor_hex)
    packed = b"".join(datas)
    packed_hash = keccak(packed)
    if salt_hex:
        salt = _bytes32_from_hex_or_default(salt_hex)
    else:
        encoded = encode_abi(["address[]","uint256[]","bytes32","bytes32"], [[to_checksum_address(t) for t in targets], [int(v) for v in values], packed_hash, predecessor])
        salt = keccak(encoded)
        salt_hex = "0x" + salt.hex()
    encoded_top = encode_abi(["address[]","uint256[]","bytes32","bytes32","bytes32"], [[to_checksum_address(t) for t in targets], [int(v) for v in values], packed_hash, predecessor, salt])
    opid = keccak(encoded_top)
    return "0x" + opid.hex(), salt_hex

# Pydantic models
class EncodeRequest(BaseModel):
    signature: str
    args: Optional[List[Any]] = []
    target: Optional[str] = None
    value: Optional[int] = 0
    predecessor: Optional[str] = None
    salt: Optional[str] = None
    sign_opid: Optional[bool] = False

class EncodeResponse(BaseModel):
    data: str
    selector: str
    types: List[str]
    coerced_args: List[Any]
    salt_used: Optional[str] = None
    opId: Optional[str] = None
    signature: Optional[str] = None
    signer_kid: Optional[str] = None

@router.post("/timelock/encode", response_model=EncodeResponse)
def encode(req: EncodeRequest, request: Request = None):
    try:
        enc = encode_function_call(req.signature, req.args or [])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    data_hex = enc["data"]
    selector = enc["selector"]
    types = enc["types"]
    coerced_args = enc["coerced_args"]
    data_bytes = enc["data_bytes"]

    opid = None
    salt_used = None
    sig_hex = None
    signer_kid = None

    if req.target:
        if not Web3.is_address(req.target):
            raise HTTPException(status_code=400, detail="invalid target address")
        try:
            opid, salt_used = compute_opid_single(req.target, int(req.value or 0), data_bytes, req.predecessor, req.salt)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"opId compute failed: {e}")

        if req.sign_opid:
            try:
                sign_result: SignResult = _signer.sign_opid(opid)
                sig_hex = sign_result.signature_hex
                signer_kid = sign_result.signer_kid
            except NotImplementedError as e:
                raise HTTPException(status_code=501, detail=str(e))
            except Exception as e:
                logger.exception("signing failed")
                raise HTTPException(status_code=500, detail="signing failed")

    audit_entry = {
        "action": "encode",
        "client": request.client.host if request and request.client else None,
        "signature": req.signature,
        "target": req.target,
        "types": types,
        "coerced_args": coerced_args,
        "data": data_hex,
        "opId": opid,
        "salt_used": salt_used,
        "signed": bool(sig_hex),
        "signer_kid": signer_kid
    }
    try:
        audit_log(audit_entry)
    except Exception:
        logger.exception("failed to write audit log")

    return {
        "data": data_hex,
        "selector": selector,
        "types": types,
        "coerced_args": coerced_args,
        "salt_used": salt_used,
        "opId": opid,
        "signature": sig_hex,
        "signer_kid": signer_kid
    }

# signer info endpoint
@router.get("/signer/info")
def signer_info():
    info = {"signer_kid": _signer.get_signer_id()}
    try:
        pub_pem = _signer.get_public_key_pem()
        if pub_pem:
            info["public_key_pem"] = pub_pem
        pub_bytes = _signer.get_public_key_bytes_uncompressed()
        if pub_bytes:
            info["public_key_uncompressed_hex"] = "0x" + pub_bytes.hex()
            info["ethereum_address"] = "0x" + keccak(pub_bytes[1:])[-20:].hex()
    except Exception:
        logger.exception("failed to get public key info")
    return info

# Audit listing endpoints
@router.get("/audit/list")
def audit_list(authorized: bool = Depends(lambda req=None: True)):
    results = []
    if AUDIT_S3_BUCKET:
        s3 = _s3_client()
        if not s3:
            raise HTTPException(status_code=500, detail="s3 client error")
        prefix = AUDIT_S3_PREFIX.rstrip("/") + "/"
        try:
            resp = s3.list_objects_v2(Bucket=AUDIT_S3_BUCKET, Prefix=prefix, MaxKeys=100)
            for obj in resp.get("Contents", []):
                results.append({"key": obj["Key"], "size": obj["Size"], "last_modified": obj["LastModified"].isoformat()})
            return {"source": "s3", "items": results}
        except Exception as e:
            logger.exception("s3 list failed: %s", e)
            raise HTTPException(status_code=500, detail="s3 list failed")
    try:
        if not os.path.exists(AUDIT_LOG_LOCAL):
            return {"source": "local", "items": []}
        with open(AUDIT_LOG_LOCAL, "r") as f:
            lines = f.readlines()[-200:]
        for i, ln in enumerate(reversed(lines)):
            results.append({"index": i, "preview": ln.strip()[:400]})
        return {"source": "local", "items": results}
    except Exception as e:
        logger.exception("local audit read failed: %s", e)
        raise HTTPException(status_code=500, detail="local audit read failed")

@router.get("/audit/get")
def audit_get(key: str, authorized: bool = Depends(lambda req=None: True)):
    if AUDIT_S3_BUCKET:
        s3 = _s3_client()
        try:
            resp = s3.get_object(Bucket=AUDIT_S3_BUCKET, Key=key)
            body = resp["Body"].read().decode("utf-8")
            return {"key": key, "data": body}
        except Exception as e:
            logger.exception("s3 get failed: %s", e)
            raise HTTPException(status_code=500, detail="s3 get failed")
    try:
        if not os.path.exists(AUDIT_LOG_LOCAL):
            raise HTTPException(status_code=404, detail="no audit log")
        with open(AUDIT_LOG_LOCAL, "r") as f:
            lines = f.readlines()
        idx = int(key)
        if idx < 0 or idx >= len(lines):
            raise HTTPException(status_code=404, detail="index out of range")
        return {"key": key, "data": lines[idx]}
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid key")
    except Exception as e:
        logger.exception("local audit get failed: %s", e)
        raise HTTPException(status_code=500, detail="local audit get failed")

@router.get("/timelock/status")
def status(opId: str):
    if not TIMELock_ADDR:
        raise HTTPException(status_code=500, detail="timelock address not configured")
    contract = w3.eth.contract(address=Web3.to_checksum_address(TIMELock_ADDR), abi=TIMELOCK_ABI)
    try:
        pending = contract.functions.isOperationPending(opId).call()
        ready = contract.functions.isOperationReady(opId).call()
        done = contract.functions.isOperationDone(opId).call()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"error querying timelock: {str(e)}")
    return {"opId": opId, "pending": pending, "ready": ready, "done": done}
