# 通过 Cloudflare OAuth 连接账号 — 设计文档

日期:2026-08-13
状态:已确认(OAuth 作为「连接 CF 账号」的新方式;与现有 Access/DEV 登录并存;client 已在 dashboard 注册)

## 目标

在「账号」功能里新增一种连接 Cloudflare 账号的方式,与现有手动 API Token **两种方式并存、均为一等公民**,用户按需二选一:

- **手动 Token(保留,不变)**:继续支持粘贴 API Token 添加 / 编辑账号,现有流程零改动。
- **OAuth(新增)**:点「用 Cloudflare 授权」走标准 OAuth 授权码流程,把拿到的 **OAuth access token 当作该账号的 CF API 凭证**,一键授权即添加账号,无需用户手工创建 / 复制 API Token。
- 两类账号在列表 / 同步 / 各功能面板中体验一致(下游只认 `CfClient(token)`),仅在「账号」页用 `auth_type` 区分展示与编辑行为。
- OAuth access token 短寿(默认 900s),用 refresh token 自动续期,对上层透明;Token 账号无过期概念,照旧。

不做(YAGNI):
- **不**改动 dashboard 的登录认证(`登录`仍走 Cloudflare Access / DEV_MODE;OAuth 只负责「连账号」,不产出 `userEmail`)。
- 不做 OAuth 作为身份登录(`login` / `both` 方案本次不实现)。
- 不做公共多租户 OAuth app(client 为 `private` 可见性,自用)。
- 不做 token 撤销 UI(删除账号即删除本地凭证;是否调 `/oauth2/revoke` 见开放问题)。

## 背景与关键约束

1. **Cloudflare self-managed OAuth**(2026-06 GA):在 `Manage Account > OAuth clients` 注册 client,走 OAuth 2.0 授权码流程拿到对 CF API 的委托访问。本项目采用 **Authorization Code + PKCE 的 public client**(token endpoint auth method = **None**,PKCE/S256 必填,**无 client secret**)——与 `wrangler` / `cf` CLI 同款流程。选此而非 confidential(带 secret)是因为:refresh 只需 `client_id`(见 wrangler `exchangeRefreshTokenForAccessToken`:`{grant_type, refresh_token, client_id}`,无 secret),把 `client_id` 存到账号行即可让**续期完全自足**,下游 `clientForAccount` / 各功能路由**零签名改动**。
2. **端点**(固定):
   - 授权 `https://dash.cloudflare.com/oauth2/auth`
   - 令牌 `https://dash.cloudflare.com/oauth2/token`(`application/x-www-form-urlencoded`)
   - 撤销 `https://dash.cloudflare.com/oauth2/revoke`
3. **token 形态**:access token 值形如 `oauth:<...>`,作为 `Authorization: Bearer oauth:<...>` 调 `api.cloudflare.com/client/v4` —— 与 API Token 用法一致,**`CfClient` 无需为鉴权改造**。token 响应含 `access_token` / `refresh_token` / `expires_in`(默认 900)/ `scope`。
4. **refresh 会轮换**:`grant_type=refresh_token` 每次返回新的 `refresh_token`,旧的作废,必须回写最新值(参考 wrangler「每次从存储重读最新 refresh token」的做法)。
5. **scope**:需 `offline_access` 才发 refresh token。请求的 scope 必须是注册 client 已授权 scope 的子集；本项目不把 OAuth 当作登录，因此不请求 `openid`/`userinfo`。
6. **项目铁律**:CfClient 是唯一 CF API 边界;密钥 AES-GCM 加密落库,绝不日志/返回明文;所有用户数据查询按 `owner_email` 隔离。本设计全部遵循。

## 方案选型

**方案 A(采用):OAuth access token 复用 `token_encrypted` 列,新增 refresh/过期列,集中一个 token 解析 choke point 做续期。**

