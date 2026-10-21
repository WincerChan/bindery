# Bindery

本地 TXT / EPUB 书库服务：分章转换 TXT、写回 EPUB 元数据与样式、在线抓取书目、阅读预览、愿望单与 Kindle（KFX）传输。实现为 TanStack Start + Solid 的 PWA，服务端运行在 Node 24，数据库使用 Node 内置的 `node:sqlite`。

## 功能概览

- TXT 上传、编码识别、卷/章解析，生成 EPUB；支持批量重新生成。
- EPUB 直接入库与导出；同一书库、同一 SQLite 表结构（`books`、`jobs`、`sessions`、`passkeys`、`webauthn_challenges`、`app_settings`、`reader_progress`、`wishlist`）。
- 书籍详情、元数据编辑、封面（上传 / URL / 从 EPUB 提取）、归档、删除、恢复。
- 规则与主题模板编辑、预览；元数据从豆瓣/Amazon 抓取。
- 阅读器章节预览、站内搜索、阅读进度。
- 愿望单/追踪、重复检测、CSV 导出。
- 浏览器端把 EPUB 转成 KFX，并通过 File System Access API 写入 USB 大容量存储模式的 Kindle。
- 可安装 PWA（应用外壳与 KFX 所需 WASM 缓存；离线不提供书库读写）。

## 开发

要求 Node 24 与 corepack：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev        # Vite 开发服务器，按终端输出访问
pnpm typecheck
pnpm build
pnpm test
pnpm start      # 运行 dist 生产构建，默认 0.0.0.0:3000
```

`pnpm start` 默认读取工作目录的 `.env`（真实环境变量优先）。生产容器使用 `PORT=5670`（见下方 Containerfile）。

主要源码目录：

- `src/core/`：解析、规则、主题、EPUB、ZIP 等纯 TS 核心。
- `src/server/`：数据库、存储、认证、任务队列、元数据抓取。
- `src/routes/`、`src/features/`：TanStack 文件路由与 Solid UI。
- `src/client/`：浏览器端 boko WASM、Kindle 设备、PWA。
- `bindery-templates/`：默认规则/主题种子，运行时复制到用户模板目录。

## 环境变量

所有列出的变量都支持 `NAME_FILE` 形式（从文件读取，去掉末尾换行），例如 `BINDERY_PASSWORD_HASH_FILE`。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BINDERY_LIBRARY_DIR` | 仓库/应用根目录下的 `library` | 书库目录。每本书为 `<book_id>/book.epub`、`book.json`、`cover.*`、`source.*`，归档书在 `archive/`。相对路径按进程工作目录解析。 |
| `BINDERY_DB_PATH` | `<BINDERY_LIBRARY_DIR>/bindery.db` | SQLite 数据库。未显式设置且书库目录下数据库不存在时，会把旧版本放在应用根目录的 `bindery.db` 迁移过去。 |
| `BINDERY_TEMPLATE_DIR` | 应用根目录下的 `.bindery-user-templates` | 用户规则/主题目录的父目录，实际使用其下 `rules/` 与 `themes/`。首次启动会从 `bindery-templates/` 复制 `default.json`。 |
| `BINDERY_RULES_DIR` | `<BINDERY_TEMPLATE_DIR>/rules` | 单独覆盖规则目录。 |
| `BINDERY_THEMES_DIR` | `<BINDERY_TEMPLATE_DIR>/themes` | 单独覆盖主题目录。 |
| `BINDERY_PASSWORD_HASH` | 无 | 登录密码的 argon2 PHC 哈希。未设置时不能登录但也无法初始化书库。 |
| `BINDERY_PUBLIC_ORIGIN` | 无 | 反代后的公开来源，例如 `https://books.example.com`。必须是无路径、无末尾斜杠的 https 来源；本机开发可用 `http://localhost:端口`。 |
| `BINDERY_WEBAUTHN_RP_ID` | 公开来源的主机名 | 可选。必须是公开来源主机名本身或它的可注册域名后缀。 |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | 生产进程监听地址。容器中设为 `5670` / `0.0.0.0`。 |
| `BINDERY_SHUTDOWN_TIMEOUT_MS` | `5000` | `SIGTERM`/`SIGINT` 后等待已有请求和当前任务完成的期限。 |
| `BINDERY_INGEST_QUEUE_MAXSIZE` | `64` | 入库队列上限（1–2048）。 |
| `BINDERY_STAGE_DIR` | 系统临时目录下的 `bindery-ingest-stage` | 上传预览暂存目录。 |
| `BINDERY_MEMORY_TRIM` | 开启 | 任务结束后请求 V8 回收；设为 `0`/`false` 可关闭。 |

生成密码哈希（在仓库根目录执行）：

```bash
node --input-type=module -e "import('@node-rs/argon2').then(async ({ hash }) => console.log(await hash('your-password')))"
```

## 认证与反向代理

