# 阶段 4：Kindle core 交付报告

工作目录 `/workspaces/bindery-wt-k`，分支 `feat/p4-kindle-core`。仅实现非视觉引擎，没有改 Kindle 占位页、设计、UI、PWA、Python 参考或 vendored boko；没有安装依赖、联网、开监听端口、启动浏览器、commit 或 push。

## 文件及用途

| 文件 | 用途 |
| --- | --- |
| `src/client/kindle/index.ts` | 页面接入的公开入口、错误消息及 FSA 结构类型 |
| `src/client/kindle/fs.ts` | Chrome FSA 的最小结构接口、原子 close/abort 包装、受保护路径与中文错误 |
| `src/client/kindle/identity.ts` | 根目录校验、`.bindery/device.json`、型号参数、固件读取、写入前身份核对 |
| `src/client/kindle/remembered.ts` | IndexedDB `bindery-kindle` / `devices`；按设备 id 存句柄与身份，事务提交后才确认成功 |
| `src/client/kindle/device.ts` | 选择、配对、恢复、授权、连接探测、订阅、Solid signal 桥接 |
| `src/client/kindle/manifest.ts` | manifest v1 严格解析、序列化与 thumbnail 名称 |
| `src/client/kindle/inventory.ts` | documents 递归书籍清单、同目录 `.sdr`、来源、字体与已枚举大小 |
| `src/client/kindle/fonts.ts` | TTF/OTF name table 解析、家族及字重、安装/删除、预览 FontFace |
| `src/client/kindle/profiles.ts` | 排版数据模型、默认配置、共享 CSS 校验、确定性 CSS 生成 |
| `src/client/kindle/epub.ts` | 使用现有 core archive/XML/CSS link 工具，在副本上追加独立排版样式表 |
| `src/client/kindle/thumbnail.ts` | 封面等比例缩放为 330×470 JPEG，白底留边 |
| `src/client/kindle/transaction.ts` | 设备写入锁、写前备份、持久恢复日志、失败回滚 |
| `src/client/kindle/transfer.ts` | 下载 EPUB → 应用配置 → Worker 转换 → KFX/缩略图/manifest 写入 |
| `src/client/kindle/operations.ts` | 删除书籍及对应 `.sdr`、Bindery 写入的缩略图与 manifest 记录 |
| `src/client/kindle/queue.ts` | SPA 生命周期的顺序传输队列、取消、订阅与 Solid 桥接 |
| `src/client/boko/client.ts` | 单任务 Worker 客户端、buffer transfer、取消时 terminate |
| `src/client/boko/worker.ts` | Vite WASM asset URL、阶段事件、Worker 内运行转换 |
| `src/client/boko/conversion.ts` | boko 初始化、`book_info`、`convert`、解析实际输出元数据；Node 测试可传 WASM bytes |
| `src/client/boko/kfx.ts` | 有边界检查的 CONT/ENTY/Ion 子集解析器，提取 content_id/ASIN/cde_content_type |
| `src/server/kindle/migration.ts` | 幂等的可选 `kindle_profiles` 表与 device 索引 |
| `src/server/kindle/profiles.ts` | 按 device id 隔离的配置 CRUD，保护默认配置 |
| `src/server/kindle/functions.ts` | 四个带现有 authenticated middleware 的 server functions |
| `src/server/db/init.ts` | 仅增加 import 与迁移调用两行；没有改旧表 |
| `tests-ts/support/fake-fs.ts` | Windows/Chrome 语义的内存 FSA，支持拔插、权限、原子 close/abort、递归删除、操作日志与故障注入 |
| `tests-ts/kindle-{device,transfer,conversion,profiles,browser}.test.ts` | 30 个测试，详见验证部分 |

## 对外 API 与生命周期

页面从 `src/client/kindle/index.ts` 导入。浏览器端在应用壳层创建并保留一个 `KindleDeviceManager`，用 `useKindleDevice(manager)` 绑定到页面；组件清理只取消订阅。`manager.startMonitoring()` 的清理函数由应用壳持有，切换页面不应调用。监控可见时每 1500 ms 探测，focus/visibilitychange 立即探测，隐藏时停止定时探测。探测读取真实 `documents/` 和身份，重连会检查并恢复未完成事务。

