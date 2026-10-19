# Phase 3 C — 入库与任务

## 范围与文件

所有业务修改位于 Slice C 的归属范围。`src/routeTree.gen.ts` 由 `pnpm build` 自动生成。

| 文件 | 职责 |
| --- | --- |
| `src/routes/_app.ingest.tsx` | 入库 SSR、认证 server function、同 URL 的 POST |
| `src/routes/_app.jobs.tsx` | 任务 SSR、查询参数、5 秒轮询及卸载清理 |
| `src/routes/ingest.preview.ts` | POST 流式上传预览；默认 HTML，JSON 内容协商 |
| `src/routes/jobs.partial.ts` | GET 任务 partial；默认 HTML，JSON 内容协商 |
| `src/routes/jobs.$job_id.retry.ts`、`jobs.cleanup-invalid.ts` | 重试与清理 |
| `src/routes/book.$book_id.regenerate.ts`、`books.regenerate.ts` | 单本、按规则/主题批量生成 |
| `src/features/ingest/{page,preview,jobs}.tsx` | 原生表单、预览与任务列表，复用 UI kit |
| `src/features/ingest/{ingest.css,css-format.ts}` | 有前缀的平面响应式样式、CSS 格式化 |
| `src/server/ingest/multipart.ts` | 有界缓冲 multipart 扫描、文件落盘、文件支持的 Blob、请求清理 |
| `src/server/ingest/{staging,preview,identity}.ts` | 暂存、文件事件预览、文件名回退、去重、追踪同步 |
| `src/server/ingest/{actions,queries,render}.ts*` | 提交/动作、分页视图、兼容 HTML partial |
| `src/server/ingest/{lifecycle,executor,queue,processor}.ts` | 懒启动 worker thread、持久队列消费、恢复、TXT/EPUB/写回处理 |
| `tests-ts/ingest*.test.ts` | 5 个文件，39 项切片测试 |
| `tests-ts/fixtures/ingest/{reference.py,production.mjs,ui-probe.tsx}` | 离线 Python 对照、生产 handler 与 Solid 2 SSR 夹具 |

未增加依赖；没有修改共享 API、Python 参考、配置或其他切片文件。

## 行为与持久化

- 保留 `/ingest`、`/ingest/preview`、`/jobs`、`/jobs/partial`、两个任务动作和两个生成动作的 HTTP 方法。页面通过 `authenticated`，HTTP 动作通过 `authenticatedRoute`；所有业务调用传当前请求的 `library`。
- 上传 POST 后始终返回 `/ingest?toast=...&toast_kind=...`，单本/重试返回 `/jobs?tab=running`，生成动作忽略 `next`，与 Python 一致。HTMX 提交返回 200 和 `HX-Redirect`；Solid 调用显式消费该头。
- 原模板只展示单个 TXT 的书名/作者覆盖字段；保持该界面规则。HTTP API 接受 title、author、language、description、series、identifier、publisher、tags、published、isbn、rating、rule/theme、custom_css、cover_file、upload_tokens、dedupe_keep_tokens。只有 EPUB 的选择自动切到 `__book__`，混合/TXT 切回 default。
- multipart 文件先写入 `.ingest-queue/.requests/<随机ID>/`，解析完成后由文件支持的 Blob 提供读取。预览与直接提交都通过流复制文件，不调用 TXT/EPUB 的 `arrayBuffer()`。保留 Starlette 的每个普通字段 1 MiB、文件/字段各 1000 个限制。封面读取到内存，与参考相同。
- 预览暂存沿用 `BINDERY_STAGE_DIR`，默认系统临时目录下 `bindery-ingest-stage`。新预览清理旧暂存，POST 保留提交的 token，token 归一化/去重。文件事件汇总卷章与目录前 10 条；支持空文件、空白文本、坏 EPUB、未知类型的原中文错误。
- 发布格式为 `.ingest-queue/<job.id>/{payload.<ext>,task.json,cover?}`。描述版本 1 包括文件名、类型、payload 名、表单字段、去重模式及封面名。完整文件与描述均写入并验证后才调用共享 `enqueueJob({ id, ... }, library)`。失败/满载清理 payload，保留失败 jobs 行。测试暂停未完成的上传流，验证其间 jobs 表没有可消费行。
- ISBN 优先，其次规范化标题+作者；一方缺作者时按标题匹配。`keep` 新建，`normalize` 关联现有书，逐 token 的 keep 覆盖全局模式。归一完成消息为“归一到已入库书籍”。立即建立/绑定追踪，保留手动记录的阅读状态、评分、标签及备注，并同步元数据缓存。
- TXT 入库与 regenerate 使用 `parseBookFileEvents` 和 `buildEpubFromSectionStream`；`book.json` 保存无正文的卷/章 stub，原始 TXT 写入 source.txt。EPUB 导入剥离 WebP、提取元数据/封面，按覆盖字段和 CSS 决定写回。regenerate 的失败会标记 metadata failed；edit-writeback 保留 Python 的完整 TXT book.json 路径，以及无 source 时修补 EPUB 的路径。
- 任务分组为进行中/已完成/失败，每页 12 条，页码夹紧；归档书保留标题但不可打开。失效任务定义与 Python 一致（包括尚无关联元数据的上传行），cleanup 清除记录和相应暂存。重试新建 retry 行，原失败行保留；导入 EPUB 返回原中文 400。

