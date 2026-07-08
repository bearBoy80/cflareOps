# FAQ

[简体中文](./FAQ.zh-CN.md) | [Back to README](./README.md)

## Local Development

### Which package manager should I use?

Use pnpm for local development when possible because the repository includes `pnpm-lock.yaml`:

```bash
pnpm install
```

npm also works, but do not mix package managers in the same `node_modules`. If you switch between npm and pnpm, remove `node_modules` and reinstall with the one you intend to use.

### Why does `npm run test` fail with `Could not locate the bindings file ... better_sqlite3.node`?

The local D1 test helper uses `better-sqlite3`, which needs a native `.node` binding. With pnpm, build scripts may be ignored until you approve them.

Check the current state:

```bash
pnpm ignored-builds
```

Approve and rebuild the packages used by local development:

```bash
pnpm approve-builds better-sqlite3 esbuild workerd sharp
pnpm rebuild
```

Then run:

```bash
pnpm run test
```

### Why do the npm scripts start, but many tests fail at `createTestDb()`?

That usually means the JavaScript dependencies are installed, but the native `better-sqlite3` binary was not built. It is an environment/install issue rather than a failing application assertion. Approve pnpm builds and rebuild as described above.

### Why do I get a local 403 while `DEV_MODE=true` is set?

`DEV_MODE` bypass is disabled whenever either `CF_ACCESS_TEAM_DOMAIN` or `CF_ACCESS_AUD` is set. This is intentional so a production Access configuration cannot accidentally run with local auth bypass.

For local development, keep:

```dotenv
DEV_MODE=true
DEV_USER_EMAIL=dev@localhost
```

and leave these unset or commented:

```dotenv
# CF_ACCESS_TEAM_DOMAIN=...
# CF_ACCESS_AUD=...
```

### Why do API routes return `config.dbBindingMissing` or `config.dbNotMigrated`?

`config.dbBindingMissing` means the `DB` binding is not available to the runtime. Make sure `wrangler.toml` exists and the binding name is `DB`.

`config.dbNotMigrated` means the D1 tables are missing. Run:

```bash
pnpm run db:migrate
```

For remote D1, run:

```bash
pnpm run db:migrate:remote
```

### What is the difference between `pnpm run dev` and `pnpm run preview`?

`pnpm run dev` runs Astro's dev server with HMR and is the fastest local workflow.

`pnpm run preview` runs `wrangler pages dev ./dist` against the production build output. Use it after `pnpm run build` when you need to verify workerd behavior, Cloudflare adapter behavior, or production SSR output.

### Why does build use `react-dom/server.edge` only during `astro build`?

Cloudflare workerd does not provide `MessageChannel`, so the production build aliases `react-dom/server` to `react-dom/server.edge`. That edge entry is not suitable for Astro's Vite dev module runner, so the alias is intentionally applied only during `astro build`.

## Cloudflare Tokens

### What token scopes are required?

Minimum read scopes:

- Zones / DNS: `Zone: Read`, `DNS: Edit`
- Workers & Pages: `Account Settings: Read`, `Workers Scripts: Read`, `Cloudflare Pages: Read`
- Usage: `Account Analytics: Read`

Write actions need the matching edit scopes:

- Pages write actions: `Cloudflare Pages: Edit`
- Workers write actions: `Workers Scripts: Edit`

Missing edit scopes should only fail the specific write action with 403; read-only views should continue to work.

### Why does one failed account not stop sync for other accounts?

Sync runs per account and records per-account failures. One expired or under-scoped token should not block other accounts from refreshing their cache.

## Data And Security

### Are API tokens stored in plain text?

No. Tokens are encrypted with AES-GCM using `ENCRYPTION_KEY` before they are stored. A SHA-256 hash is stored separately for per-user duplicate detection. Do not log decrypted tokens or return them from APIs.

### How is per-user isolation enforced?

User-owned data is scoped in SQL with `owner_email = ?`. When adding queries that touch user data, filter by the current `userEmail` from `appContext()`. Cross-user resources should behave like not-found resources.
