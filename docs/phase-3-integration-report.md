# Phase 3：共享层集成交付记录

工作区 `/workspaces/bindery`，分支 `feat/ts-rewrite`。先读取共享约定和 A–E 五份报告，再核对 Python 调用路径。没有提交、推送、切换分支、安装依赖、联网或监听 sockets；没有修改 `.codex`、`spikes/`、Python 参考及其测试，也没有写真实 `library/`。原有未跟踪 `.codex` 保留。测试全部使用临时目录。

## 按工作项交付

### 1. 一个 CSS 校验器

新增 `src/core/css.ts` 的 `validateCss` / `MAX_CSS_LENGTH`。复用 core 的 Python `strip`，精确保持纯空白优先返回、200000 Unicode 码点限制、NUL、注释/字符串闭合及花括号平衡的原中文错误和优先级。字符串中的转义、注释/字符串内的花括号不影响平衡。B 的服务及客户端入口、E 的主题入口都复用它；原 slice 模块只保留兼容 re-export 和各自格式化器。B/C 保存 CSS 也使用 Python strip，避免 U+0085/U+001C 被错误保留或 U+FEFF 被错误裁掉。

C 的 `submitUploads` 在清理任何预览暂存、创建队列目录和发布 jobs 之前校验；错误保留原 `custom_css`，返回 `自定义 CSS 校验失败：…`。原生 HTML 和 JSON 请求均为 HTTP 200；不会创建 job，已选择和未选择的有效暂存都保留。

验证：Python oracle 对照所有错误分支、错误优先级、Python 特殊空白、200000/200001 个 emoji 和超长纯空白；逐分支验证 staged token 不删除、jobs 为空；生产 handler 验证 HTML 200、中文错误和同一 token 随后的有效提交。

### 2. 编辑写回的一次性参数

共享 `enqueueEditWriteback` 接受 `book_id`、`rule_template`、`cover_bytes`、`cover_name`、`cover_url`、`strip_original_css`。C 的 `edit-staging.ts` 管理 `.ingest-queue/<job.id>/{task.json,cover?}`：先完整写入并 flush 文件，再读取验证，最后调用 SQLite 原子发布。`jobs.log` 只保存失败诊断。容量不足保留 failed jobs 行并清除暂存，发布抛错也清除暂存。

普通 `enqueueJob({ action: "edit-writeback" })` 同样生成默认描述，供 E 的主题批量写回等入口使用。缺失/损坏描述或封面会明确失败，不能静默丢掉参数；旧版本已经排队且没有描述的 edit 行也会失败，需要用户重新提交编辑。这与 Python 进程重启后不能恢复一次性参数的边界相容；新 API 发布的等待任务可以在新进程恢复。已开始的中断任务沿用 C 的明确失败恢复规则。

B 的 `SubmitEditWriteback` 默认连接该 API，移除了两处 503 guard。worker 按 Python `_run_edit_writeback` 执行：文件优先于 URL；URL 复用 B 的豆瓣 Referer/User-Agent 等下载头；导入 EPUB 可先去原 CSS 再注入主题/本书 CSS；TXT 无新封面时从旧 EPUB 提取，无封面清空缓存、提取异常保留侧文件；有 source 重建并保存完整 book.json，无 source 修补现有 EPUB；最后从更新后的 EPUB 刷新封面。失败同时标记 metadata 和 job，终态清除一次性参数。

为 URL transport 将真实 queue consumer 改为 async 串行消费。worker 的 tick 防止重入，停止时等当前消费完成后再释放进程锁，保留懒启动、SQLite claim、同库单消费者及 RC shim。

验证：通过 B 表单 → 持久描述 → 新 LibraryStorage → `recoverJobs` → 实际 claim/drain，覆盖 EPUB/TXT/无 source TXT、文件与 URL 优先级、URL headers、剥离/保留 CSS、TXT 原封面提取/无封面/提取异常、刷新封面、满载/发布失败清理、描述或封面丢失及 EPUB/下载失败。三种来源逐项对照 Python metadata、EPUB 成员顺序和内容，TXT book.json 比较原字节。另有实际 worker thread 重启恢复，以及生产 HTTP multipart 编辑提交到后台完成的检查。

