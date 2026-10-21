# 设备通用化 + Kobo（第一期）实施报告

分支 `feat/devices`（基于 `31d7fba`）。本报告只描述本 worktree 的改动；未合并、未 push、未访问其它 worktree，真实书库只以只读方式复制 EPUB 到 `/tmp` 做本地验证。

## 1. 通用设备层结构

```
src/client/devices/
  models.ts          Kindle/Kobo 型号、屏幕参数、Kobo 产品 ID → 型号映射
  fs.ts              File System Access 结构、路径/错误/写入分片（Kindle 兼容别名）
  identity.ts        .bindery/device.json、Kindle/Kobo 识别、firmware、配对
  remembered.ts      IndexedDB 多设备记忆（沿用 bindery-kindle 数据库，旧记录不丢）
  device.ts          DeviceManager（选择/恢复/授权/配对/轮询/切换）
  transaction.ts     按设备种类的写入白名单、日志、备份、回滚、设备锁
  inventory.ts       通用书目/字体/占用统计 + Kobo 扫描
  operations.ts      按种类删除书籍（Kindle 清理 sdr/缩略图；Kobo 只删 Bindery/）
  fonts.ts           字体检查/安装/删除，Kindle 原名、Kobo 约定命名
  progress.ts        进度节流与速度/ETA
  queue.ts           跨页面传输队列（取消、回滚、去字体/去图片选项）
  transfer.ts        按设备种类分派到 Kindle KFX / Kobo KEPUB
  paths.ts           安全文件名（沿用 Kindle 长路径规则）、Kobo 文件名
  kobo/
    kepub-client.ts  Worker 转换器客户端（取消=终止 Worker）
    kepub-worker.ts  KEPUB Web Worker 包装
    transfer.ts      下载 → 去资源 → KEPUB → Bindery/<书名>.kepub.epub
  kindle/            由原有 Kindle 实现继续承载 KFX/缩略图/排版方案
src/features/devices/  设备栏、标签页、连接、书目、传书、Kobo 预览占位、重定向
src/features/kindle/   保留 Kindle 专有的 typeset（排版预览）、boko 许可、图标
src/core/kepub.ts      KEPUB 包处理（ZIP/OPF/dummy titlepage/成员复制）
src/core/kepub-html.ts 流式 HTML/XHTML 分词与改写（无正文 DOM）
src/core/kepub-xml.ts  小体积 OPF/container XML 树与 etree 风格缩进
src/core/kepub-entities.ts WHATWG 命名实体表（由 CPython html.entities.html5 生成）
```

`src/client/kindle/*` 中通用模块保留为薄 re-export，避免破坏现有 Kindle 调用和测试；实际实现已移入通用层。设备身份格式扩展为 `{ id, kind, model, name, created_at, product_id? }`，旧的无 `kind` Kindle 身份自动推断为 Kindle。IndexedDB 数据库名保持 `bindery-kindle`，已有设备记录可继续读取。

## 2. 改动清单

- **识别与多设备**：`documents/` + `system/` → Kindle；`.kobo/` → Kobo，`.kobo/version` 最后一个字段为产品 ID（`N418` → Libra 2，未知值显示「Kobo（未知型号）」）；都不是则提示同时需要两种根目录结构。`DeviceManager` 支持多台已配对设备、按 ID 切换、忘记单台记录。
- **路由**：新增 `/devices`、`/devices/connect`、`/devices/transfer`、`/devices/preview`、`/devices/fonts`、`/devices/content/...`；主导航改为「设备」→ `/devices`。旧 `/kindle*` 页面通过真实 `beforeLoad` 重定向（保留 query/hash），旧 `/kindle/content/...` 资源返回 302 到 `/devices/content/...`。SSR 和客户端导航都验证过。
- **文案**：页面统一使用「设备」；只有 Kindle 专属控件（KFX、缩略图、排版方案、boko 许可）保留 Kindle 字样。Kobo 的「排版与预览」只显示「Kobo 的排版预览将在真机校准后提供」。
- **安全写入**：Kindle 白名单保持不变；Kobo 只允许 `Bindery/**/*.kepub.epub`、`fonts/*.ttf|otf`、`.bindery/device.json`。删除同样只限 `Bindery/` 下的 KEPUB。Kobo 不读写 `KoboReader.sqlite`。
- **Kobo 书目**：扫描根目录及子目录的 `.epub`/`.kepub.epub`，跳过 `.kobo`、`.bindery`、`fonts`、`system` 和系统保护条目；`Bindery/` 标记为 Bindery，其余为其他来源。传书页按 `koboBookFilename(title)` 与书库对照「已在设备 / 未传」。
- **Kobo 传书**：复用 `/book/:id/download`，可选 `stripFonts`/`stripImages`，Worker 转换为 KEPUB，写入 `Bindery/<安全书名>.kepub.epub`；同名重复传覆盖同一文件。封面不额外写。
- **Kobo 删书**：事务备份后删除 `Bindery/` 文件；UI 提示「设备下次连接或重启时会更新书架」。其他来源的 EPUB 只展示，删除按钮禁用。
- **字体**：Kindle 保持原名；Kobo 按 `<Family>-Regular|Bold|Italic|BoldItalic.ttf|otf` 命名，复用现有进度、取消、事务回滚流程。超出四档的权重（Light/Medium 等）会归入 Regular；同批多个文件映射到同一目标名时拒绝安装。
- **测试/脚本**：新增 `tests-ts/devices.test.ts`、`tests-ts/kepub-parity.test.ts` 和 Kobo UI/重定向用例；路径与文案变化同步更新既有断言，未删除原用例。

