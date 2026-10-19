# Phase 3 · Slice D：阅读器交付记录

在 `/workspaces/bindery-wt-d`、`feat/p3-reader` 实现。修改范围遵守 `phase-3-conventions.md`；`src/routeTree.gen.ts` 由构建生成。没有提交、推送、切换分支或新增依赖。共享实现和 Python 参考源码保持只读，测试仅写临时书库、数据库和模板目录。已有 `.venv` 链接保留。

## 完成范围与文件

| 文件 | 用途 |
| --- | --- |
| `src/routes/_app.book.$book_id_.preview.tsx` | `GET /book/{id}/preview`，校验书籍/EPUB/章节后 303 到章节零，携带 `resume=1` 和安全的 `return_to` |
| `src/routes/_app.book.$book_id_.preview_.$section.tsx` | 阅读页、认证 server function、查询参数、404 页面、HTTP 路径参数 422 校验和禁止缓存响应 |
| `src/routes/book.$book_id.epub.$.ts` | 已认证的 EPUB splat GET/HEAD |
| `src/routes/book.$book_id.search.ts` | 已认证的全文检索 GET |
| `src/routes/book.$book_id.progress.ts` | 已认证的阅读进度 POST |
| `src/server/reader/service.ts` | 章节数据、共享 CSS 懒同步、进度读取/写入、Python `int()` 截断和范围语义 |
| `src/server/reader/search.ts` | 每请求扫描一次 spine、文本提取、Unicode 索引和片段、结果分页与查询范围限制 |
| `src/server/reader/entities.ts`、`xmldom-entities.d.ts` | 复用已安装 xmldom 0.9.12 的 HTML5 实体表，实现 Python `html.unescape` 的兼容语义；声明仅限该内部模块 |
| `src/server/reader/parameters.ts` | Pydantic 整数参数兼容，包括整数小数表示、数字分隔符及超大非负 offset |
| `src/server/reader/resources.ts` | 成员路径校验、资源类型、HTML 过滤、独立文档封装及 CSP |
| `src/features/reader/reader.tsx`、`reader.css` | 平面阅读界面、目录、原生设置/检索对话框、书籍封面、响应式控件及章节链接 |
| `src/features/reader/frame.ts` | 三帧相邻章节预载、分页、最后一页补齐、键盘/手机边缘点击、字体/图片/尺寸变化后的锚点恢复、DOM 搜索高亮和本地脚注跳转 |
| `src/features/reader/model.ts` | 可序列化类型、恢复位置、安全返回链接、分页计算、设置归一化和文本匹配 |
| `src/features/reader/progress.ts` | 400ms 合并、串行进度提交、失败提示/后续重试、keepalive 和 pagehide/visibilitychange beacon |
| `tests-ts/reader-server.test.ts` | 52 项路由业务、数据、资源隔离、缓存和检索断言 |
| `tests-ts/reader-parity.test.ts` | 4 项真实 Python 对照，包含多个输入和交替数据库写入 |
| `tests-ts/reader-ui.test.ts` | 16 项 Solid 2 SSR、原生控件、恢复位置、分页、设置、高亮和进度传输断言 |
| `tests-ts/reader-production.test.ts` | 1 项真实生产 handler 集成检查，不开启监听 sockets |
| `tests-ts/fixtures/reader/{support.ts,ui.tsx,reference.py,production.mjs}` | 临时书库、SSR 探针、异步 Python 对照和生产 handler 驱动 |
| `src/routeTree.gen.ts` | 新路由的自动生成注册和类型 |

## 行为与兼容性

