"""Reproducible synthetic input corpus; never touches the Python tests or library."""
from pathlib import Path
import json
import struct
import zlib

ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / 'tests-ts/fixtures'

def main():
    DEST.mkdir(parents=True, exist_ok=True)
    cases = {
        'utf8': '书名：测试书\n作者：张三\n内容简介：这是简介\n\n第一章 起始\n这是第一段。\n\n第二章 继续\n这是第二段。',
        'bom': '书名：带 BOM 的书\n作者：作者\n第一章\n内容',
        'gbk': '书名：中文编码\n作者：李四\n第一章 开始\n　　中文内容。',
        'gb18030': '书名：四字节编码\n第一章 开始\n𠀀𠮷🙂',
        'crlf': '书名：换行\r\n作者：作者\r\n\r\nChapter 1 Start\r\n内容\r\n',
        'cr-only': '书名：独立回车\r作者：作者\r第一章\r正文\r',
        'volumes': '第一卷 开端\n卷前内容\n第一章 初见\n这里是内容\n第二章 重逢\n内容\n第二卷 尾声\n第三章 落幕\n',
        'chapters': '第一章 起始\n内容\n\n第二章 继续\n第二段',
        'no-headings': '无章节书\n作者候选\n普通正文\n另一段正文',
        'labels': '书 名\n：标签书\n作 者\n: 标签作者\n内容介绍\n第一段简介\n第二段简介\n\n第一章\n正文',
        'label-quirks': '书名：\n：书名值\n作  者：参考实现将此作为简介\n段落\n\n第一章\n正文',
        'bracket-title': '《括号书名》\n普通候选\n另一候选\n简介：简介段\n\n第一章\n正文',
        'blanks': '\n\n书名：空行\n\n作者：作者\n\n简介：\n\n\n简介内容\n\n\n第一章\n\n　\n正文　内部空格\n\n',
        'long-lines': '书名：长行\n作者：作者\n第一章\n' + '长文本。' * 2500 + '\n第二章\n结束',
        'heading-guards': '书名：启发式\n第一章\n正文\n第二章 这是，正文，句子。\n紧邻正文\n\n第三章 孤立，长句，仍为标题。\n\n终章：终点\n尾文',
        'english': 'Title\nAuthor\nchapter 12 Start\nText\nCHAPTER ２ Unicode digit\nEnd',
        'whitespace': ' \n\t\r\n　\n',
        'unicode-space': '书名：空白\n第一章\n\x85\x1c　正文\u2028内换行\ufeff\n',
        'empty': '',
        'empty-volumes': '第一卷\n第二卷\n第三卷\n第一章\n第二章\n',
        'candidate-skip': 'www.example.com\nQQ群：123\n书名候选\n作者候选\n普通内容\n\n序章\n正文',
        'raw-template-values': '书名：原始模板\n第一章 <b>标题</b>\n标记 &amp; <em>内容</em>\n',
    }
    manifest = []
    for name, text in cases.items():
        encoding = {'bom': 'utf-8-sig', 'gbk': 'gbk', 'gb18030': 'gb18030'}.get(name, 'utf-8')
        filename = name + '.txt'
        (DEST / filename).write_bytes(text.encode(encoding))
        manifest.append({'name': name, 'file': filename, 'encoding': encoding})
    (DEST / 'invalid.txt').write_bytes(b'\xff\n\xfe\xff\x80\n\xe2\x82\nChapter 1\nbody\xff')
    manifest.append({'name': 'invalid', 'file': 'invalid.txt', 'encoding': 'invalid'})
    pairs = 'a3a0 a6d9 a6da a6db a6dc a6dd a6de a6df a6ec a6ed a6f3 a8bc fe59 fe61 fe66 fe67 fe6d fe7e fe90 fea0 8135f437'
    (DEST / 'gb18030-compat.txt').write_bytes(b'Book\nAuthor\nChapter 1\n' + bytes.fromhex(pairs))
    manifest.append({'name': 'gb18030-compat', 'file': 'gb18030-compat.txt', 'encoding': 'gb18030'})
    (DEST / 'invalid-euro.txt').write_bytes(b'Book\nAuthor\nChapter 1\n\x80')
    manifest.append({'name': 'invalid-euro', 'file': 'invalid-euro.txt', 'encoding': 'invalid'})
    boundary = b'Book\nAuthor\nChapter 1\n'
    boundary += b'a' * (65535 - len(boundary)) + bytes.fromhex('8135f437')
    boundary += b'b' * (131071 - len(boundary)) + bytes.fromhex('a6d9')
    boundary += b'c' * (196607 - len(boundary)) + b'\r\nChapter 2\r\nend'
    (DEST / 'stream-boundaries.txt').write_bytes(boundary)
    manifest.append({'name': 'stream-boundaries', 'file': 'stream-boundaries.txt', 'encoding': 'gb18030'})
    def png_chunk(kind, payload):
        return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload))
    cover = b'\x89PNG\r\n\x1a\n'
    cover += png_chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0))
    cover += png_chunk(b'IDAT', zlib.compress(b'\x00\xff\xff\xff\xff'))
    cover += png_chunk(b'IEND', b'')
    (DEST / 'cover 中文.png').write_bytes(cover)
    (DEST / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')

if __name__ == '__main__': main()
