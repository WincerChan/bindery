import tempfile
import unittest
from pathlib import Path

from bindery.storage import save_cover_bytes


class StorageTests(unittest.TestCase):
    def test_save_cover_bytes_infers_extension_without_imghdr(self) -> None:
        cases = [
            (b"\xff\xd8\xff\xe0jpeg", ".jpg"),
            (b"\x89PNG\r\n\x1a\npng", ".png"),
            (b"GIF89agif", ".gif"),
            (b"RIFF\x04\x00\x00\x00WEBPwebp", ".webp"),
            (b"  <svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", ".svg"),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            book_id = "book"
            (base / book_id).mkdir()

            for data, expected_ext in cases:
                saved = save_cover_bytes(base, book_id, data, filename=None)
                self.assertEqual(saved, f"cover{expected_ext}")
                self.assertEqual((base / book_id / saved).read_bytes(), data)

    def test_save_cover_bytes_falls_back_to_jpg_for_unknown_data(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            book_id = "book"
            (base / book_id).mkdir()

            saved = save_cover_bytes(base, book_id, b"not-an-image", filename=None)

            self.assertEqual(saved, "cover.jpg")
            self.assertEqual((base / book_id / saved).read_bytes(), b"not-an-image")


if __name__ == "__main__":
    unittest.main()