- 阅读入口维持 303、`resume=1`、`return_to` 的内部路径/查询处理及去除 fragment。章节、目录、搜索结果和返回详情链接保留阅读入口。`next` 仍由共享登录认证边界处理；本切片沿用其行为。
- 章节页调用共享 `ensureBookEpubCss`，不另实现 EPUB 重建。上下章、跨章节上一页到末页、前进/后退历史、明确的章节访问与恢复访问分别处理。仅 `resume=1` 使用数据库保存位置；页码在实际排版后按当前页数收敛。
- 保留 `reader_progress` 原表和 upsert 行为，不检查 section 是否在现有书内，也不要求 page 小于 page_count。section 为 `[-1, 999999]`，page/page_count 为 `[0, 999999]`；支持布尔、数值截断、Unicode 十进制字符串、下划线分隔及默认值。无效 JSON/非对象返回 `400 Invalid JSON payload`。写入使用共享 UTC 时间格式。
- 检索空查询只返回 `query/hits/indexed_sections`。非空查询返回 `offset/limit/next_offset/has_more`；每章仅取首个命中，offset 按命中章节计数，达到 limit 后仍扫描余下章节以统计 indexed_sections。默认 limit=10，范围 1–100；q 原始长度上限 200 个 Unicode 字符；offset 非负。超出 JS 安全整数的 offset 在 JSON wire 中仍保留准确十进制整数。
- 检索保持 Python 的 script/style/tag 去除、HTML5/无分号实体解码、数值实体修正、Unicode 空白及码点 offset，片段为命中前 30、后 70 字符。每次从文件重新扫描，没有常驻全文缓存。
- 预览和入口响应使用 Python 的 `no-store, max-age=0`、CDN no-store、Pragma、Expires。资源复用 `edgeRevalidateHeaders`，保持 private/no-cache/must-revalidate 和两种 CDN no-store。CSS/其他 text 资源补 UTF-8 charset；HEAD 保留长度和响应头、无正文。
- 缺书统一 `404 书籍不存在`、缺 EPUB 为 `404 EPUB 不存在`，遵循基础合约的中文规范；缺成员、缺章节仍保留 `Item not found` / `Section not found`，空 EPUB 章节为 `No sections`。
- Solid 使用安装版本中的 `createEffect(compute, effect)`、`onSettled`、`onCleanup`，TanStack loader data/search 是 accessor。保留可编译识别的 `createServerFn().middleware([authenticated]).inputValidator(...)`。构建仅有上游 inputValidator 弃用提示；现有 RC compat shim 未改变。

## 内容隔离与有意差异

EPUB 以独立的同源 iframe 文档打开，iframe 仅设置 `sandbox="allow-same-origin"`，没有 `allow-scripts`、表单、弹窗、下载或顶层导航许可。父页面通过同源 DOM 控制排版、翻页和高亮；书籍标记不会注入应用正文，也不使用 srcdoc 或书籍脚本桥接。

所有 EPUB 资源响应同时提供 CSP：`sandbox allow-same-origin`、`default-src 'none'`、`script-src 'none'`、禁止 form/object/frame/connect，并限制 CSS、图片、字体到当前书的资源前缀（图片/字体另允许 data）。`frame-ancestors 'self'`、nosniff 和 no-referrer 同时生效。直接打开 HTML/SVG 资源仍受脚本禁用的响应 CSP 约束。允许同源 DOM 访问不等于允许书籍代码执行，父页面也不会开放脚本执行权限。

HTML 过滤去除 script、事件属性、meta refresh、base、嵌入子文档、表单和媒体交互；仅保留排版/SVG 元素和明确列出的属性，本地链接重新解析到本书。保留 html/body 的排版类、语言和安全内联样式；同文档脚注解析到实际章节 URL。过滤用于减少自动导航和改善呈现，**安全边界是浏览器 sandbox + CSP，不是 xmldom 容错或正则清洗**。

与 Python 的有意差异：

