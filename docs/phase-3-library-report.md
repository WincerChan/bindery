# Phase 3 Slice A：书库交付记录

工作目录 `/workspaces/bindery-wt-a`，分支 `feat/p3-library`。未提交、推送、切换分支、安装依赖或开启监听端口。未修改共享模块、其他切片文件、Python 参考实现及测试。没有创建真实 `library/`；全部数据写入使用 `/tmp/bindery-library-*` 临时目录并清理。原有未跟踪 `.venv` 保持不变。

## 完成范围与文件

| 文件 | 用途 |
| --- | --- |
| `src/routes/_app.index.tsx` | 替换数量脚手架；认证加载书库、搜索参数、客户端筛选导航、页面标题 |
| `src/routes/_app.archive.tsx` | 归档页、认证加载及批量恢复后刷新 |
| `src/routes/library.ts` | 保留 `GET /library` HTML 片段入口 |
| `src/routes/books.archive.ts` | `POST /books/archive`，固定 303 返回 `/` |
| `src/routes/archive.delete-bulk.ts` | `POST /archive/delete-bulk`，固定 303 返回 `/archive` |
| `src/routes/books.download.ts` | `POST /books/download`，ZIP 附件及中文业务错误 |
| `src/features/library/search.ts` | 排序、未读、页码和页大小规范化；返回 URL；四行网格页大小 |
| `src/features/library/functions.ts` | 带 `authenticated` middleware 的查询、批量恢复和按选择重新生成 RPC |
| `src/features/library/library-page.tsx` | 搜索、网格/列表、分页、单本入口、hover 阅读、多选工具栏、ZIP 下载与错误反馈、归档确认 |
| `src/features/library/archive-page.tsx` | 归档列表、多选、批量删除确认和批量恢复；复用 B 的单本操作 URL |
| `src/features/library/library.css` | 页面前缀样式，平面布局、40px 控件、移动端列表、桌面及平板布局 |
| `src/server/library/queries.ts` | 存储层分页查询、末页重取、`bookView` 与归档数据 |
| `src/server/library/actions.ts` | ID 清理、归档/删除/恢复、CSS 同步后的 ZIP、去重文件名、通过共享 `enqueueJob` 入队 |
| `src/server/library/handlers.ts` | 可注入临时 LibraryStorage 测试的表单 handler |
| `src/server/library/partial.tsx` | 复用 LibrarySection 服务端渲染 HTML 片段，无第二个 main |
| `src/routeTree.gen.ts` | 构建自动生成的六个页面/端点路由更新，未手工编辑 |
| `tests-ts/library.test.ts` | 25 项数据、筛选、返回导航、批量操作、HTTP 认证/状态/重定向测试 |
| `tests-ts/library-parity.test.ts` | 两项实际 Python 对照：六组分页查询；ZIP/CSS/正文/元数据和文件生命周期 |
| `tests-ts/library-ui.test.ts` | 13 项 Solid SSR 测试，移植书库及 editorial 的相关 DOM 断言 |
| `tests-ts/library-production.test.ts` | 一项生产 handler 集成测试，无 socket，覆盖真实 SSR/片段/表单/RPC |
| `tests-ts/fixtures/library/support.ts` | 临时书库、合成 EPUB/TXT 夹具 |
| `tests-ts/fixtures/library/reference.py` | 异步子进程调用的 Python 行为对照程序 |
| `tests-ts/fixtures/library/ui-probe.tsx` | 实际 Solid 2 SSR 编译入口 |
| `tests-ts/fixtures/library/production.mjs` | 使用生产构建和临时 DB 的 Request/Response 验证 |
| `docs/phase-3-library-report.md` | 本报告 |

## 行为与实现决定

