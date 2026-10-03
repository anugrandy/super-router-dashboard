"""Build the `Check` header the ZTE web UI sends on every dataPost().

From the router's own common_lib.js / index page:

    function dataPost(actionType, ...) {
        ...
        PostDataTmp += "&_sessionTOKEN=" + _sessionTmpToken;
        var selfHeader = {};
        if (commConf.IntegCheck) {
            var degistStr = sha256(PostDataTmp);      // hex digest of the body
            selfHeader["Check"] = asyEncode(degistStr);  // RSA-encrypt that hex
        }
        $.ajax({ ..., headers: selfHeader });
    }

    function asyEncode(srcStr) {
        var pubKey = "-----BEGIN PUBLIC KEY-----\\nMIIBIjAN...\\n-----END PUBLIC KEY-----";
        var encrypt = new JSEncrypt();
        encrypt.setPublicKey(pubKey);
        return encrypt.encrypt(srcStr);
    }

So: Check = base64(RSA_PKCS1_SHA1(pubkey, hex(sha256(body_with_session_token)))),
sent as a header. This is integrity checking only — the plaintext is a public
digest, so there is no confidentiality claim here.
"""
from __future__ import annotations

import base64
import hashlib

# Same key the router ships in its own web UI.
PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAodPTerkUVCYmv28SOfRV
7UKHVujx/HjCUTAWy9l0L5H0JV0LfDudTdMNPEKloZsNam3YrtEnq6jqMLJV4ASb
1d6axmIgJ636wyTUS99gj4BKs6bQSTUSE8h/QkUYv4gEIt3saMS0pZpd90y6+B/9
hZxZE/RKU8e+zgRqp1/762TB7vcjtjOwXRDEL0w71Jk9i8VUQ59MR1Uj5E8X3WIc
fYSK5RWBkMhfaTRM6ozS9Bqhi40xlSOb3GBxCmliCifOJNLoO9kFoWgAIw5hkSIb
GH+4Csop9Uy8VvmmB+B3ubFLN35qIa5OG5+SDXn4L7FeAA5lRiGxRi8tsWrtew8w
nwIDAQAB
-----END PUBLIC KEY-----"""


def body_digest(body: str) -> str:
    """sha256 hex digest of the exact request body string."""
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _rsa_encrypt(message: str) -> str:
    """Raw RSA PKCS#1 v1.5 encrypt of `message` with PUBLIC_KEY, base64-encoded.

    JSEncrypt uses PKCS#1 v1.5 padding (not OAEP) and encrypts with SHA-1 as the
    digest algorithm, which is what the router's firmware expects.
    """
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa

    pub = serialization.load_pem_public_key(PUBLIC_KEY.encode())
    assert isinstance(pub, rsa.RSAPublicKey)
    # PKCS1v15 with SHA-1, matching JSEncrypt's default. The digest arg here
    # only applies to OAEP; with PKCS1v15 the padding carries no digest, which
    # is exactly what JSEncrypt emits.
    enc = pub.encrypt(message.encode("utf-8"), padding.PKCS1v15())
    return base64.b64encode(enc).decode("ascii")


def build_check(body: str) -> str:
    """Full pipeline: sha256(body) -> RSA -> base64. This is the Check header.

    Note the router hashes the *encoded body string* it is about to send, so
    the caller must pass the exact same string (ordering and encoding matter).
    """
    return _rsa_encrypt(body_digest(body))