- 下游所有读路径(路由 + 同步 fan-out)最终都从账号行拿一个「当前有效 token」再 `new CfClient(token)`。把「解密 or 刷新」收敛到单一函数 `resolveAccountToken()`,是改动面最小、最不易漏的做法。
- 否决方案 B(每次请求都实时刷新):900s 内重复刷新浪费、且加剧 refresh 轮换竞态。用「过期前 60s 才刷新」的惰性续期。
- 否决方案 C(access token 存内存/KV 缓存):本项目无常驻内存、引 KV 属过度设计;D1 落库 + 惰性刷新已足够。
- 否决方案 D(OAuth 也承担登录):用户已明确本次只做「连账号」,登录保持 Access/DEV,降低认证面风险。

## 架构

### 配置(`src/env.d.ts` + `.dev.vars` / `wrangler.toml`)

新增环境变量(全部可选;缺失 client id 时「用 Cloudflare 授权」入口不出现,现有 Token 流程不受影响):

```
CF_OAUTH_CLIENT_ID     注册 public client 的 client_id(非机密)
CF_OAUTH_REDIRECT_URI  回调地址,须与注册值完全一致;缺省时由请求 origin + /api/accounts/oauth/callback 推导
CF_OAUTH_SCOPES        空格分隔,与 OAuth client 中已选的点号 scope ID 一致
```

**无 client secret**(public + PKCE)。`CF_OAUTH_SCOPES` 使用 Cloudflare OAuth client 页面显示的点号 ID；本项目示例与 `cfops scopes` 截图中的 61 项一致。`.dev.vars.example` / `wrangler.toml.example` 同步补齐并加注释。`getOAuthConfig(env)` 统一读取校验,`isOAuthEnabled(env)` 供路由/前端能力探测。

### OAuth 协议模块(新增 `src/server/cf/oauth.ts`)

纯协议逻辑,可注入 `fetchImpl` 便于单测:

| 导出 | 说明 |
|---|---|
| `getOAuthConfig(env)` / `isOAuthEnabled(env)` | 读取 & 校验配置 |
| `buildAuthorizeUrl({config, state, codeChallenge})` | 拼 `/oauth2/auth?response_type=code&client_id&redirect_uri&scope&state&code_challenge&code_challenge_method=S256`;仅携带 Client 已允许的配置 scope |
| `exchangeCode({config, code, codeVerifier, fetchImpl})` | POST `/oauth2/token` `grant_type=authorization_code`,form-urlencoded(`code/client_id/redirect_uri/code_verifier`,无 secret);返回 `{accessToken, refreshToken, expiresIn, scope}` |
| `refreshAccessToken({clientId, refreshToken, fetchImpl})` | POST `/oauth2/token` `grant_type=refresh_token`(仅 `refresh_token/client_id`);同上结构(含**新** refreshToken) |
| PKCE 辅助 | `randomState()` / `createPkcePair()`(verifier + S256 challenge) |

token 端点错误归一为专用 `OAuthError`。`refreshAccessToken` 只需 `clientId`(非机密),使续期自足。

### Token 解析 choke point(新增 `src/server/cf/account.ts`)

```ts
resolveAccountToken(
  db, key, account,     // account: 含 auth_type / token_encrypted / oauth_client_id / oauth_refresh_encrypted / oauth_expires_at
  fetchImpl = fetch,
): Promise<string>
```

**自足**:refresh 所需的 `client_id`、`refresh_token`、过期时间全在账号行里,不依赖 env,故无需向调用方(`clientForAccount` / fan-out)传任何 OAuth 配置。

- `auth_type !== 'oauth'` → 直接 `decryptSecret(token_encrypted)`(与现状完全一致)。
- oauth 且 `now < oauth_expires_at - 60s` → 返回解密后的 access token。
- 否则:解密 refresh token → `refreshAccessToken({clientId: row.oauth_client_id, refreshToken})` → **原子回写**新 access/refresh/过期(`updateOAuthTokens`,加密后;refresh 未回则保留旧值)→ 返回新 access token。
- refresh 失败(refresh token 失效)→ 抛出 `OAuthError`;调用侧照现有「单账号失败不阻塞」逻辑呈现,账号状态置 `error`。

