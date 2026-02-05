# Bindery

TXT -> EPUB 的本地书库服务，支持分章、写入元数据、预览与编辑，也支持直接导入 EPUB 入库。

## 快速开始

```bash
uv venv
uv sync
uv run honcho start
```

默认书库目录：`./library`，可用 `BINDERY_LIBRARY_DIR` 自定义。
SQLite 默认路径：`./bindery.db`，可用 `BINDERY_DB_PATH` 自定义。

支持直接上传 EPUB 入库（不会重新转换），阅读器使用 EPUB 内容进行模拟展示。

## 开发环境（Tailwind + Honcho）

- 需已安装 `tailwindcss` standalone CLI（确保命令在 PATH 中）
- `Procfile` 同时启动后端与 Tailwind watch

## 认证配置

设置单用户登录凭据：

- `BINDERY_PASSWORD_HASH`：argon2 哈希密码（encoded 字符串）

示例（生成哈希）：

```bash
uv run python - <<'PY'
from argon2 import PasswordHasher
print(PasswordHasher().hash("your-password"))
PY
```
