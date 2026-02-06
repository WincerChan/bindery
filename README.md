# Bindery

TXT -> EPUB 的本地书库服务，支持分章、写入元数据、预览与编辑，也支持直接导入 EPUB 入库。

## 快速开始

```bash
uv venv
uv sync
uv run honcho start
```

默认书库目录：`./library`，可用 `BINDERY_LIBRARY_DIR` 自定义。
SQLite 默认路径：`./library/bindery.db`，可用 `BINDERY_DB_PATH` 自定义。
规则/主题默认目录（运行时可写）：`./.bindery-user-templates/{rules,themes}`，
种子模板目录（Git 跟踪）：`./bindery-templates/{rules,themes}`，
可用 `BINDERY_TEMPLATE_DIR` 统一设置父目录，
也可分别用 `BINDERY_RULES_DIR` / `BINDERY_THEMES_DIR` 覆盖。

支持直接上传 EPUB 入库（不会重新转换），阅读器使用 EPUB 内容进行模拟展示。

## 开发环境（Tailwind + Honcho）

- 需已安装 `tailwindcss` standalone CLI（确保命令在 PATH 中）
- `Procfile` 同时启动后端与 Tailwind watch
- Tailwind 入口文件是 `static/tailwind.css`（Tailwind v4：`@import "tailwindcss";` + `@source` 扫描模板）

如果你发现页面“完全没样式”，优先检查：

- 浏览器 DevTools Network 里 `/static/app.css` 是否 200
- `static/app.css` 是否被 Tailwind 重新生成（文件修改时间变化）
- `static/app.css` 里是否包含你用到的类（例如搜索 `.bg-white` / `.px-4`）

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

## 容器部署

- `Containerfile`：生产镜像定义，默认监听 `5670`，并将数据目录设为 `/data/library`，模板目录设为 `/data/templates`。
- GHCR 推送：`.github/workflows/publish-ghcr.yml` 会在 `main/master` 或 `v*` tag push 时自动构建并推送镜像到 `ghcr.io/<owner>/<repo>`。
- Quadlet 示例：
  - `deploy/quadlet/bindery-library.volume`
  - `deploy/quadlet/bindery.container`

`deploy/quadlet/bindery.container` 里需要替换：

- `Image=ghcr.io/replace-me/bindery:latest`
- `EnvironmentFile=/etc/bindery/bindery.env`（文件内至少包含 `BINDERY_PASSWORD_HASH=...`）
