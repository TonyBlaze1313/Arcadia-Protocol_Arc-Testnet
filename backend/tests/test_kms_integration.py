# backend/tests/test_kms_integration.py
import os
import pytest
from eth_utils import keccak
from backend.app.signer import KMSSigner

KMS_KEY_ID = os.getenv("KMS_KEY_ID")
AWS_ENDPOINT_URL = os.getenv("AWS_ENDPOINT_URL")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")

@pytest.mark.skipif(not KMS_KEY_ID, reason="KMS_KEY_ID not provided")
def test_kms_sign_opid_roundtrip():
    signer = KMSSigner(KMS_KEY_ID, region_name=AWS_REGION, endpoint_url=AWS_ENDPOINT_URL)
    opid = "0x" + keccak(text="test-opid-" + str(os.urandom(8))).hex()
    sign_result = signer.sign_opid(opid)
    assert sign_result.signature_hex.startswith("0x")
    pub_uncompressed = signer.get_public_key_bytes_uncompressed()
    assert pub_uncompressed is not None
