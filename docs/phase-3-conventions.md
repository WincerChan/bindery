# Phase 3 并行开发约定

本文件是 A–E 的文件归属和共享 API 合约。基础层已提供认证布局、UI kit、通知、书籍视图、持久任务提交、封面和 EPUB 下载。功能切片尚未实现；首页保留数量脚手架，Kindle 仅提供阶段 4 占位页。五个 worker 从同一基础提交在独立 worktree 开始，分别修改自己拥有的文件。

## 文件归属

`<slice>` 固定使用下表的英文目录名。每个 worker 拥有 `src/server/<slice>/**`、`src/features/<slice>/**`、`tests-ts/<slice>*.test.ts`、`tests-ts/fixtures/<slice>/**` 和 `docs/phase-3-<slice>-report.md`，以及表内列出的路由文件。表外的路由不属于该 worker；需要新增公共 URL 时先在自己的报告提出，避免两个分支创建同一文件。

| 切片 / `<slice>` | 页面文件（均位于 `src/routes/`） | 服务端路由文件（同目录）与职责 |
| --- | --- | --- |
| A 书库 / `library` | `_app.index.tsx`、`_app.archive.tsx` | `library.ts`（原 `/library` 列表 partial）、`books.archive.ts`、`archive.delete-bulk.ts`、`books.download.ts`。首页网格/列表、搜索、筛选、排序、分页、多选；归档页及批量归档/删除/恢复；ZIP 下载。批量恢复在 A 的 server function 中调用现有 storage，不占用 B 的单本 URL。批量重新生成通过共享 `enqueueJob` 提交。 |
| B 书籍 / `books` | `_app.book.$book_id.tsx`、`_app.book.$book_id_.edit.tsx` | `book.$book_id.cover.upload.ts`、`book.$book_id.cover.url.ts`、`book.$book_id.cover.extract.ts`、`book.$book_id.read.ts`、`book.$book_id.archive.ts`、`book.$book_id.delete.ts`、`book.$book_id.restore.ts`、`book.$book_id.metadata.fetch.ts`。详情与编辑（含原 HTMX panel 等价交互）、封面、单本操作、在线元数据。编辑 GET/POST 合在 edit 页面文件。 |
| C 入库与任务 / `ingest` | `_app.ingest.tsx`、`_app.jobs.tsx` | `ingest.preview.ts`、`jobs.partial.ts`、`jobs.$job_id.retry.ts`、`jobs.cleanup-invalid.ts`、`book.$book_id.regenerate.ts`、`books.regenerate.ts`。入库 GET/POST 合在 ingest 页面；上传、流式预览、去重、队列消费、重试、清理；移植 `_run_regenerate` 等处理逻辑。C 也拥有已预留的 `src/server/ingest/lifecycle.ts`。 |
| D 阅读器 / `reader` | `_app.book.$book_id_.preview.tsx`、`_app.book.$book_id_.preview_.$section.tsx` | `book.$book_id.epub.$.ts`（`item_path` splat）、`book.$book_id.search.ts`、`book.$book_id.progress.ts`。章节阅读、资源、搜索、阅读进度。 |
| E 规则/主题/追踪 / `catalog` | `_app.rules.tsx`、`_app.rules_.$rule_id.editor.tsx`、`_app.themes.$theme_id.editor.tsx`、`_app.tracker.tsx`、`_app.wishlist.tsx` | `rules.new.ts`、`rules.$rule_id.delete.ts`、`rules.test.ts`、`themes.new.ts`、`themes.$theme_id.delete.ts`、`tracker.$wish_id.update.ts`、`tracker.$wish_id.delete.ts`、`tracker.duplicate-check.ts`、`tracker.export.ts` 及对应的 `wishlist.*` 四个别名文件。tracker/wishlist 的 POST 与各页面 GET 合在页面文件；编辑器 GET/POST 同文件。 |

