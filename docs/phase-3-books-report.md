# Phase 3 Slice B：书籍交付记录

工作目录为 `/workspaces/bindery-wt-b`，分支为 `feat/p3-books`。没有提交、推送、切换分支、安装依赖、访问网络或监听 sockets；没有读改写主 checkout、其他 worktree、`.codex`、`spikes/` 或 Python 参考文件。所有写入验证均使用 `/tmp/bindery-books-*` 临时书库、数据库和模板目录。

**集成前仍有一个功能阻塞：编辑表单同时提交封面或“清除原书 CSS”需要扩展共享任务提交 API。** 当前明确返回 503，且不保存这次编辑、不发布任务，避免显示成功后丢失参数。普通元数据/主题/自定义 CSS 编辑可以提交 `edit-writeback`；独立封面上传、URL 下载和 EPUB 提取接口已实现并验证。后台任务实际消费仍由 C 切片交付，本分支没有自行启动另一套 worker 或引入私有暂存协议。

## 文件与职责

| 文件 | 用途 |
| --- | --- |
| `src/server/books/service.ts` | 详情/编辑查询，追踪记录关联与缓存同步，字段规范化、CSS 校验、草稿在线填充、编辑任务提交、已读/归档/恢复/删除。导出 `EditWritebackOptions` 与可注入的 `SubmitEditWriteback`，供集成时连接持久任务入口。 |
| `src/server/books/metadata-lookup.ts` | 移植 `metadata_lookup.py`：豆瓣与 Amazon 解析、JSON-LD/HTML 回退、作者与标题评分、建议条目选择、合并、候选/verbose/simple API。全部网络调用经过可注入 `Fetch`；自动填充保持只请求豆瓣。 |
| `src/server/books/covers.ts` | 有界上传和远程读取、豆瓣下载请求头、图片类型检查、封面文件保存、从 EPUB 提取与 EPUB 同步。复用既有 core、模板、存储和 CSS 组合 API；EPUB 采用临时文件加 rename 写入。 |
| `src/server/books/responses.tsx` | HTTP 表单边界、JSON/HTML/HTMX 响应、303 与 toast。编辑 GET 的 HTMX partial；普通 POST 的验证错误提供带样式的 HTML 草稿。 |
| `src/features/books/book-detail.tsx` | 详情规格表、简介、阅读/下载/已读/编辑/归档/重新生成/永久删除；Solid 编辑面板与原生确认对话框。详情不放封面管理表单。 |
| `src/features/books/book-editor.tsx` | 原生带 label 的编辑表单、评分按钮、草稿填充反馈、封面输入、规则/主题、CSS 格式化与一次性 CSS 选项；独立封面操作放在编辑页。 |
| `src/features/books/{books.css,css.ts,navigation.ts}` | 页面范围内的平面响应式样式、CSS 校验/格式化、返回 URL 清理和编码。 |
| `src/routes/_app.book.$book_id.tsx` | `/book/{id}`，有认证 middleware 的 GET server function；缺书转为 TanStack 404。 |
| `src/routes/_app.book.$book_id_.edit.tsx` | `/book/{id}/edit` GET/POST，脱离详情父页面；普通 GET 使用共享 layout，HTMX GET 返回编辑片段。 |
| `src/routes/book.$book_id.{cover.upload,cover.url,cover.extract,read,archive,delete,restore,metadata.fetch}.ts` | 八个原有 POST URL，统一经过 `authenticatedRoute`。 |
| `tests-ts/books-{metadata,service,ui,http}.test.ts` | 离线 Python 对照、服务/数据/文件回归、Solid SSR、实际生产 fetch handler 检查。 |
| `tests-ts/fixtures/books/{lookup.json,reference.py,ui-probe.tsx,production.mjs}` | 从原测试提取的 HTML 夹具、只使用临时目录的 Python oracle、SSR 编译入口、无 sockets 的生产检查脚本。 |
| `src/routeTree.gen.ts` | 仅由构建自动生成；未手工编辑。 |

未修改任何共享实现、既有测试、依赖、配置或锁文件。代码格式化使用已安装的 Prettier 3.9.10，不新增依赖。

## 行为与对照