配套 `cfClientForAccount(db, key, account, fetchImpl?)` = `resolveAccountToken` + `new CfClient(token)`。

> 竞态说明:两个并发请求同时刷新同一账号会各拿一次新 refresh token,CF 轮换会使先写入的作废。自托管、单用户为主场景下概率低,本版接受;缓解手段(D1 乐观锁 / 单飞)列入开放问题。

### CfClient(`src/server/cf/client.ts`)

- **鉴权不改**:`Bearer oauth:<...>` 直接可用。
- OAuth token 大概率不支持 `/user/tokens/verify`(那是 API Token 专用)。因此**账号健康检查改用 `listAccounts()`(GET /accounts)** 作为存活探测(需要有效 token 才成功)。新增/复用一个轻量 `probeToken()` 语义:token 账号继续用 `verifyToken()`,oauth 账号用 `listAccounts()` 非空即 active。

### DB 层(`src/server/db/accounts.ts`)

- `AccountRow` 增列:`auth_type`、`oauth_client_id`、`oauth_refresh_encrypted`、`oauth_expires_at`、`oauth_scope`、`oauth_sub`(均可空,`auth_type` 默认 `'token'`)。
- `AccountPublic` 增 `authType`,供前端区分展示(OAuth 徽标、禁用「改 Token」)。`listAccounts` SELECT 补 `auth_type`。
- 新增 `insertOAuthAccount({id, ownerEmail, name, tokenEncrypted, refreshEncrypted, expiresAt, scope, sub, tokenHash})`。
- 新增 `updateOAuthTokens(db, ownerEmail, id, {tokenEncrypted, refreshEncrypted, expiresAt})`(刷新回写,按 `owner_email + id` 隔离)。
- **去重键**:access/refresh token 会轮换,不能拿它们做 `token_hash`。OAuth 账号按 `client_id + 授权令牌可见的 CF account id 集合` 生成稳定 hash，沿用现有 `UNIQUE(owner_email, token_hash)` 防止重复连接。

### Migration(`migrations/0005_oauth_accounts.sql`)

```sql
ALTER TABLE cf_accounts ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'token';
ALTER TABLE cf_accounts ADD COLUMN oauth_client_id TEXT;
ALTER TABLE cf_accounts ADD COLUMN oauth_refresh_encrypted TEXT;
ALTER TABLE cf_accounts ADD COLUMN oauth_expires_at TEXT;
ALTER TABLE cf_accounts ADD COLUMN oauth_scope TEXT;
ALTER TABLE cf_accounts ADD COLUMN oauth_sub TEXT;
```

SQLite/D1 支持 `ALTER TABLE ADD COLUMN`;测试 DB 按序跑真实迁移文件,自动获得新列。

### 同步 fan-out 改造(`zones.ts` / `workersPages.ts` / `r2.ts` / `d1.ts` / `email/index.ts`)

现状:各 fan-out `SELECT id, token_encrypted ...` 后 `decryptSecret + makeClient(token)`。改为:

- SELECT 补 `auth_type, oauth_client_id, oauth_refresh_encrypted, oauth_expires_at`(行类型同步扩展)。
- 把 `decryptSecret(...)` 替换为 `await resolveAccountToken(db, key, account)`,再 `makeClient(token)`。
- **函数签名不变、`makeClient` 注入点不变**;token 账号走不到刷新分支,**现有测试(全是 token 账号)零改动通过**。

### 共享 helper `clientForAccount`(`src/server/workersPages.ts`)

被 ~30 个路由复用。**签名不变**,仅把内部 `new CfClient(await decryptSecret(...))` 改为 `cfClientForAccount(db, key, account)`:

```ts
clientForAccount(db, key, ownerEmail, accountId): Promise<CfClient>   // 签名与现状一致
```

因续期自足,所有 ~30 个调用路由**零改动**。`createPagesDnsRecord` 内联解密处同样改用 `resolveAccountToken`。R2 presign / content 见「安全」。

