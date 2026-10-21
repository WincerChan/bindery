# 阶段 5：切换交付报告

工作目录 `/workspaces/bindery-p5-ds`，分支 `p5/ds`。本阶段删除了 Python 实现，将容器改为 `node:24-slim` 多阶段构建，冻结了全部 Python 对照输出，更新了工作流与 README。

## 改动摘要

### 1. 先冻结对照数据，再删除 Python

删除 Python 前，用提交 `e38de41d9d80ba1c32fe22236053bad3f49d8c14` 的 Python 实现真实运行了全部对照脚本，把测试需要的规范化结构写入 `tests-ts/fixtures/parity/`。测试改为读取这些固定数据，不再启动 `uv`/Python。

- `tests-ts/parity.test.ts`：核心解析、EPUB 构建、修补、规则/主题。挡住 214 个输出 EPUB 二进制，只保存 ZIP 成员名、顺序与规范化后的 SHA-256；`core/reference.json.gz` 32 KB（未压缩 1.34 MB）。11 个 Python 生成的外部输入 EPUB（约 28 KB）保留。
- `ingest-parity`、`library-parity`、`catalog-parity`、`reader-parity`、`integration-shared`、`foundation-server`、`books-http`、`books-metadata`：保存 Python 输出 JSON；动态 book id、时间戳、临时路径、封面 mtime、`dcterms:modified` 只在比较前规范化，业务字段不比 Python 输出更宽松。
- `data.test.ts`：保存 9 份 Python 数据层快照/运行结果（约 152 KB，最大为 74 KB 的 CRUD 快照）。ALTERNATING 用例仍用冻结的 Python 读回结果验证 TS 写入，再写回同样的元数据并比对 Python 快照。
- `auth.test.ts`：保存 Python `py_webauthn` 验证过的 9 个 COSE 算法的 passkey 行、私钥、注册密钥、Argon2 哈希、Python 生成的 session/challenge。测试用 Node `crypto` 复现 Python 参考脚本的 WebAuthn 消息；`auth/reference.json` 约 24 KB。
- `reader-frame.test.ts`：`templates/preview.html` 被删除前，把其中的 `<script>` 与背景按钮提取为 `reader/preview-template.html`（约 63 KB），测试仍在 VM 中执行这段参考 JS。

固定数据目录：`tests-ts/fixtures/parity/`，实际文件内容合计 **374,874 字节（约 366 KiB；`du` 528K）**。来源提交、生成日期（2026-10-21）、Python 环境、逐项生成命令、规范化规则与体积都写在 `tests-ts/fixtures/parity/README.md`。

没有把真实书库内容提交进仓库。核心 parity 中原来从 `library/` 动态发现的两本书对应的 patch 用例没有进入固定数据（`input-library-*` 被移除，`library_copies=0`）；`data.test.ts` 的本地真实数据库备份用例改为不依赖 Python 的原地迁移/幂等检查。

### 2. 删除 Python 实现

删除：

- `bindery/`、`templates/`、`static/`、`tests/`（全部 Python 测试）；
- `pyproject.toml`、`uv.lock`、`uv.toml`、`epubify.py`、`Procfile`、`tailwind.config.js`；
- `scripts/parity/`（包括 `reference.py`、`auth-reference.py`、`data-reference.py`、`foundation-reference.py`、`create-fixtures.py`、`audit-encoding.py/.ts`）；
- `tests-ts/fixtures/{books,catalog,ingest,integration,library,reader}/reference.py`；
- 临时生成夹具用的 `tests-ts/fixtures/parity/generate.test.ts`。

保留 `bindery-templates/`（运行时种子模板）。`.gitignore`、`.dockerignore` 去掉 Python/uv 条目，改为只保留 Node、数据、密钥与构建产物规则。

将仅表示“与旧实现字符串/JSON 语义兼容”的 TS 模块 `src/core/python.ts` 重命名为 `src/core/text.ts`，`pythonJson/pythonString/pythonRepr` 重命名为 `compatJson/compatString/compatRepr`。这是纯重命名，行为不变，避免把兼容辅助误认为还在运行 Python。

### 3. Containerfile

`node:24-slim` 四阶段：

