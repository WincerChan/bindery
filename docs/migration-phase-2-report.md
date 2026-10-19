# Phase 2：数据层与认证交付记录

在 `feat/ts-rewrite` 实现；没有提交、推送、切换分支或安装依赖。Python 参考实现、其测试与依赖、`spikes/` 和 `.codex` 均未修改。所有数据库写入、元数据迁移和文件操作测试都在 `/tmp/bindery-*` 内执行。现有书库数据库仅通过 SQLite `mode=ro` 连接备份到临时目录，迁移在备份上验证，没有在真实 `library/` 上执行初始化或写操作。

## 实现

- `src/server/db/`：`node:sqlite` 可写连接、原始 DDL、列增补与心愿单去重、sessions、jobs、reader_progress、wishlist、passkeys、webauthn_challenges 和 app_settings。每次操作关闭连接，组合写入使用事务。
- `src/server/storage.ts`：正文 `book.json` 读写、SQLite 元数据、旧 `meta.json` 迁移与删除、书库排序/搜索/分页/未读筛选、心愿单播种、归档/恢复/删除、source 与 cover 文件。目录布局保留为 `<library>/<book_id>/` 与 `archive/<book_id>/`。
- `src/server/database.ts` / `paths.ts`：扩展原有路径解析，保留 `*_FILE` 和显式 DB 路径优先级；仅可写入口执行根目录旧数据库搬迁。原有只读 `readBookCount()` 仍可独立使用。
- `src/server/auth.ts` / `auth-http.ts`：Python Argon2 PHC 验证、共享会话、10 分钟密码重认证、WebAuthn 注册/登录、通行密钥重命名与删除。保留原有 `/login`、`/logout`、`/login/passkey/*`、`/security`、`/security/reauth`、`/security/passkeys/*` URL。
- `src/server.ts` / `runtime.ts`：首次请求前初始化数据层，避免模块导入或构建触碰默认书库；在 SSR 与客户端 RPC 入口验证会话，私有响应使用 `Cache-Control: no-store`。静态构建资源仍可公开读取。
- `src/routes/login.tsx` / `security.tsx`、`src/client/passkeys.ts`：Solid 2 登录页、安全设置页和 SimpleWebAuthn 浏览器交互。陈旧会话或 passkey 登录后的注册流程会要求密码；页面支持新增、重命名、删除及错误反馈。登录页客户端导航通过公开的 `/login/data` 取显示状态，其他数据 RPC 均受会话保护。

## 兼容细节

DDL 文本与 Python 的 `sqlite_master.sql` 逐字节比较，保留 `CREATE TABLE IF NOT EXISTS`、原列顺序/类型/默认值、全部普通/部分唯一索引及 Python 实际执行的 ALTER。未重建已有表，也未增加新表或字段。旧 sessions 的 `auth_method` 补为 `password`，`password_verified_at` 保持 NULL，不伪造密码新鲜度。

连接匹配 Python：foreign_keys=0、busy_timeout=5000、synchronous=2、trusted_schema=1、recursive_triggers=0、locking_mode=normal；保留已有日志模式，新建磁盘库默认 DELETE，没有启用 WAL。允许 Python 默认支持的双引号字符串字面量。

`tags_json` 使用 Python 默认逗号/冒号空格分隔及未转义中文；`book.json` 使用 UTF-8、两空格缩进且无末尾换行。时间使用 UTC ISO 格式、显式 `+00:00`、有小数时六位；Node Date 的精度为毫秒，后三位为零。读取已有 Python 六位微秒时间戳正常。

保留 SQL 分页先计算总数、再剔除不存在目录的行为，因此 orphan 行可能使某页可见书籍少于页大小；未读筛选按 `wishlist.read_status` 判断。播种覆盖数据库内全部书籍，包括归档和 orphan 行，并保留 Python 的空 identity 默认值，下一次初始化按原规则刷新。

旧 meta 文件的数据库行优先；新迁入记录按所在目录补 archived；无法解析的 JSON 保留；成功保存后删除 active/archive 两处旧 meta。`book.json` 不转成新格式，继续使用 Phase 1 的正文序列化/恢复函数。