- 详情显示系列、出版社、出版日期前十位、ISBN、标签、来源、规则模板、状态、入库和更新时间及简介。使用共享控件、封面、确认对话框和设计 token；页面专属样式没有卡片或阴影，移动端单列布局在 640px 以下生效。
- `return_to` 贯穿详情、编辑、阅读链接与保存后的跳转；`next` 用于已读、归档和删除。拒绝外部与协议相对 URL，丢弃 fragment 和最后路径段的 URI params，保留查询；303 中的中文和空格按 URL 转义，不重复转义已有 `%xx`。
- 编辑保留 Python 字段规则：空标题回退原题，空语言为 `zh-CN`；空可选文本为 null；标签按中英文逗号拆分、保留顺序和重复；评分限制 0–5；未提交 identifier 不覆盖它；EPUB 不改切章规则，TXT 的 `__book__` 主题改为 default。CSS 错误返回 200 草稿与原中文错误，不保存、不排队。
- 详情/编辑/已读操作关联或创建追踪记录，并按追踪的阅读状态/评分同步元数据缓存。切换已读仅在状态变化时更新 `read_updated_at`，不改 `updated_at`、`epub_updated_at` 或写回状态，也不重写 EPUB。
- 普通编辑先保存 dirty 元数据、同步追踪标题/作者/评分，再用共享 `enqueueJob` 提交 `edit-writeback`。容量不足保留已保存元数据和 failed job，只显示失败 toast。成功/失败通知、303、HTMX 的 `HX-Trigger` 都有回归验证。
- 元数据抓取只修改返回的草稿，不保存抓到的字段或封面、不创建任务。保留手填系列/评分/构建设置。仅在没有现有封面和手填下载 URL 时回填豆瓣封面 URL；检索结果分别显示来源封面和实际应用的 URL。来源失败、作者冲突、空结果、无作者建议和无效来源选择均有测试。
- 豆瓣解析优先最终完整 intro，保留段落和换行；封面优先 nbg，再 OpenGraph/JSON-LD；标签依次用 tag 链接、criteria、keywords。Amazon 的 JSON-LD、byline、描述/要点、RPI、meta 回退及搜索详情 API 均保留，但不加入自动填充来源。
- 远程封面针对 `douban.com`/`doubanio.com` 及其子域携带原 Referer、Chrome User-Agent、Accept、Accept-Language、Cache-Control 和 Pragma；其他域不加这些豆瓣请求头。HTTP、网络和空响应错误沿用参考文案。
- 归档移动整个书籍目录；恢复拒绝目标冲突并返回 `/`；删除支持 active/archive，合法但不存在的 ID 可重复删除。沿用 storage 的既有行为：删除书籍不同时删除追踪行。
- 生产对照完整消费所有 Response 流，直接调用构建后的 handler，没有通过监听端口绕过沙箱限制。在线抓取由 fake transport 返回记录数据，没有真实外部请求。

## 有意差异与限制

1. 按任务要求增加封面限制：每张最多 20 MiB，整个表单最多 22 MiB；在 Content-Length、流式累计长度和上传文件大小各边界检查，返回 413。按图片签名接受 JPEG、PNG、GIF、WebP、SVG，其他内容返回 415；URL 仅允许 HTTP(S)。Python 原实现未设置这些限制。
2. 封面扩展名按实际字节确定，防止 URL 或上传文件名把 PNG 保存为 HTML 等错误类型；Python 优先沿用传入文件扩展名。常规 PNG 覆盖流程已经与 Python 逐字节对照。
3. 原 contenteditable/隐藏字段同步改成原生 input、textarea、select 和按钮；评分、格式化、在线填充、错误反馈由 Solid 管理。普通详情内可以打开编辑面板，原编辑 URL 仍可直接访问，HTMX 请求保留片段/通知兼容。
4. CSS 格式化保留字符串、注释，并额外避免拆开 `url(...)` 等括号中的分号。CSS 校验错误文本和 Unicode 字符长度与 Python 对照一致。
5. 普通 GET 使用共享应用 shell。无客户端增强的原生 POST 若返回验证草稿，返回带共享样式和取消链接的独立 HTML，未复制共享 shell。正常 Solid 提交始终在现有页面内显示该草稿。
6. 按共享合约，缺书/非法 ID 的公共错误统一为中文 `404 书籍不存在`，覆盖 Python 某些接口的英文 `Book not found`/`Invalid book id`。
7. 编辑表单中的 `cover_file`、`cover_url`、`strip_original_css` 暂未连通生产任务接口，当前保护性 503 是未完成项，不算 Python 行为已对齐；独立封面接口不受此限制。没有通过提前写回 EPUB、复制共享队列或在 jobs.log 隐藏参数来掩盖缺口。

## 共享文件变更请求

需要集成方与 C 提供一个可持久化一次性参数的提交 API，例如在 `src/server/jobs.ts` 暴露：

```ts
enqueueEditWriteback({
  book_id: string,
  rule_template: string | null,
  cover_bytes: Uint8Array | null,
  cover_name: string | null,
  cover_url: string,
  strip_original_css: boolean,
}, library: LibraryStorage): Promise<{ queued: boolean; job: Job }>
```

原因：既有 `enqueueJob` 只能存储 book ID/action/rule。cover URL 和 strip flag 不属于 Metadata，上传字节也不能从保存的元数据恢复；现有 ownership 合约同时禁止 B 定义 C 的暂存协议。这三个值在 Python `_run_edit_writeback` 中有实际作用，不能丢弃。

