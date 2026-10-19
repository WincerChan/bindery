# Bindery 迁移计划：TanStack Start + Solid 2.0 RC PWA

## 目标

- 用 TanStack Start（Solid）+ Solid 2.0 RC 重写 bindery，替换现有 Python（FastAPI + Jinja + HTMX）实现。
- EPUB 仍是书库唯一源；TXT → EPUB 的行为与现有实现保持一致。
- KFX 只在浏览器生成：boko 0.5.0 的 WASM 在 Web Worker 中运行，服务端不做 KFX、不带 boko。
- 浏览器通过 File System Access API 直接管理 USB 大容量存储模式的 Kindle（KPW3、KO3），Windows + Chrome/Edge 为主。
- 可安装的 PWA。

## 硬性约束

- **数据兼容**：沿用现有书库目录（`BINDERY_LIBRARY_DIR`，`<book_id>/book.epub|book.json|cover.*|source.*`、`archive/`）和 SQLite 数据库（`BINDERY_DB_PATH`，默认 `library/bindery.db`）。表结构不变：`books`、`jobs`、`sessions`、`passkeys`、`webauthn_challenges`、`app_settings`、`reader_progress`、`wishlist`。新旧实现可以指向同一份数据，切换无需迁移。
- **认证兼容**：现有 `BINDERY_PASSWORD_HASH`（argon2）和已注册的 passkey 继续可用；环境变量名不变（`BINDERY_PUBLIC_ORIGIN`、`BINDERY_WEBAUTHN_RP_ID` 等）。
- **行为对照**：Python 实现在切换前保留，作为 TXT 解析、EPUB 生成的参照；对照测试证明新旧输出一致后才删除。
- **路由兼容**：主要 URL 保持不变（`/`、`/book/{id}`、`/book/{id}/download`、`/ingest`、`/rules`、`/wishlist` 等），书签和习惯不受影响。

## 技术选型

| 项目 | 选择 | 说明 |
|---|---|---|
| 运行时 | Node 24 | 内置 `node:sqlite`，避免原生扩展编译 |
| 包管理 | pnpm | 本机已安装 |
| 框架 | `@tanstack/solid-start@2.0.0-rc.*`、`@tanstack/solid-router@2.0.0-rc.*` | Solid 2 适配版本 |
| UI | `solid-js@2.0.0-rc.*`、`@solidjs/web@2.0.0-rc.*`、`vite-plugin-solid@3.0.0-next.*` | Solid 2 RC |
| 构建 | Vite 8 | |
| 样式 | Tailwind CSS 4（`@tailwindcss/vite`） | 迁移现有 editorial 设计，去掉独立 tailwind CLI |
| 数据库 | `node:sqlite` | 同一数据库文件 |
| 密码 | `@node-rs/argon2` | 校验现有 argon2 PHC 哈希 |
| Passkey | `@simplewebauthn/server` + `@simplewebauthn/browser` | 兼容已存储的凭据 |
| ZIP | `fflate` | EPUB 读写 |
| XML | `@xmldom/xmldom`（或同等） | OPF/NCX/XHTML 处理 |
| 测试 | Vitest | 单元、对照、服务端函数测试 |
| KFX | boko 0.5.0 WASM（wasm-bindgen 0.2.108） | 预编译产物入库，附构建脚本、许可证、源码链接与校验和 |

依赖安装需要联网，由编排方执行；实现方如需新增依赖，先说明用途再安装。

## 目录结构（迁移期间）

- 新实现放在仓库根：`package.json`、`vite.config.ts`、`tsconfig.json`、`src/`。
- `src/core/`：与框架无关的纯 TS 核心（TXT 解析、规则、主题、EPUB 构建与修补），可在 Node 和浏览器运行。
- `src/server/`：数据库、存储、认证、任务队列、元数据抓取。
- `src/routes/`：TanStack 文件路由。
- `src/client/`：浏览器端能力（boko Worker、Kindle 设备、PWA）。
- `vendor/boko/`：WASM 产物、JS glue、LICENSE、`SOURCE.md`（版本、构建命令、sha256）。
- Python 代码（`bindery/`、`templates/`、`static/`、`tests/`、`pyproject.toml` 等）保留到阶段 5 删除。

## 阶段

每个阶段单独交付、单独验证，通过后再进入下一阶段。

### 阶段 0：脚手架