## 消费、恢复与内存

`startJobWorker(library)` 每库幂等、动态导入、非阻塞；导入/构建不启动线程。解析和 ZIP 生成发生在 worker thread，不占用登录请求所在的 HTTP 线程。开发源码使用 Node 24 的类型转换和 extension/index 解析钩子，生产直接执行 Vite 输出的 executor chunk；两个路径均有实际测试。

jobs 表是队列。单条条件 `UPDATE ... RETURNING` 只 claim `running/排队中`，切换为“预处理”，按 created_at/rowid 取任务。数据库 `BEGIN IMMEDIATE` 内协调每库 `.consumer/pid` 文件锁，避免多进程同时归一同一上传，或在别的消费者运行时进行恢复；锁不替代数据库 claim。活进程锁保留，死 PID 锁可回收。该协调要求共享文件系统上的进程处于同一 PID 命名空间；跨主机共享库不是本实现验证范围。

首次取得消费权时：未开始的持久任务继续消费；已开始但被中断的行标记 `failed/失败/后台处理被中断，请重试`，已有产物元数据也标为 failed，避免无依据地重放半完成的上传。终态上传暂存随即清理，缺失/空队列文件分别显示“读取队列文件失败”“上传文件为空”。恢复也清理终态目录和超过 24 小时的无行目录、multipart 请求目录；正在发布的目录保留宽限期。停止函数用于测试和宿主的显式关闭。

每个任务结束释放局部引用，并在允许且宿主暴露 `globalThis.gc` 时请求 V8 GC；`BINDERY_MEMORY_TRIM` 使用 Python 的布尔规则。Node 没有可移植的 `malloc_trim`；没有加入 libc FFI 或全局响应 GC 中间件。核心 EPUB 构建仍返回整个 Uint8Array，见下面的共享请求。

## 对照、验证与已修复问题

最终依次执行：

```sh
pnpm build
pnpm typecheck
pnpm test
git diff --check
```

结果：构建成功；类型检查成功；**15 个 Vitest 文件、442 项测试全部通过，无跳过**；diff 检查通过。其中本切片 **5 个文件、39 项测试**。

覆盖指定 Python 测试中的入库重定向、流式事件预览、文件名身份回退、归一/keep、逐文件 override、追踪绑定、任务视图/分页/清理、排队/重试/满载、阶段恢复与清理、同步状态和 Node 适用的 GC 行为。另覆盖 multipart 任意分块/边界前缀/二进制封面/截断/中断/字段限制/空表单、发布前完整落盘、丢失和被清空的队列文件。

`ingest-parity.test.ts` 通过异步 `uv run --no-sync python tests-ts/fixtures/ingest/reference.py <temp>` 执行 Python 实际 `_process_queued_ingest_task`（包含 `_run_ingest`），再对照 TS 消费者。三组覆盖卷章/简介、文件名回退/元数据覆盖，以及 regenerate。比较 book.json **原始字节**、source.txt 字节、EPUB 成员顺序和内容、metadata 和 tracker 字段；仅忽略运行时间、随机追踪 ID，以及 OPF 的 dcterms:modified 时间。没有真实 library 的 EPUB 复制用例收集，符合本 worktree 的预期。

生产测试使用真实 `dist/server/server.js` fetch handler，没有监听 sockets。确认认证、两个页面 SSR、multipart 预览和 token 提交、后台实际消费、EPUB 落盘、HTML/JSON partial、无效页码 422、生成/重试/cleanup 路由、`next` 忽略、私有 no-store；另有既有生产认证/RPC 门禁。

修复过的验证问题：Node 源码 worker 的目录导入需要 `/index.ts` 回退；TanStack 默认查询参数会让 `/jobs` 多出 307，现保留原查询并在 loader 使用默认值；快速插入同时间任务的测试不能假定无关联任务位于首行，现按书籍关联断言。生产 SSR 测试须消费 Response body 才能完成流和计时器清理。

