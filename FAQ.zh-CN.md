# FAQ

[English](./FAQ.md) | [返回 README](./README.zh-CN.md)

## 本地开发

### 应该使用哪个包管理器？

推荐本地开发使用 pnpm，因为仓库包含 `pnpm-lock.yaml`：

```bash
pnpm install
```

npm 也可以使用，但不要在同一个 `node_modules` 中混用 npm 和 pnpm。如果要切换包管理器，请先删除 `node_modules`，再用目标包管理器重新安装。

### 为什么 `npm run test` 报 `Could not locate the bindings file ... better_sqlite3.node`？

本地 D1 测试替身依赖 `better-sqlite3`，它需要编译一个 native `.node` binding。pnpm 可能会在安装时先忽略依赖的构建脚本，直到你明确批准。

先查看当前被忽略的构建：

```bash
pnpm ignored-builds
```

批准并重建本地开发会用到的包：

```bash
pnpm approve-builds better-sqlite3 esbuild workerd sharp
pnpm rebuild
```

然后再运行：

```bash
pnpm run test
```

### 为什么 npm scripts 能启动，但很多测试都失败在 `createTestDb()`？

这通常表示 JavaScript 依赖已经装好，但 `better-sqlite3` 的 native 二进制没有构建出来。这是本地安装环境问题，不是业务断言失败。按上一条批准 pnpm builds 并 rebuild 即可。

### 为什么设置了 `DEV_MODE=true`，本地仍然 403？

只要设置了 `CF_ACCESS_TEAM_DOMAIN` 或 `CF_ACCESS_AUD`，`DEV_MODE` 旁路就会被禁用。这是故意的安全护栏，避免生产 Access 配置意外启用本地免登录。

本地开发请保留：

```dotenv
DEV_MODE=true
DEV_USER_EMAIL=dev@localhost
```

并保持以下变量未设置或注释：

```dotenv
# CF_ACCESS_TEAM_DOMAIN=...
# CF_ACCESS_AUD=...
```

### 为什么 API 返回 `config.dbBindingMissing` 或 `config.dbNotMigrated`？

`config.dbBindingMissing` 表示当前运行时没有拿到 `DB` binding。请确认 `wrangler.toml` 存在，且 D1 binding 名称是 `DB`。

`config.dbNotMigrated` 表示 D1 表还不存在。运行：

```bash
pnpm run db:migrate
```

远程 D1 则运行：

```bash
pnpm run db:migrate:remote
```

### `pnpm run dev` 和 `pnpm run preview` 有什么区别？

`pnpm run dev` 启动 Astro dev server，带 HMR，是最快的本地开发流程。

`pnpm run preview` 会用 `wrangler pages dev ./dist` 跑生产构建产物。需要先运行 `pnpm run build`。当你要验证 workerd 行为、Cloudflare adapter 行为或生产 SSR 输出时，用 preview。

### 为什么只有 `astro build` 时才把 `react-dom/server` 指到 `react-dom/server.edge`？

Cloudflare workerd 没有 `MessageChannel`，所以生产构建必须使用 `react-dom/server.edge`。但这个 edge 入口不适合 Astro 的 Vite dev module runner，因此 alias 只在 `astro build` 时启用。

## Cloudflare Token

### API Token 需要哪些权限？

最小读取权限：

- Zones / DNS：`Zone: Read`、`DNS: Edit`
- Workers & Pages：`Account Settings: Read`、`Workers Scripts: Read`、`Cloudflare Pages: Read`
- 用量页：`Account Analytics: Read`

写操作需要对应 Edit 权限：

- Pages 写操作：`Cloudflare Pages: Edit`
- Workers 写操作：`Workers Scripts: Edit`

缺少 Edit 权限时，应只让对应写操作返回 403；只读页面不应因此不可用。

### 为什么某个账号同步失败不会阻塞其他账号？

同步按账号独立执行并记录单账号失败。某个 Token 过期或权限不足，不应该影响其他账号刷新缓存。

## 数据与安全

### API Token 会明文存储吗？

不会。Token 存储前会使用 `ENCRYPTION_KEY` 做 AES-GCM 加密。系统另存 SHA-256 hash，用于同一用户下的 Token 去重。不要记录解密后的 Token，也不要通过 API 返回它。

### 用户数据隔离在哪里保证？

用户数据隔离在 SQL 层通过 `owner_email = ?` 保证。新增任何触及用户数据的查询时，都要使用 `appContext()` 中的当前 `userEmail` 过滤。跨用户资源应该表现为资源不存在。
