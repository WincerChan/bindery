"""Offline Python oracle; exclusively uses the caller's temporary library."""
import asyncio
import dataclasses
import tempfile
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

mode, path = sys.argv[1:3]
root = Path(path)
os.environ['BINDERY_LIBRARY_DIR'] = str(root / 'library')
os.environ['BINDERY_DB_PATH'] = str(root / 'data.db')
os.environ['BINDERY_TEMPLATE_DIR'] = str(root / 'templates')
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from bindery import metadata_lookup as lookup
from bindery.css import validate_css

if mode == 'lookup':
    fixtures = json.loads(Path(__file__).with_name('lookup.json').read_text())
    results = [dataclasses.asdict((lookup.parse_douban_subject_html if row['source']=='douban' else lookup.parse_amazon_product_html)(row['html'])) for row in fixtures]
    print(json.dumps(results,ensure_ascii=False))
elif mode == 'css':
    cases = json.loads((root / 'input.json').read_text())
    print(json.dumps([validate_css(raw) for raw in cases],ensure_ascii=False))
elif mode == 'scores':
    cases = json.loads((root / 'input.json').read_text())
    print(json.dumps([{'title':lookup._title_match_score(c['title'],c['query']),'author':lookup._author_match_score(c['author'],c['expected'])} for c in cases]))
elif mode == 'flow':
    from bindery.models import Book, Chapter, Metadata
    from bindery.storage import save_book, save_metadata, load_metadata, epub_path, cover_path, archive_book_dir
    from bindery.epub import build_epub, extract_cover, extract_epub_metadata
    from bindery.db import init_db, list_jobs, get_wish_by_library_book_id
    from bindery.web import save_edit, set_read_status, upload_cover, archive_view, restore_view, delete_book
    from starlette.requests import Request
    from starlette.datastructures import UploadFile
    base = root / 'library'; base.mkdir(parents=True)
    init_db(); id = 'a'*32
    ch = Chapter(title='第一章',lines=['hello'])
    book=Book(title='示例书',author='作者',intro=None,root_chapters=[ch],spine=[ch])
    meta=Metadata(book_id=id,title='示例书',author='作者',language='zh-CN',description=None,source_type='epub',created_at='2026-02-06T00:00:00+00:00',updated_at='2026-02-06T00:00:00+00:00',epub_updated_at='2026-02-06T00:00:00+00:00')
    save_book(book,base,id);save_metadata(meta,base);build_epub(book,meta,epub_path(base,id))
    request=Request({'type':'http','method':'POST','headers':[]})
    out={}
    response=asyncio.run(set_read_status(request,id,read=' YES ',next='/?page=2#ignored'))
    meta=load_metadata(base,id)
    out['read']={'status':response.status_code,'location':response.headers['location'],'read':meta.read,'updated_at':meta.updated_at,'epub_updated_at':meta.epub_updated_at,'status_value':meta.status,'tracker_read':get_wish_by_library_book_id(id).read_status}
    with patch('bindery.web._ensure_ingest_worker_started'),patch('bindery.web._enqueue_ingest_task',return_value=True):
        response=asyncio.run(save_edit(request,id,title=' 新书 ',author=' 新作者 ',language='',description=' 简介 ',series=' 系列 ',identifier=None,publisher=' 社 ',tags='一, 二，二',published='2024-01-02',isbn='1234567890',rating='9',rule_template='ignored',theme_template='__book__',custom_css=' body {color:red;} ',strip_original_css='',cover_file=None,cover_url='',return_to='/?page=3'))
    meta=load_metadata(base,id);wish=get_wish_by_library_book_id(id)
    out['edit']={key:getattr(meta,key) for key in ['title','author','language','description','series','publisher','tags','published','isbn','rating','rule_template','theme_template','custom_css','status','read']}
    out['edit']['job_action']=list_jobs()[0].action;out['edit']['tracker_rating']=wish.rating;out['edit']['tracker_title']=wish.title;out['edit']['status_code']=response.status_code
    png=bytes.fromhex((root / 'png.hex').read_text())
    with tempfile.SpooledTemporaryFile(max_size=1024*1024) as upload:
        upload.write(png); upload.seek(0)
        response=asyncio.run(upload_cover(request,id,UploadFile(filename='cover.png',file=upload)))
    meta=load_metadata(base,id)
    out['cover']={'status':response.status_code,'location':response.headers['location'],'bytes':extract_cover(epub_path(base,id))[0].hex(),'filename':meta.cover_file,'synced':meta.status=='synced','same_time':meta.updated_at==meta.epub_updated_at}
    response=asyncio.run(archive_view(id,next='/?q=书&page=4'))
    out['archive']={'status':response.status_code,'location':response.headers['location'],'exists':archive_book_dir(base,id).exists(),'archived':load_metadata(base,id).archived}
    response=asyncio.run(restore_view(id))
    out['restore']={'status':response.status_code,'location':response.headers['location'],'exists':(base/id).exists(),'archived':load_metadata(base,id).archived}
    response=asyncio.run(delete_book(request,id,next='/archive'))
    out['delete']={'status':response.status_code,'location':response.headers['location'],'exists':(base/id).exists(),'tracker_exists':get_wish_by_library_book_id(id) is not None}
    (root / 'result.json').write_text(json.dumps(out,ensure_ascii=False))
    print(json.dumps(out,ensure_ascii=False))