构建存在 Start 对 `.inputValidator()` 的弃用提示（沿用本阶段 binding 约定）和同一模块同时静态/动态导入的分块提示，均不影响构建或运行。

## 共享文件请求与未完成项

1. **公共 CSS 校验器（阻止完整 CSS 错误行为对齐）**：请集成方提供 `src/core/css.ts` 的 `validateCss(raw: string): string | null`，移植 `bindery/css.py:validate_css`，包括 Python 200000 字符计数、NUL、注释/字符串闭合及花括号错误的原中文消息。B 的编辑与 E 的主题保存也需要它。当前 C 继续接受 CSS，**尚未拒绝非法 CSS**；未在本切片复制公共解析器。API 加入后，C 的 `submitUploads` 应在 stage cleanup/发布之前校验，并以 HTTP 200 的原中文表单错误返回。测试需要涵盖所有错误分支、注释/字符串内花括号，以及校验失败不新建 jobs、不删除有效暂存。
2. **编辑写回的非元数据选项**：现有 `enqueueJob`/Metadata 无法表达 Python `_run_edit_writeback` 的 `cover_changed` 与 `strip_original_css`。当前消费者支持已有 EPUB/TXT 的普通元数据/CSS 写回；无法从新保存的 metadata 判断 B 是否刚替换封面，TXT 会按 Python 无新封面的路径刷新已有 EPUB 封面。请集成方为持久提交提供明确的写回选项（例如 EnqueueInput 的 `writeback: { cover_changed: boolean; strip_original_css: boolean }`，在发布前持久化到专用描述文件，禁止 jobs.log 协议），并协调 B 在保存封面后传入。测试需验证新封面不被旧 EPUB 覆盖、保留/剥离原 CSS、队列满载清理、重启后选项仍有效。现有 A/E 的普通 regenerate/主题写回不需要额外参数。
3. **大型 EPUB 的峰值内存**：`src/core/epub.ts:buildEpubFromSectionStream` 当前收集全部构建 section 并返回整包 Uint8Array。C 使用现有事件 API 并隔离到线程，但不能声称 ZIP 生成具有固定内存上限。若要求 Python 的磁盘流式构建内存特性，请核心层提供 `writeEpubFromSectionStream(args, write: (chunk: Uint8Array) => void): void` 或等价 sink API，再由 C 写入临时文件并原子替换。测试需保留现有成员 parity，并补长 TXT 的峰值内存检查。

## 有意差异与外部验收

- 预览不输出宿主绝对书库路径；保留输出文件名。文件系统路径是实现信息，未放进产品流程。
- JSON 内容协商服务 Solid，默认 HTML 保留公开 partial URL。过期 token 的无 JS POST 返回可重试表单正文（200）；Solid 保留原页面并显示错误。
- 持久等待队列与明确的中断失败恢复替代 Python 的进程内 queue；容量、排队/失败终态文案沿用共享约定。新增的恢复文案只用于新实现的持久队列恢复。
- 使用平面列表、UI kit 和响应式网格；尚无真实浏览器水合、390px 设备与键盘操作结果，不能将 SSR 检查当成浏览器验收。

集成方在沙箱外、配置现有密码哈希后执行（临时库，路径变量名不覆盖系统变量）：

```sh
P3_INGEST_VERIFY_DIR=$(mktemp -d)
export BINDERY_LIBRARY_DIR="$P3_INGEST_VERIFY_DIR/library"
export BINDERY_DB_PATH="$P3_INGEST_VERIFY_DIR/bindery.db"
export BINDERY_TEMPLATE_DIR="$P3_INGEST_VERIFY_DIR/templates"
export BINDERY_STAGE_DIR="$P3_INGEST_VERIFY_DIR/stage"
pnpm build
pnpm typecheck
pnpm test
pnpm start
# 开发源码路径另用 pnpm dev 验证
```

在浏览器登录后：用键盘选择单 TXT/EPUB 和混合多文件；核对 EPUB 自动保持书籍样式、TXT 书名/作者回填、规则/主题与 CSS 格式化；验证重复项默认归一及逐项“保留”；确认成功后仍在入库页且 toast 被消费。打开任务页，检查 5 秒更新、三个 tab、12 条分页、失败日志与重试/cleanup；在 390px 视口确认无横向溢出、全部控制可 Tab 操作。上传大 TXT 后重启进程，核对排队任务续跑、已开始任务明确失败；通过两个端口启动同一临时库的进程，确认单任务只完成一次。共享请求 1/2 落地后再验证非法 CSS 与编辑替换封面/剥离 CSS 的完整跨切片行为。

建议 commit message（未执行提交）：

```text
:sparkles: feat(ingest): Implement durable uploads and background jobs
```
