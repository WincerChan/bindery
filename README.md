# Bindery

TXT -> EPUB 的本地书库服务，支持分章、写入元数据、预览与编辑。

## 快速开始

```bash
uv venv
uv sync
uv run uvicorn bindery.web:app --reload
```

默认书库目录：`./library`，可用 `BINDERY_LIBRARY_DIR` 自定义。
