# Phase 0 / Phase 1 交付记录

本次工作位于 `feat/ts-rewrite`，未提交、推送或切换分支。Python 源码及其测试、依赖文件均未修改；`library/` 只读，EPUB 修补仅对临时副本进行；未读取或修改 `.codex`。

## 运行与验证

```bash
pnpm build
pnpm typecheck
pnpm test
node scripts/check-ssr.mjs
uv run --no-sync python scripts/parity/audit-encoding.py /tmp/bindery-encoding-reference.json
node scripts/parity/audit-encoding.ts /tmp/bindery-encoding-reference.json
```

结果：生产构建和严格类型检查通过；5 个 Vitest 测试文件、311 个测试通过，无跳过。生产 handler 的直接 Request/Response 检查通过，包括首页 SSR、缺失数据库、只读 SQLite、实际客户端 RPC 地址、JS/CSS 静态资源与隐藏文件拒绝访问；全过程未监听端口。另一次只读请求连接了现有数据库，SSR 显示 7 本书。

GB18030 穷举检查覆盖 1,611,796 个序列（全部单字节、全部合法形状的双字节、全部四字节组合，含无效映射），与 Python codec 零差异。

`pnpm test` 每次通过异步子进程调用真实 Python 参考实现，创建独立临时目录，结束后删除。`uv run --no-sync` 使用已有虚拟环境；普通 `uv run --offline` 会尝试重建项目，但缓存中缺少 `setuptools>=61.0`。未安装任何包。沙箱禁止 `spawnSync`，测试改用异步 `execFile`。独立编码审计的 JSON 放在 `/tmp`，可删除。

## SSR 与生产入口

- Start 的默认入口负责服务端渲染和客户端水合；`getRouter()` 每次创建独立路由器，根路由输出 HTML document、HeadContent、Loading 和 Scripts。
- 首页 loader 调用 `createServerFn`，数据库模块只在服务端加载；返回的数量由 SSR 写入 HTML，客户端导航也通过真实 RPC 获取。
- `node:sqlite` 使用 `{ readOnly: true }`，查询 `SELECT count(*) FROM books`，不建表、不迁移、不创建数据库或目录。缺失数据库返回 0 和提示；损坏或不兼容的数据库会报告错误。
- `BINDERY_DB_PATH` 优先；未设置时使用 `BINDERY_LIBRARY_DIR/bindery.db`；再未设置时使用项目根目录下的 `library/bindery.db`。显式相对路径以 cwd 解析。支持 Python 的 `*_FILE` 读取规则。未执行 Python 的旧数据库自动迁移，因为本阶段要求只读。
- Vite 输出 `dist/client/` 与 `dist/server/server.js`。后者导出 `fetch`，不会自行监听；`pnpm start` 运行 `scripts/start.mjs`，由 srvx 提供 Node HTTP 服务并先处理构建静态资源。默认 `HOST=0.0.0.0`、`PORT=3000`。
- 服务端 chunk 保持在 `dist/server/` 同一层，令源文件与构建后路径保持相同深度，保证默认目录独立于 cwd。

## 对照范围与结果

26 个 TXT 夹具，覆盖所有仓库规则（当前 1 个）与全部主题（当前 1 个）；每个输入均比较解码、字符串解析、文件解析、分块文件解析、事件流、Book 序列化与恢复、空内容判断。

104 次 EPUB 构建，覆盖普通/流式构建、无封面/有封面、空 CSS/主题加自定义 CSS、最小/完整元数据；简介的普通构建从 `section_0000` 编号，流式构建从 `section_0001` 编号，均保留原行为。

13 个 EPUB 修补输入包括 Python 原有测试的 4 个外部 EPUB、7 个扩展变体和 2 个现有书库 EPUB 的临时副本。130 次修补覆盖仅元数据、添加/清空/替换 CSS、替换封面、WebP 清理、组合操作、重复覆盖 CSS、路径规范化。扩展变体覆盖反斜线与父路径、NCX 回退、缺失 spine 引用、注释及额外命名空间、自闭合 head、XML stylesheet PI、缺失 metadata。