- `pick()` 必须从用户点击直接调用；使用 `showDirectoryPicker({ mode: "readwrite" })`，校验 documents/system。未配对返回 `unpaired`。
- `pair("KPW3" | "KO3" | "other", name)` 创建一次身份，已有身份直接读取；不会通过重新配对覆盖已有型号/名字。
- `remembered()` 返回所有已记住设备；选择一个后 `restore(id)` 只 queryPermission，不弹框。`requestPermission()` 必须从点击直接调用。`forget(id)` 只删本机记忆，当前设备同时退出选择；不删除磁盘身份。
- 状态为 `granted / prompt / denied / disconnected / unpaired`。`checkedAt` 表示最近成功识别/探测设备的时间，`detectedAgo(state)` 返回“检测于 N 秒前”；断连后保留最近成功时间。
- UI 清单使用 `deviceInventory(device)`，它等待正在进行的设备修改并先恢复日志。`inventory(root)` 是底层无锁读取入口，主要供已持锁的操作与测试使用。
- `getTransferQueue()` 是模块单例，跨 SPA 页面导航保留。`enqueue(device, bookId, profileId, { overwrite })` 返回任务 id；`useTransferQueue()`/subscribe 观察 `等待 / 转换 / 写入 / 完成 / 失败` 与 message，`cancel(id)` 取消，`clearFinished()` 清理完成项。
- `transferBook(device, bookId, profileId, options)` 可单独调用；直接并发调用会受到单 Worker 的 busy 约束，批量传书应使用队列。队列不跨浏览器刷新持久化；写入阶段中断由设备端日志恢复。
- `deleteBook(device, filename)` 支持清单返回的 documents 相对路径；`installFonts(device, File[])`、`deleteFontFamily(device, name)` 都持有同一设备锁。
- `loadPreviewFont(device, font)` 返回已加载的 `FontFace`。页面自己 add 到 document.fonts，并在预览销毁时 delete；别将其注册进全局样式污染应用。

## 身份、清单和文件安全决策

型号为 KPW3 1072×1448 / 300 ppi / 6 英寸，KO3 1264×1680 / 300 ppi / 7 英寸；other 的屏幕参数为 null。固件读取 `system/version.txt`，缺失为 null。身份/manifest 内容损坏会明确失败，不自动重置或覆盖用户记录。

manifest 格式为 `{ version: 1, books: [...] }`。条目包含 `book_id, filename, content_id, cde_content_type, profile_id, profile_name, transferred_at, size, thumbnail`；thumbnail 为 Bindery 实际写入的文件名或 null。书籍大小、mtime 从 File 读取，来源只由 manifest 中的 filename 判断。嵌套的第三方书籍也会列出，`.sdr` 内的内容只计入 other，不当作书籍。

新传输写到 documents 根目录。名称保留中文，过滤 Windows 非法字符、保留名、尾部点/空格，限制 UTF-8 长度；按大小写不敏感检查文件、目录与同名 `.sdr`，冲突从 ` (2)` 递增。默认保留所有已有文件；overwrite 只选择 manifest 中同 book_id 的第一份 Bindery 记录，保留其文件名和阅读进度 `.sdr`。同一内容多个副本共享缩略图，删除最后一个引用才移除。第三方书籍的删除不会猜测或删除任何缩略图；存在未记录的同名缩略图时，传输明确失败而不覆盖。

可写位置仅为 documents 中书籍/匹配 sidecar、fonts 中 TTF/OTF、system/thumbnails 中严格匹配名称的 JPEG、以及 `.bindery` 自有文件。OS 目录、macOS resource 文件和 calibre 文件在枚举时跳过，绝不打开或修改其内容。恢复日志的所有目标路径在执行任何恢复前统一验证，无法借损坏日志修改 version.txt 等文件。