表内动作的 HTTP 方法沿用 `bindery/web.py`。例如 `POST /books/regenerate` **只由 C 建文件**：A 的工具栏、E 的按规则/主题批量生成可以提交到这个 URL，或在各自 server function 中使用 `enqueueJob`，不得另建同一路由。单本归档/删除/恢复只归 B；A 不修改 B 的路由，批量操作复用 storage。

E 的四个 wishlist 别名文件完整名称为 `wishlist.$wish_id.update.ts`、`wishlist.$wish_id.delete.ts`、`wishlist.duplicate-check.ts`、`wishlist.export.ts`。除 A 表中已有的首页和 C 的空 lifecycle 钩子外，上表功能文件均由对应 worker 新建。

Python 没有 bulk restore 公共路由，本基础不添加新 URL。`tests/test_cover_download_headers.py` 测的是远程 URL 抓取时的豆瓣 Referer/User-Agent，由 B 随封面 URL 功能移植；基础层 GET cover 的缓存和附件文件名测试已移植。

## 共享文件禁止修改

A–E 均不得修改 `src/styles.css`、`src/ui/**`、`src/shell/**`、`src/shared/**`、`src/client/toast.ts`、`src/routes/__root.tsx`、`src/routes/_app.tsx`、`src/routes/_app.security.tsx`、`src/routes/_app.kindle.tsx`、`src/routes/login.tsx`、`src/router.tsx`、`src/server.ts`、`src/server/db/**`、现有 storage/auth/runtime/env/paths/database/templates 模块，以及本基础新增的 `src/server/{http,functions,book-view,epub-css,files,jobs}.ts`。

`src/routes/book.$book_id.cover.ts` 和 `src/routes/book.$book_id.download.ts` 是共享文件，B 不拥有它们。`src/core/**`、`scripts/**`、既有 `tests-ts/*.test.ts`（包括 `foundation-*`）、`package.json`、`vite.config.ts`、`vitest.config.ts`、`tsconfig.json` 和锁文件也归集成方。共享功能缺口在自己的报告中写出具体 API、原因和测试需求，由集成方统一修改；不要复制一份共享实现规避合约，也不要用 `@ts-ignore` 绕过类型。

`src/routeTree.gen.ts` 是生成文件，允许构建自动更新。合并冲突不手工选择某一侧：合并源路由后执行 `pnpm build` 重新生成，再执行类型检查。各 worker 不编辑其他人的报告或本约定。

不改动 `.codex`、`spikes/`、Python 参考 `bindery/`、`templates/`、`static/`、`tests/`、`pyproject.toml`、`uv.lock`。不写真实 `library/`。不新增依赖，不提交、推送或切换主工作区分支。

## 文件路由与样式

- 页面放在 pathless `/_app` 下，URL 不带 `_app`；登录仍在外部。例：`_app.archive.tsx` 使用 `createFileRoute("/_app/archive")`。
- 页面是完整正文片段，用 `<div>` / `<article>`，不再放第二个 `<main>` 或复制导航。
- TanStack 的尾随 `_` 表示脱离同名父页面：B 的 edit 和 D 的 preview 不应渲染在 B 的详情组件内部。例：`_app.book.$book_id_.preview.tsx` 使用 `createFileRoute("/_app/book/$book_id_/preview")`；章节页进一步用 `preview_.$section`，避免嵌套整个阅读器。其真实 URL 仍是 `/book/{id}/preview/{section}`。
- 服务端专用端点放根路由（不加 `_app`），用 `.ts`，如 `books.download.ts` → `createFileRoute("/books/download")`。不能把 UI page 和 API handler 分成两个路径相同的文件。
- splat 文件 `book.$book_id.epub.$.ts` 中使用 `createFileRoute("/book/$book_id/epub/$")`，`params._splat` 对应 Python 的 `item_path`；D 必须验证路径并做好阅读器内容隔离。
- 页面专属 CSS 放 `src/features/<slice>/<page>.css`，由对应路由 `import "../features/<slice>/<page>.css"`，选择器加页面前缀。也可用 Tailwind utilities（共享 stylesheet 已扫描 routes/ui/shell/features）。不要向全局文件追加样式或定义无范围的 `section`、`button`、`nav` 等选择器。
- 复用背景 `--color-bg`、文字 `--color-ink`、强调 `--color-accent`、分隔 `--color-line` / `--color-line-soft`。保持平面布局；6px 控件圆角、默认 40px 高度、小控件 32px。不要引入卡片、阴影面板或新的设计 token。

