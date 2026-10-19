# 阶段 4：Kindle 排版预览与字体管理

工作目录 `/workspaces/bindery-wt-u2`，分支 `feat/p4-kindle-typeset`。仅修改本 slice 的两个路由、`src/features/kindle/typeset/**`、`tests-ts/kindle-ui-typeset*.test.ts` 和本报告。没有 commit / push / 切分支，没有访问其他 checkout，没有联网、监听 socket、启动浏览器或安装依赖。Kindle/boko core、共享 server/UI/shell/styles、RC shim 与 `wrapConditionals: false` 均保持原样。

## 文件及用途

| 文件 | 用途 |
| --- | --- |
| `src/routes/_app.kindle.preview.tsx` | 书籍查询参数、初始书库/章节 loader、两个鉴权 RPC、共享 profile RPC 接线、Router / beforeunload 未保存保护 |
| `src/routes/_app.kindle.fonts.tsx` | 字体页与 manager 接线；「用它预览」使用站内导航保留当前设备 |
| `src/features/kindle/typeset/preview-page.tsx` | 按设备隔离的方案列表、默认方案保护、编辑/保存/另存/删除/重置、设备/书籍/章节选择 |
| `src/features/kindle/typeset/fonts-page.tsx` | 字体清单、样式覆盖、文件选择/拖放、安装前分组确认、删除确认、重新扫描 |
| `src/features/kindle/typeset/device.ts` | mount 后才订阅设备与读取 remembered；清理订阅、忽略已卸载页面的异步响应 |
| `src/features/kindle/typeset/frame.ts` | 单文档 FontFace 生命周期、保留书籍样式并追加 profile 样式、禁止正文链接跳离预览 |
| `src/features/kindle/typeset/frames.tsx` | 按型号缩放的隔离章节 iframe；隔离字体样张 iframe；接管水合前已加载完的章节 |
| `src/features/kindle/typeset/model.ts` | 字体批次检查与家族分组、型号尺寸、大小格式、预览数据类型 |
| `src/features/kindle/typeset/preview.server.ts` | 本 slice 的只读服务端查询；最近书籍排序、EPUB 筛选、真实目录提取 |
| `src/features/kindle/typeset/typeset.css` | 两个页面的 flat 布局，复用现有 token；响应式编辑器、设备框、字体表格 |
| `tests-ts/kindle-ui-typeset.test.ts` | production browser + SSR 双编译、真实 hydrate、设备与交互回归（16 项） |
| `tests-ts/kindle-ui-typeset-model.test.ts` | 字体生命周期/校验、真实 EPUB 查询与无副作用检查（8 项） |
| `tests-ts/kindle-ui-typeset-production.test.ts` | 无 socket 的构建后 SSR 与六个 RPC 鉴权/CRUD（1 项） |

## 行为与决定

