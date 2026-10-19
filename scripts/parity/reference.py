"""Generate fresh outputs using the real Python implementation, exclusively in DEST.

Usage: uv run --no-sync python scripts/parity/reference.py DEST
No generated references are committed and no library file is patched in place.
"""
from pathlib import Path
import base64
import dataclasses
import json
import hashlib
import runpy
import re
import shutil
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from bindery import epub, parsing
from bindery.models import Metadata, book_to_dict, metadata_to_dict
from bindery.rules import validate_rule_template_json
from bindery.themes import compose_css


def inspect(path):
    cover = epub.extract_cover(path)
    docs = list(epub.iter_epub_section_documents(path))
    return {
        'metadata': epub.extract_epub_metadata(path, 'fallback'),
        'sections': [dataclasses.asdict(s) for s in epub.list_epub_sections(path)],
        'documents': [dict(index=d.index, title=d.title, item_path=d.item_path, content_sha256=hashlib.sha256(d.content).hexdigest(), media_type=d.media_type) for d in docs],
        'cover': [base64.b64encode(cover[0]).decode(), cover[1]] if cover else None,
        'loaded': [dict(item_path=d.item_path, base=epub.epub_base_href('/book/parity/epub', d.item_path), content=base64.b64encode(epub.load_epub_item(path, d.item_path, epub.epub_base_href('/book/parity/epub', d.item_path))[0]).decode(), media_type=epub.load_epub_item(path, d.item_path, '/')[1]) for d in (docs[:1] + docs[-1:] if len(docs) > 1 else docs)],
    }


