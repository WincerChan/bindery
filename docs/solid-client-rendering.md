# Solid 2 RC：列表计数更新但卡片不更新

适用版本：`solid-js` / `@solidjs/web` / `@solidjs/babel-plugin` 2.0.0-rc.15，TanStack Solid Start / Router 2.0.0-rc.8。`vite-plugin-solid` 3.0.0-next.27 在当前安装中转发到 `@solidjs/vite-plugin` 3.0.0-next.50。

## 已确认的根因

这是 RC 编译器的条件表达式优化导致的 hydration owner ID 偏移，不是 `For` 的数据没有更新，也不是应用误用了非 keyed `Show`。

编译器会在**组件 prop getter 内部**创建条件 memo。例如书库全选框的：

```tsx
indeterminate={selected().length > 0 && selected().length < props.data.books.length}
```

默认编译产生相当于：

```js
get indeterminate() {
  return memo(() => selected().length > 0)()
    && selected().length < props.data.books.length;
}
```

每次读取 getter 都会创建新的响应式 owner。SSR 和客户端 DOM 属性绑定的读取次数、时机不同，不能把这样的分配放在 getter 中。在最初的完整 `LibraryPage` 探针中，SSR 的 `LibrarySection` key 是 `000A15`，客户端查找的却是 `000A16`。客户端找不到对应节点，创建了新的脱离文档的 section；hydration 插入逻辑保留原 SSR section。后续 `For` 正常映射和协调的是脱离文档的节点，所以可见卡片一直保留，而前面的计数节点仍正常更新。

以下是本机安装源码的可核查依据（不是对其他 RC 版本的推断）：

| 位置 | 行为 |
| --- | --- |
| `node_modules/.pnpm/@solidjs+babel-plugin@2.0.0-rc.15_@babel+core@7.29.7/node_modules/@solidjs/babel-plugin/index.js:638` | `transformCondition` 为条件表达式创建 memo；逻辑表达式的 inline 分支在 `:701` 直接生成 `memo(...)` 调用。 |
| 同文件 `:6363` / `:6373` / `:6386` | 组件条件 prop 在 SSR 和 DOM 两端均经过该转换，调用被放进 getter 的返回表达式，而不是在稳定的组件初始化作用域创建。源码注释提到了 hydration ID drift（`#2959`），但仅让两端都转换仍不足以保证 getter 的读取次数一致。 |
| `node_modules/@solidjs/web/dist/web.js:69` 和 `node_modules/@solidjs/web/dist/server.js:83` | 编译器的 `memo` helper 调用同步 `createMemo`。 |
| `node_modules/solid-js/dist/server.js:614`（`createSyncMemo`），同文件 `:67`、`:74`、`:57`；`node_modules/solid-js/dist/solid.js:307` | owner 创建与节点 hydration key 共用子节点 ID 序列；多创建一个 owner 会改变后续 key。 |
| `node_modules/@solidjs/web/dist/web.js:707` / `:726` / `:750` | DOM spread 在 render effect 中收集并读取 props，包括 getter；它不是 SSR 的一次字符串属性输出。 |
| 同文件 `:1488` | `getNextElement` 按 hydration key 取节点；有 template 的 lookup miss 会直接克隆 template，不抛异常。 |
| 同文件 `:1738` / `:1744` | hydration 期间，待插入节点不是已连接的 hydratable 节点时，插入会返回原 current，保留 SSR DOM。这解释了为什么没有 console error，也解释了更新的节点与可见节点可以分离。 |

排除的替代解释：

- Router 的 `useLoaderData` 返回 `useMatch` 的 accessor：`node_modules/@tanstack/solid-router/src/useLoaderData.tsx:43`；`useMatch.tsx:100` / `:109` 使用 memo 和 `replaceEqualDeep`，不是把 loader 数据变成原地更新的 projection。当前测试使用真实 Router 和异步 loader，在数据完成后导航，无网络请求。
- `node_modules/solid-js/dist/solid.js:1473` 的 `For` 将 getter 传给 `mapArray`；`Show` 在 `:1494` 只按 truthiness 保留非 keyed 分支，这是正确的使用方式，分支内的 `For` 仍响应数据变化。
- `node_modules/@solidjs/web/dist/web.js:1797` 的列表 diff 实际执行了；探针中它的 parent 是脱离文档的 section。数组复制、添加 `For` 的 sibling 映射或调整 keyed 策略都不能重新连接这棵 DOM。
- 探针无需挂起资源即可复现，等待 hydration 后一个事件循环也仍失败；没有证据指向 `Loading` 的 stale UI 持有或 fragment diff 本身。

