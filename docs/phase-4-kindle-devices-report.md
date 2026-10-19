# Phase 4：Kindle devices & transfer 页面交付

工作目录 `/workspaces/bindery-wt-u1`，分支 `feat/p4-kindle-devices`。仅修改本切片文件；未修改其他 worktree、Kindle/boko/server 核心、Python 参考、vendor、UI kit、依赖或配置。未安装包、联网、开启监听端口、启动浏览器、提交、推送或切换分支。RC compat shim 与 `scripts/solid-options.ts` 保持原样。

## 文件及用途

| 文件 | 用途 |
| --- | --- |
| `src/routes/_app.kindle.tsx` | 共用 provider、设备栏、既有 tabs、Outlet；加载本切片 CSS；Kindle 内部链接通过 Router 导航，保留队列 |
| `src/routes/_app.kindle.index.tsx` | 设备书籍页；调用既有 authenticated `loadLibrary` 获取书籍元数据 |
| `src/routes/_app.kindle.transfer.tsx` | 传输页；接入书库查询与设备方案 server function |
| `src/routes/_app.kindle.connect.tsx` | 连接页入口 |
| `src/features/kindle/context.tsx` | 挂载后恢复句柄、订阅设备与队列、监控生命周期、权限操作、清单刷新与过期结果保护 |
| `src/features/kindle/device-bar.tsx` | 检测中、未选择、待配对、授权、连接、断开、拒绝、不支持；型号/分辨率/固件、每秒更新的检测时间、已枚举使用量 |
| `src/features/kindle/devices/connect.tsx` | 连接步骤、选目录、型号/名称配对、记住的设备与授权/忘记 |
| `src/features/kindle/devices/books.tsx` | 设备书表格、封面、来源/搜索/多选、删除确认、重新传入、预览链接 |
| `src/features/kindle/devices/transfer.tsx` | 全书库选择、分页/筛选/搜索、方案/覆盖、任务队列、取消、清除与错误反馈 |
| `src/features/kindle/devices/library.ts` | 逐页复用现有书库查询、去重并只向页面保留所需元数据；没有复制服务端存储逻辑 |
| `src/features/kindle/devices/navigation.ts` | 只拦截同源 Kindle 普通左键链接；保留 Ctrl/中键、外链、下载和锚点的浏览器行为 |
| `src/features/kindle/devices/format.ts` | 使用量、型号和传入时间显示 |
| `src/features/kindle/devices/boko-license.tsx` | 传输页直接展示 vendored SOURCE.md 与完整 LICENSE，提供固定版本对应源码下载链接 |
| `src/features/kindle/devices/devices.css` | 使用既有 token 的平面布局、细分隔线、使用量条、390px 布局；书籍宽表在自身容器横向滚动 |
| `tests-ts/kindle-ui-devices.test.ts` | 20 项真实 Solid SSR/client 编译与 hydrate/交互回归，复用 fake FS 和 client DOM |
| `tests-ts/kindle-ui-devices-production.test.ts` | 1 项实际 production fetch handler 的 SSR、鉴权及四个方案 RPC CRUD 验证，无 sockets |
| `docs/phase-4-kindle-devices-report.md` | 本报告 |

既有 `src/features/kindle/tabs.tsx` 保留；父布局的导航处理让其普通 `<a>` 在 Kindle 内执行 SPA 导航。没有新建路由或改生成 route tree。`tests-ts/support/fake-fs.ts` 已由核心切片提供所需 Chrome 语义，本次直接复用，没有重复实现或修改共享测试支持。

## 实现决策和页面接线

### SSR、生命周期与另一页面 worker 的接入

SSR 与首次客户端 render 总是从 `ready() === false`、空设备清单/任务快照开始，显示“检测中…”。不在 render 中以 `typeof window` 分支。`onSettled` 后才检查浏览器支持、访问 IndexedDB、恢复首个记住的设备、订阅 queue、启动核心的可见性/focus/1500ms 监控。恢复只 queryPermission，不自动弹授权。