## 服务端 API

### 认证、错误、路径

server function 必须保留可被 Start 编译器识别的 `createServerFn()`，配合客户端安全的 middleware；不要另包一层工厂。Node 代码只能在 handler 或服务端模块中加载。

```ts
import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../server/functions";

const loadPage = createServerFn({ method: "GET" })
  .middleware([authenticated])
  .handler(async ({ context }) => {
    const { listPage } = await import("../server/library/queries");
    return listPage(context.library);
  });
```

提交数据用 POST server function 并提供 `.inputValidator(...)`，不要在 GET loader 中实现用户写操作。`context.library` 仅留在服务器；不返回它、数据库对象、凭据或会话。全局入口仍验证 SSR/RPC 会话，layout 的 `checkSession` 保证客户端导航也检查；middleware 提供独立边界。

HTTP 路由使用下列形式；UI 页面文件的 `server.handlers.POST` 同样适用：

```ts
import { authenticatedRoute, HttpError, requireBook } from "../server/http";
// 放在 createFileRoute(... )({ server: { handlers: { POST: ... } } }) 中
const post = authenticatedRoute<{ book_id: string }>(async ({ request, params, library }) => {
  const meta = requireBook(params.book_id, library);
  // 校验表单，然后调用本切片的服务端逻辑
  return Response.json({ book_id: meta.book_id });
});
```

必须传递当前请求的 `library`，测试传临时 LibraryStorage。`requireBook(id, library)` 校验 32 位小写 hex ID，拒绝归档、缺文件和不存在书籍，返回 Metadata。归档恢复需 B/A 显式检查 archive 路径，不可使用 active-only 的 `requireBook`。

`HttpError(status, detail)` 是业务错误：400 参数无效、404 不存在、409 冲突、413 过大、415 类型不支持等。API 返回 `{ detail: "中文信息" }`；缺书统一 `404 书籍不存在`，缺封面 `封面不存在`，缺 EPUB `EPUB 不存在`。middleware 设置 RPC 错误状态并抛出错误。ENOENT→404、SQLite 锁→503、约束冲突→409，未知错误记录于服务器并仅返回 `500 服务器内部错误`，不泄露路径或堆栈。不要把所有异常当作参数错误或吞掉。

`getLibrary()`（`src/server/runtime.ts`）懒加载并初始化当前书库；`library.base`、`library.db` 可复用。`libraryPath()` 是不建目录的路径解析；`templateDirectory("rules" | "themes")` 返回并创建相应运行时模板目录，沿用 `*_FILE`、单类目录变量优先于 `BINDERY_TEMPLATE_DIR` 的规则。不要通过 cwd 拼默认书库路径，不在模块顶层初始化真实数据。

### 书籍视图和文件

