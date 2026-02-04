#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import sys
import uuid
from pathlib import Path

from bindery.epub import build_epub
from bindery.models import Metadata
from bindery.parsing import parse_book, read_text


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert novel TXT to EPUB 3 with automatic metadata and TOC parsing."
    )
    parser.add_argument("input", help="Input TXT file path")
    parser.add_argument("-o", "--output", help="Output EPUB file path")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Input file not found: {input_path}", file=sys.stderr)
        return 1

    output_path = Path(args.output) if args.output else input_path.with_suffix(".epub")
    text = read_text(input_path)
    book = parse_book(text, input_path.stem)

    now = dt.datetime.now(dt.timezone.utc).isoformat()
    meta = Metadata(
        book_id=uuid.uuid4().hex,
        title=book.title,
        author=book.author,
        language="zh-CN",
        description=book.intro,
        publisher=None,
        tags=[],
        published=None,
        isbn=None,
        rating=None,
        created_at=now,
        updated_at=now,
    )

    build_epub(book, meta, output_path)
    print(f"EPUB saved to: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