manager 的构造不调用浏览器 API，`kindleManager()` 保留惰性单例。`useKindleManager(): KindleDeviceManager | null` 的导出与类型保留；**在 provider 内 SSR 也会返回惰性的 manager 对象**，不再以 `typeof window` 决定是否返回 null。不要把 manager 的存在当作浏览器支持或已连接状态。

给 preview/fonts worker 的推荐 API：

```tsx
import { useKindle } from '../context';
const k = useKindle();
// render 使用 k.ready()、k.state()、k.inventory()、k.inventoryBusy()。
// 必须等 ready 且 state.status === 'granted' 才开始设备工作。
// 安装/删除字体等操作成功后：await k.refreshInventory();
```

`k.manager` 提供已有核心 manager；`k.refresh()` 重新探测并读取清单；`k.loadRemembered()` 更新记住的设备；`k.run(async () => ...)` 在设备栏显示统一错误并管理 busy。页面不要另启监控或在卸载时取消整个 queue。已有直接使用核心订阅的页面也应遵守初始中性渲染。`KindleProvider` 的可选 manager/queue 参数用于注入测试，产品默认使用既有单例。

枚举在首次连接、重连、切换设备、显式重新检测及任务结束时触发，不每 1.5 秒扫描整台设备。过期枚举结果有 revision 保护；切换/断开立即清掉旧清单。每次探测会产生新 DeviceState，设备 ID 经过显式 memo 去重，避免探测重置表格选择、删除对话框或排版方案。枚举使用 manager 即时 snapshot，避免 Solid 2 同一轮 setState 后读到旧 render snapshot。

目录选择和权限申请都从点击同步进入核心 API。记住的非当前设备先直接调用其句柄的 requestPermission，再 restore，避免先 await IndexedDB 导致用户激活丢失。忘记仅删除本机记忆，不改设备身份或文件。

### 书籍、传输和数据边界

- 书籍来源以核心 inventory/manifest 为准；Bindery 书的标题/作者来自当前书库，库中已不存在时退回文件名。排版方案名、传入时间来自 manifest。第三方书不猜作者、传入时间或缩略图。
- 封面优先读取 manifest 记录的设备 thumbnail；不可读时退到书库封面，再由既有 BookCover 生成封面。Blob URL 在行销毁/离页时释放。
- 删除确认明确解释匹配 `.sdr` 中的阅读位置/标注也会删除、共享缩略图由核心引用计数保护、第三方缩略图不猜测。逐本使用核心 deleteBook；部分成功后的重试仅处理剩余书籍。切换设备会关闭旧确认并清空选择，提交时也核对即时设备身份。
- 重新传入调用 `enqueue(device, book_id, recorded_profile_id, { overwrite: true })`。核心覆盖策略是该 book_id 的**首份 Bindery 副本**；同书有多个副本时在通知和按钮提示中说明，不声称能指定具体文件。已从书库移除的书禁用重新传入。
- 传输默认不覆盖。勾选“覆盖设备上的同名书”时进一步说明：仅替换 Bindery 记录的同一本书，保留文件名及 `.sdr`；第三方或不同书籍同名时另存副本。按当前设备 ID 获取方案，默认方案保持核心含义。获取失败可重试，也仍可选已有默认方案。
- queue 的真实“等待/转换/写入/完成/失败”和 message 直接显示。转换/写入用不定进度条，不伪造百分比；队列跨 Kindle 子页继续。刷新/关页会中断，页面明确说明。任务完成/失败都会重新枚举当前设备。
- 书库读取遵守现有每页最多 96 条的 API，读取所有页后在选择器按 24 条分页，避免只展示第一页导致旧设备书元数据或可传书籍缺失。只保留 id/title/author/cover/read，没有把 BookView 的服务器 path 放进本页面 loader 返回值。
- 使用量只标“已枚举文件”，显示书籍/字体/其他及细条；不显示总容量、剩余容量或盘符。未实现已放弃的“书库有更新”和“压缩超大图片”。
- boko 许可说明位于 `/kindle/transfer#boko-license`，展开即可读取未经改写的 SOURCE.md、完整 GPL 文本以及 `https://crates.io/api/v1/crates/boko/0.5.0/download`。采用页面内的静态内容，避免新增范围外的服务路由；不假设 vendor 目录本身可从网站访问。