- 默认 24 本；`per_page` 限制在 4–96；排序只接受 created/updated，未读只接受 unread/all；过大页码重取末页。使用 `LibraryStorage.listBooksPage`，没有全库扫描替代分页，也保留 orphan 数据库行计入总数后再过滤缺失目录的已有行为。
- 搜索覆盖书名/作者，输入防抖 400ms；筛选/排序重置第一页。返回地址包含 sort/q/page/read_filter/per_page，详情和阅读链接使用编码的 `return_to`，列表归档表单使用 `next`。批量归档/删除沿用 Python 固定返回地址，不采纳额外 next 字段。
- 移动端强制列表，桌面沿用 `bindery-view` localStorage 偏好。网格按最小 136px 列宽、20px 间距计算四行页大小，并受服务端 96 本上限约束。换页/筛选后移除不可见的选择；多选模式用真实按钮切换选择，避免误入详情。
- 页面复用 UI kit 的封面、按钮、输入、checkbox、chip、tag、空态、分页和原生 dialog。hover 阅读同时响应 focus-within；仅待写回/失败显示状态标签，已读标记保留；书籍 ID 和服务器路径不作为可见文案。控件为默认 40px、行内小控件 32px，无卡片或阴影。
- 无效、重复、不存在 ID 按 Python 忽略。归档更新 archived/updated_at 并移动整个书籍目录；批量删除先检查 archive 目录，使用共享 storage 删除；保留 Python 删除后已有 wishlist 关联行的行为。
- ZIP 打包前逐本调用共享 `ensureBookEpubCss`，再读取实际 EPUB。文件名复用 `downloadFilename`，重名追加 `-2`、`-3` 等；选择为空 400「未选择书籍」，没有可下载 EPUB 404「未找到可下载的 EPUB」。附件为 `bindery-books-YYYYMMDD-HHMMSS.zip`、application/zip、no-store。
- 批量恢复使用受保护 POST server function，不新增公共 URL。先检查所有现存归档目标的冲突及元数据，再调用 `restoreBook`；冲突 409「书籍已存在」。非法/已不存在选项按其他批量操作惯例忽略。
- 重新生成按选择逐本调用共享 `enqueueJob`，只处理 `bookView.can_regenerate` 的 TXT，保留该书 rule_template；导入 EPUB、无 source、失效 ID 跳过。只统计 queued=true 为成功，队列满保留 failed jobs 行并反馈失败；至少一个成功才跳往 `/jobs?tab=running` 并显示创建数量。没有创建 C 所有的 `/books/regenerate`。
- 服务端端点全部使用 `authenticatedRoute`，所有 RPC 使用 `authenticated`；Node 模块只在服务端加载。默认动态响应沿用基础 no-store 策略。

## 对照与有意差异

移植了 `test_library_filters.py` 的分页、可选页大小、未读/追踪状态和分页存储调用断言；`test_library_ui.py`、`test_editorial_ui.py` 的书库和归档部分；`test_return_navigation.py` 的书库 URL；`test_web_routes.py` 的本切片 URL、表单和分页文案；`test_bulk_actions.py` 中归档、批量下载和归档删除。规则/主题匹配的 `/books/regenerate` 测试归 C/E 的 URL 与模板逻辑，A 测试自身选择入队和容量失败。

实际 Python 对照通过异步 `execFile` 调用 `uv run --no-sync python tests-ts/fixtures/library/reference.py ...`，不使用 spawnSync、TestClient 或监听端口。对照输入为同源临时 SQLite 和合成 EPUB/TXT，比较六组页面 payload、ZIP 成员名及每个 EPUB 成员的 SHA-256、book.json/source 文件字节、books 元数据和目录移动/删除/恢复。唯一成员内容规范化为运行时生成的 `dcterms:modified` 值；不规范化 XML、CSS、书名、正文或元数据。ZIP 容器时间/压缩字节不比较。没有真实书库，既有需要真实 EPUB 复制的 parity 用例未收集，符合本 worktree 约定。

UI 不再复刻旧 HTMX DOM：一份书目 DOM 根据视图布局，避免两份封面资源；BookCover 原生 loading=lazy 且加载失败使用生成封面，替代旧 data-cover-src 手动 hydration。筛选由 TanStack 客户端导航完成，`/library` 仍提供同一 LibrarySection 的 HTML。片段自身不加载应用 shell/水合脚本。归档/删除使用 UI kit 原生确认 dialog；下载用 fetch + Blob，错误以 toast 展示。原首页的通行密钥推荐弹窗属于认证 UI，本切片未复制，安全设置仍由共享导航提供。

非法非整数 page/per_page 在首页 HTTP、`/library` 和查询 RPC 边界返回 422。错误响应遵循共享 API 约定，使用中文 `{ detail: "分页参数必须为整数" }`，替代 FastAPI 默认英文 validation error 数组；合法整数和上下限仍按 Python 规范化。首页先由 GET handler 校验再进入 SSR，避免路由器将 loader 业务错误覆盖成 500。

## 共享文件变更请求与已知缺口