### 3. Tracker 一致性

新增共享 `src/server/tracker.ts`：`ensureTrackerForBook`、`applyTrackerStateToMetadataCache`、`syncTrackerMetadata`、`ensureTrackerConsistencyForMeta`。优先已有 linked wish，再匹配规范化书名及兼容作者的手工条目，否则创建；同步标题/作者并保留阅读状态、评分、标签和备注。只有 read 变化才更新 read_updated_at；rating-only 不更新时间，缓存同步不改 updated_at、EPUB 时间或写回状态，不重写 book.json。

A 在最终取到的当前页逐书调用；B 的详情、编辑 GET/POST、在线填充和已读操作复用共享实现；D 在章节 loader 的 CSS 同步前调用；C 的新建/归一入库，以及 E 的列表、导出、追踪编辑缓存同步也统一使用此实现。E 保留全库扫描时的手工条目索引，已匹配条目从索引移除，避免同名书重复使用。storage 的 unread SQL 播种属于 Python 原有独立行为，保持不变。Python preview 首次跳转、资源、搜索和 progress 不做该同步，TS 同样只在章节打开时同步。

验证：直接调用 Python 的书库、详情、编辑和阅读器入口，对比完整 books/wishlist 数据效果；涵盖手工关联、非法旧关联 ID、仅可见页补建、linked 改名、read/rating 缓存及时间、重复调用幂等和作者冲突。已有 E 的身份合并、两次 wishlist 扫描及 CSV parity 继续通过。

### 4. 阅读器全屏布局

章节 route 标记 `staticData.readerLayout`；`AppShell` 从匹配路由读取开关，隐藏站点 header、桌面导航、手机 tab bar 和更多菜单，main 改为全宽、无 padding、100dvh。正文采用 flex 分配剩余阅读高度，替换先前减去固定导航高度的 CSS。保留可聚焦 main、skip-link、根 toast、退出阅读链接和原生 dialog；进入阅读器时关闭更多菜单状态。

生产 SSR 检查确认阅读页没有两套导航，保留 skip-link/tabindex/toast；普通详情页仍有导航和原 main 样式。390px、动态浏览器地址栏、iframe 排版及键盘实际焦点待沙箱外验收。

### 5. 一致的 404

`shared/entities.ts` 提供中文实体消息，HTTP 层的 `missingEntity` / `requireEntity` 生成业务 404。`shared/not-found.ts` 的 `loadOrNotFound` 在 loader 边界将通过认证 RPC 传来的 404 转成 TanStack `notFound`，保留其他错误及认证响应。统一 `NotFoundPage` 用于书籍、编辑器、阅读器和路由默认缺失页，避免第二个 main。

B/D 的 ad hoc catch 和 E 的 null sentinel 已迁移；缺 book/rule/theme/job/wish 分别使用中文 detail。章节、资源、EPUB 提取不到封面的错误也改为中文。合法 ID 的重复删除继续保留 Python 的幂等行为。

验证：五类实体（含 rule/theme 两种模板）的共享 loader/认证 HTTP 边界测试，以及真实生产 handler 的书籍/章节/模板 404 页面与 job/wish 404 JSON。单元测试仅模拟 TanStack notFound 标记构造，以避开无 Solid 编译环境的 RC 导入限制；实际状态和页面组件另由生产构建验证。

### 6. 流式 EPUB 构建

新增 core `writeArchiveToSink` 和 `writeEpubFromSectionStream(args, write)`；缓冲 archive builder 复用相同写入原语。sink 同步完成每个 chunk 的写入，提供背压，异常向上传播并终止 ZIP。

由于旧归档把 OPF/nav/toc 放在章节前，writer 接收可重开的 section factory：第一遍只保留目录描述，第二遍渲染、压缩并写出每章，保持原成员顺序和字节。内存随目录规模和最大单章增长，不保留全部正文或整包输出；代价是 TXT 解析两遍。检测两遍章节数量/标题/路径变化，防止错误目录。输入必须在两遍之间保持不变。