## 验证结果

最终门禁：

```sh
pnpm build
pnpm typecheck
PYTHONDONTWRITEBYTECODE=1 pnpm test
git diff --check
```

- `pnpm build`：通过。既有 inputValidator 弃用和 ingest ineffective dynamic import 提示仍存在。主 client 构建包含 `assets/worker-BLY6qYZ7.js` 与 `assets/boko_bg-CtpnVc2R.wasm`，二者都在 PWA precache 清单中。
- `pnpm typecheck`：通过。
- 全量 `pnpm test`：最终复跑 **47 文件、921 测试通过，0 失败/跳过**。环境变量用于避免 Python 对照执行生成参考目录 bytecode，没有修改测试选择或期望。
- 本切片新增 **2 文件、21 测试**，包括三页的 hydration 后设备状态变化和真实生产 RPC 集成。
- `git diff --check`：通过。最终文件清单均在授权归属内，生成 route tree 无 diff。

新增 **21 项测试**：20 项 UI/导航/书库读取，1 项 production handler 集成。覆盖三页中性 SSR hydration 后恢复设备、拔插后更新、浏览器不支持、首配型号/名字、忘记不删磁盘身份、点击直接授权与拒绝说明、目录选择错误/取消、书目来源/搜索/空态、删除 book/sidecar/thumbnail/manifest/usage、批量部分失败重试、换设备清理选择、封面 URL 释放、按记录方案覆盖、库筛选/分页/选择保留、重复探测保留选择/方案、队列跨页继续/取消/清除/完成刷新/失败、方案失败重试及许可源码内容。

production handler 测试直接消费当前构建：匿名访问三个页面和四个 RPC 都被鉴权；登录后 `/kindle`、`/kindle/connect`、`/kindle/transfer` 返回中性 SSR 与 no-store；从实际 resolver manifest 找到 list/create/update/delete 四个方案 RPC，执行真实创建、修改、按设备隔离的读取和删除。所有数据库/书库均为 `/tmp` 临时数据。

开发中发现并修复的失败：首次订阅后同轮 signal 旧值导致 connected 但无清单；重复 probe 通知触发 effect 导致选择/确认框被重置。测试采用 manager snapshot 和 ID memo 后验证修复。共享 Node-tree DOM 没有 CSSOM、body，本测试只在局部补充使用量条 style 和 toast 所需的最小实现；没有放宽生产逻辑或修改共享 helper。新 production 子进程检查沿用既有测试的临时结果文件，避免将 stdout 是否被环境转发当作完成依据。

一次全量测试出现既有 `library-production.test.ts` 子进程 Node 24 的 `FATAL ERROR: v8::ToLocalChecked Empty MaybeLocal`，栈在 `node::cjs_lexer::Parse / cjsPreparseModuleExports`；该项单独复跑通过。没有把它归因为页面逻辑，也没有修改已有测试。最终全量复跑结果见上述门禁。

## 共享请求与未验证项

1. **新书体积预估需要共享数据支持。** 现有 `loadLibrary` / BookView 不含文件大小，不能可靠给出未转换 KFX 的体积。页面显示“待转换后确定”；已有设备副本按实测大小显示“约 N（按设备已有副本）”，混合选择区分待定书籍，不填假数字。若必须在首次传输前显示数值，请共享书库查询提供 `epub_size: number | null`（对现有 EPUB 只 stat，不执行 CSS 同步），页面可标注“源 EPUB 参考大小”；KFX 实际大小仍以转换结果为准。未使用 HEAD `/book/:id/download` 探大小，因为该共享 handler 同样先执行 ensureBookEpubCss，会为仅浏览选择器引入源文件更新。
2. 若产品需要逐行覆盖**指定副本**，请核心在 TransferOptions/queue.enqueue 增加并验证目标 filename（只允许同设备 manifest 中同 book_id 的记录）。当前公开 API 只支持首份匹配，页面已如实提示；本切片未改核心。
3. 核心报告关于既有下载端点 lazy CSS sync 的源 EPUB 副作用仍适用；转换和 Kindle 排版本身只在浏览器副本上执行。是否要提供纯快照下载由主控在共享层决定。
4. preview/fonts worker 请使用上面的 context 生命周期，并在字体操作后刷新共用 usage。它们的页面仍由另一切片提供，本 worktree 不实现或验证其最终 UI。
5. 主构建已产生独立 Worker/WASM，且 `dist/client/.vite/pwa.json` 已列入二者；PWA 文件没有修改。集成另一切片后仍需在 Chrome 实际 CacheStorage 核对新构建 URL。
6. 实际 FSA 授权弹窗、IndexedDB native handle 跨重启克隆/授权、真实浏览器 Worker/canvas、390px 排版、KPW3 入库/封面/排版/阅读进度、KO3 均未在本 sandbox 验证，需执行下面步骤。

