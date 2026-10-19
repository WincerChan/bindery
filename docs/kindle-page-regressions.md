# Kindle 预览初始化与字体安装回归

适用于 Phase 4 合并后的 `feat/ts-rewrite`，Solid 2.0.0-rc.15。沿用 [Solid 渲染兼容约定](solid-client-rendering.md) 和 `scripts/solid-options.ts`，没有修改编译设置、依赖或设备事务实现。

## 已确认的原因与证据

### 预览页：把 signal setter 的返回值当成 effect cleanup

`PreviewRoute` 把 `setDirty` 作为 `TypesetPage.onDirty`。原来的

```tsx
createEffect(dirty, value => props.onDirty?.(value));
```

会把 setter 返回的布尔值交给 Solid，而 Solid 2 的 effect 回调只允许返回 cleanup 函数或 `undefined`。`node_modules/.pnpm/@solidjs+signals@2.0.0-rc.15/node_modules/@solidjs/signals/dist/prod/core/effect.js` 的 `runEffect` 保存回调返回值，下次执行时调用 `E?.()`；`false` 也不是 nullish，因此会产生 `TypeError: … is not a function`。开发运行时在同一个位置直接检查并报告 invalid cleanup。

SSR 不执行这个 effect。客户端初始化时，方案加载会更新 draft/baseline，触发 effect 再执行；非法 cleanup 中断响应式更新。此前单独挂载页面的测试省略了 `onDirty` 或使用返回 `undefined` 的 mock，漏掉了真实路由的 setter 接线。Router 的错误边界可能消费异常，所以仅检查浏览器 `pageerror` 不足以验证页面。

修复把回调改成 block body，明确不返回 `onDirty` 的结果。没有改 iframe、强制重建页面或增加客户端专用首屏分支。测试在第一个设备订阅开始前比较 SSR 和客户端的全部元素引用、文本及属性（除框架内部 `_hk`），二者完全一致；随后检查可见的原设备栏能收到恢复、断开和重连状态。

反向验证：仅恢复原来的隐式返回，真实 preview 路由的两个 hydration 测试（冷启动恢复、manager 已连接）都失败，进入 Router 错误分支。诊断探针捕获的栈位于生产 signals 的 `runEffect`；恢复修复后通过。这不是既有条件 prop memo 优化导致的 hydration ID 漂移。

### 字体页：每次探测都取消批次并重新排队扫描

`connectionKey` 原来是普通 accessor，直接用作 `createEffect` 的 compute。当前 Solid 版本在依赖变动后重算 compute，即使返回的字符串相同也会再次执行 effect。`KindleDeviceManager.startMonitoring` 每 1.5 秒发送一个带新 `now` 的状态，探测及窗口 focus 也会发送新状态。

该 effect 每次都执行 `selection++`、清空 pending/deleting，并重新调用 `scan()`。因此文件选择、异步字体检查或确认批次会被同一设备的探测取消。扫描还会推进 generation 并设置 busy；inventory 与探测共用设备锁，慢设备上不断加入的扫描会使旧结果过期、busy 持续被重置。

可核查的回归证据：

- 选择 OTF 后执行同一设备的 focus/probe，原代码又枚举 `fonts/` 两次并清掉确认批次。
- 用 fake FS 暂停字体目录枚举，发送三个与监测器相同的 heartbeat，再释放读取：原代码枚举 `fonts/` **12 次**，修复后为 **4 次**（Provider 和字体页各一次 inventory，每次分别读取字体元数据和目录用量）。
- 连接标识改用 `createMemo` 后，以上探测不再取消批次或增加扫描，读取结束后 busy 正常结束，可以继续选择和安装。

原来的 `choose()` 还会在 `busy()` 时直接丢弃输入事件。现在区分扫描和写入：扫描中返回的文件仍会被检查并保留，确认按钮等待扫描结束；安装/删除完成共享刷新前，写入状态始终保持 busy。慢扫描测试还在读取被暂停时选择 OTF，验证确认先禁用、读取结束后启用并完成安装。

字体增删原来还只刷新本页列表，未刷新共享 Provider 的 inventory，设备栏用量会过期。现在安装、删除成功后刷新共享 inventory，测试核对字体用量从 0 B → 12 B → 0 B 及实际文件字节。上下文和 manager 在组件初始化作用域捕获，避免异步回调重新读取含 `useContext` 的 prop getter；可选上下文提供明确的 null 默认值，页面也能独立挂载。

## 其他 Kindle 页面审计