1. Python 原 script/base 正则不是安全清洗器。本切片禁用书籍脚本、外部资源和交互式嵌入；这些内容不会按原样执行。自包含文本、CSS、图片、字体和脚注保留。此安全隔离要求优先于原始 HTML 字节一致。
2. 资源路径由路由解码一次后，与 ZIP 中央目录的成员名精确匹配；拒绝空路径/段、`.`、`..`、绝对路径、反斜线、NUL/控制字符和不存在的成员，不做 basename 或目录别名回退。允许成员名中的 `: | * ~ ? < > " # %`、空格和中文，不再按这些字符或 4096 字符限制拒绝。字面 `%2e%2e` 等名称只有确实存在时才能访问，路由端不会再次解码。生成的章节、资源、CSS 引用和脚注 URL 逐路径段百分号编码；书内相对引用经成员列表解析后重新生成 URL，避免冒号、问号和井号被当作 scheme/query/fragment。
3. 参数 422 仍保留状态码；detail 使用共享 API 合约的 `请求参数无效`，而非 FastAPI 的 Pydantic 错误数组。JavaScript 无法恢复的无效旧 section（包括 -1）恢复到所请求章节；数据库仍照常保存 -1，避免旧记录导致空白阅读页。
4. 采用现有平面 UI kit、40px 控件、6px 圆角、原生 dialog 和链接，替换旧 Alpine/HTMX 的呈现与源码字符串断言。阅读设置增加中文字体候选；颜色和字形按新界面调整，保留已有 `bindery:reader` 设置键及兼容字段。

## 验证结果

最终按顺序执行：

```bash
pnpm build
pnpm typecheck
pnpm test
git diff --check
```

结果：构建、strict 类型检查通过；**14 个 Vitest 文件、476 项测试通过，无失败、无跳过**。本切片贡献 **4 个测试文件、73 项测试**。本工作树没有真实 library，原有依赖真实 EPUB 副本的对照用例按既有发现规则不收集。

另对所有新增文件执行 `git diff --no-index --check /dev/null <file>`，并将新增/修改路径逐项与 D 切片所有权核对；均通过。生成路由树仅增加本切片五条路由。最终检查包括报告在内共 26 个文件。

Python 对照以异步 execFile 执行 `uv run --no-sync python tests-ts/fixtures/reader/reference.py ...`，没有 spawnSync。覆盖完整搜索返回值、HTML5/无分号/无效数值实体、Unicode/emoji 偏移、progress 响应和准确 DB 行、Python→TS→Python 写入、EPUB SHA-256 不变、恢复位置及入口 header/location/context。

生产集成调用构建后的 fetch handler，覆盖匿名拦截、303 入口、SSR 恢复、中文/空格 splat、脚本/表单/refresh 去除、缓存/CSP、参数 400/422 和缺书/缺章节/缺资源 404。SSR 流式响应显式消费完正文；成功标记写入临时 JSON 并由父测试读取，避免当前环境 Node 子进程成功输出为空造成误判。此检查并非浏览器执行验证。

实现中确认并修复的尝试：通用 HTML 解析器的实体解码不等价于 Python `html.unescape`；改为复用 xmldom 实体表并补齐 Python 规则。TanStack 把字符串 `"1"` 序列化成带引号的查询值，并对缺省字段产生额外 307；改为保持解析后的数值类型且省略未出现字段。直接从 loader 抛 HttpError 会使章节缺失显示 500；路由将业务 404 转为框架 notFound，并在 HTTP handler 阶段预校验无效整数字段，生产 404/422 均已验证。

## 请求集成方修改的共享 API

### 1. 阅读器全屏布局

建议提供 `route.staticData.readerLayout: true` 与 `AppShell` 的对应处理：隐藏站点 header/tab-bar，唯一 main 切换全宽、无外层 padding、占满动态视口的布局，保留 skip-link、toast 和焦点可达性。D 章节路由再标记该 staticData；原入口重定向不需要页面布局。

原因：Python `preview.html` 依赖 `hide_nav=True` 和 `main_class=h-screen w-screen p-0`。当前共享 AppShell 固定渲染站点导航及 wrap；D 已在可用正文区域完成响应式阅读器，但仍显示站点导航，尚未达到原阅读器的全屏布局。没有通过页面 CSS 修改共享父元素。

