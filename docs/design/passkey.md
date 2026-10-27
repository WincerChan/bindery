# Passkey Sign-in · Design Spec

Goal: after the first sign-in with a password, the user can add one or more passkeys and from then on sign in with Face ID / fingerprint / device PIN or a password manager instead of typing the password.

- **Password always remains**: it is the fallback sign-in and the only way to add a passkey (step-up verification). Deleting every passkey never locks anyone out.
- Single-user app: there is no user table; every passkey belongs to the one Bindery user.
- Visual language follows [README.md](README.md) (设计准则 · 书页); the redesigned security page is `prototype/SettingsSecurity.dc.html`.

Non-goals: multiple users, password changes, session-lifetime policy (the cookie stays a browser-session cookie as today), attestation verification, conditional UI / autofill passkeys.

---

## 1. Dependency

Add `webauthn` (py_webauthn, Duo Labs, ≥ 2.0) as a runtime dependency. Do not hand-roll WebAuthn verification (CBOR, COSE keys, signature counters, origin / RP ID hash checks); getting any of those wrong is a security hole. No frontend dependency: write `static/passkey.js` by hand.

## 2. Configuration (`bindery/env.py` `read_env`, `_FILE` variants supported)

| Variable | Description |
| --- | --- |
| `BINDERY_PUBLIC_ORIGIN` | Public origin of the site, e.g. `https://books.example.com` (no path, no trailing slash). Must be https, except when the hostname is `localhost` |
| `BINDERY_WEBAUTHN_RP_ID` | Optional; defaults to the hostname of `BINDERY_PUBLIC_ORIGIN`. Must equal that hostname or be a registrable suffix of it |

Resolve the config in a single function (e.g. `webauthn_config(request) -> Optional[Config]`):

1. If `BINDERY_PUBLIC_ORIGIN` is set: validate it (scheme / host / no path; https unless localhost) and use it. If it is invalid → treat as unavailable and log a warning at startup.
2. If it is unset: **only** when the request hostname is `localhost` (any port), take origin = `{scheme}://{host[:port]}` and rp_id = `localhost` (local development).
3. Anything else (including `127.0.0.1`: an RP ID cannot be an IP address) → unavailable. Every passkey endpoint returns 404 / no-op, the login page does not show the passkey button, and `/security` shows the configuration notice.

Do not trust `Host` / `X-Forwarded-*` to derive the origin in production: the container runs `uvicorn --proxy-headers` but `--forwarded-allow-ips` defaults to 127.0.0.1 only, so behind a reverse proxy the scheme often resolves to http.

## 3. Data model (`bindery/db.py`, follow the existing `CREATE TABLE IF NOT EXISTS` + `_table_columns` migration style)

```sql
CREATE TABLE IF NOT EXISTS passkeys (
  credential_id   TEXT PRIMARY KEY,        -- base64url
  public_key      BLOB NOT NULL,           -- COSE public key bytes
  sign_count      INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT NOT NULL DEFAULT '[]',
  aaguid          TEXT,
  device_type     TEXT,                    -- 'single_device' | 'multi_device'
  backed_up       INTEGER NOT NULL DEFAULT 0,
  name            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_used_at    TEXT
);

CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- key 'webauthn_user_id': 32 random bytes as base64url, generated on first use and never changed

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id          TEXT PRIMARY KEY,            -- secrets.token_urlsafe(32), stored in a cookie
  kind        TEXT NOT NULL,               -- 'login' | 'register'
  challenge   BLOB NOT NULL,
  session_id  TEXT,                        -- required for register: binds the challenge to the session that issued it
  expires_at  TEXT NOT NULL                -- now + 5 minutes
);
```

- Single-use challenges: on verify, **always** `DELETE ... RETURNING` (or select-then-delete inside one transaction) first, and then check kind / expiry / session. Each new challenge also purges expired rows.
- Add to `sessions`: `auth_method TEXT NOT NULL DEFAULT 'password'` and `password_verified_at TEXT`. Password sign-in writes `auth_method='password'` and `password_verified_at=now`; passkey sign-in writes `auth_method='passkey'` and `password_verified_at=NULL`. `create_session` / `sign_in` take those two arguments (keep the old call sites compatible or update them all).
- The DB layer exposes: `list_passkeys`, `get_passkey`, `count_passkeys`, `insert_passkey`, `update_passkey_usage(credential_id, sign_count, backed_up, last_used_at)`, `rename_passkey`, `delete_passkey`, `get_or_create_webauthn_user_id`, `create_challenge`, `pop_challenge`, `mark_password_verified(session_id, now)`.