1. `dependencies`：corepack 启用 `pnpm@11.10.0`，只复制 `package.json`/`pnpm-lock.yaml` 后 `pnpm install --frozen-lockfile`，利用层缓存。
2. `build`：复制源码并 `pnpm build`。
3. `production-dependencies`：同样的 lockfile 执行 `pnpm install --frozen-lockfile --prod`。
4. `runtime`：只复制生产依赖、`dist/`、`bindery-templates/`、`package.json` 和三个运行脚本（`start.mjs`、`load-env.mjs`、`production-handler.mjs`），不包含源码、测试、devDependencies 或构建工具。

保持旧镜像硬性兼容：

- uid/gid `10001`，用户名 `app`；
- `VOLUME /data`；
- `BINDERY_LIBRARY_DIR=/data/library`、`BINDERY_TEMPLATE_DIR=/data/templates`；
- `0.0.0.0:5670`、`EXPOSE 5670`、`PORT=5670`；
- 未设置 `BINDERY_DB_PATH` 时数据库为 `/data/library/bindery.db`。

增加 `HEALTHCHECK`（Node `fetch` 请求 `/login`，无新依赖）。Podman 默认 OCI 格式会忽略 HEALTHCHECK 元数据；Docker 等运行时会使用。

构建结果：`bindery:p5-ds`，**265 MB**（`podman inspect` 的 `Size` 为 264,510,822 字节；运行阶段生产 `node_modules` 18 MB，`dist` 5.3 MB）。`deploy/quadlet/` 的端口、环境变量和卷布局没有变化，因此未修改。

### 4. GitHub 工作流

`publish-ghcr.yml` 新增 `validate` job：Node 24、corepack、`pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm build`、`pnpm test`。`publish` 使用 `needs: validate`，保留原有 GHCR 标签、Buildx、登录和构建推送逻辑。工作流中已无 Python/uv。

### 5. README

按 Node 实现重写：功能、开发命令、环境变量含义与默认值（以代码为准）、容器构建/运行、数据卷与 uid 10001 权限、quadlet、反向代理与 `BINDERY_PUBLIC_ORIGIN`、浏览器/Kindle 要求、从 Python 版切换的数据/认证兼容说明。

## 验证命令与真实结果

### 本地门禁

```text
$ pnpm typecheck
tsc --noEmit
（通过，无输出）

$ pnpm build
✓ built in 643ms
（仅有既有的 INEFFECTIVE_DYNAMIC_IMPORT 提示）

$ pnpm test
Test Files  68 passed (68)
Tests       1247 passed (1247)
```

### 去掉 Python/uv/venv 后运行测试

构造了只包含 Node、pnpm 和 `/usr/bin` 中非 Python 可执行文件的 PATH：

```bash
rm -rf /tmp/p5-no-python-bin && mkdir -p /tmp/p5-no-python-bin
for f in /usr/bin/*; do b=$(basename "$f"); case "$b" in python*|pypy*|pip*|pydoc*) ;; *) ln -s "$f" "/tmp/p5-no-python-bin/$b" ;; esac; done
NODE_BIN=/home/wincer/.local/share/fnm/node-versions/v24.14.0/installation/bin
PNPM_BIN=/home/wincer/.local/share/pnpm/bin
env -i HOME="$HOME" PATH="$NODE_BIN:$PNPM_BIN:/tmp/p5-no-python-bin" bash -c '
  echo "python3=$(command -v python3 || echo none) uv=$(command -v uv || echo none)"
  pnpm test
'
```

真实输出：

```text
python3=none uv=none
Test Files  68 passed (68)
Tests       1247 passed (1247)
```

### 残留 Python 字样检查

```text
$ git grep -n -i "python\|uv run\|\.venv\|pyproject" -- . ':!docs/*'
```

逐条分类：

- `README.md`：仅“从 Python 版切换”历史说明。
- `tests-ts/data.test.ts`：一处测试数据标题字面量 `"Python"`，用于验证书名字段的读写，不执行 Python。
- `tests-ts/fixtures/parity/README.md`、`tests-ts/fixtures/parity/auth/reference.json`、`data/run-alternating.json`、`data/snapshot-alternating.json`、`reader/preview-template.html`：冻结的历史参考数据与生成说明（含 Python 生成的 passkey 名称和测试书名）。
- `docs/`：历史阶段报告与迁移计划，按任务要求保留，不改写。
- 没有 `scripts/parity/*.py`、`reference.py`、`pyproject.toml`、`uv.lock`、`.venv` 或任何测试运行路径。

### 容器构建与运行

