# R2 功能设计（存储桶列表 / 管理 / 对象浏览器 / 用量分析）

日期：2026-07-21
状态：已确认（用户批准）

## 目标

在 cloudflareOps 中新增 R2 功能区，覆盖四块能力，一次性全部实现（按「列表 → 管理 → 对象浏览 → 用量」顺序分批提交）：

1. **存储桶列表与概览** — 跨账号列出所有 bucket（名称、位置、存储类别、大小、对象数、创建时间）。
2. **存储桶管理** — 创建/删除桶；设置项：公开访问（r2.dev）+ 自定义域名、CORS 规则、生命周期规则。
3. **对象浏览器** — 进入桶浏览对象（前缀/文件夹导航），上传、下载、删除对象。
4. **用量分析** — 每桶存储量趋势 + Class A/B 操作数，全部放在 R2 自己的页面内（不动现有 Usage 页）。

## 关键技术结论（已查证官方文档与 SDK）

- **桶级操作与对象 list/get/delete/upload** 均有 Cloudflare REST API 覆盖，`cloudflare` SDK 已内置（`r2.buckets.*`、`r2.buckets.objects.*`），用现有存储的 API token 即可。REST 对象 upload 上限 300MB，且经服务器中转，故不用于上传通道。
- **上传/下载走 S3 预签名 URL 直连**：浏览器直传 R2，不占服务器带宽、不受 Workers 请求体限制。
- **S3 凭证从现有 token 推导**（官方规则）：Access Key ID = API token 的 `id`（`verifyToken()` 返回），Secret Access Key = token 值的 SHA-256。零额外配置；token 不带 R2 权限时对象传输动作报 403。
- **用量数据源**：GraphQL 数据集 `r2StorageAdaptiveGroups`（存储快照：payloadSize/metadataSize/objectCount）与 `r2OperationsAdaptiveGroups`（Class A/B 操作数），走现有 `graphql()` 通道。

## 架构决策（方案 A：桶缓存 + 对象实时）

- 桶列表沿用现有 **sync-cache 模式**（D1 缓存 + 同步按钮），与 Workers/Zones 面板一致，跨账号概览快。
- 对象列表、桶设置、用量图表**实时请求 CF**，不落库——对象数量无上界且变化频繁，缓存必然过期。
- 范围取舍：v1 只处理默认 jurisdiction 的桶（EU/FedRAMP 是独立命名空间，需按 jurisdiction 逐个请求，本期不做，表结构不留字段）。

## 1. 数据层与同步

**新迁移 `migrations/0003_r2.sql`**：

```sql
CREATE TABLE r2_buckets (
  account_id      TEXT NOT NULL REFERENCES cf_accounts(id) ON DELETE CASCADE,
  cf_account_id   TEXT NOT NULL,
  cf_account_name TEXT,
  name            TEXT NOT NULL,
  location        TEXT,      -- 位置提示 (apac/wnam/...)
  storage_class   TEXT,      -- Standard / InfrequentAccess
  creation_date   TEXT,
  -- 同步时顺带抓 GraphQL 存储快照，桶列表直接显示大小/对象数
  payload_size    INTEGER,
  metadata_size   INTEGER,
  object_count    INTEGER,
  raw_json        TEXT NOT NULL,
  synced_at       TEXT NOT NULL,
  PRIMARY KEY (account_id, cf_account_id, name)
);
```

**同步逻辑 `src/server/r2.ts`**：复刻 `workersPages.ts` 模式——`p-limit(3)` 并发 fan-out 账号；每账号「列桶 + 一次 GraphQL 存储快照查询」；`DELETE ... WHERE account_id=?` + 全部 `INSERT` 收进一个 D1 `batch()` 原子执行（上游失败则批不跑，旧缓存保留）；单账号失败进 failures 汇报，不阻塞其他账号。

存储快照查询失败不算致命：桶列表仍写入，大小/对象数列留空（NULL）。

## 2. 服务端

### CfClient 新增方法（`src/server/cf/client.ts`，全走官方 SDK）

| 方法 | SDK 路径 | 用途 |
|---|---|---|
| `listR2Buckets(cfAccountId)` | `r2.buckets.list` | 同步用 |
| `createR2Bucket` / `deleteR2Bucket` | `r2.buckets.create` / `delete` | 桶增删 |
| `getR2Cors` / `putR2Cors` / `deleteR2Cors` | `r2.buckets.cors.*` | CORS |
| `listR2CustomDomains` / `attachR2CustomDomain` / `detachR2CustomDomain` | `r2.buckets.domains.custom.*` | 自定义域名 |
| `getR2ManagedDomain` / `setR2ManagedDomain` | `r2.buckets.domains.managed.*` | r2.dev 开关 |
| `getR2Lifecycle` / `putR2Lifecycle` | `r2.buckets.lifecycle.*` | 生命周期 |
| `listR2Objects(acct, bucket, {prefix, delimiter, cursor})` | `r2.buckets.objects.list` | 对象列表 |
| `deleteR2Object` | `r2.buckets.objects.delete` | 删对象 |
| `queryR2Storage` / `queryR2Operations` | 现有 `graphql()` | 用量 |

SDK 坑点照现有惯例写行内注释。错误统一归一为 `CfApiError`。

### S3 预签名模块（`src/server/r2Presign.ts`）

- 凭证推导：`verifyToken()` 拿 token `id` → Access Key ID；`sha256Hex(token)` → Secret。随请求现算，不落库、不缓存、不记日志。
- 签名：新增依赖 **aws4fetch**（~2KB，workerd 原生兼容），`signQuery` 模式生成预签名 URL，有效期 15 分钟。
- Endpoint：`https://<cf_account_id>.r2.cloudflarestorage.com/<bucket>/<key>`。
- 支持 GET（下载）与 PUT（上传，含 Content-Type 约束）。
- token 无 R2 权限 → 该动作 403，只影响上传/下载，不破坏只读视图（现有约定）。