设备操作通过进程内队列与 `navigator.locks`（浏览器支持时）串行化。修改前先将目标文件/sidecar 备份进 `.bindery/rollback/`，再持久化 `.bindery/pending.json`，最后按顺序写书籍、缩略图、manifest，并标记 committed。失败时尽量立即回滚；拔线或权限撤销阻止回滚时，保留日志与备份，重连/下次操作先恢复。committed 日志只需清理。恢复本身中断也可再次执行。FSA 不支持多文件原子提交或可靠报告物理落盘，日志提供应用层的一致性恢复；覆盖和删除期间需要容纳旧内容的临时备份空间。

usage 是已枚举字节之和：books 为支持的书籍文件；fonts 为有效扩展名的字体文件；other 包括 sidecar、非书籍文件、字体目录其他文件、已读 system/version/thumbnails、自有元数据和可读根文件。未遍历 system 的其他目录，也跳过保护目录，因此不能当作磁盘已用容量。`capacity/free` 明确为 null。

## 排版与数据库

数据为 `TypesettingProfile { id, deviceId, name, settings, builtIn }`。settings 字段：

- `marginX / marginY / paragraphSpacing / textIndent`：em，null 表示不覆盖，允许 0–20。
- `lineHeight`：无单位，null 或 0.5–20。
- `justify`：null/true/false。
- `fontFamily`：null 或设备字体家族名；传输时核实字体仍在设备中，缺失时明确失败。
- `customCss`：字符串，经现有 `src/core/css.ts::validateCss` 校验。

`EMPTY_SETTINGS` 提供所有 null 与空 customCss。`defaultProfile(deviceId)` 的 id 恒为 `default`，名称“默认（只用书籍自带样式）”，生成空 CSS，不能修改或删除。自定义 CSS 按固定顺序输出：body 的左右/上下 margin、p 的 line-height/段距/首行缩进/对齐、body 及所有后代的 font-family，然后追加 customCss。结构化属性加 `!important`，字体名转义双引号和反斜杠；同样参数生成相同文本。现有书中优先级更高的 `!important` 规则仍遵循 CSS 级联，customCss 可按需补充。共享 validator 是语法检查，不是 CSS sanitizer。

EPUB 补丁复用 core 的 archive、XML、appendStylesheetLink：在副本中增加不冲突的 `bindery-kindle-profile[-N].css`，注册到 OPF，并在 XHTML/HTML head 末尾追加 link。保留图像、原 CSS、metadata/identifier、源书 EPUB；默认配置返回相同字节的副本。转换结果仅写 Kindle，不回写书库。

server functions：`listKindleProfiles({data: deviceId})`、`createKindleProfile({data: {deviceId,name,settings}})`、`updateKindleProfile({data: {deviceId,id,name,settings}})`、`deleteKindleProfile({data: {deviceId,id}})`。全部复用 authenticated middleware；这是现有单用户认证模型下按设备隔离的配置，不新增账户体系。

迁移采用首次使用配置仓储时激活：`KindleProfiles` 创建自己的表/索引；正常 DB init 对已存在的表执行同一幂等迁移。未使用 Kindle 的数据库保持旧 schema。这个决策既避免无关 schema 变化，也兼容既有逐字对比 Python sqlite_master 的测试；没有测试环境开关、改旧表、改 Python fixture 或放宽现有断言。新测试核实旧表 DDL/数据完全保留、反复初始化与 CRUD 后重开均正确。

## boko、content_id 与缩略图证据

读取了本机只读 crate：`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/boko-0.5.0/src/kfx/{metadata,serialization,container,ion,symbols}.rs`。本机 metadata.rs 的 188–205 行设置 ASIN/content_id 与 EBOK，309 行的 generate_content_id 使用 identifier 的 SHA-1 前 16 bytes 大写十六进制；没有依赖这个公式自行猜 ID，而是读取 WASM 产出的真实容器。

