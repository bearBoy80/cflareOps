# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

cloudflareOps — a self-hosted dashboard to manage **multiple Cloudflare accounts** (Zones, DNS, Workers, Pages, R2 storage, usage analytics) from one place. Astro 5 SSR + React 19 islands on Cloudflare Pages, D1 (SQLite) for storage, Cloudflare Access (Zero Trust) for auth. Bilingual UI (zh default / en).

## Commands

```bash
npm run dev              # Astro dev server on :4321, HMR, live D1 (better-sqlite3), .dev.vars loaded, Access bypassed
npm run build            # Production build
npm run preview          # wrangler pages dev ./dist — verify the real build against workerd
npm run deploy           # build + wrangler pages deploy
npm run typecheck        # astro check + tsc --noEmit  (run before every commit)
npm run check            # biome check --write .  — format + lint + organize imports (autofix)
npm run check:ci         # biome ci .  — non-writing gate CI runs (.github/workflows/ci.yml)
npm run format           # biome format --write .   (formatting only)
npm run lint             # biome lint .             (lint only, no writes)
npm run test             # vitest run
npm run db:migrate       # apply D1 migrations locally
npm run db:migrate:remote# apply D1 migrations to remote
```

Single test / watch:
```bash
npx vitest run tests/unit/cf-client.test.ts     # one file
npx vitest -t "verifyToken"                       # by test name
npx vitest                                        # watch mode
```

First-time local setup: `npm install`, `cp wrangler.toml.example wrangler.toml`, `cp .dev.vars.example .dev.vars`, generate a 64-hex `ENCRYPTION_KEY` (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) into `.dev.vars`, then `npm run db:migrate`.

## Architecture

**Request pipeline** (`src/middleware.ts`, run as `sequence`):
1. `errorBoundary` — wraps everything; any uncaught exception under `/api/*` becomes structured JSON via `apiErrorResponse` (stable machine `code`, e.g. `config.dbBindingMissing`, `config.dbNotMigrated`). Page routes fall through to Astro's default handler.
2. `accessMiddleware` — verifies the `Cf-Access-Jwt-Assertion` JWT against the team's JWKS (cached per team domain) and sets `locals.userEmail`. In dev, `shouldBypassAuth` (`src/server/auth.ts`) lets `DEV_MODE=true` skip auth — **but only if `CF_ACCESS_*` are unset** (mutually exclusive guard rail; keep Access vars unset locally or you get a 403).
3. `localeMiddleware` — bilingual routing.

**Every API route starts with `appContext(locals)`** (`src/server/context.ts`) → returns `{ db, key, userEmail }`, throwing typed `ConfigError`s if `DB` binding or `ENCRYPTION_KEY` is missing/invalid. This is the single choke point that guarantees a request has a DB, a decryption key, and an authenticated user.

**Per-user data isolation is enforced in SQL, not middleware.** Every account/cache query filters by `owner_email = ?` (the `userEmail` from `appContext`). See `src/server/db/accounts.ts`. When adding any query that touches user data, you MUST scope it by `owner_email`. Resources not visible to the current user surface as `NotFoundError` → 404.

**Cloudflare API access goes through `CfClient` only** (`src/server/cf/client.ts`). Business code must never `fetch` Cloudflare directly. `CfClient` wraps the official `cloudflare` SDK and normalizes errors into `CfApiError` (status + messages). Two escape hatches inside the class for endpoints the SDK doesn't cover cleanly: `raw()`/`rawEnvelope()` (v4 REST envelope) and `graphql()` (Analytics API). The file is heavily commented with SDK gotchas (e.g. `scripts.settings` vs `scripts.scriptAndVersionSettings` map to *opposite* URL paths; `/pages/projects` rejects explicit `per_page`; workerd `fetch` needs `this` bound to `globalThis`). Read those comments before changing client methods.