要求：C 管理暂存布局与恢复，必须在发布排队 job 前完整落盘并验证参数；队列满/发布失败清理暂存；重启后仍可处理；文件优先于 URL；URL 下载和清除样式由 worker 执行。复用已有表和共享 enqueue 的容量/原子发布规则，不通过 jobs.log 存参数。也可采用等价 API，由集成方统一选择。

B 已提供 `SubmitEditWriteback` 注入点及完整 `EditWritebackOptions`。接入该 API 后替换默认 submit，并移除生产拒绝一次性参数的 guard。需要补充真正的队列端到端验证：上传封面写入 EPUB；仅 URL 下载及豆瓣 headers；file+URL 优先级；strip_original_css 移除旧 CSS 后注入主题/本书 CSS；队列满、写回失败、重启恢复与暂存清理。现有注入测试只证明参数完整传递，不把它当作已存在的持久消费者。

普通 `edit-writeback` 最终写回同样依赖 C 的消费者；本切片已验证的是任务提交、dirty 状态和队列失败反馈。C 应保留 Python `_run_edit_writeback` 对 TXT 原封面的提取/保留、EPUB 更新后封面刷新、失败元数据状态与 job 状态。

## 验证结果

最终顺序执行：

```bash
pnpm build
pnpm typecheck
pnpm test
git diff --check
```

生产构建、严格类型检查通过。Vitest **14 个文件、516 项通过，无失败或跳过**；其中本切片 **4 个文件、113 项**：metadata 40、service 64、UI 8、生产 HTTP/Python 对照 1。

Python 对照包括原 `test_metadata_lookup.py` 的全部九份 HTML 输入逐字段比较、标题/作者评分、CSS 校验结果和错误文案，以及已读 → 编辑 → 上传封面 → 归档 → 恢复 → 删除的真实数据/文件副作用。生产测试另检查匿名拦截、缺书 404、恢复冲突 409、验证草稿、独立/HTMX 编辑、JSON 填充、toast、非法 URL、类型/表单大小拒绝和共享封面缓存头。其他已列 Python 测试的书籍部分断言在 service/UI 测试中适配；既有核心、SQLite、认证和共享封面/下载验证继续全部通过。此 worktree 无真实 library，依赖真实书库的 EPUB 对照用例按项目现有收集条件不纳入。

排查过程中修复了两个实现问题：编辑页面顶层引入 HTTP 模块会触发 Start 的客户端 import-protection，改为 handler 内动态导入；普通 loader 错误会成为 500，改成路由层 `notFound()`，生产 handler 已验证 404。对照工具最初使用 BytesIO 的 UploadFile 触发沙箱内线程池等待，改用原 Python 测试相同的 SpooledTemporaryFile。无 sockets 测试必须消费响应体，否则未完成流会使子进程退出检查失真；最终使用完整响应和落盘 JSON 快照对照。

未执行真实 HTTP 监听、浏览器水合/键盘焦点/390px 实机视觉检查、真实在线豆瓣/Amazon 请求或真实书库写回。没有将 SSR 和 Request/Response 检查声称为浏览器验收。

## 编排方在沙箱外执行

先合并 C 的队列实现并完成上述共享 API 请求，再合并各切片，重新生成 route tree 后按顺序运行 build/typecheck/test/diff 检查。不要手工选择某个分支的 `routeTree.gen.ts`。

仅使用真实书库的副本与独立数据库，在沙箱外启动：

```bash
pnpm build
BINDERY_LIBRARY_DIR=/path/to/copied-library \
BINDERY_DB_PATH=/path/to/copied-library/bindery.db \
BINDERY_TEMPLATE_DIR=/path/to/copied-templates \
HOST=127.0.0.1 PORT=3000 pnpm start
```

使用现有认证配置登录，至少检查：

- 从带搜索/筛选/分页的书库进入详情，阅读、编辑、保存、已读切换和归档后的返回位置；直接打开编辑 URL、后退/前进及不同书籍间导航。
- 390px 与桌面宽度下的规格表、按钮换行、编辑输入；键盘操作评分、格式化、取消和删除确认框，检查焦点、Escape/Tab 与水合后的操作。
- 原生 multipart 与 Solid 增强提交；CSS 错误留存草稿；通过 HTMX header 获取/保存片段。
- PNG/JPEG/WebP/SVG/GIF 上传、URL 下载、豆瓣防盗链请求头、从 EPUB 提取、替换后的封面版本 URL/缓存和实际下载 EPUB 封面。
- C 集成后的编辑任务：封面与 strip 参数持久化、队列满提示、失败反馈、进程重启后的任务完成；TXT 与导入 EPUB 均检查正文、主题、自定义 CSS 和封面。
- 归档、恢复冲突、恢复后阅读、永久删除及其追踪记录保留行为。真实在线元数据返回应先检查草稿，保存前确认数据库/EPUB 未被抓取操作修改。

建议 commit message（未执行 commit）：

```text
:sparkles: feat(books): Port book detail and editing workflows
```
