# Phase 3 E：规则、主题与阅读追踪交付记录

工作区 `/workspaces/bindery-wt-e`，分支 `feat/p3-catalog`。没有提交、推送、切换分支、安装依赖、联网或开启监听 sockets；没有读取或修改主 checkout 或其他 worktree 的项目源文件，没有修改 `.codex`、`spikes/` 或 Python 参考文件。Python 使用已提供的 `.venv` 链接，链接保留原状。

## 完成范围与文件

| 文件 | 用途 |
| --- | --- |
| `src/server/catalog/templates.ts` | 模板列表与选择、编辑器数据、规则校验与保存、主题保存、新建/删除、活动及归档书籍引用保护、规则测试与目录摘要。复用共享模板路径/加载 API 和 core 规则模块，不向客户端返回磁盘路径或 RegExp。 |
| `src/server/catalog/theme-css.ts` | 本切片的主题 CSS 验证：长度按 Unicode code point 计算，检查 NUL、字符串、注释和花括号；不限制合法的自定义 CSS 属性。 |
| `src/server/catalog/tracker.ts` | 追踪 CRUD、手工身份合并、重复检测及建议、书库关联与补建、元数据阅读/评分同步、筛选/统计/分页、CSV、内部重定向。复用共享 DB CRUD/编码，在一个连接的事务内完成合并和删除。 |
| `src/server/catalog/http.ts` | HTTP 表单解析、HTML/JSON 内容协商、HTMX 跳转、CSV 响应和参数错误。 |
| `src/server/catalog/responses.tsx` | 普通 POST/HTMX 请求的编辑器及规则测试 HTML fragment，复用同一套 Solid 组件。 |
| `src/features/catalog/{rules,editors,tracker}.tsx` | 规则与主题页面、格式化与保存、实时规则测试、隔离的主题预览、追踪筛选与增改删 dialog、重复检测建议及原生表单。 |
| `src/features/catalog/client.ts` | JSON fetch、认证失效跳转、CSS 格式化和预览文档。 |
| `src/features/catalog/catalog.css` | 仅本切片前缀的平面布局，复用设计 token；6px 圆角、40px 控件、移动端单列，无卡片或阴影。 |
| `src/routes/_app.rules.tsx` | `/rules` 完整页面，保留 tab/rule_id/theme_id/error 查询。 |
| `src/routes/_app.rules_.$rule_id.editor.tsx`、`_app.themes.$theme_id.editor.tsx` | 两种编辑器 GET 与 POST，页面 loader 的受保护 server function，以及缺模板的 404。 |
| `src/routes/_app.tracker.tsx`、`_app.wishlist.tsx` | 两个列表 GET/新增 POST 地址，独立认证边界。 |
| `src/routes/rules.{new,$rule_id.delete,test}.ts`、`themes.{new,$theme_id.delete}.ts` | 模板动作 POST 与规则测试 POST。 |
| `src/routes/{tracker,wishlist}.{$wish_id.update,$wish_id.delete,duplicate-check,export}.ts` | 两个 URL 家族，update/delete 为 POST，重复检测和 CSV 为 GET。 |
| `src/routeTree.gen.ts` | 仅由 `pnpm build` 自动生成。 |
| `tests-ts/catalog-{templates,tracker,ui,parity,production}.test.ts` | 服务端回归、Solid SSR 标记、Python 数据/文件对照、实际生产 fetch handler 集成检查。 |
| `tests-ts/fixtures/catalog/{reference.py,ui-probe.tsx,production.mjs}` | 本切片专用的隔离 Python/SSR/生产测试工具，全部写入 `/tmp` 临时路径。 |

## 保留的行为