C 的 TXT 上传和 regenerate 直接写临时 EPUB，完成关闭后 atomic rename，失败关闭并删除临时文件；book.json 仍为 Python 的空正文 stub。编辑写回按 Python 保存完整 book.json 的路径保留现有完整解析，不擅自改成 stub。

验证：320 章长 TXT 从文件事件解析，流式落盘与缓冲 builder 的整个 ZIP **逐字节一致**（固定构建时间），并确认第二遍尚未读完时已输出；含简介、封面、自定义 CSS 和 Unicode。补空书、仅简介、sink 故障和两遍索引变化测试。既有 Python 章节/归档成员 parity 全部保留。

### 7. 其他报告事项

- A 请求的 `.gitignore` 已在合并基线修正为 `/library/`，无须重复改动；检查三处 slice 源码/夹具不再被忽略，真实根 library 仍被忽略。
- E 的规则/主题批量按钮使用 C 的现有 URL 和共享 enqueue；现有 ingest 测试实际消费匹配任务，包含 EPUB 的 edit-writeback。默认主题与 EPUB `__book__` 在 B/C/E 原有测试中保留。
- 保留已说明的安全和运行时边界：reader iframe/CSP 隔离、主题预览隔离、封面大小和类型限制、内部跳转限制、Python 正则与 Node RegExp 的有限兼容，以及中文公共错误。它们不是丢失的一次性参数或共享层功能阻塞，不为字节复刻而撤销。
- C 的持久队列/PID 锁仍要求同一 PID 命名空间，不声称支持跨主机共享消费；Node 不提供可移植的 malloc_trim。EPUB 导入、修改和读取仍使用既有整包解压；本次 sink 解决 TXT 上传/重建的构建内存，不声称所有 EPUB 操作具有固定内存上限。未做 RSS 基准测试。

## 修改文件

| 范围 | 文件 |
| --- | --- |
| core | 新增 `src/core/css.ts`；修改 `archive.ts`、`epub.ts` |
| 共享服务 | 新增 `src/server/tracker.ts`；修改 `http.ts`、`jobs.ts` |
| 共享 UI/路由 | 新增 `src/shared/{entities.ts,not-found.ts,not-found-page.tsx}`；修改 `src/router.tsx`、`src/shell/app-shell.tsx`、`src/styles.css` |
| A | `src/server/library/queries.ts` |
| B | `src/server/books/{service,covers}.ts`、`src/features/books/css.ts`、详情/编辑两个 route |
| C | 新增 `src/server/ingest/edit-staging.ts`；修改 `actions.ts`、`identity.ts`、`processor.ts`、`queue.ts`、`executor.ts` |
| D | `src/server/reader/{service,resources}.ts`、章节 route、`src/features/reader/reader.css` |
| E | `src/server/catalog/{templates,theme-css,tracker}.ts`、规则/主题两个编辑器 route |
| 新测试 | `tests-ts/integration-{shared,errors,streaming}.test.ts`、`tests-ts/fixtures/integration/reference.py` |
| 原测试适配 | books-service、catalog-templates、catalog-tracker、ingest、ingest-multipart、ingest-parity、reader-server；books/catalog/ingest/reader 四个 production.mjs |

没有新增依赖、数据库表或 schema 字段。自动重建 route tree 后没有生成内容差异。

## 验证与重要失败尝试

最终按顺序执行：

```bash
pnpm build
pnpm typecheck
pnpm test
git diff --check
```

最终结果：生产 build、strict typecheck、diff 检查通过；**35 个 Vitest 文件、802 项测试全部通过，无失败、无跳过**（基线 761 项，新增 41 项）。保留现有 Start inputValidator 弃用及静态/动态导入分块提示；未改 RC compat shim。

新增三个 Vitest 文件共 41 项测试，其他测试保留/适配新 API。Python 均通过异步 `execFile` 调用 `uv run --no-sync python`；测试没有 spawnSync、网络或 TestClient sockets。生产测试直接消费构建后的 Request/Response，实际 worker 路径也已运行；这些检查不等于浏览器验收。

实际失败及修正：