- SSR 与客户端首次渲染均为相同的中性状态。组件不会在 render 时读取 manager snapshot，也不按 `typeof window` 产生不同标记；`onSettled` 后订阅设备并读取 remembered。每次核心 1.5 秒探测不会重新枚举整个设备：只在连接状态/设备身份变化、切换方案所属设备或手动重新扫描时读取。
- 默认方案不可修改、删除。先「另存为」创建自己的方案；重置恢复当前方案最近一次保存的值。每项数值支持恢复为 null（沿用书籍），不把默认方案偷偷转成一套固定参数。范围与 core 一致：em 参数 0–20，行高 0.5–20。
- 自定义 CSS 使用共享 `validateCss`，完整 settings 也经过共享 `profileSettings` 校验。校验失败时禁用保存并保留 frame 上一次有效样式；字体权限失效仍会清理 FontFace。生成 CSS 为只读。共享校验器是语法/参数检查，浏览器安全边界继续由原 EPUB 响应 CSP 与无脚本 sandbox 提供。
- 保存、另存为、删除调用 `src/server/kindle/functions.ts`；未增加另一套配置存储。切换方案/所属设备、重置会检查未保存修改；离开路由交给 Router blocker，刷新/普通文档跳转交给 beforeunload。外部设备切换时，已有脏草稿仍绑定原设备，显示说明，保存不会误写到新设备。
- 没有连接的设备时可选择记住的设备，按其型号预览并编辑服务器上的方案；此操作不会打开它的 FSA 句柄或申请权限。也可以仅选择 KPW3/KO3/other 型号预览书籍，此时不能持久保存方案。other 使用 KPW3 尺寸并在型号选项中明确说明。
- 初始书籍使用 `?book=<book_id>`，否则选有 EPUB 的最近更新书籍；排除归档/缺 EPUB 的条目。无效的 book 参数有中文说明并回退最近一本。读取目录不调用阅读器打开流程，不同步修改原 EPUB，不更新阅读进度。切书时忽略过期章节响应，读取失败可重试。
- 章节 iframe 的 src 是既有 `/book/{id}/epub/{item_path}`（逐路径段编码），保留原书 CSS，末尾追加方案 CSS。只有 `sandbox="allow-same-origin"`，没有 `allow-scripts`、srcdoc 或脚本桥接；资源端的 CSP 不变。预览内正文链接不跳走。缓存章节可能在 hydration 前已加载完，mount 后会检查并接管。
- 画布按 KPW3 1072×1448 / KO3 1264×1680 的真实比例，`ResizeObserver` 缩放到当前容器；预设根字号 40 CSS px，约对应 300ppi 下 9.6pt 的参考基线。书籍自身字号继续参与级联。这是可比较排版的预览，不承诺逐像素等同 Kindle；页面明确说明 Kindle 自身字号/边距及引擎差异。
- `loadPreviewFont` 加载所选家族全部字重/样式，只 add 到章节或字体样张各自的 document.fonts。切换、断连、卸载时 delete；较晚完成的加载不会重新注册。应用 document.fonts 不注册任何设备字体。字体样张由脚本禁用的独立空 iframe 承载，文本用 textContent 创建。
- 字体家族/样式复用核心 OpenType 检查，不另写解析器。表格显示文件名、手动安装来源、真实字体样张、R/B/I/BI 缺失弱化、Light/Medium 等额外字重、大小和操作。设备自带字体不冒充 fonts/ 文件列出。
- 文件选择与页面拖放共用检查：仅 TTF/OTF，拒绝损坏文件和大小写不敏感的重名批次。先显示分组与文件名，确认才写设备。同名设备文件由 core 拒绝覆盖。整家族删除有确认，使用 core 的锁/身份检查/事务。`._*` 资源文件与 Readme.txt 由已有清单实现忽略；重启或重新插拔、缺字重模拟的说明已显示。
- 「用它预览」保留真实 `?font=` 链接并通过 Router 进行普通点击导航，保留当前 manager；预览页建立未保存的字体预览副本，不改默认或已有方案。新标签/无脚本跳转仍有可用 href。

## 验证

最终门禁：

- `pnpm build`：通过。仍有项目现有的 `inputValidator` deprecated 与 ingest ineffective dynamic import 警告；新增两个查询函数沿用现有 validator 接线惯例。
- `pnpm typecheck`：通过。
- `pnpm test`：**48 个文件、925 个测试通过，0 失败**。
- 本 slice 新增 **25 个测试**：UI 16、模型/文档/EPUB 8、构建后集成 1。
- `git diff --check`：通过；最终状态仅包含所有权内的修改。

UI 测试复用现有 `tests-ts/support/fake-fs.ts` 和 `client-dom.ts`，没有修改共享 support。fake 真实走 core 配对/枚举/安装/删除/事务路径，包含 NotFoundError 拔插与 prompt 权限。DOM 测试仅在自己的文件内补充 style/property reflection，不模拟布局。

覆盖两个页面的 SSR→hydrate→设备变化、断连后清空/重连恢复、默认保护、CRUD、未保存切换/重置、保存失败保留草稿、设备变化不重定向草稿、无设备记忆型号、非法字体参数、切章竞态、字体输入/拖放/确认/冲突/删除/忽略文件、卸载晚响应，以及水合前加载完成的章节接管。文档测试验证 FontFace 不污染应用、全部真实样式注册、清理和晚加载、无效 CSS 时仍清理字体。EPUB 测试读取实际书籍目录并比较原始字节/进度不变。

