# Phase 4 · PWA shell 交付报告

本切片在 `/workspaces/bindery-wt-p`、`feat/p4-pwa` 完成。PWA 安装入口、PNG 图标、生产构建 Service Worker、离线说明和安全更新通知均已实现。没有 commit、push、切换分支、安装依赖、联网、监听端口或执行浏览器。

## 文件与用途

| 文件 | 用途 |
| --- | --- |
| `src/client/pwa/manifest.ts` | manifest 源数据；构建输出 `dist/client/manifest.json`。名称/短名称 Bindery，根 start_url/scope/id，standalone，中文描述；theme/background 使用 `src/styles.css` 的 `--color-bg: #F5F6F3`。 |
| `public/icons/icon-192.png`、`icon-512.png`、`maskable-512.png` | 不透明 PNG，沿用 `public/favicon.svg` 的黑色矩形与橙色圆形；maskable 前景完全位于中心半径 40% 的安全区内。 |
| `src/client/pwa/generate-icons.mjs` | 只用 Node fs/zlib 与手写 PNG CRC 的可复现栅格化脚本；4×4 超采样，无新依赖。运行 `node src/client/pwa/generate-icons.mjs`。 |
| `src/client/pwa/build.ts` | Vite 插件：只在 client 构建输出 manifest/offline/boko，读取 `.vite/manifest.json` 收集静态资源，补充独立 Worker 产物，生成根路径 `/sw.js` 与隐藏审计清单 `.vite/pwa.json`。 |
| `src/client/pwa/policy.ts` | 请求策略、静态响应校验、scope 隔离及旧 cache 清理的纯函数。 |
| `src/client/pwa/worker.ts` | precache、网络导航/离线回退、cache-first 静态资源、激活清理和刷新更新握手。构建为独立 classic SW，无运行时模块依赖。 |
| `src/client/pwa/offline.html` | 自包含中文离线说明和重新加载链接；无需联网 CSS/JS，不显示保存的书库内容。 |
| `src/client/pwa/register.ts`、`registration.tsx` | 仅生产浏览器注册；通过既有 `showToast` 提示“新版本可用，刷新以更新”；处理显式刷新更新及监听清理。 |
| `tests-ts/pwa.test.ts` | 策略/隐私/scope/响应 MIME、manifest、预缓存收集、旧 cache、PNG 尺寸和 maskable 安全区。 |
| `tests-ts/pwa-register.test.ts` | 注册选项、首次安装、等待更新通知、刷新握手、焦点检查节流、失败/卸载和不安全环境。 |
| `tests-ts/pwa-production.test.ts` | 在 Node VM 执行实际生成的 SW，使用内存 CacheStorage；另调用实际 production handler 验证产物 MIME，无 sockets。 |

允许修改的共享文件只有下列两处，集成时请保留另一工作者的其他修改：

- `src/routes/__root.tsx`：增加 `theme-color`、`/manifest.json` link、192px apple-touch-icon，import 并在既有 `ToastRegion` 后挂载 `PwaRegistration`。
- `vite.config.ts`：仅 import `pwaBuild`，在既有 plugins 数组末尾追加 `pwaBuild()`。RC compat shim、Solid 插件顺序、`scripts/solid-options.ts` 和 `wrapConditionals: false` 均保持原样。

没有改动 Python 参考实现、`spikes/`、`.codex`、`vendor/boko/**`、依赖文件或其他 worktree。`src/routeTree.gen.ts` 无 diff。

## 决策与行为

**manifest 使用生成的 `/manifest.json`。** 当前 `srvx@1.0.6` 静态 MIME 表没有 `.webmanifest`，会将该扩展当作 `application/octet-stream`；它也没有自定义 MIME 配置。采用任务允许的 generated equivalent，生产入口直接返回浏览器可用的 `application/json`，link type 与其一致；没有输出 MIME 错误的 `.webmanifest`，也无需越界修改 `scripts/production-handler.mjs`。`/sw.js` 在根目录，响应 `text/javascript`，scope 为 `/`，无需 `Service-Worker-Allowed`。

**只缓存公共构建产物。** precache 覆盖 Vite client manifest 的 JS/CSS/资源、独立 Worker 文件、`/assets/` 下 WASM，以及本切片的 manifest、图标、favicon 和离线页。运行时只对带 hash 的 `/assets/` 静态文件、该目录下任意层级的 WASM 及固定公共文件使用 cache-first。查询参数资产、跨源/范围外请求、POST/HEAD、Range/Authorization 请求均绕过。写 cache 还要求 200、无重定向、非 private/no-store、扩展名与 MIME 匹配；静态资源误返回登录 HTML 会导致安装失败并删除不完整 cache。