- 编辑规则只通过 `validateRuleTemplateJson`，保存失败返回 200、保留原输入并且不改文件；有效数据归一化后保存。规则测试使用**已保存模板**，空输入显示“尚未运行测试。”，目录最多 15 项。模板 ID 的直接查询不回退到别的模板；规则测试的未知 ID 则沿用共享 `getRule` 的回退。
- 默认模板不能删除（400，“默认模板不可删除”）；活动或归档书籍引用模板时，303 跳回对应 tab 并保留模板及 error 查询。HTMX 新建/删除使用 200 + HX-Redirect。
- 主题保存保留文件其他字段及输入 CSS 的末尾空白；编辑器重新读取时沿用 Python 的 rstrip。无效 CSS 保留输入及中文错误、不写文件。仅存在损坏 JSON 时，列表显示空模板状态，仍能新建。
- `/tracker` 与 `/wishlist` 的 GET/POST，以及 update/delete/duplicate-check/export 别名均可用；成功操作默认 303 到 `/tracker`。`next` 保留安全的内部路径和查询，移除 fragment；中文 Location 按 Starlette 的规则转义。
- 追踪默认状态为已完结；兼容旧 read 标志、三种阅读状态、评分 0–5 的服务端归一化、标签去重与评论。已关联条目的书名/作者从书库取得，空的 library_book_id 更新继续保留既有关联。
- 新增重复条目不改原数据，跳回 duplicate 提示；提供作者时仅阻止相同规范化书名+作者，空作者按书名阻止。部分书名建议与精确拦截独立返回，顺序优先精确作者/书库关联。
- 手工条目更新撞到已有身份时，保留目标 ID、写入新字段并删除来源记录，整个合并为事务。失败注入测试确认目标更新会回滚。
- 列表和导出均执行 Python 的追踪补建、手工条目关联以及 read/rating 元数据同步。只扫描 wishlist 两次，一个手工条目不会被两个同名库内书重复使用；书库身份使用索引匹配。`book.json` 和 EPUB 不因追踪编辑而改写。
- 每页 20 条；页码夹在有效范围；统计为全量，filtered 为筛选后数量。CSV 忽略分页、沿用所有筛选，包含 UTF-8 BOM、CRLF、原列顺序、空评分/评论和引号/换行转义。
- 所有 server function 使用 `authenticated`；HTTP 动作使用 `authenticatedRoute`；动态响应 `Cache-Control: no-store`。没有修改共享表结构、任务协议或模板目录规则。

## 有意差异与边界

1. 编辑器 GET 作为完整应用页面；列表内也可以直接编辑。普通 POST 保留 HTML fragment 与原状态语义；Solid fetch 通过 `Accept: application/json` 取得同一业务结果，属于新增内容协商。原 HTMX/Alpine 属性由 Solid 交互取代。
2. 主题预览使用 `sandbox` iframe，配合 `default-src 'none'`、禁止脚本/表单/外部资源的 CSP，避免 CSS 或 HTML 结束标签影响应用。格式化器保留字符串、注释及函数内的分号，修正旧格式化器对 data URL 的拆分；不需要新依赖。
3. 延续 core 已记录的 Python 正则兼容边界：例如 `(?>a+)` 原子组被 Node RegExp 拒绝，保存时显示正则校验错误。JSON/正则底层诊断由当前运行时产生，不伪造 Python 的诊断全文。
4. `next` 额外拒绝反斜杠和控制字符，防止浏览器将其解释成跨站地址。其余常见内部重定向及 duplicate 查询保留行为已对照。
5. 新页面和字段均使用 UI kit、真实标签/按钮/链接及原生 dialog。原模板中只测试 HTMX/Alpine 源代码字符串的断言，改成对实际 Solid SSR 输出和 HTTP 行为的断言。

## 验证

最终执行：

```bash
pnpm build
pnpm typecheck
pnpm test
git diff --check
```

结果：构建、类型检查、diff 检查通过；**15 个 Vitest 文件、473 项测试全部通过，无跳过**。本切片新增 **5 个测试文件、70 项测试**：服务端 59 项，UI/格式化 8 项，Python parity 2 项，生产 handler 集成 1 项。

Python parity 使用异步 `execFile` 执行 `uv run --no-sync python tests-ts/fixtures/catalog/reference.py ...`，没有 spawnSync、TestClient 或网络。对照验证了模板保存后的 JSON 数据、无效输入不落盘、归档引用删除保护、CSS 中文错误及 Unicode 长度、规则章节摘要、追踪跳转、身份合并、补建/关联后的 DB 行、元数据同步、book.json 不变和 CSV 字节。随机 ID 与时间仅在比较中剔除或固定，没有归一化业务字段。