构建后测试调用真实 production handler，不开端口：两页匿名 303、登录 SSR；新增 getPreview/getChapters 与四个共享 profile RPC 的匿名拦截；有会话的目录查询和 profile create/update/list/delete，及设备隔离。测试直接读取构建 manifest 定位 RPC；POST 使用当前 Solid RC 的 `X-Server-Function-Format: 8` JSON 数组协议。最初省略此格式标签会把数组当一个参数，返回 400；补齐实际客户端协议后通过，没有修改生产代码来迁就测试。

## 尚未实测与共享文件请求

1. 本 sandbox 没有运行 Chrome/Edge，不能证明真实字体解码、iframe FontFaceSet、CSP 实际执行、ResizeObserver 缩放、原生 dialog/beforeunload 焦点或 KPW3 固件表现。Node 测试不替代下面的检查。
2. 真实字体大文件解码的内存/耗时、Kindle 在重启/重新插拔后的字体识别、实际传书排版，仍由主控在设备上验证。KO3 只有尺寸与记忆型号路径的自动覆盖，尚无实机。
3. **没有 core、依赖或共享文件变更请求。** 合并另一 Kindle worker 的 provider/设备栏/连接页后，请保留 `useKindleManager()` 返回当前长生命周期 manager 的契约。本 slice 不启动/停止 shell 的探测循环，也不实现另一 worker 的连接页。
4. 集成时保留 `scripts/solid-options.ts` 与现有 RC shim，并在合并全部 worker 后重跑三项门禁。两个页面的独立 hydration 与完整生产 SSR/RPC 已测，整个 Start 浏览器 bootstrap、其他 worker 的共享布局仍需合并后人工检查。

## 主控的 Windows Edge/Chrome 检查

使用允许启动服务/浏览器的主控环境；以下步骤没有在本 sandbox 执行。先使用有真实章节与 CSS 的 EPUB，准备一个包含 R/B/I/BI 的家族及只有 R/Light/Medium 的另一个家族。

### 可选：用 OPFS 建立假 Kindle

开发服务登录后打开 `/kindle/fonts`，Console 执行（只写专用 OPFS 子目录）：

```js
const k = await import('/src/client/kindle/index.ts');
const { kindleManager } = await import('/src/features/kindle/context.tsx');
const opfs = await navigator.storage.getDirectory();
const root = await opfs.getDirectoryHandle('bindery-typeset-check', { create: true });
await root.getDirectoryHandle('documents', { create: true });
const system = await root.getDirectoryHandle('system', { create: true });
await root.getDirectoryHandle('fonts', { create: true });
const stream = await (await system.getFileHandle('version.txt', { create: true })).createWritable();
await stream.write('OPFS test firmware');
await stream.close();
const device = await k.pairDevice(root, 'KPW3', 'OPFS Paperwhite');
const dm = kindleManager();
await dm.restore({ id: device.identity.id, identity: device.identity, root });
```

使用应用同一个 manager，字体页应该从中性状态更新。OPFS 不能验证 USB 拔插、Windows 目录选择对话框或浏览器重启后的授权；这些必须在实机上做。使用生产服务时，通过连接页选择一个包含 documents/system/fonts 的专用本地测试目录即可，不使用开发 import。

### 页面与浏览器行为