## 主控 Chrome / Edge 人工验收

以下在允许开服务与浏览器的集成环境执行；本 worker 没有执行。使用测试书库和可删除样本，不要拿唯一的实机阅读记录做删除试验。

### OPFS 假 Kindle：页面与导航

1. 在 Windows Edge/Chrome 打开集成应用并登录，进入 `/kindle/connect`。Console 和 Network 保持打开，正常刷新一次：无 hydration 报错，先“检测中…”再进入实际设备状态。通过 Device Toolbar 设 390×844：tabs、按钮、表单和队列不撑宽页面；设备宽表只在自己的区域横向滚动，所有操作可触达；Tab/Enter/Escape 可操作选择和确认框。
2. Console 创建原生 OPFS 测试根，覆盖本页的 picker（只用于该标签测试，不改产品代码）：

   ```js
   const opfs = await navigator.storage.getDirectory();
   const testRoot = await opfs.getDirectoryHandle('bindery-kindle-ui-test', {create: true});
   const documents = await testRoot.getDirectoryHandle('documents', {create: true});
   const system = await testRoot.getDirectoryHandle('system', {create: true});
   await system.getDirectoryHandle('thumbnails', {create: true});
   await testRoot.getDirectoryHandle('fonts', {create: true});
   const put = async (dir, name, text) => {
     const out = await (await dir.getFileHandle(name, {create: true})).createWritable();
     await out.write(text); await out.close();
   };
   await put(system, 'version.txt', 'Kindle UI test firmware');
   await put(documents, '外部示例.txt', 'external book');
   const nativePicker = window.showDirectoryPicker;
   window.showDirectoryPicker = async () => testRoot;
   ```

3. 点击“选择 Kindle 目录”，首次出现配对表单，选 KPW3、填“测试 Paperwhite”、保存。设备栏应显示 1072×1448 / 300 ppi / 6″、测试固件和已枚举分类；没有盘符/总容量/剩余空间。Console 读取 `await (await (await testRoot.getDirectoryHandle('.bindery')).getFileHandle('device.json')).getFile().then(f => f.text())`，核对模型/名字/id。切到设备书籍，外部 TXT 的来源为其他，格式 TXT、作者未知，时间和方案为“—”。筛选和搜索均生效。
4. 传书页准备至少两本有效 EPUB，其中一本带封面；先确认“不在设备/未读/全部”、搜索、多选、本页全选、跨页选择和计数。默认方案传第一本；合入另一 worker 后创建一个方案并传第二本。选择后停留 5 秒并点“重新检测”，选择和方案不得重置。未转换书籍应显示大小待定；已有副本显示大小依据。
5. 开始批量传输，观察真实转换/写入 message、不定进度和成功/失败。使用顶部 Kindle tabs 在设备书籍、连接、传书之间来回切换；Network 不应新增 document 请求，队列不重建、不重新执行已完成项。预览链接应为 `/kindle/preview?book=<id>`。取消等待/正在转换项，出现取消消息；清除已结束不移除尚在运行的任务。完成后“不在设备”自动去掉已传入书。
6. 设备书表格显示书库标题/作者、Bindery 来源、方案、大小、传入时间；有封面时使用设备 JPEG，缺封面时生成。对同一书分别取消/勾选覆盖重传：前者产生另存副本，后者按核心策略覆盖首份 Bindery 副本。重新传入使用该行记录的方案；若方案已删除应明确失败，不默默替换默认方案。
7. 给一个可删除样本创建匹配的 `.sdr`（如 `documents/书名.sdr/position.txt`），多选后点删除：确认框解释阅读记录和缩略图；取消不变；确认后书、`.sdr`、manifest 记录和无其他引用的 Bindery thumbnail 消失，分类大小更新。保留其他文件、calibre 和 OS 保护目录。删除其他来源书时不猜删 thumbnail。
8. 模拟拔插（仅当前已选择的 OPFS 原对象，不刷新标签）：

   ```js
   const getDirectory = testRoot.getDirectoryHandle.bind(testRoot);
   let unplugged = false;
   testRoot.getDirectoryHandle = (...args) => unplugged
     ? Promise.reject(new DOMException('unplugged', 'NotFoundError'))
     : getDirectory(...args);
   unplugged = true; // 约 1.5 秒后：断开，最后检测时间继续增长
   // 稍后单独执行：
   unplugged = false; // 约 1.5 秒后自动恢复，无需重新选择
   ```

   切到其他浏览器标签并返回/聚焦窗口，观察立即探测。OPFS 无法验证系统 USB 和真实权限弹窗。
