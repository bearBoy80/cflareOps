# D1 数据库管理面板 — 设计文档

日期:2026-07-22
状态:已确认(管理 + SQL 控制台;任意 SQL、写操作二次确认;表列表 + 点击浏览数据)

## 目标

在 cloudflareOps 中新增 D1 面板,跨多个 Cloudflare 账号管理 D1 数据库:

- 列表:跨账号聚合展示所有 D1 数据库(缓存 + 同步,R2 模式)
- 创建 / 删除数据库,读复制(read replication)开关
- 详情页:表结构浏览、点表名分页浏览数据、SQL 查询控制台(任意 SQL,写操作前端二次确认)

不做(YAGNI):导出/导入 SQL dump、Time Travel、可视化单元格编辑、SQL 查询历史持久化(用 localStorage)。

## 方案选型

采用**方案 A:完全复用 R2 模式(缓存 + 同步)**。

- 列表页读 `cf_d1_databases` 缓存表,手动/首次自动同步;与 Zones/Workers/R2 体验一致,符合「D1 表是 CF-API 缓存」的项目约定。
- 详情页(表浏览、SQL 控制台、设置)全部实时调 CF API,不缓存。
- 否决方案 B(纯实时列表):多账号时列表慢,且与既有架构相悖。
- 否决方案 C(查询历史入库):localStorage 足够。

## 架构

### CfClient 新增方法(`src/server/cf/client.ts`)

全部走官方 SDK `client.d1.database.*`(SDK 6.5.0 已完整支持),无需 raw 逃生舱:

| 方法 | SDK 调用 | 说明 |
|---|---|---|
| `listD1Databases(accountId)` | `d1.database.list` | 处理 V4 分页,取全量 |
| `getD1Database(accountId, dbId)` | `d1.database.get` | |
| `createD1Database(accountId, name, locationHint?)` | `d1.database.create` | |
| `deleteD1Database(accountId, dbId)` | `d1.database.delete` | |
| `editD1Database(accountId, dbId, readReplication)` | `d1.database.edit` | 读复制 auto/disabled |
| `queryD1Raw(accountId, dbId, sql, params?)` | `d1.database.raw` | 列名/行分离,适合表格渲染 |

错误统一由现有封装归一为 `CfApiError`。

### 服务层(`src/server/d1.ts`)

仿照 `src/server/r2.ts`:

- `syncD1Databases(db, key, userEmail)`:fan out 用户全部账号,`p-limit(3)` 并发;每账号 `DELETE WHERE account_id=?` + 全量 `INSERT` 组成单次 D1 `batch()`(原子;上游失败则旧缓存保留);单账号失败收集报告、不阻塞其他账号。
- `listCachedD1Databases(db, userEmail)`:读缓存,`owner_email` 通过 join `cf_accounts` 隔离。
- 单账号增量刷新(创建/删除后调用)。

### Migration(`migrations/0004_d1.sql`)

`cf_d1_databases` 表,列 1:1 映射 SDK `D1` 对象:

```
account_id TEXT NOT NULL REFERENCES cf_accounts(id) ON DELETE CASCADE
uuid TEXT NOT NULL            -- 数据库 ID
name TEXT NOT NULL
version TEXT
num_tables INTEGER
file_size INTEGER
created_at TEXT
read_replication_mode TEXT    -- auto | disabled
raw_json TEXT NOT NULL
synced_at TEXT NOT NULL
PRIMARY KEY (account_id, uuid)
```

### API 路由(`src/pages/api/d1/`)

所有路由以 `appContext(locals)` 开头;资源不属于当前用户 → `NotFoundError` 404。

| 路由 | 方法 | 行为 |
|---|---|---|
| `databases.ts` | GET | 读缓存列表 |
| | POST | 创建(校验账号归属 → CF 创建 → 单账号刷新缓存) |
| `sync.ts` | POST | 全量同步,返回各账号成败 |
| `[accountId]/[databaseId].ts` | GET | 实时详情 |
| | PATCH | 读复制开关 |
| | DELETE | 删除(CF 删除 → 删缓存行) |
| `[accountId]/[databaseId]/query.ts` | POST | 执行 SQL(`raw` 端点);CF 侧 SQL 错误(含行号 message)以结构化 JSON 透传,HTTP 200 + `error` 字段,前端展示在结果区 |
| `[accountId]/[databaseId]/tables.ts` | GET | 表清单:`SELECT name FROM sqlite_master WHERE type='table'` + 逐表 `PRAGMA table_info` + 行数 `SELECT COUNT(*)`,拼装返回 |

