"""Emit Python codec reference data for every GB18030 byte sequence family."""
from pathlib import Path
import json
import sys

pairs = []
for lead in range(256):
    raw = bytes([lead])
    try: value = raw.decode('gb18030')
    except UnicodeDecodeError: value = None
    pairs.append([raw.hex(), value])
for lead in range(0x81, 0xff):
    for trail in range(0x40, 0xff):
        if trail == 0x7f: continue
        raw = bytes([lead, trail])
        try: value = raw.decode('gb18030')
        except UnicodeDecodeError: value = None
        pairs.append([raw.hex(), value])
ranges = []
start = 0
previous = old = None
for pointer in range(126 * 10 * 126 * 10):
    x = pointer
    b4 = x % 10 + 0x30; x //= 10
    b3 = x % 126 + 0x81; x //= 126
    b2 = x % 10 + 0x30; x //= 10
    b1 = x + 0x81
    try: code = ord(bytes([b1, b2, b3, b4]).decode('gb18030'))
    except UnicodeDecodeError: code = None
    if pointer and not ((code is None and old is None) or (code is not None and old is not None and code == old + 1)):
        ranges.append([start, pointer - 1, previous]); start = pointer; previous = code
    elif not pointer: previous = code
    old = code
ranges.append([start, pointer, previous])
Path(sys.argv[1]).write_text(json.dumps(dict(pairs=pairs, ranges=ranges)))