- `bookView(meta, library?, tracker?)`（`src/server/book-view.ts`）返回可序列化的 `BookView`。保留 Metadata 字段、复制 tags，补 `status_label/status_class`、`effective_theme_template`、`source_type`、`can_regenerate`、`path`、`cover_url`。无封面用 `null`（Python 是缺 key）。`read_updated_at` 也保留在 TS 结果中。
- active 书籍优先从 tracker 取 read/rating；归档不自动读 tracker。传 tracker 可避免重复查询。`cover_url` 用封面文件的 `mtimeNs` 作为 `?v=`，缺文件时回退 updated_at。上传/替换封面后重新取视图。
- `statusView(meta)` 保留 Python 的时间比较逻辑；`effectiveThemeId(meta)` 将 EPUB 的 `__book__` 映射到 null，其他默认 `default`。
- `composeBookCss`、`bookEpubNeedsCssSync`、`ensureBookEpubCss(meta, library?)` 位于 `src/server/epub-css.ts`。A 的 ZIP 下载可在打包每本前调用后者，复用懒同步；C 的重新生成移植自身处理流程。TXT 有 source 则重建并保存 book.json，无 source 则修补已有 EPUB；导入 EPUB 只更新 overlay。同步成功更新 status/epub_updated_at/updated_at 并保存元数据。
- 保留已由真实 Python 对照确认的行为：无 source 的 TXT 加 overlay 后，原 style.css 仍不匹配，下一次下载可能再次同步。这不是新的“只同步一次”保证。不要在切片中自行修复这一参考行为。
- `fileResponse(request, path, { type?, filename?, headers? })` 流式输出，提供长度、ETag、Last-Modified、HEAD、单段/后缀 range、304 和 416。`downloadFilename(meta)` 为清理后的 `书名-作者.epub`，缺作者用“未知”，缺标题用 book。
- `coverCacheHeaders()`：`private, max-age=604800, immutable`，CDN/Cloudflare CDN 都 `no-store`。`edgeRevalidateHeaders()`：`private, no-cache, must-revalidate` + 两种 CDN no-store + Pragma no-cache，供 D 的 EPUB 资源使用。入口仅在没有显式策略时补 `no-store`；动态业务响应不要设置公共缓存。

### 任务提交和 C 的启动钩子

`src/server/jobs.ts` 的接口：

```ts
enqueueJob({
  book_id,                         // string | null；重新生成类必须有 ID
  rule_template: "default",        // 可省略或 null
  action: "regenerate",            // 可省略，默认 regenerate
  // id: stagedJobId,              // 可选的 32 位 hex；上传先落盘后发布
}, library);                       // → { queued: boolean, job: Job }
```

支持 action：`regenerate`、`retry`、`edit-writeback`、`upload`、`upload-epub`、`ingest`。A 的批量生成使用 regenerate；B 的编辑写回使用 edit-writeback。只有返回 `queued === true` 才显示“已创建任务”；失败也保留 jobs 行供任务页解释。

本基础没有内存队列、消费者、定时器或新增表。jobs 行就是耐重启的待处理项：`status='running' AND stage='排队中'`，message“等待后台处理”，log null，created_at/updated_at 同一 UTC 时间。`BEGIN IMMEDIATE` 内做容量检查与插入；`BINDERY_INGEST_QUEUE_MAXSIZE` 默认 64、限制 1–2048，仅计算等待项。满时仍插入 `failed/失败/任务队列已满，请稍后重试` 行。与 Python 的最终 jobs 行一致；不会留下中间“预处理”行，不保证内存 queue.put_nowait 的进程内顺序。

C 独占 `src/server/ingest/lifecycle.ts` 的 `startJobWorker(library): void`。共享 server 入口在处理每个请求前调用，当前是空钩子；C 将其实现为**每库幂等、非阻塞、懒启动**的消费循环，包括首次请求恢复队列、原子 claim、异常处理和清理。不得在导入或构建时开启 worker，也不能阻塞登录请求。多进程只能由条件 UPDATE/事务中的 claim 决定归属，不以 JS 内存标记作为唯一保护。处理时先把 stage 从“排队中”改成运行阶段；终态与重试、重启恢复策略归 C。