## 页面与交互

### 列表页 `/d1`(+ `/en/d1`)

- `MainLayout` 导航新增入口(R2 已占用 `Database` 图标,D1 用 lucide 其他库类图标,如 `DatabaseZap`)。
- 跨账号聚合表格,列:名称(永远可见,link-hover,双击行跳详情)/ 账号 / 表数量 / 大小(`formatBytes`)/ 创建时间 / 操作;次要列按 `hidden sm:table-cell` / `md` / `lg` 逐级隐藏;表格包 `overflow-x-auto`。
- 工具栏:同步按钮(窄屏纯图标 + `title`,loading 态)、「创建数据库」按钮 → 模态:选账号 + 库名(+ 可选 location hint 下拉:wnam/enam/weur/eeur/apac/oc)。
- 删除:二次确认模态,需输入库名匹配才可确认(防误删),loading 态。

### 详情页 `/d1/[accountId]/[databaseId]`(+ en 镜像)

复用 `DetailTabs` + `useDetailTab`,`?tab=` 走 URL,astro 服务端读 searchParams 传 `initialTab`。Tab 内容全宽垂直堆叠。

- **表 Tab**(默认):表列表(名称 / 行数 / 展开列结构:列名、类型、PK、NOT NULL、默认值);点表名 → 切到查询 Tab 并自动执行 `SELECT * FROM "表名" LIMIT 50`,结果区提供上一页/下一页(OFFSET 分页)。
- **查询 Tab**:SQL textarea(Cmd/Ctrl+Enter 执行)+ 执行按钮(loading 态)+ 结果表格(`overflow-x-auto` 容器内横滚)+ meta(耗时、返回/变更行数)。前端正则检测首个非注释语句,非 `SELECT`/`PRAGMA`/`EXPLAIN`/`WITH...SELECT` → 弹确认框(明示这是写操作)。查询历史:localStorage 最近 20 条,点击回填。
- **设置 Tab**:只读信息(UUID、版本、大小、创建时间、区域)+ 读复制 toggle(loading 态)+ 危险区删除(同列表页确认模式,删除成功跳回列表)。

### i18n

全部新文案进 `src/i18n/index.ts` zh + en;`src/pages/en/d1/**` 镜像页面。

## 错误处理

- `ConfigError`/`NotFoundError`/`CfApiError` 走既有中间件边界与 `handleCfError` 映射。
- Token 缺 D1 Edit 权限:仅创建/删除/写 SQL/读复制开关返回 403 并在对应控件上提示;列表与只读视图不受影响(项目既有约定)。
- SQL 语法/运行时错误不是异常路径:HTTP 200 + `{ error: { message } }`,前端展示于结果区。
- 查询 Tab 对超大结果的防护:后端对 `raw` 返回行数截断至 1000 行并在 meta 标注 `truncated`(避免超大 SELECT 撑爆响应/前端)。

## 测试(Vitest,`createTestDb`)

- migration 0004 随真实迁移文件在测试 DB 中生效(现有机制自动覆盖)。
- 同步:原子 batch 语义(上游 fetch 抛错 → 旧缓存保留)、单账号失败不阻塞、`synced_at` 更新。
- 隔离:`owner_email` 过滤——用户 A 看不到用户 B 账号下的库;跨用户访问详情/删除 → 404。
- 创建后缓存新增、删除后缓存行移除。
- CfClient D1 方法:URL/参数/分页行为,仿 `tests/unit/cf-client.test.ts`。
- SQL 语句分类(写操作检测正则)的纯函数单测(`src/lib/` 下)。
- workerd 特有问题(fetch this 绑定等)以 `npm run preview` 人工验证。

## 验收标准

- `npm run check` / `npm run typecheck` / `npm run test` 全绿。
- 移动端:500px 视口 `document.scrollingElement.scrollWidth === window.innerWidth`(零整页横滚),逐页检查列表页 + 详情页三个 Tab;1440px 桌面无视觉回归。
- 手工链路:创建库 → 列表出现 → 详情建表(SQL)→ 表 Tab 可见 → 点表名浏览数据 → 写操作弹确认 → 读复制开关 → 删除库(输名确认)→ 列表消失。