所需共享测试：阅读页 SSR 不显示主导航/手机 tab-bar；普通页面继续显示；390px 和桌面视口无横向溢出、阅读区占满可用视口；skip-link、toast、键盘和退出阅读链接可用。

### 2. 打开书籍时 tracker 一致性同步

建议在共享 `book-view.ts` 或 storage 公共层提供：

```ts
ensureTrackerConsistencyForMeta(meta: Metadata, library: LibraryStorage): Wish
```

严格移植 Python `_ensure_tracker_for_book` + `_apply_tracker_state_to_metadata_cache` / `_ensure_tracker_consistency_for_meta`：连接匹配的手工 tracker、必要时创建 tracker、同步书名/作者，并将 tracker 的 read/rating 写回元数据缓存（read 变化时写 read_updated_at）。返回 tracker 供 `bookView(meta, library, tracker)` 复用。

D 应在 `loadReader` 的 requireBook 后、CSS 懒同步前调用此 API。当前代码复用既有 `bookView` 读取 tracker 覆盖状态，但**未重建 Python 打开预览时这些 DB 副作用**；已有共享 API 只有全库 seed，无法表达上述单书行为。该问题也影响 B/E，交由集成方统一实现。

所需共享测试：已有 linked tracker 的 read/rating 覆盖与缓存更新、read_updated_at、匹配的手工条目连接、新条目创建、标题/作者变更同步、重复调用幂等，以及预览与详情入口的一致性。D 可在 API 落地后增加完整 DB 副作用对照。

## 未验证项与沙箱外验收

共享请求落地前，全屏布局和打开阅读器的 tracker 副作用仍是已知差距。沙箱禁止 sockets，未启动 HTTP 服务器，也没有实际浏览器水合/布局/iframe 权限验证。真实书籍超长章节、图片/字体加载后的分页、手机点击/选字、浏览器历史与原生 dialog 焦点需由编排方检查。阅读器现已使用按需解压和有界索引缓存（见下方修复记录）；其他需要完整 EPUB 的共享核心调用仍使用原实现。

编排方先准备测试书库、数据库、模板的**临时副本**，在合并五个切片并重建路由树后执行：

```bash
pnpm build
pnpm typecheck
pnpm test
git diff --check

BINDERY_LIBRARY_DIR=/tmp/bindery-reader-check/library \
BINDERY_DB_PATH=/tmp/bindery-reader-check/db.sqlite \
BINDERY_TEMPLATE_DIR=/tmp/bindery-reader-check/templates \
HOST=127.0.0.1 PORT=3000 pnpm start
```

开发模式检查用相同 BINDERY 环境变量执行 `pnpm dev --host 127.0.0.1 --port 5173`。浏览器登录后访问 `/book/<测试书ID>/preview?return_to=%2Fjobs%3Ftab%3Dsuccess`；确认入口 303 后恢复保存章节/页，直接 `/preview/0` 不恢复。检查前后翻页、跨章末页、目录、滚动到当前目录、设置持久化和锚点、全文检索/加载更多/高亮、返回详情及历史前进后退；把视口设为 390px 后重复。

以下 HTTP 命令中，`READER_BOOK_ID` 和 `READER_COOKIE` 由测试书籍和登录会话提供：

```bash
curl -i -H "Cookie: $READER_COOKIE" "http://127.0.0.1:3000/book/$READER_BOOK_ID/preview?return_to=%2Fjobs"
curl -i -H "Cookie: $READER_COOKIE" "http://127.0.0.1:3000/book/$READER_BOOK_ID/search?q=正文&limit=1&offset=0"
curl -i -H "Cookie: $READER_COOKIE" -H 'Content-Type: application/json' \
  --data '{"section":0,"page":3,"page_count":8}' \
  "http://127.0.0.1:3000/book/$READER_BOOK_ID/progress"
```