9. 连接页“忘记”应只清本机记录；重新选同根仍识别原身份。另建第二个 OPFS 根并填 KO3，列表可在两台之间“授权 / 选择”，显示 1264×1680 / 7″。换设备后不能保留上一台的选择或待删确认。点击 boko 许可链接并展开 summary，核对 SOURCE.md、完整 GPL 文本和 0.5.0 源码下载地址。
10. 测试后执行 `window.showDirectoryPicker = nativePicker`，在界面忘记测试设备；需要清空 OPFS 测试目录时仅删除 `bindery-kindle-ui-test` 这个测试根（先离开设备页），不要清空站点所有存储。

### 真实 KPW3：Windows Edge/Chrome

1. 恢复原生 picker、插入 KPW3，在连接页点击选 **Kindle 磁盘根目录**；误选普通目录应有 documents/system 中文错误，取消选择不产生失败通知。首次配对选 KPW3，名字按用户输入；检查真实 `.bindery/device.json`，再次选择不重写身份。设备栏读取 system/version.txt，名字和分辨率正确，不显示虚构盘符/容量。
2. 页面可见时拔线，约 1–2 秒进入断开；等待时最后检测秒数递增。重插同一设备自动恢复且不重新选目录。隐藏标签至少 5 秒再回来、重新聚焦窗口，应立即探测。
3. 完整退出浏览器再打开 `/kindle/connect`：已记住设备进入需要授权，只有点击“授权”才弹框；记录“每次访问都允许”选项的实际文案及 Edge/Chrome 版本。分别验证拒绝后的修复说明、再次授权恢复。另用不支持 FSA 的浏览器检查明确提示和禁用选目录按钮。
4. 从测试库传带封面的有效 EPUB，默认和一个自定义方案各一次。Network 确认 EPUB 从书库下载，KFX 在浏览器 Worker 中生成；构建的 worker JS/WASM 加载正常，Canvas JPEG 没有跨源错误。传输中在 Kindle tabs 导航，任务继续；取消转换项；再传成功。检查 documents 中 KFX、system/thumbnails 的真实记录名和 manifest。
5. 从系统安全弹出 Kindle，在实机确认新书可打开、章节/排版正确、KPW3 书库封面能显示。读几页形成进度，再接 USB 勾选覆盖重传，安全弹出后核对阅读位置仍在。只对可丢弃样本执行删除及 `.sdr` 清理验收。
6. 实测传输中拔线和重新插入：失败有明确消息，重连由核心恢复日志，重新检测后列表与 manifest 一致；重试可成功，原有其他书籍/阅读记录/保护目录不变。空间不足只在可控测试介质/测试设备验证，不为此填满用户设备。
7. KO3 接入后重复以上授权、固件、1264×1680、封面和排版检查；目前未宣称 KO3 实机通过。

建议提交消息：`:sparkles: feat(kindle): Add device management and browser transfer pages`