### API 路由（`src/pages/api/r2/`）

每个路由以 `appContext(locals)` 开头。桶归属校验：按 `owner_email` 查 `r2_buckets` 缓存确认可见性，查不到抛 `NotFoundError` → 404（数据隔离在 SQL 层，现有约定）。

```
sync.ts                          POST   同步桶缓存（可选 accountId 单账号同步）
buckets.ts                       GET    缓存桶列表（owner 过滤）
                                 POST   创建桶 {accountId, name, location?, storageClass?}
[account]/[bucket]/index.ts      DELETE 删桶
[account]/[bucket]/cors.ts       GET / PUT（PUT 空规则数组 = 走 deleteR2Cors 清除配置）
[account]/[bucket]/domains.ts    GET 自定义域名列表 + r2.dev 状态
                                 POST 绑定域名 / DELETE 解绑 / PUT r2.dev 开关
[account]/[bucket]/lifecycle.ts  GET / PUT
[account]/[bucket]/objects.ts    GET 对象列表 (?prefix&cursor) / DELETE 删对象 (?key)
[account]/[bucket]/presign.ts    POST {key, op: 'get'|'put', contentType?} → {url, expiresAt}
[account]/[bucket]/usage.ts      GET 最近 30 天存储趋势 + Class A/B 操作数
```

`[account]` = 本系统账号记录 id；`[bucket]` = 桶名（URL encode）。创建桶后触发该账号的单账号同步刷新缓存；删桶后从缓存表删行。

## 3. 前端

### 桶列表页 `/r2`

`src/pages/r2/index.astro` + `src/pages/en/r2/index.astro` → `R2Panel.tsx`（WorkersPanel ListSection 模式，`Column.className` 应用于 th/td/skeleton 三处）。

- 列：名称（`link-hover font-mono`，点击进详情；行双击同跳）、账号、位置、存储类别、大小、对象数、创建时间、操作（删除）。
- 窄屏只留「名称 + 创建时间 + 操作」（移动端规则 2），其余 `hidden sm/md/lg:table-cell` 逐级恢复；表格包 `overflow-x-auto`。
- 工具栏：同步按钮（窄屏纯图标 + `title`，文字 `hidden sm:inline`）+ 创建桶表单（名称 + 位置提示下拉 + 存储类别下拉；容器 `flex-col gap-2 sm:flex-row`，输入 `w-full sm:w-48`）。
- 删桶二次确认；CF 侧非空桶删除报错时透出 `CfApiError` 信息。
- 同步失败按账号聚合展示（同 Workers 页）。

### 桶详情页 `/r2/[account]/[bucket]`

`DetailTabs` + `useDetailTab`，`?tab=` 持久化，astro 服务端读 searchParams 传 `initialTab`。全部 tab 内容全宽垂直堆叠（禁两列网格）。

- **对象 tab（默认）**：
  - `delimiter='/'` 分组：文件夹行（点击下钻）+ 对象行；前缀面包屑导航可回退。
  - 对象行：名称、大小、修改时间、操作（下载 = presign GET 新窗口打开；删除 = 确认后 REST 删除）。
  - 游标分页「加载更多」。
  - 上传：文件选择 → `presign.ts` 拿 PUT URL → 浏览器 XHR 直传（进度条）→ 完成后刷新当前前缀列表。
- **设置 tab**：三卡片垂直排：
  1. 公开访问 — r2.dev toggle + 自定义域名列表（增删，显示状态）。
  2. CORS — 结构化表单（origins / methods / headers / maxAge），底层 PUT 整个规则数组。
  3. 生命周期 — 规则列表（前缀 + 过期天数 / 转 Infrequent Access 天数），增删。
- **用量 tab**：存储量趋势 + Class A/B 操作数（最近 30 天），复用 UsagePanel 现有图表方案。

### i18n 与导航

- 全部新字符串进 `src/i18n/index.ts`（zh + en）；英文页面镜像 `src/pages/en/r2/**`。
- 导航栏加 R2 入口。

## 4. 错误处理

- `ConfigError` / `NotFoundError` / `CfApiError` → 现有中间件边界与 `handleCfError` 映射，新配置类失败给稳定 `code`。
- token 缺 R2 权限：读列表（REST）与传输（S3）分别在具体动作上 403，不破坏页面其余部分。
- 预签名 URL 泄露面控制：15 分钟有效期 + 单对象单方法作用域。

## 5. 测试

Vitest（Node 环境，`tests/helpers/d1.ts` 真迁移建表）：

- `tests/unit/r2.test.ts` — 同步逻辑：原子 batch（上游失败保留旧缓存）、单账号失败不阻塞、`owner_email` 隔离、存储快照失败降级（列空）。
- `tests/unit/r2-presign.test.ts` — 固定凭证 + 固定时间下预签名 URL 确定性断言（签名参数、15 分钟过期）。
- CfClient 新方法按现有 `cf-client.test.ts` 模式补桩测。
- workerd 特有风险（aws4fetch 兼容性、fetch `this` 绑定）：`npm run preview` 人工验证。

## 6. 验收标准

- `npm run check` / `npm run typecheck` / `npm run test` 全过；CI 绿。
- 移动端：500px 视口下逐页 `document.scrollingElement.scrollWidth === window.innerWidth`（零整页横滚）；1440px 桌面回归无视觉变化。
- 多账号场景：一个账号 token 失效不影响其他账号的桶同步与展示。
- token 无 R2 权限的账号：桶列表同步该账号失败被聚合汇报，其余账号正常。