- 登录密码使用 argon2；已存的 `BINDERY_PASSWORD_HASH` 无需重建。
- 通行密钥（passkey）兼容旧版 `passkeys` 表，凭据、计数器与 transports 不变。
- WebAuthn 需要安全上下文：HTTPS，或开发时的 `http://localhost:端口`（不能是 `127.0.0.1`）。
- 反向代理后必须设置 `BINDERY_PUBLIC_ORIGIN`（以及需要时的 `BINDERY_WEBAUTHN_RP_ID`）。新版直接使用该配置计算 origin/RP ID 和 Cookie 的 `Secure` 属性，不再依赖 uvicorn 的 `--proxy-headers`，也不需要转发 `X-Forwarded-*` 头。
- 例如 Nginx/Caddy 只需把 `https://books.example.com` 反代到 `http://127.0.0.1:5670`，并在容器环境里设置公开来源。

## 浏览器要求

- 日常书库与阅读：现代浏览器即可。
- 通行密钥：支持 WebAuthn 的浏览器；需要 HTTPS 或 `http://localhost`。
- PWA 安装：支持 Service Worker 的现代浏览器。
- Kindle 设备管理：需要桌面版 Chrome 或 Edge（File System Access API，`showDirectoryPicker`）。Windows 是主要验证平台；浏览器把 Kindle 的 USB 大容量存储设备当作目录读写。不支持该 API 的浏览器会明确提示，仍可以下载 EPUB/KFX。

## 容器构建与运行

`Containerfile` 使用 `node:24-slim` 多阶段构建：依赖阶段按 `package.json` 的 `packageManager` 用 corepack 启用 pnpm，构建阶段执行 `pnpm build`，运行阶段只带生产依赖、`dist/`、运行脚本和 `bindery-templates/`。

```bash
podman build -f Containerfile -t bindery:latest .
# Docker: docker build -f Containerfile -t bindery:latest .

podman run -d --name bindery \
  -p 5670:5670 \
  -v /path/to/bindery-data:/data:Z,U \
  --env-file .env \
  bindery:latest
```

注意 `podman --env-file` 不会去掉值两侧的引号；如果 `.env` 写成 `BINDERY_PASSWORD_HASH='$argon2...'`，请去掉引号，或改用 `-e BINDERY_PASSWORD_HASH="$BINDERY_PASSWORD_HASH"` 传值（`pnpm start` 读取 `.env` 时会自行处理引号）。

数据卷布局与旧镜像一致：

```text
/data
├── library/           # BINDERY_LIBRARY_DIR，含 bindery.db 与书
└── templates/
    ├── rules/
    └── themes/        # BINDERY_TEMPLATE_DIR
```

镜像固定行为：

- 非 root 用户 `app`，uid/gid `10001`；
- `VOLUME /data`；
- `BINDERY_LIBRARY_DIR=/data/library`、`BINDERY_TEMPLATE_DIR=/data/templates`；
- 监听 `0.0.0.0:5670`，`EXPOSE 5670`；
- 未设置 `BINDERY_DB_PATH` 时数据库为 `/data/library/bindery.db`；
- HEALTHCHECK 请求 `/login`（Docker 等支持的运行时会执行；Podman 默认的 OCI 镜像格式会忽略该元数据）。

权限：容器以 uid 10001 运行，数据目录必须对它可读写。rootless Podman 使用 `:Z,U` 会把挂载目录的所有权映射给容器用户；Docker 或已有目录可提前 `chown -R 10001:10001 /path/to/bindery-data`。不要用 root 运行容器。

停止：

```bash
podman stop --time 10 bindery
```

容器应把停止宽限时间设为大于 `BINDERY_SHUTDOWN_TIMEOUT_MS`（默认 5 秒）。正常关闭会停止接受新请求/任务，等待已有响应与当前任务完成，退出码 0；未领取任务保留到下次启动。

## Quadlet 部署

示例文件：

- `deploy/quadlet/bindery-library.volume`
- `deploy/quadlet/bindery.container`

把 `deploy/quadlet/bindery.container` 中的 `Image=ghcr.io/replace-me/bindery:latest` 换成实际镜像，并准备 `/etc/bindery/bindery.env`（至少包含 `BINDERY_PASSWORD_HASH=...`；反代时再加 `BINDERY_PUBLIC_ORIGIN=...`）。把两个文件放到 `~/.config/containers/systemd/`（或系统目录）后执行：

```bash
systemctl --user daemon-reload
systemctl --user start bindery
```

## 从 Python 版切换

- 数据无需迁移：新实现直接使用旧书库目录、`book.json` 与同一 SQLite 文件/表结构；旧版本写在应用根目录的 `bindery.db` 会在首次以默认路径打开时移动或复制到书库目录。
- 认证无需迁移：已有 `BINDERY_PASSWORD_HASH` 与已注册 passkey 继续可用。
- 路由保持：`/`、`/book/{id}`、`/book/{id}/download`、`/ingest`、`/rules`、`/wishlist`、`/tracker`、`/kindle` 等主要 URL 不变。
- 旧 Python 实现、`pyproject.toml`/`uv.lock`、Jinja 模板和 Python 测试已在阶段 5 删除；约束与冻结的对照数据见 `tests-ts/fixtures/parity/README.md` 和 `docs/phase-5-cutover-report.md`。