- 初始化 TanStack Start + Solid 2.0 RC 项目，配置 Vite、TypeScript（strict）、Tailwind 4、Vitest。
- 最小页面能 SSR 渲染；`node:sqlite` 以只读方式打开现有数据库并列出书目数量，以此验证技术栈可行。
- 脚本：`dev`、`build`、`start`、`test`、`typecheck`。
- **验收**：`pnpm build`、`pnpm typecheck`、`pnpm test` 通过；生产构建启动后首页可访问（编排方验证）。

### 阶段 1：核心移植与对照测试

- 移植 `bindery/parsing.py`（编码识别：utf-8-sig → utf-8 → gb18030，失败时 utf-8 替换字符；标题、卷、章节识别）、`rules.py`、`themes.py`、`epub.py`（`build_epub`、流式构建、元数据更新、webp 清理、路径规范化、CSS 处理）到 `src/core/`。
- 对照工具：同一批 TXT 与规则模板分别交给 Python 和 TS 生成 EPUB，规范化后（忽略时间戳、随机 UUID、ZIP 元数据）逐文件比较；EPUB 修补函数用同样方式对照。
- 夹具覆盖：GBK/UTF-8/BOM、卷与章节、无标题、简介/作者标签、长文本、空内容、各规则模板、主题 CSS。
- **验收**：对照测试全部一致；不一致的地方必须逐条解释并得到确认。

### 阶段 2：数据层与认证

- 数据库访问层（与现有表结构一致）、书库存储读写、`book.json` 兼容。
- 登录（密码 + passkey）、会话、重新认证、安全设置页（passkey 增删改名）。
- **验收**：用现有数据库和哈希登录成功；用 Python 端注册的 passkey 能登录；单元测试覆盖。

### 阶段 3：书库功能

按以下顺序移植页面与服务端函数，每组完成后做行为对照：

1. 书库首页、筛选、排序、分页、归档页。
2. 书籍详情、元数据编辑、封面（上传、URL、从 EPUB 提取）、已读状态、删除、归档与恢复。
3. EPUB 下载与批量下载（ZIP）。
4. 入库：TXT/EPUB 上传、预览流、去重、后台任务队列（`jobs` 表）、重试与清理、批量重新生成。
5. 规则与主题编辑器、规则测试。
6. 元数据在线抓取（`metadata_lookup.py`）。
7. 阅读器：章节渲染、站内搜索、阅读进度。
8. 心愿单与追踪、重复检测、导出。

- **验收**：Vitest 覆盖服务端逻辑；编排方用真实书库做端到端检查。

### 阶段 4：浏览器 KFX、Kindle 管理与 PWA

- **KFX**：在 Web Worker 中加载 boko WASM，EPUB → KFX；Service Worker 缓存 WASM；只用这一种转换方式，保证容器 ID 稳定。
- **Kindle 设备**：用 `showDirectoryPicker` 选择 Kindle 根目录，并校验它确实是 Kindle（存在 `documents/`、`system/`）；目录句柄存 IndexedDB，下次自动请求授权；列出设备上的书，与书库对照；把 KFX 写入 `documents/`；删除设备上的书。
- **封面缩略图**：写入 `system/thumbnails/`，命名规则需在 KPW3/KO3 实机上确认。
- **PWA**：manifest、图标、Service Worker（应用外壳 + WASM 缓存）、可安装。
- 不支持 File System Access API 的浏览器给出明确提示，仍然可以下载 KFX。
- **验收**：Chrome 自动化测试覆盖 Worker 转换（使用模拟目录句柄）；KPW3/KO3 实机传书由用户验证。

### 阶段 5：切换

- 删除 Python 实现与相关配置；Containerfile 改为 `node:24-slim` 多阶段构建；更新 GitHub 工作流与 README。
- **验收**：容器构建通过；用现有数据卷启动后功能正常。

## 不在本次范围内

- MTP 设备、无线推送、越狱相关功能。
- 服务端 KFX 生成。
- 离线阅读与离线编辑书库（PWA 只缓存应用外壳和 WASM）。

## 风险

- Solid 2.0 与 TanStack Solid 适配均为 RC，可能遇到框架缺陷；锁定精确版本，问题记录在案。
- EPUB 生成行为细节多，靠对照测试兜底。
- `showDirectoryPicker` 能否直接选择 Kindle 根目录，需要实机确认。
- boko 输出的容器 ID 与平台位数相关，因此只用 WASM 一种方式转换。
- Codex 沙箱不能联网，也不能监听端口：依赖安装、开发服务器与浏览器测试由编排方执行。