生产检查直接调用 `createProductionHandler()`，实际覆盖所有页面和两个别名家族、匿名拦截、登录、HTML/JSON 保存、规则测试、默认删除 400、缺模板 404、缺追踪 404、limit 422、中文重定向、CSV BOM/附件头和 no-store。测试读取完 SSR 响应流，并写完成凭据文件，避免仅凭子进程退出码判定执行成功。

移植来源：`test_rules.py`、`test_rule_validation.py`、`test_template_crud.py`、`test_template_paths.py`、`test_wishlist.py`、`test_tracker_export.py` 的本切片数据断言；规则/主题/追踪相关 UI 与路由断言；`test_css_validation.py` 和 `test_css_format_ui.py` 的主题部分。`test_theme_defaults.py` 的 shared effectiveThemeId 断言也已覆盖；其中 EPUB 入库元数据构建，以及 `test_theme_defaults_ui.py` 的 ingest/meta-edit 表单断言分别属于 C/B，需要集成方核对它们的测试，不在 E 越权实现。

重要失败及修复：生产测试最初发现缺模板 GET 被普通 HttpError 渲染成 500，现由 server function 返回缺失结果、loader 使用 TanStack `notFound()`，真实 handler 已确认 404。生产探针曾因未消费 404 SSR 流而超过 20 秒，已改为完整读取响应并验证完成凭据；没有通过放宽超时掩盖问题。

## 共享文件请求与集成事项

- **没有必须修改的共享文件/API 请求。** 仅修改切片归属文件和自动生成的 route tree；未复制共享 storage、模板加载、认证、DB CRUD、正则校验或任务实现。
- 批量重建按钮按合约提交 C 所有的 `POST /books/regenerate`，字段为 `scope=parsing|themes` 和 `template_id`。C 的该路由在此独立工作区尚不存在，因此按钮的队列消费结果需合并 C 后验证；E 没有创建同名路由或另建队列。
- B/C 需保留 EPUB 的全局默认主题和 `__book__` 选项，以及相应 CSS 表单验证；这些调用点和共享文件不属于本切片。
- Start RC 对 `inputValidator` 发出弃用提示；仍按绑定合约使用该 API，没有更改 RC shim 或依赖。无构建/类型错误。

## 沙箱外验收命令与未验证项

沙箱内没有浏览器水合、原生 dialog 焦点/返回焦点、实际 390px 视口或真实 HTTP 监听验证。没有真实书库目录，因此不收集依赖真实书库 EPUB 副本的 parity 测试，符合本工作区约束。

编排方合并所有切片后，先重新生成路由树并按顺序执行：

```bash
pnpm build
pnpm typecheck
pnpm test
git diff --check
node tests-ts/fixtures/catalog/production.mjs
```

随后在沙箱外，以书库、数据库及模板的**副本**运行（替换绝对路径；沿用配置好的密码变量）：

```bash
BINDERY_LIBRARY_DIR=/absolute/test-copy/library \
BINDERY_DB_PATH=/absolute/test-copy/bindery.db \
BINDERY_TEMPLATE_DIR=/absolute/test-copy/templates \
pnpm dev --host 127.0.0.1 --port 3000
```

浏览器登录后访问 `/rules`、`/rules/default/editor`、`/themes/default/editor`、`/tracker`、`/wishlist`：验证新建/选择/保存/格式化、错误输入保留、连续输入规则测试不出现陈旧结果、主题预览隔离、引用模板无法删除；验证追踪添加/编辑/删除、重复建议跳到编辑、作者区分、筛选分页和导出。以 390px 和桌面宽度检查布局，纯键盘检查 dialog 的 Tab/Escape/焦点恢复。最后合并 C 后点击两种模板的批量重建按钮，确认 jobs 入队及实际重建结果。

建议 commit message（未执行 commit）：

```text
:sparkles: feat(catalog): Add rules, themes, and reading tracker
```