**导航优先联网，不持久化 HTML。** HTML 导航直接返回原始网络 Response，不 clone、读 body 或改写 headers。网络抛错时只返回公开中文离线页。303 登录重定向、HTTP 错误与 SSR stream 均保留原行为。其余动态 fetch 不调用 `respondWith`，由浏览器直接处理；`/_serverFn`、API、封面、下载、`/book/{id}/epub/*`、EPUB/KFX 等资源连导航离线替代也不做。书籍、封面、RPC、认证结果及 SSR 书库 HTML 不写入 CacheStorage。离线书库/阅读不在产品范围内。

**boko 协调点无需共享文件修改。** 插件读取只读 `vendor/boko/boko_bg.wasm` 和 `boko.js`，向 client 输出 hash 资产，并仅在生成的 glue 中将默认相邻 WASM 引用指向实际 hash 文件名。WASM 字节不变，测试核对 SOURCE.md 的 SHA-256。Kindle Worker 仍可直接 import vendored JS 并使用 Vite `?url` 加载 WASM；本切片会扫描独立 Worker 构建输出进行 precache，运行时也缓存 `/assets/**/*.wasm`。不在服务端加载或执行 boko。生产 cache 会同时含独立 glue 和未来 Worker 内打包的 glue，少量重复 JS 用于保证进入 Kindle 页之前转换资产已预热。

**版本和更新。** cache 名为 `bindery-pwa:<编码后的 scope path>:<构建内容摘要>`；构建摘要覆盖公共资产实际字节以及 SW/策略源码。activate 只删除同 scope 的旧代 cache，保留其他应用/其他 scope。安装时不 `skipWaiting`，不 `clients.claim`。首次安装在下一次导航后接管；新版本安装完成后调用现有 toast，当前会话不自动刷新。focus/可见性恢复时至多每分钟检查一次更新，浏览器正常注册也会检查。

浏览器明确 reload 且注册时已有 waiting worker，客户端才请求更新；waiting worker 确认同源范围内只有该一个窗口客户端后，先回执再 `skipWaiting`。只有收到该 worker 回执的刷新页面会在 controllerchange 后再加载一次，以使用一致的新资源。其他标签页或已安装窗口仍打开时继续等待；关闭其他窗口再刷新，或关闭全部窗口后重新打开即可。缺少 SW、非 secure context、离线注册/更新失败不会阻断应用。开发模式不注册 SW。

本切片不调用 File System Access API，所以没有新增目录句柄 fake 或修改 Kindle 测试支持；SW 测试的内存 CacheStorage 只服务本切片。目录句柄语义应由 Kindle 切片的 FSA 测试覆盖。

## 已执行验证

最终门禁：

```sh
pnpm build
pnpm typecheck
pnpm test
git diff --check
```

- `pnpm build`：成功；client 生成根 SW、manifest、offline、图标和 boko 资产。保留了既有 `inputValidator` 弃用和 ingest 混合静态/动态 import 提示；没有新增依赖或改兼容配置。
- `pnpm typecheck`：成功。
- `pnpm test`：40 个测试文件、870 项测试通过，无跳过；PWA 新增 3 个文件、74 项。
- PWA 的实际 SW 测试覆盖：完整 precache、失败安装清理、版本清理、303/stream 原样返回、离线回退、API/EPUB/封面/下载旁路、WASM 首次写入后离线命中、拒绝缓存登录跳转、多窗口更新保护。
- 实际 `createProductionHandler()` 静态请求检查：`/manifest.json` 为 `application/json` 且内容等于 manifest 源数据；`/sw.js` 为 `text/javascript`；offline 为 `text/html`；所有 PNG 为 `image/png`。完整读取响应，未开端口。
- 图标做了 PNG 解码、尺寸/不透明格式、安全区测试，并人工查看生成图像。既有生产集成测试同时验证认证、server functions、书籍资源与 SSR。
- `git diff --check`：成功。最终 diff/未跟踪文件清单已核对，均在归属范围内。

## 编排方 Chrome / Edge 人工检查

以下需在允许监听端口与浏览器的环境执行，本沙箱没有执行，不能据 Node 测试声称已通过浏览器安装或 Lighthouse。

