import os
import tempfile
import unittest
from pathlib import Path

from bindery.auth import configured_hash
from bindery.db import db_path
from bindery.env import read_env
from bindery.storage import library_dir


def _restore_env(name: str, previous: str | None) -> None:
    if previous is None:
        os.environ.pop(name, None)
    else:
        os.environ[name] = previous


class EnvFileTests(unittest.TestCase):
    def test_read_env_prefers_plain_value(self) -> None:
        prev_plain = os.environ.get("BINDERY_SAMPLE")
        prev_file = os.environ.get("BINDERY_SAMPLE_FILE")
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as tmp:
            tmp.write("from-file")
            file_path = tmp.name
        try:
            os.environ["BINDERY_SAMPLE"] = "from-env"
            os.environ["BINDERY_SAMPLE_FILE"] = file_path
            self.assertEqual(read_env("BINDERY_SAMPLE"), "from-env")
        finally:
            Path(file_path).unlink(missing_ok=True)
            _restore_env("BINDERY_SAMPLE", prev_plain)
            _restore_env("BINDERY_SAMPLE_FILE", prev_file)

    def test_read_env_supports_file_suffix(self) -> None:
        prev_plain = os.environ.get("BINDERY_SAMPLE")
        prev_file = os.environ.get("BINDERY_SAMPLE_FILE")
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as tmp:
            tmp.write("from-file\n")
            file_path = tmp.name
        try:
            os.environ.pop("BINDERY_SAMPLE", None)
            os.environ["BINDERY_SAMPLE_FILE"] = file_path
            self.assertEqual(read_env("BINDERY_SAMPLE"), "from-file")
        finally:
            Path(file_path).unlink(missing_ok=True)
            _restore_env("BINDERY_SAMPLE", prev_plain)
            _restore_env("BINDERY_SAMPLE_FILE", prev_file)

    def test_configured_hash_can_read_from_file(self) -> None:
        prev_hash = os.environ.get("BINDERY_PASSWORD_HASH")
        prev_hash_file = os.environ.get("BINDERY_PASSWORD_HASH_FILE")
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as tmp:
            tmp.write("$argon2id$v=19$dummy")
            file_path = tmp.name
        try:
            os.environ.pop("BINDERY_PASSWORD_HASH", None)
            os.environ["BINDERY_PASSWORD_HASH_FILE"] = file_path
            self.assertEqual(configured_hash(), "$argon2id$v=19$dummy")
        finally:
            Path(file_path).unlink(missing_ok=True)
            _restore_env("BINDERY_PASSWORD_HASH", prev_hash)
            _restore_env("BINDERY_PASSWORD_HASH_FILE", prev_hash_file)

    def test_library_and_db_path_can_read_from_file(self) -> None:
        prev_library = os.environ.get("BINDERY_LIBRARY_DIR")
        prev_library_file = os.environ.get("BINDERY_LIBRARY_DIR_FILE")
        prev_db = os.environ.get("BINDERY_DB_PATH")
        prev_db_file = os.environ.get("BINDERY_DB_PATH_FILE")
        with tempfile.TemporaryDirectory() as tmp:
            library_target = Path(tmp) / "library-data"
            db_target = Path(tmp) / "db" / "bindery.sqlite"
            lib_file = Path(tmp) / "library_path.txt"
            db_file = Path(tmp) / "db_path.txt"
            lib_file.write_text(str(library_target), encoding="utf-8")
            db_file.write_text(str(db_target), encoding="utf-8")
            try:
                os.environ.pop("BINDERY_LIBRARY_DIR", None)
                os.environ.pop("BINDERY_DB_PATH", None)
                os.environ["BINDERY_LIBRARY_DIR_FILE"] = str(lib_file)
                os.environ["BINDERY_DB_PATH_FILE"] = str(db_file)
                self.assertEqual(library_dir(), library_target)
                self.assertEqual(db_path(), db_target)
            finally:
                _restore_env("BINDERY_LIBRARY_DIR", prev_library)
                _restore_env("BINDERY_LIBRARY_DIR_FILE", prev_library_file)
                _restore_env("BINDERY_DB_PATH", prev_db)
                _restore_env("BINDERY_DB_PATH_FILE", prev_db_file)


if __name__ == "__main__":
    unittest.main()