- 最终文件范围审计首次使用同步 Node 子进程，被沙箱以 `spawnSync git EPERM` 阻止；改为异步 execFile 完成审计，确认 49 个修改/新增文件中没有禁改路径。
- 首次 shell 使用 `python` 做文本编辑，系统命令不存在，未产生对应文件修改；改用系统 python3 做文件编辑，参考执行仍用规定的 uv 命令。
- 新 tracker 对照最初把 TS 默认 updated 排序与 Python created 排序比较，导致可见页不同；统一显式 created 后完整 DB 对照通过，未放宽数据断言。
- 直接在 Vitest 导入含 JSX/Router RC 的 helper 无法解析/触发 client-only API；将纯映射 helper 与展示组件分开，单元测试模拟标记构造，生产 handler 继续验证真实 Router。
- B 的原生产快照在 Python 暂停 worker，TS 却同时消费编辑任务；首次全量出现 read 快照被前置编辑污染、删除与待写回任务竞态。将新增编辑检查移到 read 快照之后，并让该探针持有真实 consumer lock，与 Python 的暂停条件一致。后台完成验证由独立真实 worker 和生产 ingest/edit 探针承担，没有关闭生产 worker。

## 剩余缺口与沙箱外验收

上述必须集成的共享请求均已实现。尚未执行真实监听 HTTP、浏览器水合、390px/桌面视觉、iframe 权限实际执行、图片/字体加载后的分页、原生 dialog 焦点、在线豆瓣/Amazon 及部署进程重启验收。没有真实库 EPUB 副本，因此依赖真实库发现的额外用例未收集；合成 EPUB/TXT 和临时 DB 的 parity 已执行。

编排方在沙箱外按下面命令创建独立验收库。第一终端（临时密码仅用于本地验收，可自行替换）：

```bash
pnpm build
pnpm typecheck
pnpm test
git diff --check
for P3_ENV in BINDERY_LIBRARY_DIR BINDERY_DB_PATH BINDERY_TEMPLATE_DIR BINDERY_STAGE_DIR BINDERY_RULES_DIR BINDERY_THEMES_DIR BINDERY_PASSWORD_HASH; do
  unset "${P3_ENV}_FILE"
done
export P3_REVIEW_DIR="$(mktemp -d /tmp/bindery-p3-review-XXXXXX)"
export BINDERY_LIBRARY_DIR="$P3_REVIEW_DIR/library"
export BINDERY_DB_PATH="$P3_REVIEW_DIR/bindery.db"
export BINDERY_TEMPLATE_DIR="$P3_REVIEW_DIR/templates"
export BINDERY_STAGE_DIR="$P3_REVIEW_DIR/stage"
export BINDERY_RULES_DIR=""
export BINDERY_THEMES_DIR=""
export P3_REVIEW_PASSWORD='phase3-local-check'
export BINDERY_PASSWORD_HASH="$(node --input-type=module -e 'import {hash} from "@node-rs/argon2"; process.stdout.write(await hash(process.env.P3_REVIEW_PASSWORD, {memoryCost:8192,timeCost:1}))')"
printf '%s\n' "$P3_REVIEW_DIR"
HOST=127.0.0.1 PORT=3000 pnpm start
```

上面先清除相关 `BINDERY_*_FILE` 覆盖，避免继承真实配置。第二终端把第一终端打印的临时路径填入 `P3_REVIEW_DIR`，执行：