### API 路由(`src/pages/api/accounts/oauth/`)

均以 `appContext(locals)` 起步(拿 `db/key/userEmail`),路由不经 locale 中间件(`/api/*` 豁免)。

| 路由 | 方法 | 行为 |
|---|---|---|
| `status.ts` | GET | 返回 `{ enabled: isOAuthEnabled(env) }`,供前端能力探测 |
| `start.ts` | GET | `isOAuthEnabled` 否 → 404;生成 `state` + PKCE pair,把 `{state, verifier, redirectUri, exp}` 用 `ENCRYPTION_KEY` 加密写入 **HttpOnly / Secure / SameSite=Lax** cookie(`Path=/api/accounts/oauth`,`Max-Age=600`);302 跳 `buildAuthorizeUrl` |
| `callback.ts` | GET | 校验 `state` 与 cookie 一致且未过期;`exchangeCode` 拿 token;`fetchUserInfo` 取 `sub/email`;`insertOAuthAccount`(名默认取 email 或首个 CF 账号名,可后续改名);清 cookie;302 回 `/accounts?connected=1`。错误 302 回 `/accounts?oauth_error=<code>`(不回显敏感细节) |

`callback` 内 `code` / `state` / cookie 任一缺失或不符 → 视为 CSRF/失效,拒绝并跳错误。上游 `error` 参数(用户拒绝授权)映射为友好文案。

## 页面与交互(`src/components/AccountsPanel.tsx` + `/accounts` astro)

- 新增「用 Cloudflare 授权」按钮(仅当后端探测 `oauthEnabled` 时显示):`window.location = '/api/accounts/oauth/start'` 触发跳转;OAuth 是整页重定向,非 fetch。
  - 能力探测:`/api/accounts` GET 响应或新增 `/api/accounts/oauth/status` 返回 `{ enabled }`;astro 页面服务端读 env 传给岛,避免闪烁。
- 回跳后读 `?connected=1` / `?oauth_error=` → Toast 成功/失败,并清理 query(`history.replaceState`)。
- 列表:OAuth 账号加一枚徽标(如 `OAuth`,`badge-sm shrink-0 whitespace-nowrap`);编辑模态对 OAuth 账号**隐藏/禁用「新 Token」输入**(仅可改名),因其凭证由授权托管。
- `AccountPublic.authType` 驱动上述区分。
- 移动端遵循既有 UI 铁律(按钮含汉字加 `whitespace-nowrap`,徽标 `shrink-0`,表格 `overflow-x-auto`)。

## 安全

- **CSRF/state**:state 走加密 HttpOnly cookie,回调强校验一致性 + 过期;叠加 PKCE(S256),`code_verifier` 亦仅存于该加密 cookie。
- **public client 无 secret**:采用 PKCE public client(同 wrangler),不存在可泄露的 client secret;`client_id` 非机密。授权码没有 `code_verifier` 无法兑换,构成主要防护。
- **密钥落库加密**:access/refresh token 均 `encryptSecret`(复用 `ENCRYPTION_KEY`);`oauth_client_id` 明文仅作续期配置，`oauth_sub` 在当前非 OIDC 授权流中为 NULL。日志与 API 响应绝不含明文 token / refresh token。
- **redirect_uri 固定**:优先用显式 `CF_OAUTH_REDIRECT_URI`,须与注册值完全一致,防开放重定向。
- **隔离**:OAuth 账号同样 `owner_email` 归属当前登录用户;跨用户访问 → 404。
- **R2 presign 兼容性(已知不确定项)**:`src/server/r2Presign.ts` 从 token 派生 S3 凭证(accessKeyId=`verifyToken().id`,secret=`sha256(token)`)。OAuth token 是否支持该 S3 派生**未经证实**。本设计将 presign 处的解密改为 `resolveAccountToken`(保证 token 有效),但**不保证 R2 对象直传对 OAuth 账号可用**;若不可用,按现有「单动作 403/报错、不影响只读视图」的约定呈现,并在文档/开放问题标注。R2 桶/对象元数据等走 CfClient 的路径不受影响。