def main():
    dest = Path(sys.argv[1]).resolve()
    dest.mkdir(parents=True, exist_ok=True)
    fixtures = ROOT / 'tests-ts/fixtures'
    manifest = json.loads((fixtures / 'manifest.json').read_text())
    rules = []
    for file in sorted((ROOT / 'bindery-templates/rules').glob('*.json')):
        raw = file.read_text()
        data = validate_rule_template_json(file.stem, raw)
        config = parsing.RuleConfig(rule_id=file.stem, **{k: data[k] for k in ['name', 'chapter_patterns', 'volume_patterns', 'special_headings', 'heading_max_len', 'heading_max_commas', 'skip_candidate_re']})
        rules.append((file.stem, parsing.build_rules(config), data))
    themes = [json.loads(p.read_text()) for p in sorted((ROOT / 'bindery-templates/themes').glob('*.json'))]
    records = []
    for case in manifest:
        path = fixtures / case['file']
        for rule_id, rule, _ in rules:
            book = parsing.parse_book_file(path, case['name'], rule)
            events = list(parsing.parse_book_file_events(path, case['name'], rule))
            meta = Metadata(book_id='parity-id', title=book.title, author=book.author, language='zh-CN', description=book.intro)
            record = dict(name=case['name'], file=case['file'], rule=rule_id, decoded=parsing.decode_text(path.read_bytes()), book=book_to_dict(book), text_book=book_to_dict(parsing.parse_book(parsing.decode_text(path.read_bytes()), case['name'], rule)), events=[dataclasses.asdict(e) for e in events], has_content=parsing.text_file_has_content(path), builds=[])
            variants = [('plain', None, None)] + [(t['id'], compose_css(t['css'], '  p { color: #123; }\n'), fixtures / 'cover 中文.png') for t in themes]
            for variant, css, cover in variants:
                # Full metadata covers all optional OPF branches as well as minimal metadata above.
                current = meta if variant == 'plain' else dataclasses.replace(meta, identifier='ID-123', isbn='9781234567890', series='系列', publisher='出版社', tags=['标签1', '', '标签2'], published='2024-01-01', rating=4)
                for mode in ['book', 'stream']:
                    filename = f'{case["name"]}-{rule_id}-{variant}-{mode}.epub'
                    output = dest / filename
                    if mode == 'book': epub.build_epub(book, current, output, cover, css)
                    else: epub.build_epub_from_section_stream(stream_sections=(epub.StreamBuildSection(kind=e.kind, title=e.title, lines=e.lines) for e in events if isinstance(e, parsing.ParsedBookSection)), source_author=book.author, source_intro=book.intro, meta=current, output_path=output, cover_path=cover, css_text=css)
                    record['builds'].append(dict(file=filename, mode=mode, meta=metadata_to_dict(current), css=css, cover=cover.name if cover else None, inspection=inspect(output)))
            records.append(record)

    # Reuse the real external-EPUB fixture constructors from Python's tests.
    helpers = runpy.run_path(str(ROOT / 'tests/test_epub.py'))['BuildEpubTests']()
    external = []
    for kind in ['inline_style', 'linked_style', 'webp_refs', 'html_webp_only']:
        path = dest / f'input-{kind}.epub'
        getattr(helpers, f'_create_external_epub_with_{kind}')(path, book_id='external-id')
        external.append(path)
    # Exercise namespace allocation, unknown metadata, comments, fallback spine, nested paths.
    original = dest / 'input-linked_style.epub'
    for variant in ['paths', 'ncx-only', 'no-spine', 'comments', 'self-head', 'css-pi', 'no-metadata']:
        output = dest / f'input-{variant}.epub'
        with zipfile.ZipFile(original) as src, zipfile.ZipFile(output, 'w') as dst:
            for info in src.infolist():
                name, payload = info.filename, src.read(info.filename)
                if name.endswith('content.opf'):
                    text = payload.decode()
                    if variant == 'ncx-only': text = text.replace('properties="nav"', '')
                    if variant == 'no-spine': text = text.replace('<itemref idref="c1"/>', '')
                    if variant == 'comments': text = text.replace('</metadata>', '<!-- comment --><meta name="custom">keep</meta><x:extra xmlns:x="urn:extra" x:attr="a">extra</x:extra></metadata>')
                    if variant == 'no-metadata':
                        import re
                        text = re.sub(r'<metadata.*?</metadata>', '', text, flags=re.S)
                    payload = text.encode()
                if name.endswith('nav.xhtml') and variant == 'ncx-only': payload = b'<html><head/><body/></html>'
                if name.endswith('ch1.xhtml'):
                    text = payload.decode()
                    if variant == 'self-head': text = '<html><head/><body><p>正文</p></body></html>'
                    if variant == 'css-pi': text = '<?xml-stylesheet href="old.css"?>' + text.replace('</head>', '<link rel=stylesheet href="old.css"><link href="../Styles/bindery-overlay.css" rel="stylesheet" /></head>')
                    payload = text.encode()
                if variant == 'paths' and name.startswith('OEBPS/'):
                    name = '/OEBPS/Text/../' + name[len('OEBPS/'):]
                    name = name.replace('/', '\\')
                dst.writestr(name, payload, compress_type=zipfile.ZIP_STORED)
        external.append(output)
    # User data is copied to DEST before any operation. Prefer two small existing books.
    library = ROOT / 'library'
    candidates = sorted(library.rglob('*.epub'), key=lambda p: p.stat().st_size) if library.exists() else []
    copied = 0
    for source in candidates[:2]:
        target = dest / f'input-library-{copied}.epub'
        shutil.copyfile(source, target)
        external.append(target)
        copied += 1

    patch_meta = Metadata(book_id='updated-id', title='新标题 & <测试>', author='新作者', language='en', description='新简介\n第二行', identifier='urn:custom:123', series='系列', publisher='出版社', tags=['新标签', '', '另一标签'], published='2025-01-02', isbn='9781234567890', rating=0)
    patches = []
    for source in external:
        record = dict(input=source.name, inspection=inspect(source), variants=[])
        for variant, options in [
            ('metadata', {}), ('css', {'css_text': '  p { color: #456; }\n'}),
            ('clear-overlay', {'css_text': ''}), ('strip-css', {'css_text': '', 'strip_original_css': True}),
            ('replace-css', {'css_text': 'p{margin:0}', 'strip_original_css': True}),
            ('cover', {'cover_path': fixtures / 'cover 中文.png'}),
            ('combined', {'cover_path': fixtures / 'cover 中文.png', 'css_text': 'p{color:#789}', 'strip_original_css': True, 'strip_webp_assets': True}),
            ('repeat-css', {'css_text': 'p{color:#abc}'}),
        ]:
            output = dest / f'{source.stem}-{variant}.epub'; shutil.copyfile(source, output)
            epub.update_epub_metadata(output, patch_meta, **options)
            if variant == 'repeat-css': epub.update_epub_metadata(output, patch_meta, **options)
            record['variants'].append(dict(kind=variant, file=output.name, options={k: v.name if isinstance(v, Path) else v for k, v in options.items()}, inspection=inspect(output)))
        for kind in ['strip-webp', 'normalize']:
            output = dest / f'{source.stem}-{kind}.epub'; shutil.copyfile(source, output)
            changed = epub.strip_webp_assets_and_refs(output) if kind == 'strip-webp' else epub._normalize_epub_archive_paths(output)
            record['variants'].append(dict(kind=kind, file=output.name, changed=changed, inspection=inspect(output)))
        patches.append(record)
    epubs = {}
    for path in sorted(dest.glob('*.epub')):
        members = []
        with zipfile.ZipFile(path) as archive:
            for info in archive.infolist():
                payload = archive.read(info)
                if info.filename.lower().endswith('.opf'):
                    payload = re.sub(rb'''(\bproperty=["']dcterms:modified["'][^>]*>)[^<]*(</)''', rb'\1__MODIFIED__\2', payload)
                members.append(dict(name=info.filename, sha256=hashlib.sha256(payload).hexdigest()))
        epubs[path.name] = members
    (dest / 'reference.json').write_text(json.dumps(dict(cases=records, rules={r[0]: r[2] for r in rules}, themes=themes, patch_meta=metadata_to_dict(patch_meta), patches=patches, library_copies=copied, epubs=epubs), ensure_ascii=False))
    print(json.dumps(dict(fixtures=len(manifest), parsed_cases=len(records), builds=sum(len(r['builds']) for r in records), patch_inputs=len(patches), patches=sum(len(p['variants']) for p in patches), library_copies=copied)))

if __name__ == '__main__': main()