## 3. KEPUB 对照覆盖与结果

固定对照数据位于 `tests-ts/fixtures/parity/kepub/`：

- 生成工具：kepubify v4.0.4，sha256 `37d7628d26c5c906f607f24b36f781f306075e7073a6fe7820a751bb60431fc5`，生成日期 2026-10-21。
- 生成方式：`node tests-ts/fixtures/parity/kepub/make-fixtures.mjs`，再 `KEPUBIFY=/path/to/kepubify node tests-ts/fixtures/parity/kepub/generate-reference.mjs`。详见同目录 `README.md`。
- 规范化：成员按名字排序；忽略 ZIP 时间/压缩/extra/comment；文本成员保存原始 UTF-8 字节（含 BOM），二进制保存 sha256 + 未压缩大小。正文、OPF、CSS、路径内容不做任何规范化。
- 输入覆盖：中英文分句与中英混排标点、行内嵌套、`br`、`pre`/`code`、`script`/`style`、`svg`、`math`、图片、表格、脚注链接、已有 `koboSpan`、已有 `book-columns`/`book-inner`、空章节、非 UTF-8 声明、实体、畸形 p/div、特殊路径；另有 titlepage（不加 dummy）、dummy heuristic、非线性格、Calibre 元数据删除、文件过滤和目录项。
- 结果：3 个 fixture、全部成员逐字节一致（7 项测试全部通过）；异步 Worker 打包路径与同步路径的成员内容/名称完全一致。

## 4. 本地全书库对照

对 `/workspaces/bindery/library` 的 7 本 EPUB 做临时副本转换，并与 kepubify v4.0.4 输出逐个成员比较：

| 大小 | 成员数 | 差异 |
| --- | ---: | ---: |
| 21.1 MB | 2241 | 0 |
| 18.2 MB | 1488 | 0 |
| 16.6 MB | 1474 | 0 |
| 10.9 MB | 1057 | 0 |
| 9.8 MB | 1463 | 0 |
| 5.9 MB | 1355 | 0 |
| 4.0 MB | 906 | 0 |

合计 9,984 个成员，0 个成员差异（成员名、文本字节、二进制字节全部一致）。真实书籍内容未提交，临时目录 `/tmp/kobo-work` 已单独使用。

## 5. 分阶段性能（Node 24，预热后）

最大 EPUB：21,148,474 bytes，2241 个成员，2228 个内容文档转换、12 个成员原样复制。

**Worker 使用的异步路径**（`convertToKepubAsync`，Node 4 次中位数）：

- 总耗时 **1.176 s**（1139 / 1170 / 1182 / 1201 ms）。
- 解包/中央目录：约 3 ms
- OPF 解析/改写/dummy：约 35 ms
- 内容解压：约 281 ms
- HTML/XHTML 流式改写：约 558 ms
- 压缩（原生 `CompressionStream("deflate-raw")`）：约 261 ms
- 其余 ZIP 组装：约 12 ms（`packMs` 约 273 ms 含压缩）
- 输出：22,849,493 bytes