## i18n

新增文案进 `src/i18n/index.ts` zh + en:`accounts.connectWithCloudflare`、`accounts.oauthBadge`、`accounts.connected`、`accounts.oauthEditHint`、`accounts.errOauth*`(用户拒绝/state 失效/交换失败/refresh 失效)等;`/accounts` 与 `/en/accounts` 镜像。错误码 → 文案沿用 `ERROR_CODE_KEYS` 映射表扩展。

## 错误处理

- 配置类:未配 OAuth → 入口不显示 + `start` 返回 404(`code: config.oauthNotConfigured`)。
- 授权类:用户拒绝 / state 失效 / code 交换失败 → 回 `/accounts?oauth_error=<code>`,前端 Toast;不回显 provider 原始细节。
- 运行期:refresh token 失效 → `resolveAccountToken` 抛 `CfApiError`,同步/路由按既有映射(账号置 `error`,`handleCfError`)。
- `verifyToken` 对 OAuth 不可用 → 健康检查改走 `listAccounts()`,避免误报 error。

## 测试(Vitest,`createTestDb`)

- migration 0005 随真实迁移在测试 DB 生效(现有机制自动覆盖);断言新列存在、默认 `auth_type='token'`。
- `oauth.ts` 纯协议:`buildAuthorizeUrl`(仅携带已配置 scope,含 state/PKCE)、`exchangeCode` / `refreshAccessToken`(form-urlencoded body、auth method、解析 `access_token/refresh_token/expires_in/scope`)——全部注入 `fetchImpl` 断言请求与解析。
- `resolveAccountToken`:token 账号直解密不触网;OAuth 未过期直接返回;过期触发刷新并**回写**新 refresh(读回 DB 断言轮换);refresh 失败抛错。
- accounts 仓储:`insertOAuthAccount` 落列正确、连接指纹去重(同 client + CF account 集合二次插入 409);`listAccounts` 返回 `authType`。
- callback 逻辑(可抽纯函数或用 fetch 替身):state 不符 → 拒绝;成功 → 插入 OAuth 账号。
- 隔离回归:OAuth 账号仅属 owner;跨用户 404。
- 既有 fan-out / `clientForAccount` 测试因新增形参可选而零改动通过(回归验证)。
- workerd 特有问题(fetch this 绑定、`oauth:` token 直传)以 `npm run preview` 人工验证。

## 验收标准

- `npm run check` / `npm run typecheck` / `npm run test` 全绿。
- 手工链路(`npm run dev` + 已配 OAuth env):点「用 Cloudflare 授权」→ dash 同意页 → 回跳 `/accounts` 出现新账号(OAuth 徽标)→ Zones/Workers/R2/D1 同步与浏览正常 → 等待 >15min 后再次操作仍正常(验证自动 refresh)→ 删除账号本地凭证清除。
- 未配 OAuth env 时:入口不出现,现有 Token 添加/编辑/检查/同步全部无回归。
- 移动端:500px 视口 `/accounts` 零整页横滚(新按钮 + 徽标);1440px 桌面无视觉回归。

## 开放问题 / 风险

1. **refresh 轮换竞态**:并发刷新同账号可能作废彼此 refresh token。缓解:D1 行级乐观锁(比对 `oauth_expires_at`/版本列)或单飞;本版接受、列为后续。
2. **R2 对象直传对 OAuth token 是否可用**未证实(见「安全」)。需 `npm run preview` 实测;若不可用,考虑为 OAuth 账号禁用对象直传或降级为服务端中转,单独跟进。
3. **scope 配置**:请求 scope 须为注册 client scope 的子集，且必须使用 OAuth client 页面显示的点号 ID；Wrangler 旧式冒号 scope 不适用于此配置。
4. **删除账号是否调 `/oauth2/revoke`**:当前仅删本地凭证。是否主动撤销上游授权,待定(倾向后续增强)。