从目录取得实际 item_path 后检查 `/epub/<item_path>` 的 Content-Type、CSP 和 edge revalidation 头。另用临时 EPUB 加入 script、onerror、meta refresh、表单、iframe 和外部 CSS/图片引用，确认在阅读页与直接打开资源时均不能执行代码/导航到应用，也不能改变父页面；浏览器控制台可看到 sandbox/CSP 拦截。沙箱内测试已验证生成策略和过滤输出，尚未验证浏览器实际执行策略。

建议 commit message（未执行 commit）：

```text
:sparkles: feat(reader): Add isolated EPUB reader and progress tracking
```


## 2026-10-20 · 真实 EPUB 路径、性能及开发模式修复

工作树 `/workspaces/bindery-wt-r`，分支 `feat/reader-fixes`。未提交、推送、切换分支、安装依赖或使用网络、socket、浏览器；未访问另一工作树的书库，也未修改 Kindle 文件或 Python 参考。

### 原因与实现

- 旧 `validateItemPath` 把合法 ZIP 名称中的冒号、百分号、井号、问号当作危险路径；`EpubArchive.locate` 又存在目录/basename 别名回退。阅读器现从 ZIP 中央目录建立精确成员集合，验证结构后必须命中集合。路径字符规则见上方第 2 条。
- 新增 `src/core/epub-path.ts`，统一段编码和基于成员集合的相对引用解析。支持已编码及生产者使用的原始名称、嵌套目录、fragment、字面百分号；只解码一次。章节 URL、HTML 的 href/src、内联 style、CSS 的 `url()` / 字符串 `@import` 都生成本书内完整编码的 URL；CSS 注释和无关字符串保持原样。搜索结果仍走数字章节路由，查询内容使用 URLSearchParams 编码。
- 新增 `src/server/reader/archive.ts`：读取尾部 EOCD 和中央目录，记录名称、局部头偏移、压缩大小、原始大小、方法和 flags；每次读取只打开文件并读取目标成员的数据，对 deflate slice 调用 `inflateSync`。支持 stored/deflate、data descriptor、ZIP64、UTF-8/CP437 和通过原名称 CRC 校验的 Unicode path extra field；拒绝加密、未知压缩方法和损坏边界。
- 按文件路径、大小、纳秒级 mtime 缓存索引和解析后的 OPF manifest、spine、TOC/章节标题及 media type 映射。LRU 上限为 16 本 / 32 MiB 的索引、解析数据和 CSS 检查结果估算大小，不常驻整本归档或解压章节；解析后增长也会触发淘汰。EPUB 替换、大小/mtime 变化或删除会失效。
- `service.ts` 和 `search.ts` 复用归档缓存；检索仍按次读取 spine 正文，没有常驻全文缓存。`epub-css.ts` 的阅读器路径使用索引检查实际 CSS 成员，只有需要修改时才读取整本并保留既有原子写回流程。供排版/导出使用的 `readBookEpub` 和共享完整归档 API 保持原有语义。
- Reader 的恢复位置和初始检索词是 ReaderFrames 会话的初始化快照，使用显式 `untrack`；动态展示仍通过 JSX，设置和目录副作用仍使用 effect compute，effect 回调不返回 setter 结果。开发运行时审计还修复了 LibraryPage、BookDetail、BookEditor、IngestPage、Editor、TrackerForm 中的同类本地状态初始化读取，书库既有查询同步 effect 保留。
- PWA 插件在开发模式为 `/manifest.json` 的 GET/HEAD 直接提供同一份 manifest JSON；生产构建的 manifest、service worker 和预缓存生成流程保持原样。

iframe 的 `sandbox="allow-same-origin"`、无脚本许可、响应 CSP、nosniff、no-referrer、认证及缓存响应策略完全保留，没有增加书籍脚本桥接。

### 合成 EPUB 性能测量

