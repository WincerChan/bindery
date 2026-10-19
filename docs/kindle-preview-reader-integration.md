# Kindle 预览与 reader 索引集成

分支 `feat/ts-rewrite`，基于合并提交 `cba0eea`。未提交、推送、切换分支、安装依赖或使用网络、socket、浏览器；未修改 `.codex`、`spikes/`、Python 参考、`vendor/boko/**` 或实际书库。

## 实现

- 预览通过 `readBookArchive` 复用 `readerArchives` 的精确成员索引、按需解压和文件身份失效机制。每个归档身份/模式只创建一个转换计划，计划保存在弱引用键映射中，元数据及后续封面名称映射的估算大小计入 reader LRU。不保留整本 EPUB、章节、图片、字体或转换后的 CSS 字节。
- `createEpubAssetStripper` 共享 CSS、XHTML/SVG、加密清单和 OPF 的转换逻辑。预览只读取请求的原始成员；删除的字体和非封面图片直接返回 404。整本 KFX 转换仍通过 `stripEpubAssets` 生成副本。
- 保留旧封面 CSS 变体的命名、冲突处理和传递 `@import` 关系。首次需要封面变体时，按需扫描 CSS 建立名称依赖映射，此后变体请求仅读取并转换对应的一个源 CSS。仅直接请求 OPF/尚未发现的变体且无 guide 时，可能需要一次封面文档发现扫描；正文请求不扫描兄弟章节。发现过程读取失败后可重试，不缓存半完成状态。
- Reader 与预览共用 `epubMemberResponse`：精确成员 URL 解析、逐段编码、HTML/CSS URL 重写、CSP、sandbox、nosniff、no-referrer 和 GET/HEAD 行为一致。预览继续使用 `Cache-Control: no-store`。
- 预览章节列表也改用 reader 解析缓存，避免把已编码的 OPF href 当作真实 ZIP 名称再编码；iframe URL 使用 `encodeEpubPath`，支持 `: | * ~ # ? %`、空格和 CJK。

## 回归验证

- `kindle-preview-indexed.test.ts` 使用既有 `obfuscatedEpub` fixture 覆盖 `00/01/10/11`、字面 `%2e%2e` / `%2F` / `#` / `?`、CSS 导入、字体、图片、脚注、GET/HEAD、路径拒绝、不修改源 EPUB、缓存失效/淘汰和封面依赖失败重试。
- 对混淆名称、带加密清单资源和传递封面样式三个样本的四种模式，比较每个原始/新增/删除成员：预览隔离前的转换字节必须等于 `stripEpubAssets` 输出中的成员字节，并验证 HTTP 输出仅增加共用 reader 隔离处理。
- `kindle-strip-compatibility.test.ts` 的哈希来自修改前的实现，固定成员顺序、名称及完整 payload 字节，覆盖四种模式的加密清单和封面变体。另以固定时钟检查过修改前后的完整 ZIP 字节相等；持久化测试排除 ZIP 时间戳，避免时区差异。
- 生产 handler 测试无 socket 调用实际编译后的路由及 RPC，验证四种模式、认证、混淆名称路径、iframe src 和 CSP。

## 性能

独立运行：

```sh
BINDERY_KINDLE_PERF_REPORT=/tmp/bindery-kindle-preview-performance.json pnpm exec vitest run tests-ts/kindle-preview-performance.test.ts
```

合成 EPUB 为 **21,947,842 字节（20.93 MiB）、2241 个成员、2227 个章节**，没有版权书籍内容。比较同一进程/文件上的模式 `11` 单章资源；旧路径复现完整读文件 + `stripEpubAssets` + `loadEpubItem` + HTML 隔离，新路径调用实际 `kindlePreviewResource`。各采样 7 次，使用中位数，排除 fixture 生成时间。

| 指标 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 单章资源响应，中位数 | 2000.19 ms | 1.16 ms |
| 冷请求（索引、转换计划、单章响应） | — | 43.49 ms |

计数门禁不依赖机器时间：索引与转换计划各建立一次；冷请求只读 container、OPF、目标章节共 3 个成员；热请求每次只读目标成员，其压缩字节数为 9610；禁止预览调用 `readBookEpub` 或 `stripEpubAssets`。四种模式另有逐成员读取计数测试，封面变体有单独的依赖映射复用测试。

以上为无网络/socket 的服务端测量，不包含浏览器排版或 iframe 显示时间。

最终门禁：`pnpm build`、`pnpm typecheck`、`PYTHONDONTWRITEBYTECODE=1 UV_OFFLINE=1 pnpm test`、`git diff --check`。环境变量仅用于避免 Python 字节码写入及 uv 网络访问，不改变测试收集。构建保留既有 inputValidator 弃用与 ingest 混合 import 提示。

最终结果：构建、类型检查、**59 个文件 / 1114 项测试**及 diff/新增文件空白检查全部通过，无失败或跳过。