```text
$ podman build -f Containerfile -t bindery:p5-ds .
Successfully tagged localhost/bindery:p5-ds
（成功；HEALTHCHECK 在 OCI 格式下被 Podman 忽略的警告不影响构建）

$ podman images bindery:p5-ds
localhost/bindery:p5-ds 265 MB
```

启动命令（`.env` 中哈希带引号，Podman `--env-file` 不会去引号，因此用 source 后 `-e` 传入同一值）：

```bash
set -a; . ./.env; set +a
podman run --rm -d --name bindery-p5-ds \
  -p 5682:5670 \
  -v /tmp/claude-1000/-workspaces-bindery/c1f19ccf-0acd-46fb-84f1-07b0fe108229/scratchpad/p5-data-ds:/data:Z,U \
  -e BINDERY_PASSWORD_HASH="$BINDERY_PASSWORD_HASH" \
  bindery:p5-ds
```

数据卷包含 `library/`（7 本现有书、`bindery.db`）与 `templates/{rules,themes}`。真实响应：

```text
GET /login: 200
POST /login (password=admin): 303, Location: /
GET /: 200
GET /tracker: 200
GET /rules: 200
GET /kindle: 200
GET /book/0c24b86a83704131b6f24e800ead9b93: 200
  包含：下载 EPUB、阅读状态、封面
GET /book/.../cover: 200 image/png
GET /book/.../download: 200 application/epub+zip
书库列出：我降临于诸天世界、幻想世界大穿越、最终进化、魔临、那年那蝉那把剑、无尽武装、诸界末日在线（7/7）
/tracker 含“追踪”，/rules 含“规则”“主题”，/kindle 含“Kindle”“排版”
```

验证后已停止并删除容器；`podman ps -a` 中无残留容器。

## 未完成或无法验证

- GitHub Actions 没有在本环境实际执行（无仓库 runner）；工作流只做了静态编写和依赖关系检查。
- 没有在真实 Kindle / Windows Chrome/Edge 上重复实机验收；本阶段只验证服务端数据与容器页面。
- Podman 默认 OCI 格式忽略 HEALTHCHECK 元数据；未额外用 Docker 构建验证 HEALTHCHECK。
- `data.test.ts` 的“真实书库数据库备份”用例：原用例依赖本地 `library/bindery.db` 和 Python 快照；由于不能提交真实书库内容，改为 TS 原地迁移后行数不丢失、二次 `init` 快照稳定。它不再与 Python 快照逐字节比较。
- 核心 parity 中从真实书库动态发现的两本书对应 patch 用例未纳入固定数据；外部 EPUB、合成书与所有模板/主题变体仍完整对照。
- `auth.test.ts` 中“Python 验证 TS 注册公钥”这一步改为用 `@simplewebauthn/server` 的独立 verify 调用验证冻结私钥签出的断言；冻结的 COSE/公钥与 passkey 行本身来自 Python `py_webauthn`。
- 未验证真实反向代理（Nginx/Caddy）后的 passkey；代码层面确认 WebAuthn origin/RP 与 Cookie `Secure` 来自 `BINDERY_PUBLIC_ORIGIN`，不依赖 `--proxy-headers` 或 `X-Forwarded-*`。

## 自行决定

1. **把 `@tanstack/solid-router`、`@tanstack/solid-start` 从 `dependencies` 移到 `devDependencies`。** 构建产物 `dist/` 的外部 import 列表中没有这两个包；它们只参与 Vite 构建/类型检查。移动后生产 `node_modules` 从 135 MB 降到 18 MB，镜像从 377 MB 降到 265 MB。`pnpm-lock.yaml` 已同步更新，`pnpm typecheck`/`build`/`test` 均通过。
2. **核心 parity 的 ZIP 输出只固定成员摘要与成员内容哈希。** 未提交 214 个输出 EPUB；断言仍覆盖成员顺序、`mimetype` 存储方式、OPF 规范化和每个成员 SHA-256，不弱化字节等价判断。
3. **`auth` 使用冻结私钥在 Node 中重放签名。** 这样动态 challenge 仍由 TS 生成，同时保留对 Python 生成的 COSE 公钥、计数器、transports 和 9 种算法签名的验证。
4. **保留 `src/core/text.ts` 等兼容辅助的“legacy”命名。** 它们实现旧实现的字符串/JSON 语义，但不包含 Python 运行时或 Python 代码。
5. **`.env` 引号注意事项写进 README。** 没有改应用的环境变量解析来容忍 Podman `--env-file` 的字面引号，以免改变现有 `_FILE`/环境变量语义。