JS 解析 CONT 固定头、container info 的索引偏移/长度、24-byte entity index 和 ENTY 头，只在 book_metadata（490）中递归读取 key（492）与 value（307），要求 content_id、ASIN 一致且类型为 EBOK/PDOC。限制长度/整数/递归深度，拒绝截断、加密、压缩和不支持的容器版本。此解析器是为当前 boko 无压缩输出编写的 Ion 子集，不作为通用 Kindle 格式解析器。

在测试以外，用 vendored WASM 生成了 `/tmp/bindery-kindle-verification-35LOjD/sample.kfx`。独立 JS 解析得到：

```json
{"contentId":"F8BD0F3C8D937974D0C35F419C178B99","cdeContentType":"EBOK","asin":"F8BD0F3C8D937974D0C35F419C178B99"}
```

随后直接执行：

```sh
/tmp/claude-1000/-workspaces-bindery/c248ea48-0d49-4c57-89c1-81cb8bbc8106/scratchpad/boko-cargo/bin/boko kfx-dump -f metadata /tmp/bindery-kindle-verification-35LOjD/sample.kfx
```

exit 0，原生输出的 ASIN/content_id 均为上述值，cde_content_type 为 EBOK，creator_version 为 0.5.0。没有使用原生工具生成产品 KFX。最初通过 Node execFileSync 调原生工具时 sandbox 返回 EPERM（同时已有 stdout），改为上述直接命令后成功；Node strip-only 模式也不支持 TS parameter property，一次性解析命令使用 `node --experimental-transform-types`，产品与测试不依赖该开关。样本是临时验证材料，不属于仓库或测试前提。

Worker 中以 Vite `?url` 加载 WASM，输出阶段为 loading / inspecting / converting / metadata / done，不伪造转换百分比。同步 WASM 无法处理 cancel 消息，因此取消通过 terminate 整个 Worker；完成/错误同样释放 Worker，下个任务重新创建，避免 panic 后复用损坏实例。进出 buffer 使用 transferable，输入先复制，调用方保留原 EPUB。

缩略图从下载 EPUB 的真实封面提取，浏览器 createImageBitmap/canvas 等比例 contain 到 **330×470**、白底居中、JPEG quality 0.85，不裁剪或拉伸。选择此尺寸作为 KPW3/KO3 共用的轻量 portrait 缩略图；是否被固件按预期显示还需要实机。文件名使用真实 `thumbnail_<content_id>_<cde_content_type>_portrait.jpg`。当前 WASM 确认输出 EBOK；如果以后输出 PDOC，代码会按 PDOC 命名，但归类会变为个人文档，缩略图展示不能沿用 EBOK 的实机结论。

## 验证结果

- `pnpm build`：通过。现有 inputValidator deprecated、ingest ineffective dynamic import 警告仍存在。
- `pnpm typecheck`：通过。
- `pnpm test`：**42 文件、826 测试通过，0 失败**。包括构建后已有的无 socket production-handler 回归。
- 新增 **30 测试**：device 10、transfer 8、conversion 5、profiles 4、browser 3。
- FSA fake 覆盖不区分大小写、File 快照、close 前不可见/abort、递归删除、已删除句柄、拔插同句柄、prompt/denied/granted、focus/visibility 及停止监控、多设备存储、存储事务失败。
- 设备与传输覆盖 manifest 往返、来源与字节数、嵌套 books/sidecar、保护目录、恢复日志路径攻击、SFNT name table、R/B/I/BI/Light/SemiBold、字体安装/删除/预览、碰撞名、只覆盖 Bindery、共享缩略图、下载/转换/取消失败、转换时拔线、写 KFX/manifest 时拔线、覆盖回滚、权限撤销后恢复、队列串行及页面取消订阅后继续。
- Node 直接执行 **vendored WASM**：实际 EPUB→KFX，解析实际元数据；把生成 CSS 的字体与 `text-indent: 3.25em` 从 KFX style 实体读回。测试不调用原生 CLI 或原生 round-trip。
- 独立 Vite browser 构建确认 Worker JS 与独立 `.wasm` asset 都会产出，WASM bytes 等于 vendor，Worker 不含 Node/server 模块。缩略图单测校验比例、尺寸、JPEG 参数和 bitmap 释放；未声称在真实 canvas/浏览器中验证图像。
- 初次全量测试因无条件新增表导致 6 个 Python schema parity 断言失败；改为首次激活的可选迁移后，原断言全部通过，没有修改参考与旧测试。