```bash
export P3_REVIEW_DIR=/tmp/bindery-p3-review-实际后缀
curl -i -c "$P3_REVIEW_DIR/cookies" --data-urlencode 'password=phase3-local-check' http://127.0.0.1:3000/login
cat > "$P3_REVIEW_DIR/source.txt" <<'TXT'
《集成验收》
作者：测试作者
简介：用于临时书库的共享层验收。

第一章 开始
正文与检索词。
第二章 继续
另一章正文。
TXT
curl -fsS -b "$P3_REVIEW_DIR/cookies" -H 'Accept: application/json' -F "files=@$P3_REVIEW_DIR/source.txt" http://127.0.0.1:3000/ingest/preview -o "$P3_REVIEW_DIR/preview.json"
P3_UPLOAD_TOKEN="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[0].upload_token)' "$P3_REVIEW_DIR/preview.json")"
curl -i -b "$P3_REVIEW_DIR/cookies" --data-urlencode "upload_tokens=$P3_UPLOAD_TOKEN" --data-urlencode 'custom_css=p{' http://127.0.0.1:3000/ingest
curl -i -b "$P3_REVIEW_DIR/cookies" --data-urlencode "upload_tokens=$P3_UPLOAD_TOKEN" --data-urlencode 'custom_css=p {color:blue}' http://127.0.0.1:3000/ingest
curl -fsS -b "$P3_REVIEW_DIR/cookies" -H 'Accept: application/json' 'http://127.0.0.1:3000/jobs/partial?tab=success' -o "$P3_REVIEW_DIR/jobs.json"
# 任务完成后执行；若列表为空，先重复上一条查询。
P3_BOOK_ID="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).jobs[0].book_id)' "$P3_REVIEW_DIR/jobs.json")"
node -e 'require("node:fs").writeFileSync(process.argv[1], Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X4D1kAAAAASUVORK5CYII=", "base64"))' "$P3_REVIEW_DIR/cover.png"
curl -i -b "$P3_REVIEW_DIR/cookies" -H 'Accept: application/json' -F 'title=编辑验收' -F 'author=测试作者' -F 'theme_template=default' -F 'custom_css=p {color:blue}' -F 'strip_original_css=on' -F "cover_file=@$P3_REVIEW_DIR/cover.png" "http://127.0.0.1:3000/book/$P3_BOOK_ID/edit"
curl -i -b "$P3_REVIEW_DIR/cookies" "http://127.0.0.1:3000/book/$P3_BOOK_ID/preview?return_to=%2Fjobs"
curl -i -b "$P3_REVIEW_DIR/cookies" "http://127.0.0.1:3000/book/$P3_BOOK_ID/preview/0"
curl -i -b "$P3_REVIEW_DIR/cookies" "http://127.0.0.1:3000/book/$P3_BOOK_ID/search?q=正文&limit=1&offset=0"
curl -i -b "$P3_REVIEW_DIR/cookies" -H 'Content-Type: application/json' --data '{"section":0,"page":1,"page_count":3}' "http://127.0.0.1:3000/book/$P3_BOOK_ID/progress"
curl -i -b "$P3_REVIEW_DIR/cookies" http://127.0.0.1:3000/book/invalid
curl -i -b "$P3_REVIEW_DIR/cookies" http://127.0.0.1:3000/rules/missing/editor
curl -i -b "$P3_REVIEW_DIR/cookies" http://127.0.0.1:3000/themes/missing/editor
curl -i -b "$P3_REVIEW_DIR/cookies" -X POST http://127.0.0.1:3000/jobs/missing/retry
curl -i -b "$P3_REVIEW_DIR/cookies" -X POST http://127.0.0.1:3000/tracker/ffffffffffffffffffffffffffffffff/update
```

浏览器登录同一临时库，检查：

1. `/`、详情、`/rules`、`/tracker` 保留普通导航；`/preview/0` 没有站点 header/tab bar，阅读区占满动态视口，退出、skip-link、toast 及 Tab 可达；390px 和桌面均无横向溢出。
2. 入库无效 CSS 保留输入和预览、改正后能继续提交；任务页可见真实结果；编辑上传封面/URL/file+URL、保持/剥离原 CSS（另导入含原样式的 EPUB），下载和阅读所得封面/CSS 正确。URL 在线测试使用你可控制的测试图片地址。
3. 手工 tracker 先设 read/rating，再入库或打开匹配书；确认关联、详情/书库/阅读器一致，评分变更不把 EPUB 标为待写回；书名/作者编辑同步 tracker。
4. 目录、搜索、图片/字体加载后分页、前后翻页、移动端选字、历史导航、dialog 的 Tab/Escape/返回焦点与 iframe sandbox/CSP 实际生效。
5. 在临时库提交大 TXT 和编辑任务后重启服务；等待任务继续消费，已开始的中断任务明确失败，终态无参数暂存。用同样环境执行 `pnpm dev --host 127.0.0.1 --port 5173`，复核源码 worker 和水合路径。

建议 commit message（未执行 commit）：

```text
:bug: fix(integration): Align shared Phase 3 workflows with Python
```
