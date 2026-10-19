"""Generate and verify real WebAuthn signatures with Python, using temp DBs only."""
from __future__ import annotations
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import sys
import tempfile

import cbor2
from argon2 import PasswordHasher, Type
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, padding, rsa
from webauthn import verify_authentication_response, verify_registration_response
from webauthn.helpers import bytes_to_base64url

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from bindery import db
from bindery.auth import sign_in, is_authenticated

root = Path(sys.argv[2]).resolve()
assert root.is_relative_to(Path(tempfile.gettempdir()).resolve()), "Temp directories only"
root.mkdir(parents=True, exist_ok=True)
os.environ["BINDERY_DB_PATH"] = str(root / "data.db")
os.environ["BINDERY_LIBRARY_DIR"] = str(root / "library")
db.init_db()
origin = "https://books.example.com"
rp_id = "books.example.com"

def b64(data):
    return bytes_to_base64url(data)

def unb64(data):
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))

def client_data(kind, challenge, config):
    return json.dumps({"type": kind, "challenge": challenge, "origin": config.get("origin", origin), "crossOrigin": False}, separators=(",", ":")).encode()

def register(alg, challenge, config):
    if alg in (-7, -36):
        key = ec.generate_private_key(ec.SECP256R1() if alg == -7 else ec.SECP521R1())
        nums = key.public_key().public_numbers()
        size = 32 if alg == -7 else 66
        cose = {1: 2, 3: alg, -1: 1 if alg == -7 else 3, -2: nums.x.to_bytes(size), -3: nums.y.to_bytes(size)}
    elif alg == -8:
        key = ed25519.Ed25519PrivateKey.generate()
        cose = {1: 1, 3: alg, -1: 6, -2: key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)}
    else:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        nums = key.public_key().public_numbers()
        cose = {1: 3, 3: alg, -1: nums.n.to_bytes(256), -2: nums.e.to_bytes(3)}
    credential_id = secrets.token_bytes(24)
    public_key = cbor2.dumps(cose)
    flags = config.get("flags", 0x45)
    auth_data = hashlib.sha256(config.get("rp_id", rp_id).encode()).digest() + bytes([flags]) + (0).to_bytes(4)
    auth_data += b"\x00" * 16 + len(credential_id).to_bytes(2) + credential_id + public_key
    client = client_data("webauthn.create", challenge, config)
    credential = {"id": b64(credential_id), "rawId": b64(credential_id), "type": "public-key", "clientExtensionResults": {},
                  "response": {"clientDataJSON": b64(client), "attestationObject": b64(cbor2.dumps({"fmt": "none", "attStmt": {}, "authData": auth_data})), "transports": ["internal", "hybrid", "bogus"]}}
    private = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    (root / (b64(credential_id) + ".pem")).write_bytes(private)
    os.chmod(root / (b64(credential_id) + ".pem"), 0o600)
    (root / (b64(credential_id) + ".cose")).write_bytes(public_key)
    return credential

def assertion(credential_id, challenge, config):
    key = serialization.load_pem_private_key((root / (credential_id + ".pem")).read_bytes(), password=None)
    cose = cbor2.loads((root / (credential_id + ".cose")).read_bytes())
    alg = cose[3]
    auth_data = hashlib.sha256(config.get("rp_id", rp_id).encode()).digest() + bytes([config.get("flags", 5)]) + config.get("counter", 1).to_bytes(4)
    client = client_data("webauthn.get", challenge, config)
    signed = auth_data + hashlib.sha256(client).digest()
    if alg == -8:
        signature = key.sign(signed)
    else:
        hash_alg = { -7: hashes.SHA256, -36: hashes.SHA512, -37: hashes.SHA256, -38: hashes.SHA384, -39: hashes.SHA512, -257: hashes.SHA256, -258: hashes.SHA384, -259: hashes.SHA512 }[alg]()
        if alg in (-7, -36):
            signature = key.sign(signed, ec.ECDSA(hash_alg))
        elif alg in (-37, -38, -39):
            signature = key.sign(signed, padding.PSS(mgf=padding.MGF1(hash_alg), salt_length=hash_alg.digest_size), hash_alg)
        else:
            signature = key.sign(signed, padding.PKCS1v15(), hash_alg)
    if config.get("corrupt"):
        signature = bytes([signature[0] ^ 1]) + signature[1:]
    return {"id": credential_id, "rawId": credential_id, "type": "public-key", "clientExtensionResults": {},
            "response": {"clientDataJSON": b64(client), "authenticatorData": b64(auth_data), "signature": b64(signature), "userHandle": None}}

mode = sys.argv[1]
if mode == "hashes":
    output = {kind.name: PasswordHasher(time_cost=1, memory_cost=8192, type=kind).hash("兼容-password😀") for kind in (Type.ID, Type.I, Type.D)}
elif mode in ("registration", "enroll-python"):
    alg, challenge = int(sys.argv[3]), sys.argv[4]
    config = json.loads(sys.argv[5]) if len(sys.argv) > 5 else {}
    credential = register(alg, challenge, config)
    if mode == "enroll-python":
        # Unknown transports are not part of py_webauthn's credential struct.
        clean = json.loads(json.dumps(credential))
        clean["response"]["transports"] = ["internal", "hybrid"]
        verified = verify_registration_response(credential=clean, expected_challenge=unb64(challenge), expected_rp_id=rp_id, expected_origin=origin, require_user_verification=True)
        db.insert_passkey(b64(verified.credential_id), verified.credential_public_key, verified.sign_count, '["internal", "hybrid"]', str(verified.aaguid), verified.credential_device_type.value, verified.credential_backed_up, "Python 通行密钥", "2026-10-19T00:00:00+00:00")
    output = credential
elif mode == "assertion":
    output = assertion(sys.argv[3], sys.argv[4], json.loads(sys.argv[5]) if len(sys.argv) > 5 else {})
elif mode == "verify":
    body = json.loads(Path(sys.argv[3]).read_text())
    key = db.get_passkey(body["credential"]["rawId"])
    verified = verify_authentication_response(credential=body["credential"], expected_challenge=unb64(body["challenge"]), expected_rp_id=rp_id, expected_origin=origin, credential_public_key=key["public_key"], credential_current_sign_count=key["sign_count"], require_user_verification=True)
    db.update_passkey_usage(key["credential_id"], verified.new_sign_count, verified.credential_backed_up, "2026-10-19T00:00:00+00:00")
    output = {"counter": verified.new_sign_count}
elif mode == "challenge":
    challenge = secrets.token_bytes(64)
    output = {"id": db.create_challenge("login", challenge), "challenge": b64(challenge)}
elif mode == "session":
    output = {"session": sign_in()}
elif mode == "check-session":
    output = {"authenticated": is_authenticated(sys.argv[3])}
else:
    raise ValueError(mode)
print(json.dumps(output))
