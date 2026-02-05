import os
import unittest

from argon2 import PasswordHasher

from bindery.auth import verify_password


class AuthTests(unittest.TestCase):
    def test_verify_password(self) -> None:
        hasher = PasswordHasher()
        hashed = hasher.hash("secret")
        os.environ["BINDERY_PASSWORD_HASH"] = hashed
        try:
            self.assertTrue(verify_password("secret"))
            self.assertFalse(verify_password("wrong"))
        finally:
            del os.environ["BINDERY_PASSWORD_HASH"]


if __name__ == "__main__":
    unittest.main()