| 范围 | 结论 / 修改 |
| --- | --- |
| preview 的设备选择、方案加载、字体扫描 | 也存在按稳定标识触发副作用的普通 compute；改用设备 ID、目标 ID、字体来源 memo。重复 probe 不重读方案、不清空所选方案或字体；脏草稿仍保留原设备。 |
| 设备书籍 `selectionDevice`、传书 `deviceId` | 已使用 memo；无需修改。现有 20 项设备 UI 测试覆盖探测、选择保留、共享队列和 inventory。 |
| connect、Provider、设备栏 | 启动在 `onSettled` 后；使用中性 SSR 状态。Provider 通过普通 `observed` 状态判断连接变化，没有按 heartbeat 无条件重扫。生命周期回调返回正确的清理函数。 |
| `ChapterFrame`、`FontSample`、页面设备订阅 | effect 回调使用 block body；未发现 setter/Promise 被当 cleanup 返回。iframe 首屏参数确定，布局和字体 API 在挂载后使用。 |
| fonts 路由 | 将 `useKindleManager()` 从 JSX prop getter 移到初始化作用域；与 preview 的接线一致。 |

## 自动验证

`tests-ts/kindle-ui-typeset.test.ts` 复用 `tests-ts/support/client-dom.ts`、fake FS 和生产 Solid options，分别构建 SSR 与 production browser bundle。新增四项回归：两个真实 preview 路由 hydration 用例、完整 OTF 选择/确认/安装/删除流程、共享设备锁下的慢扫描与 heartbeat。实际使用生产 route 组件、`useBlocker`、Provider、设备栏及 tabs，仅注入 loader/RPC 和设备存储边界；没有浏览器、端口或网络。

最终执行结果：

- `pnpm build`：通过；保留已有 `inputValidator` 弃用与 ingest 混合 import 提示。
- `pnpm typecheck`：通过。
- `pnpm test`：50 个文件、979 项通过，无跳过。
- `git diff --check`：通过；最终 diff 仅包含本次 Kindle UI、回归测试和本文档。

真实 Chrome / OPFS、Start bootstrap 和实机字体显示留给下面的编排方检查，Node DOM 测试不代表这些已通过。

## 编排方生产 Chrome 检查

使用新产物重启生产服务：

```sh
pnpm build
node scripts/start.mjs
```

1. 登录，沿用原来的 OPFS Kindle 目录和 `showDirectoryPicker` override；先清空专用测试目录的 `fonts/`，在 `/kindle/connect` 配对 KPW3。直接 `page.goto('/kindle/preview')`，检查 `[data-kindle-device-bar]` 只有一个，约 1 秒内显示「已连接」及设备名，「方案所属设备」选中该设备，方案列表完成加载。等待至少 6 秒后再次断言；普通刷新、`?book=<有效 id>`、`?font=<已安装家族>` 分别重做。检查页面没有 Router 错误提示，同时采集 console 和 pageerror。
2. 直接打开 `/kindle/fonts`，等待初次 inventory 完成和「添加字体」启用。用 `input[type="file"][accept=".ttf,.otf"][multiple]` 选择有效 OTF，确认列出家族、文件名、目标设备；确认安装前 OPFS 中应仍无该文件。让窗口失焦再聚焦，并等待至少 4.5 秒覆盖三次监测，确认批次仍在，按钮可用，没有持续的「正在读取或更新设备字体…」。
3. 点击「确认安装」，等待确认区消失、成功通知、字体表格行和文件同时出现，比较 OPFS 文件字节与输入文件；设备栏字体用量必须包含新文件，不能停在「未读取」。重新扫描、刷新页面后文件仍在。重复选择同一文件应明确报告已存在且不覆盖，输入框复位后仍能再次选择文件。
4. 删除测试家族：先取消一次，确认文件不变；再确认删除，核对文件和表格行消失、设备栏字体用量减少。其他家族、Readme 和 `._*` 文件不受影响。另用原先含 TTF 的目录检查字体表及样张仍能显示；应用 document.fonts 不应新增设备字体。
5. 在含较多书籍/目录的 OPFS 测试设备上重复步骤 2–3：初次扫描期间按钮可禁用，扫描结束后必须恢复；选择文件后跨多个监测周期不能再次清空确认区或持续排队。预览选择自定义方案、改一个参数，等待至少 6 秒，方案、字段和脏草稿提示必须保持，不能被周期探测重置。
6. 分别完整导航 `/kindle`、`/kindle/fonts`、`/kindle/transfer`、`/kindle/preview`，每页检查恢复连接和 inventory；再通过 tabs 做客户端导航。授权提示、断开/重连和未保存离开保护保持原行为。OPFS 无法替代真实 USB 拔插与 Kindle 重启后字体菜单验收。