1. **必须修正根 `.gitignore:7` 的 `library/` 为 `/library/`。** 当前规则同时忽略 `src/features/library/**`、`src/server/library/**` 和 `tests-ts/fixtures/library/**`，源码/夹具已实际创建，但不出现在普通 `git status --short` / `git diff` 中。未修改 `.gitignore`，也未写共享 Git 管理目录。集成方需先修正规则或显式 `git add -f` 上述三个目录，避免遗漏。验证：`git check-ignore -v src/features/library/library-page.tsx src/server/library/actions.ts tests-ts/fixtures/library/reference.py` 应不再报告忽略，真实根 `library/` 仍应忽略。
2. **增加共享追踪一致性 API**，建议 `ensureBookTracker(meta: Metadata, library: LibraryStorage): Wish`，放 `src/server/book-view.ts` 或其他集成方选定的共享模块；对应 Python `_ensure_tracker_for_book` + `_apply_tracker_state_to_metadata_cache`。应优先已有 linked wish，再按规范化标题和兼容作者匹配 manual wish，否则创建；同步 wish 的 title/author；把 read/rating 写回 books，read 改变时更新 read_updated_at，同时不改变 updated_at。A 的 libraryPage 在每个当前页条目调用该 API，再 `bookView(meta, library, tracker)`。当前严格使用已有 `bookView` 展示 linked wish 的 read/rating，没有复制缺失的共享逻辑，因此 **all 筛选页面不会创建/关联追踪条目或持久化 read/rating 缓存**；未读筛选仍用已有 storage 播种和 SQL 条件。新增共享测试应覆盖：无 tracker 仅当前页建条目、manual wish 标题/作者匹配、linked title/author 改名、read/rating 缓存与 read_updated_at、更新时间保持、分页越界重取及 Python 真实 side-effect 对照。A 的页面对照夹具预先播种 linked wishes，不宣称已覆盖这个缺口。

尚未集成 B/C/D：详情/单本归档恢复删除/阅读/任务页面由对应切片提供；A 保留既定 URL，不添加占位实现。任务消费仍依赖 C 完成 lifecycle worker，本分支验证的是耐重启入队。没有新增依赖请求。

## 实际验证

```bash
pnpm build
pnpm typecheck
pnpm test
git diff --check
```

结果：生产客户端/服务端构建通过；strict TypeScript 通过；**14 个 Vitest 文件、444 项测试通过，无跳过；其中 Slice A 4 个文件、41 项新增测试**。构建保留现有 Solid/TanStack RC shim；inputValidator 的上游 deprecated 提示来自约定 API，不影响构建。额外检查包含所有未跟踪/被忽略切片文件的尾随空白，以及最终归属列表。

排查中实际修正：Solid 2 effect 回调须返回 void；onSettled 中需返回 cleanup、不能嵌套 onCleanup；搜索默认值不能由 validateSearch 补进地址，否则首页被 TanStack canonical URL 机制变成 307，现已在数据加载边界规范化、生产 GET 返回 200；非法分页由页面 GET handler 保留 422，避免框架 loader 错误状态被重写为 500；Python 对照的 dcterms:modified 规范化需支持 XML 命名空间前缀。未通过修改共享文件绕过这些问题。

## 编排方在沙箱外验证

先合并各切片并修复共享请求，再构建、类型检查、测试及 diff 检查。使用书库和 DB 的**副本**，不要把示例环境变量指向真实原件：

```bash
BINDERY_LIBRARY_DIR=/tmp/bindery-review/library BINDERY_DB_PATH=/tmp/bindery-review/library/bindery.db BINDERY_TEMPLATE_DIR=/tmp/bindery-review/templates HOST=127.0.0.1 PORT=3000 pnpm start
```

另一个终端使用部署密码登录并保存 cookie：

```bash
curl -i -c /tmp/bindery-library-cookie --data-urlencode "password=$BINDERY_REVIEW_PASSWORD" http://127.0.0.1:3000/login
curl -fsS -b /tmp/bindery-library-cookie 'http://127.0.0.1:3000/?q=书&sort=created&read_filter=unread&page=2&per_page=20'
curl -fsS -b /tmp/bindery-library-cookie 'http://127.0.0.1:3000/library?q=书&per_page=4'
curl -fsS -b /tmp/bindery-library-cookie http://127.0.0.1:3000/archive
curl -fS -b /tmp/bindery-library-cookie -D /tmp/bindery-bundle-headers -o /tmp/bindery-bundle.zip --data-urlencode "book_ids=$BINDERY_REVIEW_BOOK_ID" http://127.0.0.1:3000/books/download
```

浏览器检查桌面网格/列表及偏好恢复、四行页大小、390px 无横向溢出、400ms 搜索和筛选、末页、详情/阅读/next 返回、多选时键盘选择且不打开详情、跨页选择清理、封面失败回退、批量 ZIP 的下载/错误、入队成功和队列满反馈。归档/删除只在副本确认，检查批量恢复和冲突、文件及 DB 结果；用 Tab/Shift+Tab/Escape 验证原生 dialog 焦点循环和焦点恢复。真实 HTTP 监听、浏览器水合/交互、原生下载、响应式视觉和 dialog 焦点未在本沙箱运行；无 socket 生产 Request/Response 已验证。

建议 commit message（未执行 commit）：

```text
:sparkles: feat(library): Implement library browsing and bulk actions
```
