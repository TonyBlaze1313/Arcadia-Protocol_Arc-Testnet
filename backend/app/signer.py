# Signer abstraction with LocalSigner (existing) and KMSSigner (AWS KMS integration).
# KMSSigner uses boto3 KMS Sign/GetPublicKey and converts DER signature -> r,s,v (Ethereum v).
# For production use: configure SIGNER_TYPE=kms and KMS_KEY_ID, AWS credentials, and region.

import os
import logging
from typing import Optional, Dict, Any, Tuple

from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import keccak
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.serialization import load_der_public_key

logger = logging.getLogger("arcadia.signer")
SIGNER_TYPE = os.getenv("SIGNER_TYPE", "local")
ADMIN_PRIVATE_KEY = os.getenv("ADMIN_PRIVATE_KEY")
AWS_ENDPOINT_URL = os.getenv("AWS_ENDPOINT_URL")  # optional (e.g., localstack)
KMS_KEY_ID = os.getenv("KMS_KEY_ID")  # required for KMS signer
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")


class SignResult:
    def __init__(self, signature_hex: str, signer_kid: str, r: int = None, s: int = None, v: int = None):
        self.signature_hex = signature_hex
        self.signer_kid = signer_kid
        self.r = r
        self.s = s
        self.v = v


class BaseSigner:
    def sign_opid(self, opid_hex: str) -> SignResult:
        raise NotImplementedError()

    def get_signer_id(self) -> str:
        raise NotImplementedError()

    def get_public_key_pem(self) -> Optional[str]:
        # optional: return PEM for public key
        return None

    def get_public_key_bytes_uncompressed(self) -> Optional[bytes]:
        # optional: return uncompressed EC public key (0x04 | x | y)
        return None


class LocalSigner(BaseSigner):
    def __init__(self, private_key_hex: Optional[str]):
        if not private_key_hex:
            raise ValueError("ADMIN_PRIVATE_KEY must be set for local signer")
        self._acct = Account.from_key(private_key_hex)
        self._kid = f"local:{self._acct.address.lower()}"

    def sign_opid(self, opid_hex: str) -> SignResult:
        # eth_sign/defunct style signed: sign defunct message of opId (hex)
        msg = encode_defunct(hexstr=opid_hex)
        signed = Account.sign_message(msg, private_key=self._acct.key)
        sig_hex = "0x" + signed.signature.hex() if isinstance(signed.signature, (bytes, bytearray)) else signed.signature
        try:
            r = int(signed.r)
            s = int(signed.s)
            v = int(signed.v)
        except Exception:
            r = None; s = None; v = None
        return SignResult(sig_hex, self._kid, r=r, s=s, v=v)

    def get_signer_id(self) -> str:
        return self._kid

    def get_public_key_bytes_uncompressed(self) -> Optional[bytes]:
        try:
            # eth_account key object internals (works with eth_keys backend)
            key_obj = self._acct._key_obj  # eth_keys.keys.PrivateKey
            pub = key_obj.public_key
            raw = pub.to_bytes()  # 64 bytes X||Y
            if len(raw) == 64:
                return b"\x04" + raw
            return raw
        except Exception:
            return None


class KMSSigner(BaseSigner):
    def __init__(self, key_id: str, region_name: str = AWS_REGION, endpoint_url: Optional[str] = None):
        try:
            import boto3  # local import to avoid hard dependency for non-KMS setups
        except Exception as e:
            raise RuntimeError("boto3 is required for KMSSigner") from e
        self.key_id = key_id
        self.endpoint_url = endpoint_url
        # create client; allow localstack via endpoint_url
        import boto3
        client_kwargs = {"region_name": region_name}
        if endpoint_url:
            client_kwargs["endpoint_url"] = endpoint_url
        self.kms = boto3.client("kms", **client_kwargs)
        self._kid = f"kms:{self.key_id}"

    def get_signer_id(self) -> str:
        return self._kid

    def get_public_key_pem(self) -> Optional[str]:
        resp = self.kms.get_public_key(KeyId=self.key_id)
        pub_der = resp.get("PublicKey")
        if not pub_der:
            return None
        try:
            from cryptography.hazmat.primitives import serialization
            pub = load_der_public_key(pub_der)
            pem = pub.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
            return pem.decode()
        except Exception:
            return "0x" + pub_der.hex()

    def get_public_key_bytes_uncompressed(self) -> Optional[bytes]:
        resp = self.kms.get_public_key(KeyId=self.key_id)
        pub_der = resp.get("PublicKey")
        if not pub_der:
            return None
        try:
            pub = load_der_public_key(pub_der)
            numbers = pub.public_numbers()
            x = numbers.x
            y = numbers.y
            xb = int(x).to_bytes(32, "big")
            yb = int(y).to_bytes(32, "big")
            return b"\x04" + xb + yb
        except Exception:
            return None

    def _der_signature_to_r_s(self, der_sig: bytes) -> Tuple[int, int]:
        r, s = decode_dss_signature(der_sig)
        return r, s

    def sign_opid(self, opid_hex: str) -> SignResult:
        """
        Sign opid (bytes32 hex string) using AWS KMS.

        Strategy:
          - Compute msg_hash = keccak(opid_bytes)
          - Call KMS.sign with Message=msg_hash, MessageType='DIGEST', SigningAlgorithm='ECDSA_SECP256K1_SHA256'
          - Convert DER signature to r,s and attempt to compute v by recovering against public key
        """
        opid_clean = opid_hex[2:] if opid_hex.startswith("0x") else opid_hex
        opid_bytes = bytes.fromhex(opid_clean)
        msg_hash = keccak(opid_bytes)  # 32 bytes

        try:
            resp = self.kms.sign(
                KeyId=self.key_id,
                Message=msg_hash,
                MessageType="DIGEST",
                SigningAlgorithm="ECDSA_SECP256K1_SHA256"
            )
            der_sig = resp.get("Signature")
            if der_sig is None:
                raise RuntimeError("KMS did not return Signature")
            r, s = self._der_signature_to_r_s(der_sig)

            pub_bytes = self.get_public_key_bytes_uncompressed()
            if not pub_bytes:
                sig_hex = "0x" + (r.to_bytes(32, "big") + s.to_bytes(32, "big")).hex()
                return SignResult(sig_hex, self._kid, r=r, s=s, v=None)

            # derive address from pubkey
            pubkey_no_prefix = pub_bytes[1:]
            addr_from_kms = "0x" + keccak(pubkey_no_prefix)[-20:].hex()

            # try to recover v by trying recid 0/1
            from eth_keys import keys as _keys
            recovered_v = None
            for recid in (0, 1):
                try:
                    sig_obj = _keys.Signature(vrs=(recid, r, s))
                    rec_pub = sig_obj.recover_public_key_from_msg_hash(msg_hash)
                    rec_bytes = rec_pub.to_bytes()
                    rec_addr = "0x" + keccak(rec_bytes)[-20:].hex()
                    if rec_addr.lower() == addr_from_kms.lower():
                        recovered_v = recid
                        break
                except Exception:
                    continue
            if recovered_v is None:
                sig_hex = "0x" + (r.to_bytes(32, "big") + s.to_bytes(32, "big")).hex()
                return SignResult(sig_hex, self._kid, r=r, s=s, v=None)

            v_eth = 27 + recovered_v
            sig_bytes = r.to_bytes(32, "big") + s.to_bytes(32, "big") + bytes([v_eth])
            return SignResult("0x" + sig_bytes.hex(), self._kid, r=r, s=s, v=v_eth)
        except Exception as e:
            logger.exception("KMS sign failed: %s", e)
            raise