会话 cookie 继续使用 `bindery_session`、HttpOnly、SameSite=Lax 和浏览器会话有效期；会话本身沿用 Python 的无 TTL 行为。challenge cookie 继续按登录/注册路径隔离、SameSite=Strict、300 秒、HTTPS 时 Secure；验证请求先用原子的 DELETE RETURNING 消费 challenge，再检查类型、期限和注册会话绑定，失败也清理 cookie。

passkey 凭据 ID 继续为无填充 base64url，公钥继续为 COSE BLOB；device_type 写回 `single_device` / `multi_device`。注册算法列表沿用 Python 的全部 9 项，而非 SimpleWebAuthn 的默认子集。由于 WebCrypto 验证会让出执行权，登录最终写入原子检查签名计数，避免并发回退；注册在验签后再次检查密码新鲜度。

## 验证

```bash
pnpm typecheck
pnpm build
pnpm test
node scripts/check-ssr.mjs
git diff --check
```

最终结果：7 个 Vitest 文件、367 项测试通过，无跳过；类型检查和生产构建通过。生产 SSR 检查也包含在 `pnpm test` 中。

新增对照工具 `scripts/parity/data-reference.py`、`auth-reference.py` 均通过异步子进程 `uv run --no-sync python ...` 执行，未使用 spawnSync、网络或 sockets。

数据验证包括：空库 DDL/PRAGMA、旧 sessions/wishlist 补列、linked/manual 心愿单去重、旧 meta 文件、正文文件字节、CRUD 与编码、排序分页与播种、删除后关联记录的原有行为、Python → TS → Python → TS 交替操作，以及真实现有数据库临时备份上两端迁移结果的摘要对照。现有数据库尚无 passkeys 表，因此比较的是两端执行原有升级规则后的结果；没有把正常补表判为不兼容。

认证验证使用实际签名而非 mock 验签结果：Python 生成并实际验证/入库的 ES256、EdDSA、ES512、PS256/384/512、RS256/384/512 凭据全部可在 TS 登录；TS 注册的公钥可由 Python 验证并更新计数，Python 签发的 challenge 可在 TS 消费。另覆盖 Python Argon2id/i/d 哈希、双方共享会话、RP/origin、UV/UP、坏签名、计数重放、并发更新、challenge 重放/过期/错误类型/畸形请求、注册会话绑定与密码新鲜度、重复凭据、重命名与删除，以及多 SQLite 连接争用同一 challenge。

`scripts/check-ssr.mjs` 使用真实生产 handler 与临时数据库，验证匿名跳转、登录 HTML/数据、错误/正确密码、会话写入、安全页 SSR、受保护 RPC、公开 JS/CSS、隐藏文件拒绝访问和退出后失效。保留 `scripts/solid-start-compat.ts`，构建后的真实 RPC 仍通过。

## 未执行与外部验收

沙箱禁止 sockets，未启动 HTTP 监听或运行真实浏览器。因此未验证浏览器水合、平台认证器弹窗或真实硬件 passkey。没有用户密码输入，未尝试用部署中的真实密码登录；兼容性证明使用 Python 生成的 PHC 哈希和已实际完成 Python 验签/入库的测试凭据。

编排方可在沙箱外指向书库/数据库副本启动 `pnpm dev` 或 `pnpm start`，用现有密码与原 Python 注册的硬件 passkey 完成登录，访问 `/security` 检查新增、重新认证、重命名、删除与退出。Phase 3 的完整书库页面和业务路由未纳入本阶段，首页仍保留已有数量脚手架并增加安全设置入口。

本次过程中 `.gitignore` 新增了 `.env` 忽略条目；未由本次文件编辑操作写入，来源未确认，已原样保留，未将其归为本次实现。初始未跟踪 `.codex` 亦原样保留。

建议 commit message（未执行 commit）：

```text
:sparkles: feat(server): Port compatible storage and authentication
```
