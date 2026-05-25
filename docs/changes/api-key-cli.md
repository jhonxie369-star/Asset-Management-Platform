# API Key and CLI Automation

Date: 2026-05-15

## Goal

为后续 AI/CLI/CI 自动化接入 SASP 提供受控入口，避免 AI 直接改数据库或复用 Web session。第一版实现 API Key 认证、API Key 管理接口、`sasp-cli` 薄封装和 AI context 预留接口。

## Change 1: Shared data model

- Files:
  - `shared/src/index.ts`
- What changed:
  - Added `ApiKeyRecord`.
  - Added `AuthAuditLog`.
- Why:
  - API Key 需要独立生命周期：创建、只展示一次、hash 存储、lastUsedAt、revoke。
  - 审计日志为后续追踪 AI/CLI 写操作预留。
- Risk control:
  - Only adds new collections/types; does not change existing asset/task/finding structures.

## Change 2: Store collections

- Files:
  - `backend/src/storage/store.ts`
- What changed:
  - Added `apiKeys` and `authAuditLogs` collections to JSON store.
- Why:
  - Current platform uses JSON store; first version should keep API Key data in the same persistence model.
- Risk control:
  - `Store.init()` already merges default collections, so old `store.json` remains compatible.

## Change 3: API Key auth middleware

- Files:
  - `backend/src/http/auth.ts`
- What changed:
  - `requireAuth(store)` now accepts either Web session or `Authorization: Bearer sasp_xxx.yyy`.
  - API Key is verified by sha256(fullKey).
  - `lastUsedAt` is updated on successful API Key use.
  - `req.authActor` is populated for downstream audit.
- Why:
  - AI/CLI should use long-lived API Key, not session cookie/password.
- Risk control:
  - Session login behavior remains supported.
  - Full key is never stored, only hash.
  - Revoked keys are rejected.

## Change 4: API Key management API

- Files:
  - `backend/src/http/api-keys.ts`
  - `backend/src/http/app.ts`
- What changed:
  - Added `GET /api/api-keys`.
  - Added `POST /api/api-keys`.
  - Added `DELETE /api/api-keys/:keyId`.
  - Full key returned once on create.
- Why:
  - AI/CLI needs a stable credential lifecycle.
- Risk control:
  - List API never returns `keyHash` or full key.
  - Delete is soft revoke via `revokedAt`.

## Change 5: AI context placeholder

- Files:
  - `backend/src/http/ai.ts`
  - `backend/src/http/app.ts`
- What changed:
  - Added `GET /api/ai/context?asset=<query>`.
  - Added `POST /api/ai/query` placeholder.
- Why:
  - Future AI penetration testing needs structured context: assets, endpoints, services, paths, findings.
- Risk control:
  - First version is read-only context aggregation.

## Change 6: CLI thin wrapper

- Files:
  - `cli/sasp-cli`
- What changed:
  - Added Bash CLI wrapper around REST API.
  - Reads `SASP_URL` + `SASP_API_KEY`, or falls back to `SASP_USER` + `SASP_PASS` login.
  - Supports `--json`.
  - Commands include assets, services, endpoints, findings, tasks, task-run, api-key-create/revoke, ai-context, manifest.
- Why:
  - AI should prefer a stable CLI/tool surface over ad hoc curl or direct DB edits.
- Risk control:
  - CLI contains no business logic; backend remains source of truth.
  - Credentials are read from environment variables.

## Current Scope Model

`scopes` are stored on API keys but not yet enforced per endpoint. This is intentional for first version compatibility. Later versions should add route-level `requireScope()` with wildcard support:

- `read:*`
- `assets:write`
- `ports:write`
- `tasks:write`
- `fingerprints:write`
- `api_keys:write`
- `admin:*`
- `*`

## Verification Plan

1. Build: `npm run build`.
2. Restart service: `./sasp.sh restart`.
3. Create temporary API Key through session auth.
4. Use `Authorization: Bearer <key>` to call `/api/modules`.
5. Use the temporary API Key to call `/api/ai/context`.
6. Revoke key and confirm bearer request fails with 401.
7. Use `cli/sasp-cli` with `SASP_USERNAME/SASP_PASSWORD` compatibility to call `modules`.
8. Use `cli/sasp-cli manifest` and parse JSON.

Actual result:

- Build passed.
- Service restarted successfully.
- Temporary API Key could access `/api/modules` and `/api/ai/context`.
- Revoked temporary API Key returned 401 on subsequent use.
- CLI `modules` returned 5 registered modules.
- CLI `manifest` returned 11 commands.

## Security Notes

- Do not paste full API keys into chat/logs.
- Full key is shown once on creation.
- API Key list shows key id, name, scopes, timestamps only.
- For production, add scope enforcement before granting AI write access broadly.