上传额外参数由 C 在 `<library>/.ingest-queue/<job.id>/` 持久化，目录布局/任务描述文件和恢复逻辑归 C，不占用 jobs.log 作为隐式参数协议。必须先生成 job ID、完整落盘并验证 payload，再传 `id` 调用 enqueueJob 发布；入队失败要清理暂存文件，避免 worker 读到半成品。A/B 的 regenerate/edit-writeback 参数由 jobs 行和已保存的书籍元数据取得，不依赖 C 的上传描述格式。

### UI 和通知

从 `src/ui` 统一导入：

| 组件 | 约定 |
| --- | --- |
| `Button` | 原生 button，默认 `type="button"`；表单显式 submit；variant 为 primary/secondary/quiet/danger；小尺寸 `size="sm"`。链接用 `<a class="btn btn-secondary">` 等共享类。 |
| `TextField` / `Select` / `Textarea` | 必传中文 label，支持原生属性、hint/error，自动关联辅助信息。Select 子项是原生 option。 |
| `Checkbox` | 必传 label；支持 checked/onChange、indeterminate（批量选择）。 |
| `Chip` / `Tag` | Chip 是 filter toggle button，selected 映射 aria-pressed；Tag 的 tone 为 neutral/ok/pending/failed。 |
| `GeneratedCover` / `BookCover` | 接收 book_id/title/author，BookCover 另接 cover_url；compact 为列表单字封面，eager 仅 BookCover。按 ID 前两位 hex % 5 取 Python 配色；加载失败回退生成封面。父容器控制宽度。 |
| `Dialog` / `ConfirmDialog` | controlled open/title/onClose/children；使用原生 modal dialog 管理焦点、Escape、Tab。ConfirmDialog 提供 onConfirm（可 async）、confirmLabel、danger；失败不关闭，显示错误，处理中禁止重复确认。 |
| `EmptyState` / `Pagination` | EmptyState 可传 title/children/action；Pagination 接 page/total/perPage/href，保留查询和 hash。 |

客户端调用 `showToast(message, kind?)`（`src/client/toast.ts`），kind 为 success/warning/error，显示 2600ms；新通知替换旧通知并重置计时。兼容 `window.binderyToast` 和 `bindery:toast` / `detail.value` 事件。所有文案经文本渲染。

服务端可用 `redirectWithToast(target, message, kind?)`（303）或客户端安全的 `withToast(target, message, kind?)` 构造 redirect URL。全局 ToastRegion 在首次加载与客户端导航完成时消费 `toast`/`toast_kind`，移除这两个查询参数，保留其他查询、hash 和 history state。原 HTMX 响应用 `setToastHeader(response, message, kind?)`；新 Solid fetch 调用方也须消费响应或主动 showToast，浏览器 fetch 不会自动处理 HX-Trigger。

## 测试与合并

每个切片移植相关 Python 行为，测试只写 `mkdtemp` 临时目录并清理；显式传临时 LibraryStorage，模板目录环境变量也必须指向临时目录。不要对默认 runtime 调用写操作。Python 通过 `uv run --no-sync python` 执行，不开启 TestClient/uvicorn 的真实监听。无网络时在线元数据/下载测试用可注入 transport 或 mock，绝不访问外网。

使用 Solid 2 RC 的 API（例如 `createEffect(compute, effect)`），不要引入 Solid 1 的 createResource/splitProps 等旧假设。UI SSR 测试可参考 `tests-ts/foundation-ui.test.ts` 的 Vite + Solid 编译，无需添加 DOM 依赖；浏览器水合、原生 dialog 焦点和移动端实机检查由编排方在沙箱外补充。

各 worker 的报告应包含完成范围、公共 API 缺口、参考行为差异、实际命令/结果及未验证项。集成时检查路由重名和 ownership，重新生成 route tree，然后按序执行 `pnpm build`、`pnpm typecheck`、`pnpm test`、`git diff --check`。生产测试直接调用构建后的 fetch handler，不开 sockets；现在检查共享 checkSession RPC，不依赖 A 的临时数量页面或 getBookCount 函数。
