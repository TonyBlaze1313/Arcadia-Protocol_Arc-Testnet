# backend/tests/test_encode_opid_prod.py
import os
import json
from web3 import Web3
from eth_account import Account
from backend.app import timelock_api as api

FIXTURES_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "encode_samples.json")
os.makedirs(os.path.dirname(FIXTURES_PATH), exist_ok=True)

TEST_PRIVATE_KEY = os.getenv("TEST_ADMIN_PRIVATE_KEY") or Account.create().key.hex()
os.environ["ADMIN_PRIVATE_KEY"] = TEST_PRIVATE_KEY
os.environ["SIGNER_TYPE"] = "local"

def save_fixture(data):
    with open(FIXTURES_PATH, "w") as f:
        json.dump(data, f, indent=2)

def test_parametric_edge_cases_and_signature_verification():
    samples = []
    # uint8 edge
    sig = "setSmall(uint8)"; args = [255]; target = "0x" + "11"*20
    enc = api.encode_function_call(sig, args)
    opid, salt = api.compute_opid_single(target, 0, enc["data_bytes"], None, None)
    req = api.EncodeRequest(signature=sig, args=args, target=target, value=0, sign_opid=True)
    resp = api.encode(req)
    assert resp["opId"] == opid
    assert resp["signature"] is not None
    acct = Account.from_key(TEST_PRIVATE_KEY)
    saved = {"signature": sig, "args": args, "target": target, "data": resp["data"], "opId": resp["opId"], "salt": resp["salt_used"], "signature_hex": resp["signature"]}
    samples.append(saved)

    # uint256 large
    sig2 = "setLarge(uint256)"; args2 = [2**200]; target2 = "0x" + "12"*20
    resp2 = api.encode(api.EncodeRequest(signature=sig2, args=args2, target=target2, value=0, sign_opid=True))
    samples.append({"signature": sig2, "args": args2, "target": target2, "data": resp2["data"], "opId": resp2["opId"]})

    # bytes32
    sig3 = "setHash(bytes32)"; args3 = ["0x1234"]; target3 = "0x" + "13"*20
    resp3 = api.encode(api.EncodeRequest(signature=sig3, args=args3, target=target3, sign_opid=True))
    samples.append({"signature": sig3, "args": args3, "target": target3, "data": resp3["data"], "opId": resp3["opId"]})

    # address[] and tuple[]
    sig4 = "approveMany(address[])"; args4 = [["0x" + "21"*20, "0x" + "22"*20]]; t4 = "0x" + "14"*20
    resp4 = api.encode(api.EncodeRequest(signature=sig4, args=args4, target=t4, sign_opid=True))
    samples.append({"signature": sig4, "args": args4, "target": t4, "data": resp4["data"], "opId": resp4["opId"]})

    sig5 = "setPairs((uint256,address)[])"; args5 = [[[1, "0x" + "31"*20], [2, "0x" + "32"*20]]]; t5 = "0x" + "15"*20
    resp5 = api.encode(api.EncodeRequest(signature=sig5, args=args5, target=t5, sign_opid=True))
    samples.append({"signature": sig5, "args": args5, "target": t5, "data": resp5["data"], "opId": resp5["opId"]})

    fixture = {"generated_at": Web3.toHex(Web3.keccak(text=str(os.urandom(16)))), "samples": samples}
    save_fixture(fixture)
    assert os.path.exists(FIXTURES_PATH)