每个 EPUB 比较所有成员的顺序、名称与完整字节，并交叉检查 Python `zipfile` 独立计算的成员 SHA-256；同时检查 `mimetype` 为第一个成员、值正确、ZIP 方法为 stored。唯一成员内容归一化是 `dcterms:modified`；未做 XML 规范化、空白清理、BOM 清理、命名空间改写或 HTML 容错归一化。ZIP 时间与压缩方式不参与比较。书籍 ID 固定，未屏蔽任何 UUID。元数据、封面、目录、spine 文档和预览资源也分别对照。

以上语料全部零差异。ElementTree 的前缀选择、空元素格式、属性顺序、元素 tail 删除行为由 TS 序列化器实际实现，未通过测试归一化隐藏。

## 已处理的问题与限制

1. **Solid / TanStack RC 接口冲突。** `@tanstack/solid-start@2.0.0-rc.8` 的 `server-functions-handler` 导入 `parseServerFunctionUrl`，但 `@solidjs/web@2.0.0-rc.15` 仅导出 `parseServerFunctionActionUrl`；旧 `serverFunctionUrl(id)` 在新版也已成为接收 GET 引用的数据 URL API。未经适配时，生产入口直接 import 就报缺失导出。`scripts/solid-start-compat.ts` 仅在该上游模块内将两个调用改为 action URL API，同时适用于开发和生产，不修改 node_modules。首页 SSR 和实际 `/_serverFn/data/{id}` 调用已验证。升级这些 RC 版本时需复核或移除此适配。
2. **GB18030 版本差异。** WHATWG/ICU 接受 Python 拒绝的单字节 `80`；20 个双字节 PUA 映射以及四字节 `8135f437` 不同。`src/core/gb18030.ts` 按原始字节修正，保留 TextDecoder 为基础，已通过完整序列空间审计。
3. **现有行为保留。** `.j2` 后缀使 Python Jinja 的 `select_autoescape` 实际不转义；六个 TS 模板保留原始插值。Python 预览的 script/base 正则有双重转义，未在本阶段改变其行为；这些函数不可作为 HTML 安全清洗器。后续阅读器实现需要单独设计隔离和清洗。
4. **自定义正则的兼容边界。** 仓库规则全部通过；提供行首 `(?i/m/s)`、Unicode 字符类及 Python 命名捕获的适配，但不宣称支持整个 Python `re` 语言。已确认例子：Python 3.12 接受 `(?>a+)` 原子组，Node 24 的 `RegExp(..., 'u')` 报 `Invalid group`，规则验证因此显式拒绝。JSON/正则语法错误的底层诊断文字也来自各自运行时。此项是已知自定义规则差异，未从对照中归一化，未增加正则引擎依赖。
5. **资源与容错边界。** 核心 API 使用 Uint8Array，普通与流式构建接受 Book 或章节迭代器；返回完整 EPUB 时仍需在内存中保留结果和渲染内容。服务端 TXT 读取采用 64 KiB 分块及跨块解码。ZIP 使用 fflate，同步解压整个归档；不支持 ZIP64/非 UTF-8 历史文件名。畸形 XML 的 xmldom 与 Python lxml 的恢复策略未承诺完全相同；本次两个真实书籍副本和全部有效/测试变体均一致。
6. **未进行真实端口和浏览器检查。** 沙箱禁止 sockets。已执行浏览器目标打包并在无 Node 导入的打包产物上验证解析、构建、读取与修补；实际浏览器水合、开发 HMR 和 HTTP 监听由编排方验证。Node 24 的 SQLite experimental 提示属于运行时提示。

## 编排方在沙箱外执行

在仓库根目录：

```bash
pnpm dev --host 127.0.0.1 --port 5173
# 另一个终端
curl -fsS http://127.0.0.1:5173/
```