## 修复和移除条件

`scripts/solid-options.ts` 将 `solid.wrapConditionals` 设为 `false`；`vite.config.ts` 和客户端回归测试共用同一配置。这样在 SSR、客户端构建和开发编译中都不生成这些条件 memo。getter 仍然响应式读取数据；`Show`、`For`、正常 DOM render effect 和其他显式 memo 保持工作。

这是针对上游 RC 问题的统一兼容处理。它会减少条件表达式的 truthiness 缓存，部分表达式可能多计算；不强制整页重建、不修改依赖文件、不复制 loader 数据、不改默认 keyed 语义。审计范围内的页面统一经过此配置，无需在各页面逐个添加重建 key 或包裹组件。

上游报告标题建议：**Conditional component prop getters allocate memos per read and drift SSR hydration IDs**。报告应附上本文件的源码位置、完整 `LibraryPage` 探针和默认配置失败的测试结果。当前环境无网络，未查阅或提交远程 issue；源码中的 `#2959` 仅是本地注释中的线索，不代表已确认其远程状态。

升级 Solid / 编译器后，将 `wrapConditionals` 恢复默认并运行 `pnpm exec vitest run tests-ts/client-rendering.test.ts`，再按下方 Chrome 清单验证。只有两端 key 对齐、这些测试和浏览器检查全部通过后，才能删除兼容配置；保留客户端回归测试。

## 审计范围

| 页面 / 组件 | 检查与保护 |
| --- | --- |
| 书库 `LibraryPage` / `LibrarySection` / `LibraryBook` / `SelectedIds` | 计数与卡片一致，8→1→0→多项、顺序变化、选择模式分支、筛选后隐藏 ID 清理；SSR hydration 与纯 CSR 均测。 |
| 归档 `ArchivePage` | restore 的 refresh 数据进入同一个 props；行删除、最后一行清空、重新出现、全选按钮分支均测。 |
| tracker / wishlist | 两个路由共用 `TrackerPage`；过滤结果、空状态均测。`TrackerForm` 的重复建议/阻止列表及 keyed 编辑弹窗也经过统一编译设置；实际查重交互留给浏览器验证。 |
| jobs / partial polling | `/jobs/partial` 的 JSON 最终通过 `setData` 传入 `JobsSection`，原生 HTML partial 单独 SSR；用相同 payload 路径测试任务删减、tabs、失败→成功、重试/日志分支。未启动真实 5 秒轮询请求。 |
| 规则 / 主题 | `RulesPage` 的模板列表、tab 切换、keyed `Editor` 和无模板分支均测；`RulePreview` 的目录替换与清空均测。独立 editor 路由使用同一组件和配置。 |
| 详情 / 编辑 / 封面 | `BookDetail` 的 fragment fallback、进入编辑、模拟保存后返回详情、spec 列表、封面 Show 均测；`BookEditor` 的模板选项、检索结果/attempts 列表经代码审计和统一配置覆盖。 |
| 阅读器 | 实际 `Reader` 的 TOC 替换、两次查询、追加结果、`HighlightedText` 的 For→Show 文本/mark 分支、空结果、加载更多按钮均测。iframe 排版与翻页未在最小 DOM 中模拟。 |
| 入库 / 预览 | `IngestPage` 模板选项和格式条件使用统一配置；`UploadPreviews` 的多文件替换、重复提示 fragment、TOC、hidden token、空状态均测。 |
| 公共 `Pagination` | 页码变化、gap、当前链接、上一/下一页、单页隐藏均测。 |
| shell / dialog / controls / security / login | 审计其条件、static navigation 和 passkey 列表；统一关闭优化。真实 `AppShell` 在 Router 测试中使用；登录、通行密钥和 toast 的浏览器 API 不在此 DOM 测试中模拟。 |