**模拟 Worker 线程**（同一异步入口，`node:worker_threads`）：1068 / 1094 / 1134 / 1181 ms，中位数 **1.114 s**。

**同步 Node 路径**（默认 level 1，测试/无 `CompressionStream` 回退）：1308 / 1357 / 1379 ms，中位数 **1.357 s**；压缩阶段约 560 ms。

**最小 4.0 MB EPUB**（906 成员）异步路径：355 / 371 / 376 ms，中位数 **371 ms**。

对比基线：boko 最大 1.06–1.09 s、最小 0.25 s；kepubify 原生最大 0.63 s。异步 KEPUB 已达到 ≤1.5 s 要求，并与 boko 同量级。优化手段：正文不使用 DOM；未变化成员直接复制原始 DEFLATE 流（图片不重新压缩）；Worker 使用原生 `deflate-raw` 并行压缩；ZIP 层面只比较规范化成员。

## 6. 测试与验证

- `pnpm typecheck`：通过。
- `pnpm build`：通过（Vite 构建并重新生成 `routeTree.gen.ts`）。
- `pnpm test`：**72 个测试文件 / 1288 项全部通过**。期间有一次全量运行命中既有 `kindle-epub-strip` 的 ZIP 时间戳跨秒断言（两次生成落在不同秒），立即重跑全部通过；该 flake 与本次设备/KEPUB 改动无关。
- 任务基线 70 文件 / 1296 项中包含依赖本地真实书库的用例；本 worktree 根目录没有 `library/`，这些本地用例不会收集。本 worktree 的常驻测试基线为约 70 文件 / 1267 项，本次新增 21 项（设备识别、多设备、白名单、Kobo 书目/传书/删书/字体、Kobo UI、重定向、KEPUB 对照），因此 1288 项。
- 既有 Kindle 用例全部保留；仅更新路径/文案相关断言：`/kindle*` → `/devices*`、`/kindle/content` → `/devices/content`、连接页标题/按钮中性化、删除报告「设备本机」、导航/PWA 路径、生产 SSR 期望，以及把旧 preview/fonts 路由测试切到新路由。未删除或跳过任何原有 Kindle 行为用例。

## 7. 自行决定

1. Kobo 传书文件名使用 EPUB 元数据标题清洗后的 `<书名>.kepub.epub`；重复传同一标题覆盖，不做内容级去重。若不同书同标题，会覆盖同名 Bindery 文件。
2. Kobo 不写 manifest；Bindery 来源由 `Bindery/` 目录判定。书目与书库对照使用 `koboBookFilename(书库标题)`，当 EPUB 内标题与书库标题不同时可能显示「未传」但实际已在设备。
3. Kobo 未知型号保留产品 ID 并显示「Kobo（未知型号）」；仍可传书、删书、装字体。
4. Kobo 字体多权重映射到四档；映射冲突直接拒绝，避免静默覆盖。
5. 旧 `/kindle/content/...` 使用 302（资源请求），页面路由使用路由级 replace 重定向。
6. Kindle 现有行为保持不变：旧调用路径保留 re-export，错误文案仍以 Kindle 设备名显示；Kobo 才切换为 Kobo/设备文案。
7. 压缩：同步 API 默认 level 1；Worker 优先使用原生 `CompressionStream`，不可用时回退同步。

## 8. 未验证/已知边界

- **未在真实 Kobo Libra 2 上验收**：书架刷新、KEPUB 分页/高亮、字体分组、Libra 2 屏幕效果需要用户真机确认。
- 未在真实 Chromium Worker 中跑完整 21 MB 性能；Node `worker_threads` 模拟为 1.114 s，浏览器原生压缩通常不慢于 Node，但需真机/浏览器确认。
- KEPUB 分词器覆盖了 kepubify 默认行为和本机全部 7 本书，但不是完整 HTML5 树构建算法：adoption agency、复杂 foster parenting、`template`、极少见的外来内容调整未系统验证。
- ZIP64、加密 EPUB、非 UTF-8 ZIP 文件名的 EPUB 会明确拒绝或按 UTF-8 解码；kepubify 对部分此类输入可能也能处理。
- Kobo 产品 ID 映射来自社区已知型号，可能缺少新机型；未知时会降级显示但功能不受影响。
- 浏览器 File System Access API 的权限/断开行为已用 FakeFileSystem 覆盖，但真实 Kobo USB 挂载的长路径/权限差异未验证。