## 4. Endpoints

All JSON POSTs **must** carry `Content-Type: application/json`; otherwise return 415 (CSRF hardening: a cross-site form cannot send JSON without a preflight). On error, return `{"error": "<Chinese message>"}` with a matching 4xx status. Do not include anything sensitive in error messages; log details on the server.

### 4.1 Sign-in (no session needed; under the `/login` prefix, which the existing middleware already exempts)

| Method & path | Behavior |
| --- | --- |
| `POST /login/passkey/options` | Requires an available config and ≥ 1 passkey (otherwise 404). `generate_authentication_options(rp_id, user_verification=REQUIRED, allow_credentials=[])` (discoverable credentials). Store challenge with kind=login. Set cookie `bindery_webauthn` = challenge id: `HttpOnly; SameSite=Strict; Path=/login/passkey; Max-Age=300`, plus `Secure` when the origin is https. Return the options JSON (`options_to_json`) |
| `POST /login/passkey/verify` | Body `{"credential": <PublicKeyCredential JSON>, "next": "/..."}`. pop_challenge (kind=login, unexpired) → look up the passkey by `rawId` → `verify_authentication_response(expected_rp_id, expected_origin, credential_public_key, credential_current_sign_count, require_user_verification=True)` → update sign_count / backed_up / last_used_at → `sign_in(auth_method='passkey')`, set the session cookie (same attributes as password sign-in) → clear `bindery_webauthn` → return `{"redirect": safe_next}`. Every failure (missing/expired challenge, unknown credential, failed verification) returns the same 400 `{"error":"通行密钥验证失败"}` |

### 4.2 Management (requires a session; prefix `/security`)

Freshness: the session is "fresh" when `password_verified_at` is within the **last 10 minutes**. That way, right after a password sign-in the user can add a passkey without re-entering the password; past that window they must confirm the password again.

| Method & path | Behavior |
| --- | --- |
| `GET /security` | Security page, see §6.2 |
| `POST /security/reauth` | `{"password": "..."}` → on success `mark_password_verified`, return `{"ok": true}`; on failure 400 `{"error":"密码错误"}`; with no password hash configured, 400 `{"error":"未配置密码哈希"}` |
| `POST /security/passkeys/register/options` | Config unavailable → 404. Not fresh → **403 `{"error":"needs_password"}`**. Otherwise `generate_registration_options(rp_id, rp_name="Bindery", user_id=webauthn_user_id, user_name="bindery", user_display_name="Bindery", exclude_credentials=<existing, with transports>, authenticator_selection=AuthenticatorSelectionCriteria(resident_key=REQUIRED, user_verification=REQUIRED), attestation=NONE)`. Store challenge with kind=register and session_id. Cookie `bindery_webauthn` with `Path=/security/passkeys`, other attributes as above. Return the options JSON |
| `POST /security/passkeys/register/verify` | Body `{"credential": ..., "name": "..."}`. pop_challenge (kind=register, unexpired, session_id equals the current session) → **check freshness again** → `verify_registration_response(expected_challenge, expected_origin, expected_rp_id, require_user_verification=True)` → insert (credential_id already exists → 409 `{"error":"此通行密钥已添加"}`) → return `{"ok": true, "passkey": {...}}`. Name: trim, at most 40 characters; if empty, default to `通行密钥 N` |
| `POST /security/passkeys/{credential_id}/rename` | `{"name": "..."}`, same rules → `{"ok": true, "name": ...}`; 404 when it does not exist |
| `POST /security/passkeys/{credential_id}/delete` | Plain form POST (no JSON needed); 303 back to `/security?toast=已删除通行密钥` (the base template already handles the `toast` query). No freshness required (deleting can only reduce access) |

### 4.3 Hardening the existing code (on the same path)