## 未验证项与对其他 worker/主控的接线请求

1. **实机仍待验证**：系统授权、IndexedDB 对真实句柄的 structured clone、Worker 在 Edge 中的实际运行与性能、真实 canvas JPEG、KPW3 入库/排版/封面/阅读进度、KO3 后续接入。Node fake 不能替代这些。
2. **页面 worker**：在 Kindle 页面/壳层导入公开入口并持有 manager；绑定队列、server functions、字体预览。没有修改 `src/routes/_app.kindle.tsx`，也未建立最终页面或临时 UI。
3. **PWA worker**：页面真正导入 converter/queue 后，Vite 才会将 Worker/WASM 纳入主应用构建；当前主应用保留占位页，因此单独的 browser-build 测试验证产物。请将构建后的 Worker JS 与 `.wasm` asset 加入缓存（仅缓存 WASM 不足以在离线时首次启动 Worker）。不要缓存 EPUB 下载、个人 API 或设备内容。具体 SW 与 manifest 文件不在本 worker 归属。
4. **集成门禁**：页面消费 `src/server/kindle/functions.ts` 后，请再运行完整 build/typecheck/test，并用生产 handler 验证编译后的这四个新 RPC 的鉴权与 CRUD。当前测试验证真实 middleware/数据库逻辑；现有占位页尚未把这些 RPC 纳入应用路由依赖图。
5. 容量 API 无法提供，usage 必须标注“已枚举文件”，不能显示虚构的总容量/剩余容量。事务备份期间临时空间会增加；空间不足应展示明确失败。
6. **既有下载端点的副作用需主控确认**：任务指定的 `/book/<id>/download` 在 `src/server/files.ts::bookDownloadResponse` 中调用 `ensureBookEpubCss`，旧 EPUB 与书库样式不同步时，端点本身可能先更新库内 EPUB。本实现从不把 Kindle 排版回写书库，但不能替该共享端点保证“任何旧书首次下载都不改源文件”。若此要求也包含既有 lazy sync，请主控在共享 download handler 中提供不触发同步的快照读取方式，并接到本引擎；本 worker 未修改权限范围外的 handler。
7. 除上一项共享下载语义外，无其他共享代码修改请求；`src/server/db/init.ts` 两行是本任务已授权的唯一共享代码 hook。RC compat shim 与 `scripts/solid-options.ts` 的 `wrapConditionals: false` 保持不变。

## 主控在 Windows Edge/Chrome 的精确手动步骤

下面可在允许启动浏览器/服务的主控环境、Vite 开发模式先验证引擎；最终页面接线后再用页面重复。此 sandbox 没有执行这些步骤。

1. 在 Windows 用 Edge/Chrome 打开开发站点并登录；插入 KPW3。DevTools Console 执行：

   ```js
   const k = await import('/src/client/kindle/index.ts');
   const dm = new k.KindleDeviceManager();
   const stop = dm.startMonitoring();
   const unsub = dm.subscribe(s => console.log(s.status, s.message, k.detectedAgo(s), s.device?.firmware));
   const button = (label, action) => {
     const b = document.createElement('button'); b.textContent = label;
     b.onclick = () => action().then(console.log).catch(console.error);
     document.body.append(b); return b;
   };
   button('选择 Kindle', () => dm.pick());
   button('授权 Kindle', () => dm.requestPermission());
   ```

