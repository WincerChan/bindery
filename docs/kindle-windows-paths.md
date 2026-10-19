# Kindle 在 Windows 上的局部文件访问失败

KPW3 会在 Linux 固件上生成超过 Windows MAX_PATH 的 `.sdr` 文件。Windows Edge 可以枚举这些目录与文件名，但对其中的 `getFile()` 或删除操作可能返回 `NotFoundError`。这不代表磁盘已拔出。旧实现由 inventory 直接抛出单个文件异常，`errorMessage` 将所有 `NotFoundError` 翻译为「Kindle 已断开」，probe 又把所有恢复异常归入 disconnected，因此设备仍有授权、根目录仍可访问时也会出现断开提示。

## 错误与统计

- 对具体条目的 `NotFoundError`、`NotReadableError`、`InvalidStateError`、`NotAllowedError` 和 `SecurityError`，先重新访问磁盘根目录的 `documents`。根目录仍可访问时，返回带路径的 `EntryAccessError`；根目录失联才显示断开，根权限失败保留授权错误。
- inventory / treeSize / fonts / thumbnails / `.bindery` / 根文件共享 `EntryReader`，跳过不可读条目并按路径去重。`DeviceInventory.unreadable` 包含 `path`、错误名 `reason`、`likelyCause` 和使用 `X:\` 前缀计算的 `windowsPathLength`；`unreadableCount` 为条目数。不可读子树也记为一个条目，不能推测未枚举文件的数量或大小。
- 设备栏用可展开的普通提示列出这些路径。已读字节仍正常显示。文件名非法或路径过长属于诊断推测，不把所有 `NotFoundError` 都归因于长路径。
- 未知 `.bindery` 文件（包括遗留 `probe.json`）不解析、不删除，可读字节仍计入「其他」。已存在但无法读取的 identity / manifest / journal 不会被当成缺失文件或自动重建。JSON `null` 仍视为损坏。
- probe 对可达设备保留「已连接」并显示具体错误；身份变化则要求重新配对。只读 inventory 可在身份条目或恢复文件暂时不可读时继续，但修改仍须通过身份与恢复校验。

## 删除与恢复

书籍本体与 manifest 保留事务一致性。提交后逐项删除对应 `.sdr` 和最后一个引用的自有 thumbnail，不需要先读取或备份整个 `.sdr`。一个无法删除的文件不阻止其他文件删除；若无法枚举目录，会尝试递归删除该目录。返回 `DeleteBookReport.notRemoved` 的精确路径，页面告知用户可在 Kindle 本机或使用支持长路径的工具清理。共享封面和第三方封面的保护规则保留。

这一顺序意味着：书籍删除已提交后，清理阅读记录期间拔线不会恢复书籍；重新连接后，残留目录计入其他用量。写入书籍或 manifest 期间失败仍通过原有日志恢复。

恢复先完整读取备份并校验恢复目标，再修改任何目标，避免列得出但读不到的备份导致目标先被删除。恢复完成后将日志标为 cleanup-only，再清理 rollback，最后移除日志。局部清理失败会保留可重试日志，并显示在连接消息和 inventory 提示中。无法恢复的写操作会中止并保留恢复资料。

## 新路径预算

Windows 路径按 UTF-16 单元计算，固定使用三字符磁盘前缀 `X:\`。新 KFX 名称沿用规范化、Windows 非法字符处理、保留名保护和大小写不敏感的 ` (2)`、` (3)` 冲突规则。

最坏已知 Kindle 伴生文件：

```text
X:\documents\<stem>.sdr\<stem><32 hex>.yjr.bad_file
长度 = 63 + 2 × stem.length
```

`BOOK_STEM_BUDGET = 88`，**包含重名后缀**，故此路径最多 239 字符，距 260 至少保留 21 字符。截断是确定性的、不拆分代理对，仍保留原有 180 UTF-8 字节的书名预算。生成每个冲突候选时先为后缀腾出空间。KFX 自身路径也会单独检查。

覆盖旧 manifest 名称时不擅自重命名或移动阅读进度；如果旧名称会生成超限伴生文件，则拒绝覆盖并报告路径。新 `.bindery` 文件使用固定的 `device.json`、`manifest.json`、`pending.json` 和短数字 rollback 名称；所有事务写路径和旧目录备份/恢复的目标都经过 Windows 路径检查，不复制过长名称生成新的超限文件。

## KPW3 / Windows Edge 实机复验

1. 使用原来保存的授权句柄打开 `/kindle`，点击「重新检测」。应显示「已连接」；受影响书籍正常显示，普通提示列出那三个 `.yjf`、`.yjr`、`.yjr.bad_file`，展开后能看到完整路径、`NotFoundError` 和超过 260 的长度。大小不包含这三个文件。无需删除 `.bindery` 或重新配对。
2. 确认 `.bindery/probe.json` 仍保留。反复检测、切换 Kindle 页面后，设备应保持连接；此文件若可读仍计入其他用量。
3. 对允许删除的受影响书籍执行删除。书籍本体应消失，能删除的阅读记录继续清理；若 Windows 无法移除那三个文件，页面应列出准确残留路径及本机/长路径工具处理说明。Bindery 记录应同步移除，自有封面只在最后一个引用删除后清理。检查其他书及共享封面仍保留。
4. 从书库传入一个长标题测试书，再重复传入至少两次。核对新 `.kfx` 名称确定性截短且后缀为 ` (2)`、` (3)`；将实际 stem 代入上述公式应不超过 239。安全弹出 Kindle，打开测试书生成阅读记录，再连接 Edge，确认新伴生文件可读，统计不新增长路径跳过项。
5. 在页面可见时真正拔出 USB，约 1.5 秒后应显示「已断开」。重插并点击重新检测，应恢复「已连接」及同样的跳过提示。若撤销站点的文件权限，应显示授权提示，重新授权后恢复。

自动测试用内存 FSA 注入局部 getFile/remove/values 错误及 Windows 路径限制，并以无浏览器 DOM 测试验证提示和删除报告；它们不能替代上述实机复验。

本次最终验证：`pnpm build`、`pnpm typecheck`、`pnpm test`、`git diff --check` 均通过；完整测试为 51 个文件、1017 个测试。构建仍报告既有的 inputValidator 弃用与 ingest 动态导入警告。未在真实 KPW3、Windows Edge 或浏览器中执行上述手动步骤。