- Add `_safe_next(value: str) -> str`: accept only paths that start with `/`, are not `//` or `/\`, and contain no scheme or control characters; otherwise return `/`. Use it for the `next` on the `GET /login` page, the `POST /login` redirect, and `POST /login/passkey/verify`. (Today `POST /login` passes `next` straight to `RedirectResponse`, which is an open redirect.)
- Password sign-in must write `auth_method` / `password_verified_at` (see §3).

## 5. `static/passkey.js` (hand-written, no build step, ~150 lines)

Expose `window.binderyPasskey`:

- `supported()`: `!!window.PublicKeyCredential && !!navigator.credentials`
- `login(next)`: options → `navigator.credentials.get({publicKey})` → verify → `location.assign(redirect)`
- `register({name})`: options (on 403 needs_password, throw `{code:'needs_password'}`) → `navigator.credentials.create` → verify
- `reauth(password)`
- Conversion: prefer `PublicKeyCredential.parseCreationOptionsFromJSON` / `parseRequestOptionsFromJSON` and `credential.toJSON()`; otherwise fall back to hand-written base64url ↔ ArrayBuffer conversion (challenge, user.id, excludeCredentials[].id, allowCredentials[].id; rawId, clientDataJSON, attestationObject, authenticatorData, signature, userHandle; plus `getTransports()`).
- Normalize errors: `NotAllowedError` / `AbortError` → `{code:'cancelled'}`; `InvalidStateError` → `{code:'exists'}`; server error → `{code:'server', message}`.
- Send JSON POSTs with `credentials: 'same-origin'`.

Include it in `login.html` and `base.html` with `<script defer src="/static/passkey.js">`.

## 6. UI

### 6.1 Login page `login.html` (based on the current redesigned layout)

When a passkey is usable (config available and ≥ 1 passkey on the server; the block is rendered with `hidden`, and JS reveals it only if `supported()`):

```
■ Bindery
PRIVATE LIBRARY · TXT → EPUB
────────────────────────── (ink rule)
[ 🔑 使用通行密钥登录 ]        ← btn-primary, full width, 42px, key icon as inline stroke SVG
────── 或使用密码 ──────        ← hairline + 12px ink-3 text + hairline
密码
[ 输入访问密码           ]
[ 登录 ]                      ← changes to btn-secondary (passkey is primary now)
```

- When unavailable: the current layout is unchanged (password + black "登录").
- While running: button disabled, text changes to "等待验证…".
- Cancelled: an ink-3 hint "已取消。" below the button. Failure: the existing danger-style notice (with the 2px left bar) "通行密钥登录失败，请重试或使用密码。"
- `next` comes from the server-rendered hidden field (already sanitized by `_safe_next`).

### 6.2 Security page `/security` (`templates/security.html`)

Page head (`.page-head`): `安全` + mono `N 个通行密钥`; right side `btn-primary` "+ 添加通行密钥" (hidden when unsupported or not configured).

**Section "通行密钥"** (section title 15/600 + 12.5px ink-3 description "通行密钥保存在设备或密码管理器中，用指纹、面容或设备密码即可登录。")

- Desktop table (mono uppercase header + ink rule, line hairlines between rows):
  `名称` | `类型` | `创建` | `最近使用` | actions
  - Type uses `.tag`: `multi_device` or `backed_up` → "已同步" (surface + line stroke); otherwise "仅此设备" (same style)
  - Dates in mono `YYYY-MM-DD`; most-recent-use null → "从未"
  - Actions: `重命名` (btn-quiet btn-sm), `删除` (btn-quiet btn-sm, danger text; `confirm('删除后将无法再用它登录。确定删除？')`)
  - Rename is inline: the name cell turns into `.field` + `保存`/`取消`; Enter saves, Esc cancels (Alpine + fetch)
- Phone (< 768px): two-line rows. Line 1: name 15/600 + type tag; line 2: mono `创建 2026-10-19 · 最近 2026-10-20`; the two actions on the right of the row.
- Empty state: `还没有通行密钥` 15/600 + ink-3 "添加后，下次登录无需输入密码。" + primary `添加通行密钥`
- Not configured: a notice (warn color, 2px left bar): "通行密钥不可用：未配置 BINDERY_PUBLIC_ORIGIN。本地开发请用 http://localhost:端口 访问（127.0.0.1 不行）。"
- Browser unsupported (JS check): a notice "当前浏览器不支持通行密钥。"

**Section "密码"**: one line of ink-3 text: "密码始终可作为备用登录方式。修改密码请更新 BINDERY_PASSWORD_HASH 并重启服务。"

### 6.3 "Add passkey" dialog (partial `templates/partials/passkey_dialog.html`, reused by the security page and the library-page prompt)

Use the existing `.modal-panel` + `.sheet-mask` (same as the tracker page's modals); on phone it docks at the bottom as a sheet. Alpine state machine:

1. **`confirm`** (only when register/options returns needs_password): title "确认身份", text "添加通行密钥前，请输入当前密码。", password `.field` (autofocus, `autocomplete="current-password"`), buttons `取消` (quiet) / `继续` (primary). Wrong password → danger inline "密码错误". On success, return to step 2 automatically.
2. **`name`**: title "添加通行密钥", label "名称", `.field` pre-filled with a device name guessed from the UA (`iPhone` / `iPad` / `Mac` / `Android` / `Windows` / `Linux`, otherwise empty, placeholder "例如：我的 iPhone"); buttons `取消` / `创建通行密钥` (primary).
   - The flow requests register/options first. If it gets needs_password it goes to step 1 and, after that passes, comes back here; otherwise it starts the browser ceremony.
3. **`waiting`**: text "请在系统弹窗中完成验证…", buttons disabled.
4. Result: success → close the dialog, `binderyToast('已添加通行密钥')`, refresh the list (on the security page `location.reload()`; on the library page hide the prompt). `cancelled` → back to step 2 with ink-3 "已取消。"; `exists` → danger "这个设备已经添加过通行密钥。"; other → danger "添加失败：<message>".

### 6.4 Post-login prompt (top of the library page `index.html`, below the page head)

Server-side condition: `passkey config available` and `current session auth_method == 'password'` and `count_passkeys() == 0`. Client-side condition: `supported()` and `localStorage['bindery-passkey-nudge'] !== 'dismissed'` (wrap reads and writes in try/catch). Render with `hidden` and let JS reveal it.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 🔑  下次登录可以跳过密码   用指纹或面容即可登录。      [添加通行密钥] [不再提示] │
└──────────────────────────────────────────────────────────────────────────┘
```