生产验证（先结束开发服务，或使用另一端口）：

```bash
pnpm build
HOST=127.0.0.1 PORT=3000 pnpm start
# 另一个终端
curl -fsS http://127.0.0.1:3000/
```

检查返回 HTML 中 `data-testid="book-count"` 的数量；在浏览器打开首页，确认数量、CSS、JS 加载及水合正常。可使用 `BINDERY_DB_PATH=/不存在的路径.db` 验证缺失数据库提示，也可指向数据库副本。没有新增依赖需求。

## 文件清单

| 文件 | 用途 |
|---|---|
| `package.json`（修改） | 增加 dev/build/start/test/typecheck 脚本；依赖及锁文件不变 |
| `vite.config.ts` | Start、Solid 2、Tailwind 4 和 RC 兼容插件配置 |
| `tsconfig.json` | strict TypeScript、Solid 2 JSX 类型和浏览器/Node 类型配置 |
| `vitest.config.ts` | 仅发现 TS 测试，独立于应用 Vite 插件运行 |
| `src/router.tsx` | 每次请求的路由器工厂及类型注册 |
| `src/routeTree.gen.ts` | Start 自动生成的类型化文件路由树 |
| `src/routes/__root.tsx` | SSR HTML 外壳和水合脚本 |
| `src/routes/index.tsx` | 通过 server function 查询并 SSR 展示书籍数量 |
| `src/styles.css` | Tailwind 4 入口和基础页面样式 |
| `src/core/index.ts` | 浏览器及 Node 共用核心导出 |
| `src/core/models.ts` | Book/Volume/Chapter/Metadata/Job/Wish 类型与序列化 |
| `src/core/python.ts` | Python 空白、splitlines 和常用正则语义适配 |
| `src/core/gb18030.ts` | Python GB18030 映射与有效序列兼容 |
| `src/core/parsing.ts` | TXT 元数据、分卷分章、Book 与事件流解析 |
| `src/core/rules.ts` | 规则模板验证、归一化和配置加载的纯逻辑 |
| `src/core/themes.ts` | 默认主题、主题数据和 CSS 合并纯逻辑 |
| `src/core/archive.ts` | fflate ZIP 读写、成员顺序和 POSIX 路径处理 |
| `src/core/xml.ts` | xmldom 遍历及匹配 ElementTree 的输出序列化 |
| `src/core/epub-html.ts` | 章节标题拆分、CSS/WebP/预览 HTML 处理 |
| `src/core/epub-templates.ts` | 六个 Jinja EPUB 模板的静态 TS 渲染等价实现 |
| `src/core/epub.ts` | EPUB 构建、章节流构建、元数据/封面/目录/资源读取 |
| `src/core/epub-patch.ts` | 保留文档的元数据、封面、CSS 与 WebP 修补 |
| `src/server/paths.ts` | 源码与构建产物一致的项目根目录定位 |
| `src/server/env.ts` | 环境变量与 `*_FILE` 的 Python 兼容读取 |
| `src/server/database.ts` | 默认数据库路径及只读书籍计数 |
| `src/server/parsing.ts` | 分块文件解码、文件解析与章节事件迭代 |
| `src/server/templates.ts` | 运行时规则/主题文件发现与默认模板初始化 |
| `scripts/start.mjs` | srvx Node 生产服务启动入口 |
| `scripts/production-handler.mjs` | 构建资源及 Start fetch handler 的可独立测试组合 |
| `scripts/check-ssr.mjs` | 使用临时 SQLite 的无 socket 生产集成验证 |
| `scripts/solid-start-compat.ts` | 限定于 rc.8 上游模块的 URL API 适配 |
| `scripts/parity/create-fixtures.py` | 用标准库重建全部合成 TXT 与有效 PNG 封面 |
| `scripts/parity/reference.py` | 用真实 Python 函数生成隔离的 EPUB/JSON 参考结果 |
| `scripts/parity/audit-encoding.py` | 穷举 Python GB18030 序列并输出参考区间 |
| `scripts/parity/audit-encoding.ts` | 将全部序列与 TS GB18030 实现对照 |
| `tests-ts/parity.test.ts` | Book、构建、修补、读取和独立成员摘要对照 |
| `tests-ts/core.test.ts` | 原有 Python 断言的 Vitest 移植及规则验证 |
| `tests-ts/server.test.ts` | 路径、只读 SQLite、环境文件和模板加载验证 |
| `tests-ts/production.test.ts` | 构建存在时验证真实生产 handler；验收顺序先 build |
| `tests-ts/browser-core.test.ts` | 完整核心浏览器打包及打包产物功能验证 |
| `tests-ts/fixtures/manifest.json` | 合成 TXT 文件名、场景和编码清单 |
| `tests-ts/fixtures/cover 中文.png` | 带中文文件名的有效 1×1 PNG 封面 |
| `docs/migration-phase-0-1-report.md` | 本交付记录、文件用途、结果与限制 |