**R2 has one sanctioned exception to the CfClient boundary.** Bucket/object/settings/usage calls go through `CfClient` like everything else, but object transfers are browser-direct via presigned S3 URLs built in `src/server/r2Presign.ts` — the **only** file allowed to reference `*.r2.cloudflarestorage.com`. S3 credentials are derived per request from the account token (accessKeyId = `verifyToken().id`, secret = SHA-256 hex of the token) and are never stored or logged. Adding `downloadFilename` appends a `response-content-disposition=attachment` query param **before signing** → true attachment download. Object preview is a hybrid channel: media kinds (image/pdf/video/audio) load presigned GET URLs directly in tags (tag loads are CORS-exempt, so bucket CORS config is not required); text/markdown go through `GET .../content`, which relays ≤1 MB via `CfClient.getR2ObjectContent` (over limit → 413 with code `objectTooLarge`); markdown renders only inside a sandbox iframe (`sandbox=""` + srcDoc — same anti-XSS pattern as `EmailPreview`). R2 SDK gotchas: objects list with `delimiter='/'` returns folder prefixes in `result_info.delimited` (undeclared in SDK types), not in the result array; object keys must be per-segment encoded via `encodeR2ObjectKey` (the SDK splices keys into URLs raw).

**Secrets (API tokens) are encrypted at rest** with AES-GCM (`src/server/crypto.ts`). `ENCRYPTION_KEY` is 64 hex chars (256-bit). Stored format is `base64(iv).base64(ciphertext)`. Tokens are also de-duplicated per user via `token_hash` (SHA-256). Never log or return decrypted tokens.

**Sync = cache-fill pattern.** `syncWorkersPages` (`src/server/workersPages.ts`) and the zones sync fan out across a user's accounts with `p-limit` concurrency (3). Each account's refresh is an **atomic batch**: collect `DELETE ... WHERE account_id=?` + all `INSERT`s, then run them in one D1 `batch()`. If any upstream fetch throws first, the batch never runs and the old cache is preserved (no partial-delete). Per-account failures are collected and reported, not fatal — one bad token doesn't block other accounts.

**D1 tables are CF-API caches.** Cache-table columns map 1:1 to SDK object fields (see comments in `migrations/`), plus system columns `account_id` / `synced_at` and a `raw_json` holding the full SDK object. Cascade deletes (`ON DELETE CASCADE` from `cf_accounts`) keep account + cache atomic. Migrations are `migrations/NNNN_description.sql`, applied in filename order.