2. 点击“选择 Kindle”，先选普通目录，确认出现中文 documents/system 根目录错误；再次点击选择 Kindle **磁盘根目录**，确认 unpaired。执行 `await dm.pair('KPW3', '我的 Paperwhite')`；确认 granted、固件字符串和磁盘 `.bindery/device.json`；`await dm.remembered()` 应含真实句柄。已有 identity 的设备不会覆盖身份。
3. 在可见页拔线，1.5 秒左右应变 disconnected；重插同一设备应恢复 granted，不重新选目录。切走标签至少 5 秒，回来或聚焦窗口应立即探测。刷新后重新创建 manager，`const saved = await dm.remembered(); await dm.restore(saved[0].id)`；完整退出浏览器再打开，应为 prompt；点击授权按钮观察真实“每次访问都允许”选项。拒绝后应 denied，可再次授权。
4. `const device = dm.snapshot().device; const inv = await k.deviceInventory(device); console.table(inv.books); console.table(inv.fonts)`。核对已知文件大小、format、mtime、同目录 sdr、来源、固件；确认 capacity/free 均为 null，total 只是已枚举字节总量，OS/calibre 文件仍存在且未被打开写入。
5. 安装一组合法 R/B/I/BI 与 Light/Medium TTF/OTF（通过真实 `<input type=file multiple>` 的 FileList 调用 `k.installFonts(device, [...input.files])`）。核对字体家族；安装同名文件应失败。`const family = (await k.listFonts(device.root))[0]; const face = await k.loadPreviewFont(device, family.fonts[0]); document.fonts.add(face)`；用该 family 渲染本地预览文字，再 `document.fonts.delete(face)`。删除测试家族，确认其他家族、Readme.txt、`._*` 均保留。
6. 准备书库中一部有封面的测试 EPUB，记录其 32 位 bookId。默认配置先传一次：

   ```js
   const queue = k.getTransferQueue();
   const unsubscribeQueue = queue.subscribe(items => console.table(items));
   queue.enqueue(device, '替换为真实的32位bookId', 'default');
   ```

   Network 确认下载 `/book/<id>/download`，转换在 Worker 中，WASM 使用独立 asset URL；states 转换→写入→完成。核对 documents KFX、manifest 和 system/thumbnails 中实际 content_id 的 EBOK 文件；再次传应新名字，overwrite:true 只覆盖记录的副本。导航到其他 SPA 页面再返回，任务应继续。以完成既有下载端点 lazy CSS sync 的 EPUB 为基准，确认 Kindle 配置不改变书库 EPUB bytes/mtime；未同步旧书的情况见前述共享端点请求。
7. 创建自定义配置：`const rpc = await import('/src/server/kindle/functions.ts'); const p = await rpc.createKindleProfile({data:{deviceId:device.identity.id,name:'实机排版',settings:{...k.EMPTY_SETTINGS,textIndent:3.25,lineHeight:1.75,marginX:0.5,justify:true}}})`。enqueue 使用 p.id；在 Kindle 安全弹出后打开测试书，检查缩进/行高/封面、书籍归类为 Books。设备字体选择与 customCss 也分别测一次；删除默认配置必须被拒绝。登出后四个 RPC 都应要求登录。
8. 使用较大 EPUB，在“转换”阶段拔线，应失败且没有新增磁盘文件；重插后再传。在“写入”阶段拔线，重插后等待探测恢复，核对失败任务的旧书/旧 manifest/旧缩略图/旧阅读进度完整，新建任务没有残留空 KFX。刷新页也应在恢复后继续可操作。磁盘空间不足时核对明确错误与恢复；操作系统安全弹出仍应遵循用户的正常 USB 使用方式。
9. 对测试 Bindery 书调用 `await k.deleteBook(device, filename)`，核对书、对应 sdr、最后引用的自有缩略图和 manifest 记录一起消失。对第三方测试书核对只删书/sdr，不碰 system 中其他缩略图。结束时执行 `stop(); unsub(); unsubscribeQueue()` 清理临时订阅/监控。
10. PWA 接线后清缓存加载一次，核对 Worker/WASM 已缓存，再关闭网络测试转换器加载；不要求离线访问书库 EPUB。最后在真实生产构建重复配对/授权/传书及 RPC，避免只验证 Vite 开发路径。KO3 到位后按相同步骤验证型号、封面与排版。