TXT 夹具的每个文件用途：

| `tests-ts/fixtures/` 下文件 | 用途 |
|---|---|
| `utf8.txt` | UTF-8 元数据、简介及两章 |
| `bom.txt` | UTF-8 BOM |
| `gbk.txt` | GBK 中文及全角空白 |
| `gb18030.txt` | GB18030 四字节字符 |
| `crlf.txt` | CRLF 与英文章节 |
| `cr-only.txt` | 独立 CR 的字符串/文件解析区别 |
| `volumes.txt` | 卷前正文与多卷多章 |
| `chapters.txt` | 无卷章节 |
| `no-headings.txt` | 无标题行的正文及候选元数据 |
| `labels.txt` | 分行书名/作者及简介标签 |
| `label-quirks.txt` | 多空格作者标签的参考行为 |
| `bracket-title.txt` | 《书名》与作者候选 |
| `blanks.txt` | 简介及正文空行边界 |
| `long-lines.txt` | 长行及跨 64 KiB 的 UTF-8 解码 |
| `heading-guards.txt` | 标点、逗号和孤立标题启发式 |
| `english.txt` | 英文章节忽略大小写和 Unicode 数字 |
| `whitespace.txt` | 仅空白内容 |
| `unicode-space.txt` | Python Unicode 空白和内嵌换行字符 |
| `empty.txt` | 空文件及空书默认章节 |
| `empty-volumes.txt` | 空卷和空章节 |
| `candidate-skip.txt` | 广告候选过滤及特殊标题 |
| `raw-template-values.txt` | 原始模板插值与内嵌标记 |
| `invalid.txt` | 多种无效字节及 UTF-8 replacement 回退 |
| `gb18030-compat.txt` | 全部已识别 GB18030 修订映射差异 |
| `invalid-euro.txt` | Python 拒绝、WHATWG 接受的单字节 0x80 |
| `stream-boundaries.txt` | 四字节、双字节和 CRLF 在分块边界拆开 |

## 最终工作区核对

`git diff --check` 通过；分支仍为 `feat/ts-rewrite`。最终 `git status --short` 为：

```text
 M package.json
?? .codex
?? docs/migration-phase-0-1-report.md
?? scripts/
?? spikes/
?? src/
?? tests-ts/
?? tsconfig.json
?? vite.config.ts
?? vitest.config.ts
```

`spikes/kindle-access/index.html` 在任务执行期间新出现（17:21:51），不属于本次操作创建的文件，归属未确认，已原样保留。因此无法确认“仅本次预期文件加 `.codex`”；除这一外部新增项外，清单与本次交付一致。Python 参考实现、`pnpm-lock.yaml`、`uv.lock` 和其他已跟踪文件均无修改。

建议 commit message（未执行 commit）：

```text
:sparkles: feat(migration): Add Solid scaffold and Python parity core
```