**Build target quirk** (`astro.config.mjs`): `output: 'server'` with the Cloudflare adapter targets workerd, which lacks `MessageChannel`, so the *build* aliases `react-dom/server` → `react-dom/server.edge`. That edge entry is CJS and Vite's dev module runner can't load it (and Node doesn't need it), so the alias is applied **only when `process.argv[2] === 'build'`**. If you touch SSR/rendering config, keep that dev-vs-build split intact.

### Layout

```
src/
  middleware.ts          auth + error boundary + locale (the pipeline)
  env.d.ts               Env bindings + App.Locals.userEmail
  server/
    context.ts           appContext(), typed errors, error→Response mapping
    auth.ts              shouldBypassAuth
    crypto.ts            AES-GCM encrypt/decrypt, sha256Hex
    cf/client.ts         CfClient — the ONLY path to Cloudflare's API
    cf/types.ts          normalized Cf* shapes
    db/accounts.ts       account repo (all owner_email-scoped)
    workersPages.ts      Workers/Pages sync + cache reads
    zones.ts, usage.ts, r2.ts  same pattern for zones, analytics, and R2 buckets
    r2Presign.ts         presigned S3 URL builder (the only *.r2.cloudflarestorage.com site)
  pages/                 Astro routes + src/pages/api/** endpoints (file-based)
  pages/en/**            English mirror of the localized routes
  components/            React island panels (one per feature) + components/ui/**
  lib/                   shared pure helpers (previewKind, withCf, triggerDownload, formatBytes, ...)
  i18n/                  LOCALES, string tables, locale middleware/routing
migrations/              D1 SQL (NNNN_description.sql)
tests/unit/**            Vitest; tests/helpers/d1.ts is the D1 test double
```

### Testing

Tests run under Node (not workerd). `tests/helpers/d1.ts` `createTestDb()` builds an in-memory `better-sqlite3` DB, **runs the real migration files in order** (so the test schema always matches production), and mirrors D1's `batch()` = single-transaction all-or-nothing semantics with `foreign_keys = ON`. Because tests are Node-only, workerd-specific bugs (the `fetch`/`this` binding issue, CJS edge SSR entry) won't surface here — verify those with `npm run preview`.

## Conventions

- **CfClient is the boundary.** No direct `fetch` to `api.cloudflare.com` outside `src/server/cf/client.ts`. The single S3 exception: `*.r2.cloudflarestorage.com` may appear only in `src/server/r2Presign.ts`.
- **Imports use path aliases, never parent-relative paths.** `@/*` → `src/*`, `@tests/*` → `tests/*`, defined in `tsconfig.json` `paths` and mirrored in `vitest.config.ts` `resolve.alias` (Astro reads tsconfig aliases natively; Vitest does not). Same-directory `./` imports are fine.
- **Scope every user-data query by `owner_email`.**
- **API errors:** throw `ConfigError`/`NotFoundError`/`CfApiError`; let the middleware boundary or `handleCfError` map them. Give new config failures a stable `code` so the frontend can localize a diagnostic.
- **New user-facing strings go in `src/i18n/index.ts`** for both `zh` and `en`; add the English page under `src/pages/en/**`.
- Missing Edit-scope tokens should surface a 403 on the specific action only, never break read-only views.
- Run `npm run check` (Biome format + lint), `npm run typecheck`, and `npm run test` before submitting. Biome is scoped to JS/TS/JSON — `.astro`, `.css` (Tailwind v4), and `public/**` are excluded; `noNonNullAssertion`, `useButtonType`, and `noArrayIndexKey` are off, matching existing code. CI (`.github/workflows/ci.yml`) runs `check:ci` + typecheck + test.

---

## 手机端 UI 设计规则

以下规则来自 2026-07-06 移动端适配三轮真机验收（Workers/Pages/Zones），**所有新页面/新组件必须遵循**：

### 表格

1. **卡片内所有 `<table>` 必须包 `<div className="overflow-x-auto">`**（含 skeleton 占位表格）——表格在卡内横滚，永远不允许把整页撑出横向滚动条。
2. **列表页次要列窄屏隐藏**：手机上只保留「名称 + 时间 + 操作」三列（无横滚），次要列按重要性用 `hidden sm:table-cell` / `hidden md:table-cell` / `hidden lg:table-cell` 逐级恢复。名称列永远可见。
   - 自研表格（WorkersPanel ListSection 模式）：`Column.className`，渲染时应用到 th/td/skeleton td 三处。
   - TanStack Table（ZonesPanel 模式）：`columnDef.meta.className` + `colClass()` helper，同样应用三处。
3. 列表行统一支持：名称列可点击链接（`link-hover font-mono hover:text-primary`）+ 行双击跳详情（`cursor-pointer hover:bg-base-200/60` + onDoubleClick）。

### 页头与按钮

4. 页头 `h1` 用 `min-w-0 flex-1 truncate`（窄屏单行省略号，禁止竖排换行撑高）；用户 email 等次要信息 `hidden md:inline`。
5. **含汉字的小按钮（btn-xs/btn-sm）必须加 `whitespace-nowrap`**——否则两个汉字会被压成竖排。
6. **工具栏主操作按钮（同步类）窄屏收成纯图标**：文字包 `<span className="hidden whitespace-nowrap sm:inline">`，按钮加 `title` 提示；≥sm 恢复图标+文字。**禁止窄屏 `w-full` 整行铺开方案**（已被用户否决）。

### 表单与行内布局

7. 多输入表单行窄屏纵向堆叠：容器 `flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start`，输入 `w-full sm:w-48`（或 `sm:flex-1`）。
8. 固定宽度输入（如 `w-64` 搜索框）必须加 `max-w-full`。
9. flex 行内元素：badge 加 `shrink-0 whitespace-nowrap`，长文本（URL 等）加 `min-w-0 break-all`，右侧控件（toggle/按钮）加 `shrink-0`。

### 详情页 Tab 布局

10. Tab 内容一律**全宽垂直堆叠**，禁止两列网格（用户明确偏好）；tab 状态走 URL `?tab=`（复用 `src/components/ui/DetailTabs.tsx` + `useDetailTab`，astro 页面服务端读 searchParams 传 `initialTab` 防 hydration mismatch）。

### 模态框

11. 大内容模态（R2 对象预览 PreviewModal 模式）：手机端全屏（`h-full w-full max-w-full rounded-none`），≥sm 恢复 `sm:h-[85vh] sm:w-[90vw] sm:rounded-2xl`；内容区 `min-h-0 flex-1 overflow-auto` 自身滚动，禁止撑破页面；Esc 与点遮罩均可关闭。

### 验收标准

12. 每次 UI 改动的移动端验收：**500px 视口下 `document.scrollingElement.scrollWidth === window.innerWidth`（零整页横滚）**，逐页检查；1440px 桌面回归无视觉变化。