1. 字体页添加一个 R/B/I/BI 批次：确认先列出分组、文件名和大小，设备 fonts/ 尚未写入；取消后应仍无文件。再添加并确认，核对四种覆盖与真实样张。拖入 R/Light/Medium 批次走同样确认流程；拒绝 WOFF、损坏 TTF、同批大小写重名。再选已有文件，核对明确的同名错误与原文件字节不变。向测试根目录放入 `fonts/._test.ttf` 与 `fonts/Readme.txt`，扫描不能把它们列作字体。
2. 点击某家族「用它预览」：URL 含 `?font=`，通过站内导航保留当前设备；预览选择该字体、显示未保存副本，默认方案仍不可编辑。检查 `document.fonts` 没有新增设备字体；章节 iframe 的 contentDocument.fonts 中有该家族的真实样式。回字体页后旧 frame 的 FontFaceSet 应清空。样张 iframe 同样单独注册，应用的导航/按钮字体不改变。
3. 直接进入 `/kindle/preview?book=<真实 book_id>`，选择指定书籍，切章可见其真实文字/图像/原 CSS；中文/空格路径正常。再无 book 参数进入，核对最近更新的有 EPUB 书籍。指定缺失 id、无 EPUB、空书库、章节读取失败分别有相应说明；修复数据后可点「重新读取章节」。快速切两本不同章节的书，不出现上一请求的目录或内容。
4. 默认不可改/删；另存为后拖五个滑杆、切对齐/字体、填写自定义 CSS，生成区立即同步。每项「沿用书籍」只清该覆盖；保存后刷新、重新选同一记忆设备，值仍在。另存为不改原方案；删除确认只删该自定义方案。另一个设备不出现这些方案。
5. 输入 `p {`，显示共享校验错误、不能保存，预览保留上次有效样式；补完后继续。修改后切方案/所属设备、重置，分别取消与确认；修改后导航、后退、刷新，检查原生或 Router 离开保护。DevTools Offline 后保存，应显示错误且保留草稿；恢复网络后可保存。存在脏草稿时在连接页之外通过 manager 恢复另一设备，草稿仍属于原设备，保存不改新设备。
6. 不选设备时选择 KPW3/KO3/other，再选择记住的 KO3，核对尺寸分别为 1072×1448 / 1264×1680 / KPW3 fallback。记忆设备未授权时不自动弹权限框，仍可读/改方案；设备字体说明为不可用。缩放窗口至 1440、850、390px，框内画布保持比例，不裁掉页面操作。
7. 保持章节缓存，直接刷新预览页并快速等待页面出现；方案 CSS 应正常应用（覆盖 iframe 在 hydration 之前已完成加载的情况）。检查 iframe sandbox 不含 allow-scripts；章节响应 CSP 保留 `script-src 'none'`。用含 script/onerror/外链资源的测试 EPUB 重复 phase 3 隔离检查，不能执行书籍脚本或改变应用 DOM；父页面只向 frame 追加样式/字体。
8. 在字体页删除刚添加的测试家族：取消不变、确认后所有样式文件消失，其他家族、Readme、资源文件和非 fonts 内容不变。预览再选旧方案会说明缺失字体，可改为设备默认；不自动改写任何已有方案。

### KPW3 实机

1. Windows Edge/Chrome 用另一 slice 的连接页选择真实 Kindle 磁盘根目录、配对 KPW3。两页进入后正常更新，不出现 SSR 旧节点、重复表格或客户端异常。确认不出现虚构盘符/磁盘总量；字体页总大小只来自枚举的字体文件。
2. 添加专用测试家族并核对设备 `fonts/` 字节与样张；拔线等待约 1–2 秒，字体页禁用操作/清空清单，预览保留脏草稿并移除设备 FontFace。重新插入同一 KPW3，原句柄恢复，重新扫描出现该家族。完整退出浏览器再开，未授权时不能读写字体；点击连接页授权后恢复。OPFS 不能替代本步骤。
3. 新字体在 Kindle 上重启或重新插拔后应可选。使用传书 worker 的页面选择该方案，把同一本书发送两份可区分的测试副本；安全弹出后在 Kindle 上对比左右/上下边距、行高、段距、缩进、对齐和家族，并固定 Kindle 自身字号/边距。检查真实粗/斜体与缺样式模拟的差别。预览与实机存在渲染差异时记录固件、方案参数与书籍样式，不把浏览器比例当像素等效证明。
4. 只删除新添加的测试家族，重新插拔/重启后核对字体列表更新；确认原有字体、书籍与阅读进度未受影响。KO3 接入时重复上述实机流程。

建议 commit message：`:sparkles: feat(kindle): Add typesetting preview and font management`