## 自动验证的能力与边界

`tests-ts/client-rendering.test.ts` 将真实 TSX 组件分别编译为 SSR 与 **production browser** bundle，再调用安装的 `@solidjs/web` 客户端 `render` / `hydrate`。使用现有 `@xmldom/xmldom` 实现节点树，复用 Solid JSX 编译器已安装的 `parse5` 解析 HTML template，并补上少量 DOM 属性和测试事件入口。没有新增依赖、浏览器、服务器或 socket。

13 个测试检查的是节点删除/替换、顺序、文本、属性和交互处理器的结果，不是 SSR 字符串快照。真实 Router 测试先 hydrate `/` 或实际 `RulesPage` 的 `/rules`，再导航、替换 loader 数据并查询可见卡片。fetch 全部是本地 mock；表单提交不验证浏览器原生 FormData 序列化。

反向验证：临时恢复 `wrapConditionals: true` 后，完整书库 hydration 的选择分支失败；真实 Router 的 `/` 测试能通过“计数为 1”的断言，却仍保留三张卡片。恢复兼容配置后 13 项通过。早期探针还验证了仅将全选框 `checked` / `indeterminate` 的条件移到普通 accessor，也能消除该 key 偏移，进一步定位了编译器优化。

边界必须保留：**纯 CSR 最小探针，以及当前 `/rules`→`/` 的 Router 探针，在原配置下也能通过**。因此不能声称独立复现了 orchestrator 报告的所有纯客户端执行条件；该浏览器路径是否还有额外触发因素尚未验证。统一关闭优化消除了所有页面中的同类 getter 分配，但真实 Start bootstrap、流式传输、浏览器事件代理、ResizeObserver、dialog、iframe 布局仍需 Chrome 验证。

## Orchestrator 的生产 Chrome 检查清单

1. 用新的 `pnpm build` 产物重启服务，使用同一组八本书。直接打开 `/`，等待 hydration；搜索「魔临」并按 Enter，检查 URL、`[data-library-count]`、`[data-book-card]` 数量及 `data-book-id` 同时变成预期值。查询无结果、清空查询、切换仅未读、切换排序、翻页、后退/前进；不能留下旧卡片或旧 hidden ID。
2. 新开 `/rules`，通过真正的客户端 Router 导航进入 `/`（确认没有 document reload），重复步骤 1；另直接打开 `/?q=魔临` 检查 SSR→hydration 后仍是一册，再清空查询。桌面网格、列表、手机布局均检查，包含 ResizeObserver 调整 per_page 后的结果。
3. 多选两本后过滤掉一本，检查两份批量表单的 `input[name=book_ids]` 只保留仍显示且选中的书；退出多选后详情/阅读链接恢复。归档批量恢复后，计数与行同步删除；恢复最后一本时显示空状态。
4. tracker 和 wishlist 各做搜索、阅读/入库/状态筛选、翻页和清空；打开不同条目的编辑弹窗，新增时连续触发查重，确保建议/阻止列表与当前输入一致。
5. jobs 切换 tabs / 页码；让正在执行任务完成或失败，等至少两次 partial polling，核对行、计数、重试按钮、日志与产物链接，再核对分组清空。
6. 规则/主题反复切换并选择不同模板；规则连续运行两组产生不同目录的测试，再测试零目录结果。详情进入编辑、自动填充、保存后返回，检查 spec、检索详情、封面及按钮分支同步变化。
7. 入库连续选择不同文件批次，包含多文件、重复文件、TXT/EPUB 和错误预览，检查旧 article、token、重复提示与目录均被替换。
8. 阅读器打开 TOC、切章，再以两个不同词查询、加载更多、查询零结果；检查旧结果/mark 消失、链接对应当前结果且加载更多状态正确。检查浏览器 console 无异常。
9. 检查手机更多菜单和 reader 布局切换后的导航显示、确认弹窗开关、通知显示/关闭；有通行密钥配置的环境中检查安全页空列表/已有列表及需要密码时的条件输入框。