1. **启动与响应头。** 在集成后的 checkout 配置可用测试书库/认证环境，执行 `pnpm build`，再执行 `HOST=127.0.0.1 PORT=3000 pnpm start`。打开 Chrome/Edge 的 `http://localhost:3000/` 并登录；正式部署使用 HTTPS。Network 核对 `/manifest.json` 200 `application/json`、`/sw.js` 200 `text/javascript`、PNG `image/png`、`boko_bg-*.wasm` `application/wasm`，均不跳转登录。不要用 `pnpm dev` 验收 SW。
2. **manifest 与安装。** DevTools → Application → Manifest，确认名称/短名称 Bindery、start URL/scope `/`、display standalone、主题/背景 `#F5F6F3`、192/512 图标和单独 maskable 图标；预览 maskable 的圆/圆角裁切。等待首次 SW 安装完成，普通刷新一次，Console 确认 `navigator.serviceWorker.controller` 存在，Application → Service workers 确认根 scope。地址栏安装按钮或菜单“将此站点安装为应用”安装，打开独立窗口，检查标题/图标/无地址栏/根路径启动。浏览器安装提示可能受用户参与度或已安装状态影响，以菜单及 Manifest 面板辅助核对。
3. **离线 reload。** 保持已接管的窗口；在 Network 选 Offline，普通刷新 `/`、`/kindle`、`/book/<id>/preview/0`，均应显示“当前离线”“书库需要连接服务器”，以及可键盘操作的重新加载链接。不得显示先前搜索结果/书籍/封面。Application → Cache storage 只含公共构建文件，不得含 `/`、`/login`、`/_serverFn`、`/api`、`/book/`、EPUB、cover 或下载 URL。切回 Online，点“重新加载”，恢复在线服务端页面。
4. **动态请求/认证。** 已接管时在 Network 观察匿名 `/` 的 303 → `/login`；登录/退出、书库 loader/RPC、长章节流式 SSR、预览章节及 `/book/<id>/epub/...`、EPUB 下载和封面均能正常使用。离线请求 RPC/下载/封面应网络失败，不能获得缓存私密数据或中文离线 HTML 替代。确认 CacheStorage 无新增动态条目。
5. **单窗口更新。** 使用有内容差异的两个构建 A/B；可仅在 B 的 `src/client/pwa/offline.html` 临时增加一行测试文案并重建，验证结束后恢复该文案。A 先接管，保持同一标签页，部署 B 并重启服务；DevTools 的 “Update on reload” 与 “Bypass for network” 均保持关闭。在 Console 执行 `await (await navigator.serviceWorker.getRegistration('/')).update()`；等待安装完成，应出现既有 toast“新版本可用，刷新以更新”，B 为 waiting，A 仍控制页面，页面不刷新。完成当前操作后按普通刷新，应激活 B 并完成一次额外 reload；不得循环 reload；旧代 cache 删除。断网刷新可用 B 的离线文案确认版本。
6. **多窗口更新。** A/B 更新步骤另做一次，保持两个受控标签页（或标签页加已安装应用窗口）；一个停留在 Kindle 工作页。触发 update 后，刷新其中一个页面，B 应仍 waiting，其他页面不得自动刷新/切换控制器。关闭另一个标签页/应用窗口后再普通刷新，应启用 B。也检查关闭所有窗口后重新打开可自然启用新版本。
7. **Lighthouse 与安装清单。** 对在线、已接管页面运行当前版本 Lighthouse 的可用审计；核对 HTTPS/安全上下文、manifest 名称/start URL/display/theme/background/icons、可安装性、maskable 裁切、正确 viewport、首次可用响应、离线自定义说明，以及独立窗口启动和键盘焦点。若当前 Lighthouse 已不提供 PWA 分类，用 Application Manifest/Service workers 的安装诊断加上述手动项目记录结果；不能把本项目有意不支持的离线书库当作已实现。记录 Chrome/Edge 版本、审计结果和实际安装/离线/更新截图。

## 未验证项与共享请求

浏览器真实 SW 生命周期、安装 UI、Lighthouse 和 Windows 独立窗口尚待上述人工验收。FSA/KPW3/KO3/浏览器 KFX 转换的功能与实机验收属于并行 Kindle 切片；本报告不宣称已验证。

没有必须由编排方补做的范围外代码修改。合并时保留上述两处共享入口增量，并用合并后的 Kindle Worker 重新运行三个门禁，再检查其 JS/WASM URL 已出现在 `dist/client/.vite/pwa.json` 和 CacheStorage。若部署改用自定义静态服务器，继续为 JSON manifest、JS、WASM 返回正确 MIME 并允许根路径 `/sw.js`；不要为动态书库响应增加缓存。