`tests-ts/fixtures/reader/obfuscated.ts` 在测试中生成内容，无版权书籍数据。大样本为 **21,947,303 字节（约 20.93 MiB）、2241 个成员、2227 个 spine 章节**，含嵌套混淆目录与相对 CSS/图片/字体；PNG 是程序生成的有效 1×1 图片。性能样本的章节 href 使用旧实现也能定位的原始 `: | * ~` 名称，使前后工作量可比；完整特殊字符组合由其他测试覆盖。

独立运行 `BINDERY_READER_PERF_REPORT=/tmp/bindery-reader-performance-r.json pnpm exec vitest run tests-ts/reader-realworld.test.ts`。同一进程/同一文件中，旧路径通过完整读文件 + `loadEpubItem` + 隔离 HTML 处理；新路径调用实际 `loadReader` / `epubResource`。资源各取 7 次的中位数，首章为冷缓存的一次采样，未包括生成 fixture 的时间。

| 服务端操作 | 旧实现 | 新实现 |
| --- | ---: | ---: |
| 单章资源响应，中位数 | 266.2 ms | 1.5 ms |
| CSS 检查 + spine/TOC + 首章响应 | 903.3 ms | 69.6 ms |

性能门禁使用实际计数而非机器相关时间阈值：冷启动仅读取 container、OPF、nav 和目标章节 **4 个成员**；热请求每次 **1 个成员**，压缩读取字节数等于该成员的压缩大小；索引和 package 各只构建/解析一次。测试还覆盖按条目/字节淘汰、LRU 命中顺序和 package 解析导致的缓存增长。

这些数字是无 socket 的服务端路径测量，不能等同于浏览器首章可见时间。用户真实 EPUB 的布局、字体、图片、iframe load 和 Start 开发水合仍需编排方 Chrome 复验。

### 验证与边界

新增 `reader-realworld.test.ts`、`reader-archive.test.ts` 和生成 fixture；生产 handler 测试覆盖混淆 spine 章节的 SSR iframe src、图片/CSS/字体、脚注、字面 `%2e%2e` / `%2F` / `#` / `?`、GET/HEAD、遍历/控制字符拒绝及既有隔离策略。缓存测试独立覆盖 mtime 改变和保持 mtime 的 size 改变。

`client-rendering.test.ts` 保留生产 SSR/hydration/CSR 测试，并额外构建真实开发 runtime，渲染 13 类视图（包括详情→编辑）捕获 `STRICT_READ_UNTRACKED`。反向临时撤销 Reader 的两处显式快照后，该测试准确报告 Reader 的 **3 条**警告并失败；恢复修复后通过。开发 manifest 通过直接调用 Vite middleware 的 GET/HEAD 测试验证，不启动 dev server。未在此沙箱执行真实 Chrome、水合启动或布局测试。

最终门禁按顺序执行：

```sh
pnpm build
pnpm typecheck
PYTHONDONTWRITEBYTECODE=1 UV_OFFLINE=1 pnpm test
git diff --check
```

构建、strict 类型检查、**53 个文件 / 1020 项测试**全部通过，无失败或跳过；新增文件另做末尾换行和尾随空白检查。构建保留既有 inputValidator 弃用和 ingest 混合 import 提示。`PYTHONDONTWRITEBYTECODE` / `UV_OFFLINE` 用于避免 Python 参考产生字节码写入及 uv 网络访问，不改变测试收集或断言。

早先两次默认并发全量运行分别出现既有 Kindle production 子进程的 Node 原生 `v8::ToLocalChecked Empty MaybeLocal` 崩溃，以及 catalog production 探针的一次 SQLite busy（503）。两项单独重跑通过；`pnpm test --maxWorkers=2` 全部通过，之后两次默认并发全量运行也全部通过。没有修改这些失败探针或 Kindle 实现。是否与并发压力有关仍是未确认假设，原生崩溃及 busy 的根因未进一步定位。