- surface background, 1px line stroke, 2px corners, padding 12px 16px; key icon in ink; main text 13.5/600, secondary text 12.5 ink-3; on the right `btn-primary btn-sm` + `btn-quiet btn-sm`.
- On phone: text above, two buttons below, in two equal columns.
- "添加通行密钥" opens the dialog from §6.3 (within 10 minutes of the password sign-in it skips straight to the naming step); after success the prompt disappears. "不再提示" writes localStorage and hides it.

### 6.5 Navigation

- Desktop header right side: before "退出", add a quiet link `安全` (`/security`), with the same active state as the nav (ink + 600).
- Phone "更多" sheet: after "归档" and before "退出登录", add a row `安全与通行密钥` → `/security`; the "更多" tab's active condition should also include `/security`.

## 7. Tests (`unittest` + `fastapi.testclient`, like the existing `tests/test_cache_headers.py`)

Point the DB at a temp file (`BINDERY_DB_PATH`) with a configured password hash; **mock** the four py_webauthn verify/generate functions (patch the names imported in `bindery.web`), so no real authenticator is needed. Cover at least:

- Config resolution: env set (https / localhost http) → available; http on a non-localhost host → unavailable; unset + localhost request → available; unset + 127.0.0.1 → unavailable.
- Migrations: the new `sessions` columns are added to an old DB; CRUD for `passkeys` / `app_settings` / `webauthn_challenges`; `webauthn_user_id` is stable.
- `_safe_next`: `/`, `/book/x?y=1` allowed; `//evil.com`, `https://evil.com`, `/\evil.com`, `javascript:...`, empty → `/`.
- Sign-in: options sets the cookie and stores the challenge; verify success → session with auth_method=passkey + safe redirect; the same challenge cannot be reused; expired challenge, unknown credential and failed verification → 400 with the identical message; with no passkeys, options → 404; non-JSON → 415; `/login/passkey/*` is reachable without a session.
- Registration: within 10 minutes of a password sign-in, options are issued directly; outside it → 403 needs_password; after reauth they are issued; a challenge from another session is rejected; duplicate credential → 409; default name and 40-character truncation.
- rename / delete; `/security` without a session redirects to login.
- Password sign-in writes `password_verified_at`; `POST /login` with an evil `next` redirects to `/`.
- Template smoke tests: login.html contains the passkey block (hidden) only when available; index.html shows the prompt only when the condition holds.

## 8. Docs

Add a "通行密钥" section to the root `README.md`: what it is for, the `BINDERY_PUBLIC_ORIGIN` / `BINDERY_WEBAUTHN_RP_ID` configuration (a Quadlet example), that local development must use `localhost`, and that the password always remains as the fallback. Also add a commented `BINDERY_PUBLIC_ORIGIN=` line to the env example in `deploy/quadlet/bindery.container`.
