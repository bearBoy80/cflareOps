# D1 数据库管理面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 cloudflareOps 中新增 D1 面板:跨账号数据库列表(缓存+同步)、创建/删除、读复制开关、表结构浏览、点表名分页浏览数据、SQL 查询控制台(写操作二次确认)。

**Architecture:** 完全复用 R2 面板分层——`CfClient` 新增 D1 方法(官方 SDK `client.d1.database.*`)→ `src/server/d1.ts` 同步/缓存层(p-limit 3 并发、每账号原子 batch)→ `migrations/0004_d1.sql` 缓存表 → `src/pages/api/d1/**` 路由 → `D1Panel` 列表页 + `DetailTabs` 三 Tab 详情页。详情页全部实时调 CF API,仅列表走缓存。

**Tech Stack:** Astro 5 SSR + React 19 islands、cloudflare SDK 6.5.0、D1 (better-sqlite3 测试替身)、Vitest、Biome、Tailwind v4 + daisyUI。

**Spec:** `docs/superpowers/specs/2026-07-22-d1-management-design.md`

## Global Constraints

- 导入一律用路径别名 `@/*` / `@tests/*`,同目录 `./` 可用;禁止父级相对路径。
- Cloudflare API 只能经 `CfClient`(`src/server/cf/client.ts`);业务代码禁止直接 fetch `api.cloudflare.com`。
- 所有用户数据查询必须以 `owner_email` 过滤(join `cf_accounts`)。
- API 错误:抛 `ConfigError`/`NotFoundError`/`CfApiError`,由中间件边界或 `handleCfError` 映射;新 config 失败给稳定 `code`。
- 新用户文案同时进 `src/i18n/index.ts` 的 `zh` 与 `en` 两个字典;英文页面镜像放 `src/pages/en/**`。
- 缺 Edit-scope token 时只有写动作 403,只读视图不受影响。
- 手机端 UI 规则(CLAUDE.md「手机端 UI 设计规则」全部 12 条):表格包 `overflow-x-auto`、次要列 `hidden sm:table-cell` 逐级隐藏、含汉字小按钮 `whitespace-nowrap`、工具栏主按钮窄屏纯图标、表单行窄屏纵向堆叠、Tab 内容全宽垂直堆叠 + URL `?tab=`。
- 每个任务完成后跑 `npm run check && npm run typecheck && npm run test`(或至少该任务的单测文件),然后提交。
- 提交信息格式跟随仓库惯例:`feat(d1): ...` / `fix(d1): ...`,中文描述。

## File Structure

```
migrations/0004_d1.sql                                  缓存表 d1_databases
src/server/cf/types.ts                                  + CfD1Database, CfD1QueryResult
src/server/cf/client.ts                                 + 6 个 D1 方法
src/server/d1.ts                                        新建:sync + 缓存读取
src/lib/sqlWrite.ts                                     新建:isWriteSql 写语句检测(纯函数)
src/pages/api/d1/databases.ts                           GET 缓存列表 / POST 创建
src/pages/api/d1/sync.ts                                POST 同步
src/pages/api/d1/[accountId]/[databaseId]/index.ts      GET 实时详情 / PATCH 读复制 / DELETE
src/pages/api/d1/[accountId]/[databaseId]/query.ts      POST 执行 SQL
src/pages/api/d1/[accountId]/[databaseId]/tables.ts     GET 表清单
src/i18n/index.ts                                       + nav.d1 与 d1.* 文案(zh+en)
src/layouts/MainLayout.astro                            + 导航入口
src/components/D1Panel.tsx                              列表页 island
src/components/d1/DeleteDatabaseModal.tsx               输名确认删除模态(列表页+设置 Tab 共用)
src/components/d1/D1DatabaseDetailPanel.tsx             详情页 Tab 壳
src/components/d1/TablesTab.tsx                         表 Tab
src/components/d1/QueryTab.tsx                          查询 Tab
src/components/d1/SettingsTab.tsx                       设置 Tab
src/pages/d1/index.astro                                列表页(zh)
src/pages/d1/[accountId]/[databaseId].astro             详情页(zh)
src/pages/en/d1/index.astro                             列表页(en)
src/pages/en/d1/[accountId]/[databaseId].astro          详情页(en)
tests/unit/d1-client.test.ts                            CfClient D1 方法
tests/unit/d1-databases.test.ts                         migration + sync + 缓存读取
tests/unit/sql-write.test.ts                            isWriteSql
tests/unit/d1-api.test.ts                               API 路由
```

---

### Task 1: Migration + CfClient D1 方法

**Files:**
- Create: `migrations/0004_d1.sql`
- Modify: `src/server/cf/types.ts`(文件尾部追加)
- Modify: `src/server/cf/client.ts`(类尾部追加方法,import 追加类型)
- Test: `tests/unit/d1-client.test.ts`

**Interfaces:**
- Consumes: 既有 `CfClient.wrap()`、`CfApiError`、SDK `this.sdk.d1.database.*`。
- Produces(后续任务依赖的精确签名):
  - `interface CfD1Database { uuid: string; name: string; version: string | null; created_at: string | null; num_tables: number | null; file_size: number | null; read_replication_mode: 'auto' | 'disabled' | null; raw?: unknown }`
  - `interface CfD1QueryResult { columns: string[]; rows: unknown[][]; meta: { duration: number | null; changes: number | null; changed_db: boolean; rows_read: number | null; rows_written: number | null } }`
  - `CfClient.listD1Databases(cfAccountId: string): Promise<CfD1Database[]>`
  - `CfClient.getD1Database(cfAccountId: string, databaseId: string): Promise<CfD1Database>`
  - `CfClient.createD1Database(cfAccountId: string, opts: { name: string; primaryLocationHint?: string }): Promise<CfD1Database>`
  - `CfClient.deleteD1Database(cfAccountId: string, databaseId: string): Promise<void>`
  - `CfClient.editD1DatabaseReplication(cfAccountId: string, databaseId: string, mode: 'auto' | 'disabled'): Promise<CfD1Database>`
  - `CfClient.queryD1Raw(cfAccountId: string, databaseId: string, sql: string, params?: string[]): Promise<CfD1QueryResult[]>`
  - 表 `d1_databases(account_id, cf_account_id, cf_account_name, uuid, name, version, num_tables, file_size, created_at, read_replication_mode, raw_json, synced_at)`,PK `(account_id, cf_account_id, uuid)`。

- [ ] **Step 1: 写 migration**

`migrations/0004_d1.sql`:

```sql
-- D1 数据库缓存表:列 1:1 对应 SDK d1.database D1 对象字段(uuid/name/version/created_at 等)。
-- num_tables/file_size/read_replication_mode 在 list 响应的 SDK typings 中未声明但运行时通常返回,
-- best-effort 写入(缺失为 NULL);详情页展示以实时 get 为准。
CREATE TABLE IF NOT EXISTS d1_databases (
  account_id            TEXT NOT NULL REFERENCES cf_accounts(id) ON DELETE CASCADE,
  cf_account_id         TEXT NOT NULL,
  cf_account_name       TEXT,
  uuid                  TEXT NOT NULL,
  name                  TEXT NOT NULL,
  version               TEXT,
  num_tables            INTEGER,
  file_size             INTEGER,
  created_at            TEXT,
  read_replication_mode TEXT,
  raw_json              TEXT NOT NULL,
  synced_at             TEXT NOT NULL,
  PRIMARY KEY (account_id, cf_account_id, uuid)
);

CREATE INDEX IF NOT EXISTS idx_d1_databases_account ON d1_databases(account_id);
```

- [ ] **Step 2: 写失败测试(client 方法)**

`tests/unit/d1-client.test.ts`(全文;仿 `tests/unit/r2-client.test.ts` 的 fetchImpl 注入模式):

```ts
import { describe, expect, it } from 'vitest';
import { CfApiError, CfClient } from '@/server/cf/client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function envelope(result: unknown, result_info?: unknown) {
  return { success: true, errors: [], messages: [], result, ...(result_info ? { result_info } : {}) };
}

describe('CfClient D1 databases', () => {
  it('listD1Databases hits /accounts/:id/d1/database and maps fields best-effort', async () => {
    let seenUrl = '';
    const fetchImpl: typeof fetch = async (input) => {
      seenUrl = String(input);
      return jsonResponse(
        envelope(
          [
            {
              uuid: 'u1',
              name: 'db-one',
              version: 'production',
              created_at: '2026-01-01T00:00:00Z',
              num_tables: 4,
              file_size: 2048,
            },
            { uuid: 'u2', name: 'db-two' }, // 最小字段:num_tables/file_size 缺失 → null
          ],
          { page: 1, per_page: 100, count: 2, total_count: 2 },
        ),
      );
    };
    const dbs = await new CfClient('tok', fetchImpl).listD1Databases('cf-1');
    expect(seenUrl).toContain('/accounts/cf-1/d1/database');
    expect(dbs).toHaveLength(2);
    expect(dbs[0]).toMatchObject({
      uuid: 'u1',
      name: 'db-one',
      version: 'production',
      created_at: '2026-01-01T00:00:00Z',
      num_tables: 4,
      file_size: 2048,
    });
    expect(dbs[0].raw).toBeDefined();
    expect(dbs[1]).toMatchObject({ uuid: 'u2', num_tables: null, file_size: null, read_replication_mode: null });
  });

  it('getD1Database GETs the database path and maps read_replication.mode', async () => {
    let seenUrl = '';
    const fetchImpl: typeof fetch = async (input) => {
      seenUrl = String(input);
      return jsonResponse(
        envelope({ uuid: 'u1', name: 'db-one', file_size: 100, num_tables: 1, read_replication: { mode: 'auto' } }),
      );
    };
    const d = await new CfClient('tok', fetchImpl).getD1Database('cf-1', 'u1');
    expect(seenUrl).toContain('/accounts/cf-1/d1/database/u1');
    expect(d.read_replication_mode).toBe('auto');
  });

  it('createD1Database posts name and primary_location_hint', async () => {
    let seenBody = '';
    let seenMethod = '';
    const fetchImpl: typeof fetch = async (_input, init) => {
      seenMethod = (init?.method ?? '').toLowerCase();
      seenBody = String(init?.body ?? '');
      return jsonResponse(envelope({ uuid: 'nu', name: 'new-db', created_at: '2026-07-22T00:00:00Z' }));
    };
    const d = await new CfClient('tok', fetchImpl).createD1Database('cf-1', {
      name: 'new-db',
      primaryLocationHint: 'apac',
    });
    expect(seenMethod).toBe('post');
    expect(JSON.parse(seenBody)).toEqual({ name: 'new-db', primary_location_hint: 'apac' });
    expect(d.uuid).toBe('nu');
  });

  it('deleteD1Database DELETEs the path and maps API errors to CfApiError', async () => {
    let seenUrl = '';
    let seenMethod = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenMethod = (init?.method ?? '').toLowerCase();
      return jsonResponse(envelope(null));
    };
    await new CfClient('tok', fetchImpl).deleteD1Database('cf-1', 'u1');
    expect(seenMethod).toBe('delete');
    expect(seenUrl).toContain('/accounts/cf-1/d1/database/u1');

    const failing: typeof fetch = async () =>
      jsonResponse({ success: false, errors: [{ code: 10000, message: 'unauthorized' }], result: null }, 403);
    await expect(new CfClient('tok', failing).deleteD1Database('cf-1', 'u1')).rejects.toThrowError(CfApiError);
  });

  it('editD1DatabaseReplication PATCHes read_replication.mode', async () => {
    let seenBody = '';
    let seenMethod = '';
    const fetchImpl: typeof fetch = async (_input, init) => {
      seenMethod = (init?.method ?? '').toLowerCase();
      seenBody = String(init?.body ?? '');
      return jsonResponse(envelope({ uuid: 'u1', name: 'db-one', read_replication: { mode: 'disabled' } }));
    };
    const d = await new CfClient('tok', fetchImpl).editD1DatabaseReplication('cf-1', 'u1', 'disabled');
    expect(seenMethod).toBe('patch');
    expect(JSON.parse(seenBody)).toEqual({ read_replication: { mode: 'disabled' } });
    expect(d.read_replication_mode).toBe('disabled');
  });

  it('queryD1Raw posts sql to /raw and maps columns/rows/meta per statement', async () => {
    let seenUrl = '';
    let seenBody = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenBody = String(init?.body ?? '');
      return jsonResponse(
        envelope([
          {
            success: true,
            results: { columns: ['id', 'name'], rows: [[1, 'a'], [2, 'b']] },
            meta: { duration: 0.5, changes: 0, changed_db: false, rows_read: 2, rows_written: 0 },
          },
        ]),
      );
    };
    const results = await new CfClient('tok', fetchImpl).queryD1Raw('cf-1', 'u1', 'SELECT * FROM t');
    expect(seenUrl).toContain('/accounts/cf-1/d1/database/u1/raw');
    expect(JSON.parse(seenBody)).toEqual({ sql: 'SELECT * FROM t' });
    expect(results).toHaveLength(1);
    expect(results[0].columns).toEqual(['id', 'name']);
    expect(results[0].rows).toEqual([[1, 'a'], [2, 'b']]);
    expect(results[0].meta).toEqual({ duration: 0.5, changes: 0, changed_db: false, rows_read: 2, rows_written: 0 });
  });

  it('queryD1Raw surfaces SQL errors as CfApiError with the CF message', async () => {
    const failing: typeof fetch = async () =>
      jsonResponse(
        { success: false, errors: [{ code: 7500, message: 'near "SELEC": syntax error at offset 0' }], result: null },
        400,
      );
    await expect(new CfClient('tok', failing).queryD1Raw('cf-1', 'u1', 'SELEC 1')).rejects.toThrowError(
      /syntax error/,
    );
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/unit/d1-client.test.ts`
Expected: FAIL —— `listD1Databases is not a function` 等。

- [ ] **Step 4: 实现类型与 client 方法**

`src/server/cf/types.ts` 文件尾部追加:

```ts
/** 字段名与 SDK d1.database D1 对象一致;read_replication_mode 由 read_replication.mode 拍平,raw 为 SDK 原始对象 */
export interface CfD1Database {
  uuid: string;
  name: string;
  version: string | null;
  created_at: string | null;
  num_tables: number | null;
  file_size: number | null;
  read_replication_mode: 'auto' | 'disabled' | null;
  raw?: unknown;
}

/** raw 端点单条语句的结果:列名与行分离(比 query 端点省流量且适合表格渲染) */
export interface CfD1QueryResult {
  columns: string[];
  rows: unknown[][];
  meta: {
    duration: number | null;
    changes: number | null;
    changed_db: boolean;
    rows_read: number | null;
    rows_written: number | null;
  };
}
```

`src/server/cf/client.ts`:

1. import 类型列表中追加 `CfD1Database, CfD1QueryResult`(保持字母序,Biome 会整理)。
2. 在模块级 helper 区(如 `toPagesDomain` 之后)添加映射函数:

```ts
/** list 响应的 num_tables/file_size/read_replication SDK typings 未声明但运行时返回,best-effort 读取(同 toWorkerVersion 先例) */
function toD1Database(d: unknown): CfD1Database {
  const db = d as {
    uuid?: string;
    name?: string;
    version?: string;
    created_at?: string;
    num_tables?: number;
    file_size?: number;
    read_replication?: { mode?: 'auto' | 'disabled' } | null;
  };
  return {
    uuid: db.uuid ?? '',
    name: db.name ?? '',
    version: db.version ?? null,
    created_at: db.created_at ?? null,
    num_tables: typeof db.num_tables === 'number' ? db.num_tables : null,
    file_size: typeof db.file_size === 'number' ? db.file_size : null,
    read_replication_mode: db.read_replication?.mode ?? null,
    raw: d,
  };
}
```

3. `CfClient` 类尾部(`putR2Lifecycle` 之后)追加方法:

```ts
  /** 账号下 D1 数据库列表(V4 分页迭代取全量) */
  listD1Databases(cfAccountId: string): Promise<CfD1Database[]> {
    return this.wrap(async () => {
      const out: CfD1Database[] = [];
      for await (const d of this.sdk.d1.database.list({ account_id: cfAccountId, per_page: 100 })) {
        out.push(toD1Database(d));
      }
      return out;
    });
  }

  /** 单库实时详情(file_size/num_tables/read_replication 以此为准,列表缓存仅 best-effort) */
  getD1Database(cfAccountId: string, databaseId: string): Promise<CfD1Database> {
    return this.wrap(async () => toD1Database(await this.sdk.d1.database.get(databaseId, { account_id: cfAccountId })));
  }

  /** 创建数据库;primaryLocationHint 为 CF 主副本区域提示(wnam/enam/weur/eeur/apac/oc),省略则就近 */
  createD1Database(cfAccountId: string, opts: { name: string; primaryLocationHint?: string }): Promise<CfD1Database> {
    return this.wrap(async () =>
      toD1Database(
        await this.sdk.d1.database.create({
          account_id: cfAccountId,
          name: opts.name,
          ...(opts.primaryLocationHint ? { primary_location_hint: opts.primaryLocationHint as never } : {}),
        }),
      ),
    );
  }

  deleteD1Database(cfAccountId: string, databaseId: string): Promise<void> {
    return this.wrap(async () => {
      await this.sdk.d1.database.delete(databaseId, { account_id: cfAccountId });
    });
  }

  /** 读复制开关(PATCH .../d1/database/:id,body 仅 read_replication.mode) */
  editD1DatabaseReplication(
    cfAccountId: string,
    databaseId: string,
    mode: 'auto' | 'disabled',
  ): Promise<CfD1Database> {
    return this.wrap(async () =>
      toD1Database(
        await this.sdk.d1.database.edit(databaseId, { account_id: cfAccountId, read_replication: { mode } }),
      ),
    );
  }

  /**
   * 执行 SQL(POST .../raw:列名/行分离,比 /query 的对象数组省流量)。
   * sql 支持分号分隔多语句(CF 侧按批执行),每条语句一个结果集。
   * SQL 语法/运行时错误由 CF 以 400 + 7500 系列 code 返回 → CfApiError(400),
   * 是否当"结果"展示由路由层决定,这里统一抛出。
   */
  queryD1Raw(cfAccountId: string, databaseId: string, sql: string, params?: string[]): Promise<CfD1QueryResult[]> {
    return this.wrap(async () => {
      const out: CfD1QueryResult[] = [];
      for await (const r of this.sdk.d1.database.raw(databaseId, {
        account_id: cfAccountId,
        sql,
        ...(params?.length ? { params } : {}),
      })) {
        out.push({
          columns: r.results?.columns ?? [],
          rows: (r.results?.rows ?? []) as unknown[][],
          meta: {
            duration: r.meta?.duration ?? null,
            changes: r.meta?.changes ?? null,
            changed_db: r.meta?.changed_db ?? false,
            rows_read: r.meta?.rows_read ?? null,
            rows_written: r.meta?.rows_written ?? null,
          },
        });
      }
      return out;
    });
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/unit/d1-client.test.ts`
Expected: PASS(7 个用例)。migration 的建表断言在 Task 2 的 d1-databases.test.ts 里(createTestDb 会自动跑 0004)。

- [ ] **Step 6: 门禁 + 提交**

```bash
npm run check && npm run typecheck && npx vitest run tests/unit/d1-client.test.ts
git add migrations/0004_d1.sql src/server/cf/types.ts src/server/cf/client.ts tests/unit/d1-client.test.ts
git commit -m "feat(d1): CfClient D1 方法与缓存表 migration"
```

---

### Task 2: 同步与缓存层 `src/server/d1.ts`

**Files:**
- Create: `src/server/d1.ts`
- Test: `tests/unit/d1-databases.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `CfClient.listAccounts/listD1Databases`、表 `d1_databases`;既有 `decryptSecret`、`updateAccountStatus`、`Db`/`DbStatement`。
- Produces:
  - `interface D1DatabaseItem { uuid: string; name: string; accountId: string; accountName: string; cfAccountId: string; cfAccountName: string | null; version: string | null; numTables: number | null; fileSize: number | null; createdAt: string | null; readReplicationMode: string | null; syncedAt: string }`
  - `syncD1Databases(db, key, ownerEmail, makeClient?, accountId?): Promise<{ databases: number; failures: { accountId: string; error: string }[] }>`
  - `listCachedD1Databases(db, ownerEmail, opts?: { page?: number; pageSize?: number; search?: string }): Promise<{ databases: D1DatabaseItem[]; total: number }>`
  - `getCachedD1Database(db, ownerEmail, accountId, uuid): Promise<D1DatabaseItem | null>`

- [ ] **Step 1: 写失败测试**

`tests/unit/d1-databases.test.ts`(全文;仿 `tests/unit/r2.test.ts`):

```ts
import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import type { CfAccount, CfD1Database } from '@/server/cf/types';
import { encryptSecret, importEncryptionKey } from '@/server/crypto';
import { deleteAccount, insertAccount } from '@/server/db/accounts';
import { getCachedD1Database, listCachedD1Databases, syncD1Databases } from '@/server/d1';

const HEX_KEY = 'b'.repeat(64);
const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';

async function seedAccount(
  db: ReturnType<typeof createTestDb>,
  key: CryptoKey,
  id: string,
  token: string,
  ownerEmail = ALICE,
) {
  await insertAccount(db, {
    id,
    ownerEmail,
    name: `acct-${id}`,
    tokenEncrypted: await encryptSecret(token, key),
    tokenHash: `hash-${id}`,
  });
}

function db1(uuid: string, name: string, extra: Partial<CfD1Database> = {}): CfD1Database {
  return {
    uuid,
    name,
    version: null,
    created_at: null,
    num_tables: null,
    file_size: null,
    read_replication_mode: null,
    ...extra,
  };
}

function fakeClient(cfAccounts: CfAccount[], dbsByCf: Record<string, CfD1Database[]> = {}) {
  return {
    listAccounts: async () => cfAccounts,
    listD1Databases: async (id: string) => dbsByCf[id] ?? [],
  };
}

describe('d1_databases migration', () => {
  it('creates the table', async () => {
    const db = createTestDb();
    const row = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='d1_databases'`)
      .first<{ name: string }>();
    expect(row?.name).toBe('d1_databases');
  });

  it('cascade-deletes cached rows when the account is removed', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await syncD1Databases(db, key, ALICE, () => fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [db1('u1', 'db1')] }));
    await deleteAccount(db, ALICE, 'a1');
    const { total } = await listCachedD1Databases(db, ALICE);
    expect(total).toBe(0);
  });
});

describe('syncD1Databases', () => {
  it('fans out per account and caches database fields', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');

    const r = await syncD1Databases(db, key, ALICE, () =>
      fakeClient([{ id: 'cf-1', name: 'CF One' }], {
        'cf-1': [
          db1('u1', 'db-one', {
            version: 'production',
            created_at: '2026-01-01T00:00:00Z',
            num_tables: 4,
            file_size: 2048,
            read_replication_mode: 'auto',
          }),
          db1('u2', 'db-two'),
        ],
      }),
    );
    expect(r).toEqual({ databases: 2, failures: [] });

    const { databases, total } = await listCachedD1Databases(db, ALICE);
    expect(total).toBe(2);
    const one = databases.find((d) => d.uuid === 'u1')!;
    expect(one).toMatchObject({
      name: 'db-one',
      accountName: 'acct-a1',
      cfAccountId: 'cf-1',
      cfAccountName: 'CF One',
      version: 'production',
      numTables: 4,
      fileSize: 2048,
      readReplicationMode: 'auto',
    });
    expect(databases.find((d) => d.uuid === 'u2')!.fileSize).toBeNull();
  });

  it('keeps old cache when listD1Databases throws mid-sync (atomic batch)', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await syncD1Databases(db, key, ALICE, () =>
      fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [db1('u-old', 'old-db')] }),
    );

    const failing = await syncD1Databases(db, key, ALICE, () => ({
      ...fakeClient([{ id: 'cf-1', name: 'CF One' }]),
      listD1Databases: async () => {
        throw new Error('api down');
      },
    }));
    expect(failing.failures).toHaveLength(1);
    expect(failing.failures[0]).toMatchObject({ accountId: 'a1' });

    const { databases } = await listCachedD1Databases(db, ALICE);
    expect(databases.map((d) => d.uuid)).toEqual(['u-old']);
  });

  it('one failing account does not block the other (per-account isolation)', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedAccount(db, key, 'a2', 'tok-2');

    const r = await syncD1Databases(db, key, ALICE, (token) =>
      token === 'tok-1'
        ? fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [db1('u1', 'db1')] })
        : {
            listAccounts: async () => {
              throw new Error('bad token');
            },
            listD1Databases: async () => [],
          },
    );
    expect(r.databases).toBe(1);
    expect(r.failures).toEqual([{ accountId: 'a2', error: 'bad token' }]);
  });

  it('accountId narrows the sync to a single account', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedAccount(db, key, 'a2', 'tok-2');
    const r = await syncD1Databases(
      db,
      key,
      ALICE,
      () => fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [db1('u1', 'db1')] }),
      'a1',
    );
    expect(r.databases).toBe(1);
  });
});

describe('listCachedD1Databases / getCachedD1Database', () => {
  it('scopes rows by owner_email', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1', ALICE);
    await seedAccount(db, key, 'b1', 'tok-2', BOB);
    await syncD1Databases(db, key, ALICE, () =>
      fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [db1('ua', 'alice-db')] }),
    );
    await syncD1Databases(db, key, BOB, () =>
      fakeClient([{ id: 'cf-2', name: 'CF Two' }], { 'cf-2': [db1('ub', 'bob-db')] }),
    );

    const alice = await listCachedD1Databases(db, ALICE);
    expect(alice.databases.map((d) => d.uuid)).toEqual(['ua']);
    expect(await getCachedD1Database(db, ALICE, 'b1', 'ub')).toBeNull(); // 跨用户 → null
    expect((await getCachedD1Database(db, ALICE, 'a1', 'ua'))?.name).toBe('alice-db');
  });

  it('searches by database name or account name and paginates', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await syncD1Databases(db, key, ALICE, () =>
      fakeClient([{ id: 'cf-1', name: 'CF One' }], {
        'cf-1': [db1('u1', 'prod-app'), db1('u2', 'staging-app'), db1('u3', 'scratch')],
      }),
    );
    const hit = await listCachedD1Databases(db, ALICE, { search: 'app' });
    expect(hit.total).toBe(2);
    const page = await listCachedD1Databases(db, ALICE, { page: 2, pageSize: 2 });
    expect(page.total).toBe(3);
    expect(page.databases).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/d1-databases.test.ts`
Expected: FAIL —— 无法解析 `@/server/d1`。

- [ ] **Step 3: 实现 `src/server/d1.ts`**

全文(结构照抄 `src/server/r2.ts`,去掉快照逻辑):

```ts
import pLimit from 'p-limit';
import { CfClient } from './cf/client';
import { decryptSecret } from './crypto';
import { updateAccountStatus } from './db/accounts';
import type { Db, DbStatement } from './db/types';

export interface D1DatabaseItem {
  uuid: string;
  name: string;
  accountId: string; // 本系统账号记录 id
  accountName: string; // 本系统账号备注名
  cfAccountId: string; // CF 侧账号 id
  cfAccountName: string | null;
  version: string | null;
  numTables: number | null; // list 响应 best-effort;详情页以实时 get 为准
  fileSize: number | null;
  createdAt: string | null;
  readReplicationMode: string | null;
  syncedAt: string;
}

const CONCURRENCY = 3;

type SyncClient = Pick<CfClient, 'listAccounts' | 'listD1Databases'>;

/** D1 数据库缓存同步:复刻 r2.ts 的原子 batch 替换模式(任一上游抛错则批不跑,旧缓存原样保留)。 */
export async function syncD1Databases(
  db: Db,
  key: CryptoKey,
  ownerEmail: string,
  makeClient: (token: string) => SyncClient = (t) => new CfClient(t),
  accountId?: string,
): Promise<{ databases: number; failures: { accountId: string; error: string }[] }> {
  const params: unknown[] = [ownerEmail];
  let sql = 'SELECT id, token_encrypted FROM cf_accounts WHERE owner_email = ?';
  if (accountId) {
    sql += ' AND id = ?';
    params.push(accountId);
  }
  const { results: accounts } = await db
    .prepare(sql)
    .bind(...params)
    .all<{ id: string; token_encrypted: string }>();

  const limit = pLimit(CONCURRENCY);
  const failures: { accountId: string; error: string }[] = [];
  let databases = 0;

  await Promise.all(
    accounts.map((account) =>
      limit(async () => {
        try {
          const token = await decryptSecret(account.token_encrypted, key);
          const client = makeClient(token);
          const cfAccounts = await client.listAccounts();
          const syncedAt = new Date().toISOString();

          const stmts: DbStatement[] = [db.prepare('DELETE FROM d1_databases WHERE account_id = ?').bind(account.id)];
          let localDbs = 0;

          for (const cfAccount of cfAccounts) {
            const list = await client.listD1Databases(cfAccount.id);
            for (const d of list) {
              stmts.push(
                db
                  .prepare(
                    `INSERT OR REPLACE INTO d1_databases (
                       account_id, cf_account_id, cf_account_name, uuid, name,
                       version, num_tables, file_size, created_at, read_replication_mode,
                       raw_json, synced_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  )
                  .bind(
                    account.id,
                    cfAccount.id,
                    cfAccount.name,
                    d.uuid,
                    d.name,
                    d.version,
                    d.num_tables,
                    d.file_size,
                    d.created_at,
                    d.read_replication_mode,
                    JSON.stringify(d.raw ?? d),
                    syncedAt,
                  ),
              );
            }
            localDbs += list.length;
          }

          await db.batch(stmts);
          await updateAccountStatus(db, account.id, 'active');
          databases += localDbs;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          failures.push({ accountId: account.id, error: message });
          try {
            await updateAccountStatus(db, account.id, 'error', message);
          } catch {
            // 失败已记录在 failures[];状态落库失败不应中断整个同步
          }
        }
      }),
    ),
  );

  return { databases, failures };
}

interface DbRow {
  uuid: string;
  name: string;
  account_id: string;
  account_name: string;
  cf_account_id: string;
  cf_account_name: string | null;
  version: string | null;
  num_tables: number | null;
  file_size: number | null;
  created_at: string | null;
  read_replication_mode: string | null;
  synced_at: string;
}

function toItem(r: DbRow): D1DatabaseItem {
  return {
    uuid: r.uuid,
    name: r.name,
    accountId: r.account_id,
    accountName: r.account_name,
    cfAccountId: r.cf_account_id,
    cfAccountName: r.cf_account_name,
    version: r.version,
    numTables: r.num_tables,
    fileSize: r.file_size,
    createdAt: r.created_at,
    readReplicationMode: r.read_replication_mode,
    syncedAt: r.synced_at,
  };
}

const ROW_COLUMNS = `d.uuid, d.name, d.account_id, a.name AS account_name, d.cf_account_id, d.cf_account_name,
       d.version, d.num_tables, d.file_size, d.created_at, d.read_replication_mode, d.synced_at`;

export async function listCachedD1Databases(
  db: Db,
  ownerEmail: string,
  opts?: { page?: number; pageSize?: number; search?: string },
): Promise<{ databases: D1DatabaseItem[]; total: number }> {
  const page = Math.max(1, opts?.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts?.pageSize ?? 20));
  const rawSearch = opts?.search?.trim() ?? '';

  const conditions: string[] = ['a.owner_email = ?'];
  const params: unknown[] = [ownerEmail];
  if (rawSearch !== '') {
    const pattern = `%${rawSearch.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(`(d.name LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\')`);
    params.push(pattern, pattern);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS cnt FROM d1_databases d JOIN cf_accounts a ON a.id = d.account_id ${where}`)
    .bind(...params)
    .first<{ cnt: number }>();
  const total = countRow?.cnt ?? 0;

  const { results } = await db
    .prepare(
      `SELECT ${ROW_COLUMNS}
       FROM d1_databases d JOIN cf_accounts a ON a.id = d.account_id
       ${where} ORDER BY (d.created_at IS NULL), d.created_at DESC, d.name LIMIT ? OFFSET ?`,
    )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all<DbRow>();

  return { databases: results.map(toItem), total };
}

/** 详情路由归属校验:owner 隔离取单库缓存行(含 cfAccountId),不存在返回 null(路由映射 404) */
export async function getCachedD1Database(
  db: Db,
  ownerEmail: string,
  accountId: string,
  uuid: string,
): Promise<D1DatabaseItem | null> {
  const r = await db
    .prepare(
      `SELECT ${ROW_COLUMNS}
       FROM d1_databases d JOIN cf_accounts a ON a.id = d.account_id
       WHERE d.uuid = ? AND d.account_id = ? AND a.owner_email = ? LIMIT 1`,
    )
    .bind(uuid, accountId, ownerEmail)
    .first<DbRow>();
  return r ? toItem(r) : null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/d1-databases.test.ts`
Expected: PASS(8 个用例)。

- [ ] **Step 5: 门禁 + 提交**

```bash
npm run check && npm run typecheck && npm run test
git add src/server/d1.ts tests/unit/d1-databases.test.ts
git commit -m "feat(d1): 数据库缓存同步与 owner 隔离读取"
```

---

### Task 3: SQL 写语句检测 `src/lib/sqlWrite.ts`

**Files:**
- Create: `src/lib/sqlWrite.ts`
- Test: `tests/unit/sql-write.test.ts`

**Interfaces:**
- Produces: `isWriteSql(sql: string): boolean` —— true 表示可能修改数据库,前端据此弹二次确认。仅用于 UX 确认层,不是安全边界(真正权限由 CF token 决定)。

- [ ] **Step 1: 写失败测试**

`tests/unit/sql-write.test.ts`(全文):

```ts
import { describe, expect, it } from 'vitest';
import { isWriteSql } from '@/lib/sqlWrite';

describe('isWriteSql', () => {
  it.each([
    'SELECT * FROM users',
    '  select 1',
    'PRAGMA table_info("users")',
    'EXPLAIN QUERY PLAN SELECT * FROM t',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    "SELECT * FROM logs WHERE msg = 'please update me'", // 字符串字面量里的写关键词不算
    "-- delete everything\nSELECT 1", // 注释里的写关键词不算
    '/* drop table? no */ SELECT 2',
  ])('read-only: %s', (sql) => {
    expect(isWriteSql(sql)).toBe(false);
  });

  it.each([
    "INSERT INTO t VALUES (1)",
    'update t set a = 1',
    'DELETE FROM t',
    'DROP TABLE t',
    'ALTER TABLE t ADD COLUMN c TEXT',
    'CREATE TABLE t (id INTEGER)',
    'REPLACE INTO t VALUES (1)',
    'WITH doomed AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM doomed)', // CTE 后接写语句
    'SELECT 1; DROP TABLE t', // 多语句批中的写语句
    'VACUUM',
  ])('write: %s', (sql) => {
    expect(isWriteSql(sql)).toBe(true);
  });

  it('treats empty/whitespace input as read-only (no confirm popup on empty run)', () => {
    expect(isWriteSql('')).toBe(false);
    expect(isWriteSql('   \n ')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/sql-write.test.ts`
Expected: FAIL —— 无法解析 `@/lib/sqlWrite`。

- [ ] **Step 3: 实现**

`src/lib/sqlWrite.ts` 全文:

```ts
/**
 * SQL 写语句检测(UX 确认层,非安全边界)。
 * 思路:先剥离字符串字面量与注释,再全文匹配写关键词——比"看首关键词"可靠,
 * 能覆盖 `WITH ... DELETE`、`SELECT 1; DROP ...` 等形态;被引号包裹的标识符
 * (如列名 "update")会被当作字符串剥掉,不会误报。
 */
const WRITE_RE =
  /\b(insert|update|delete|replace|create|drop|alter|truncate|vacuum|attach|detach|reindex|grant|revoke)\b/i;

function stripLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      // SQLite 里 '' 转义单引号、"" 转义双引号:跳过成对引号内的所有内容
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      i = j + 1;
      out += ' ';
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

export function isWriteSql(sql: string): boolean {
  return WRITE_RE.test(stripLiteralsAndComments(sql));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/sql-write.test.ts`
Expected: PASS。

- [ ] **Step 5: 门禁 + 提交**

```bash
npm run check && npm run typecheck && npx vitest run tests/unit/sql-write.test.ts
git add src/lib/sqlWrite.ts tests/unit/sql-write.test.ts
git commit -m "feat(d1): SQL 写语句检测(查询控制台二次确认用)"
```

---

### Task 4: API 路由

**Files:**
- Create: `src/pages/api/d1/databases.ts`
- Create: `src/pages/api/d1/sync.ts`
- Create: `src/pages/api/d1/[accountId]/[databaseId]/index.ts`
- Create: `src/pages/api/d1/[accountId]/[databaseId]/query.ts`
- Create: `src/pages/api/d1/[accountId]/[databaseId]/tables.ts`
- Test: `tests/unit/d1-api.test.ts`

**Interfaces:**
- Consumes: Task 1 client 方法、Task 2 `syncD1Databases/listCachedD1Databases/getCachedD1Database`;既有 `appContext/handleCfError/jsonError`、`clientForAccount`(`@/server/workersPages`)。
- Produces(前端依赖的响应形状):
  - `GET /api/d1/databases?page&pageSize&search` → `{ databases: D1DatabaseItem[], total: number }`
  - `POST /api/d1/databases` body `{ accountId, cfAccountId, name, primaryLocationHint? }` → `{ database: CfD1Database }`;非法名 400 code `invalidDatabaseName`
  - `POST /api/d1/sync?accountId=` → `{ databases: number, failures: [...] }`
  - `GET /api/d1/:accountId/:databaseId` → `{ database: CfD1Database }`(实时)
  - `PATCH` 同路径 body `{ mode: 'auto' | 'disabled' }` → `{ database: CfD1Database }`
  - `DELETE` 同路径 → `{ ok: true }`(CF 删除成功后同步删缓存行)
  - `POST .../query` body `{ sql, params? }` → 200 `{ results: [{ columns, rows, meta, truncated }] }` 或 200 `{ error: { message } }`(CF 400 = SQL 错误);401/403 等仍走 HTTP 错误
  - `GET .../tables` → `{ tables: [{ name, rowCount, columns: [{ name, type, notnull, pk, dflt_value }] }], truncated: boolean }`

- [ ] **Step 1: 写失败测试**

`tests/unit/d1-api.test.ts`(全文;仿 `tests/unit/r2-api.test.ts`——只测不出网的分支:缓存读取、参数校验、归属 404):

```ts
import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import { DELETE as dbDelete, GET as dbGet, PATCH as dbPatch } from '@/pages/api/d1/[accountId]/[databaseId]/index';
import { POST as queryPost } from '@/pages/api/d1/[accountId]/[databaseId]/query';
import { GET as tablesGet } from '@/pages/api/d1/[accountId]/[databaseId]/tables';
import { GET as databasesGet, POST as databasesPost } from '@/pages/api/d1/databases';
import { encryptSecret, importEncryptionKey } from '@/server/crypto';
import { insertAccount } from '@/server/db/accounts';

const HEX_KEY = 'a'.repeat(64);
const ALICE = 'alice@ops.dev';

function ctx(db: unknown, url: string, init?: RequestInit, params?: Record<string, string>) {
  return {
    locals: { userEmail: ALICE, runtime: { env: { DB: db, ENCRYPTION_KEY: HEX_KEY } } },
    request: new Request(url, init),
    params: params ?? {},
  } as never;
}

async function seed(db: ReturnType<typeof createTestDb>) {
  const key = await importEncryptionKey(HEX_KEY);
  await insertAccount(db, {
    id: 'a1',
    ownerEmail: ALICE,
    name: 'acct-a1',
    tokenEncrypted: await encryptSecret('tok-1', key),
    tokenHash: 'h1',
  });
  await db
    .prepare(
      `INSERT INTO d1_databases (account_id, cf_account_id, cf_account_name, uuid, name, raw_json, synced_at)
       VALUES ('a1', 'cf-1', 'CF One', 'u1', 'db-one', '{}', '2026-07-22T00:00:00Z')`,
    )
    .run();
}

describe('GET /api/d1/databases', () => {
  it('lists cached databases scoped to the owner', async () => {
    const db = createTestDb();
    await seed(db);
    const res = await databasesGet(ctx(db, 'http://localhost/api/d1/databases'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { databases: { uuid: string; name: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.databases[0]).toMatchObject({ uuid: 'u1', name: 'db-one' });
  });
});

describe('POST /api/d1/databases validation', () => {
  it('400s on a bad database name before touching CF', async () => {
    const db = createTestDb();
    await seed(db);
    const res = await databasesPost(
      ctx(db, 'http://localhost/api/d1/databases', {
        method: 'POST',
        body: JSON.stringify({ accountId: 'a1', cfAccountId: 'cf-1', name: 'Bad Name!' }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('invalidDatabaseName');
  });

  it('400s when accountId or cfAccountId is missing', async () => {
    const db = createTestDb();
    await seed(db);
    const res = await databasesPost(
      ctx(db, 'http://localhost/api/d1/databases', { method: 'POST', body: JSON.stringify({ name: 'ok-name' }) }),
    );
    expect(res.status).toBe(400);
  });
});

describe('database ownership guard (detail/query/tables/delete/patch)', () => {
  it('404s for a database outside the owner scope', async () => {
    const db = createTestDb();
    await seed(db);
    const params = { accountId: 'a1', databaseId: 'nope' };
    for (const [handler, init] of [
      [dbGet, undefined],
      [dbPatch, { method: 'PATCH', body: JSON.stringify({ mode: 'auto' }) }],
      [dbDelete, { method: 'DELETE' }],
      [tablesGet, undefined],
      [queryPost, { method: 'POST', body: JSON.stringify({ sql: 'SELECT 1' }) }],
    ] as const) {
      const res = await (handler as (c: never) => Promise<Response>)(
        ctx(db, 'http://localhost/api/d1/a1/nope', init as RequestInit | undefined, params),
      );
      expect(res.status).toBe(404);
    }
  });
});

describe('POST /api/d1/:accountId/:databaseId/query validation', () => {
  it('400s on empty sql before touching CF', async () => {
    const db = createTestDb();
    await seed(db);
    const res = await queryPost(
      ctx(
        db,
        'http://localhost/api/d1/a1/u1/query',
        { method: 'POST', body: JSON.stringify({ sql: '   ' }) },
        { accountId: 'a1', databaseId: 'u1' },
      ),
    );
    expect(res.status).toBe(400);
  });

  it('400s on oversized sql', async () => {
    const db = createTestDb();
    await seed(db);
    const res = await queryPost(
      ctx(
        db,
        'http://localhost/api/d1/a1/u1/query',
        { method: 'POST', body: JSON.stringify({ sql: `SELECT '${'x'.repeat(60_000)}'` }) },
        { accountId: 'a1', databaseId: 'u1' },
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/d1/:accountId/:databaseId validation', () => {
  it('400s on an invalid mode', async () => {
    const db = createTestDb();
    await seed(db);
    const res = await dbPatch(
      ctx(
        db,
        'http://localhost/api/d1/a1/u1',
        { method: 'PATCH', body: JSON.stringify({ mode: 'sometimes' }) },
        { accountId: 'a1', databaseId: 'u1' },
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/d1/:accountId/:databaseId', () => {
  it('removes the cached row after CF confirms the delete', async () => {
    const db = createTestDb();
    await seed(db);
    // 路由内部 clientForAccount 用全局 fetch 构造 CfClient:临时替换为固定成功响应
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: true, errors: [], messages: [], result: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    try {
      const res = await dbDelete(
        ctx(db, 'http://localhost/api/d1/a1/u1', { method: 'DELETE' }, { accountId: 'a1', databaseId: 'u1' }),
      );
      expect(res.status).toBe(200);
      const row = await db.prepare('SELECT COUNT(*) AS c FROM d1_databases').first<{ c: number }>();
      expect(row?.c).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/d1-api.test.ts`
Expected: FAIL —— 路由模块不存在。

- [ ] **Step 3: 实现 5 个路由文件**

`src/pages/api/d1/databases.ts` 全文:

```ts
import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { listCachedD1Databases, syncD1Databases } from '@/server/d1';
import { clientForAccount } from '@/server/workersPages';

export const GET: APIRoute = async ({ locals, request }) => {
  const { db, userEmail } = await appContext(locals);
  const url = new URL(request.url);
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
  const search = url.searchParams.get('search') ?? '';
  return Response.json(await listCachedD1Databases(db, userEmail, { page, pageSize, search }));
};

/** D1 库名规则:1-63 位小写字母/数字/连字符/下划线,首字符为字母或数字 */
const DB_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const LOCATION_HINTS = new Set(['wnam', 'enam', 'weur', 'eeur', 'apac', 'oc']);

export const POST: APIRoute = async ({ locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const body = (await request.json().catch(() => null)) as {
    accountId?: unknown;
    cfAccountId?: unknown;
    name?: unknown;
    primaryLocationHint?: unknown;
  } | null;
  const accountId = typeof body?.accountId === 'string' ? body.accountId : '';
  const cfAccountId = typeof body?.cfAccountId === 'string' ? body.cfAccountId : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const hint = typeof body?.primaryLocationHint === 'string' ? body.primaryLocationHint : '';
  if (!accountId || !cfAccountId) return jsonError('accountId and cfAccountId are required', 400);
  if (!DB_NAME_RE.test(name)) return jsonError('invalid database name', 400, 'invalidDatabaseName');
  if (hint && !LOCATION_HINTS.has(hint)) return jsonError('invalid location hint', 400);
  try {
    const client = await clientForAccount(db, key, userEmail, accountId);
    const database = await client.createD1Database(cfAccountId, {
      name,
      ...(hint ? { primaryLocationHint: hint } : {}),
    });
    // 创建成功后单账号增量同步刷新缓存;失败不致命(下次手动同步会补上)
    try {
      await syncD1Databases(db, key, userEmail, undefined, accountId);
    } catch {
      // 缓存刷新失败不影响创建结果
    }
    return Response.json({ database });
  } catch (e) {
    return handleCfError(e);
  }
};
```

`src/pages/api/d1/sync.ts` 全文:

```ts
import type { APIRoute } from 'astro';
import { appContext } from '@/server/context';
import { syncD1Databases } from '@/server/d1';

export const POST: APIRoute = async ({ locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const accountId = new URL(request.url).searchParams.get('accountId') ?? undefined;
  return Response.json(await syncD1Databases(db, key, userEmail, undefined, accountId));
};
```

`src/pages/api/d1/[accountId]/[databaseId]/index.ts` 全文:

```ts
import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { getCachedD1Database } from '@/server/d1';
import { clientForAccount } from '@/server/workersPages';

/** 实时详情:cfAccountId 从缓存行取(uuid 全局唯一,无需 query 参数);缓存缺失(未同步过)→ 404 */
export const GET: APIRoute = async ({ params, locals }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cached = await getCachedD1Database(db, userEmail, params.accountId!, params.databaseId!);
  if (!cached) return jsonError('Database not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const database = await client.getD1Database(cached.cfAccountId, cached.uuid);
    return Response.json({ database });
  } catch (e) {
    return handleCfError(e);
  }
};

export const PATCH: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const body = (await request.json().catch(() => null)) as { mode?: unknown } | null;
  const mode = body?.mode;
  if (mode !== 'auto' && mode !== 'disabled') return jsonError('mode must be "auto" or "disabled"', 400);
  const cached = await getCachedD1Database(db, userEmail, params.accountId!, params.databaseId!);
  if (!cached) return jsonError('Database not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const database = await client.editD1DatabaseReplication(cached.cfAccountId, cached.uuid, mode);
    await db
      .prepare('UPDATE d1_databases SET read_replication_mode = ? WHERE account_id = ? AND uuid = ?')
      .bind(mode, cached.accountId, cached.uuid)
      .run();
    return Response.json({ database });
  } catch (e) {
    return handleCfError(e);
  }
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cached = await getCachedD1Database(db, userEmail, params.accountId!, params.databaseId!);
  if (!cached) return jsonError('Database not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    await client.deleteD1Database(cached.cfAccountId, cached.uuid);
    await db
      .prepare('DELETE FROM d1_databases WHERE account_id = ? AND uuid = ?')
      .bind(cached.accountId, cached.uuid)
      .run();
    return Response.json({ ok: true });
  } catch (e) {
    return handleCfError(e);
  }
};
```

`src/pages/api/d1/[accountId]/[databaseId]/query.ts` 全文:

```ts
import type { APIRoute } from 'astro';
import { CfApiError } from '@/server/cf/client';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { getCachedD1Database } from '@/server/d1';
import { clientForAccount } from '@/server/workersPages';

/** 单结果集最大返回行数:超出截断并标记 truncated(防超大 SELECT 撑爆响应/前端) */
const MAX_ROWS = 1000;
/** SQL 文本长度上限(字符):防误粘贴整个 dump */
const MAX_SQL_LEN = 50_000;

export const POST: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const body = (await request.json().catch(() => null)) as { sql?: unknown; params?: unknown } | null;
  const sql = typeof body?.sql === 'string' ? body.sql.trim() : '';
  if (!sql) return jsonError('sql is required', 400);
  if (sql.length > MAX_SQL_LEN) return jsonError('sql too long', 400);
  const bindParams = Array.isArray(body?.params) ? body.params.filter((p): p is string => typeof p === 'string') : [];
  const cached = await getCachedD1Database(db, userEmail, params.accountId!, params.databaseId!);
  if (!cached) return jsonError('Database not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const results = await client.queryD1Raw(cached.cfAccountId, cached.uuid, sql, bindParams);
    return Response.json({
      results: results.map((r) => ({
        columns: r.columns,
        rows: r.rows.slice(0, MAX_ROWS),
        meta: r.meta,
        truncated: r.rows.length > MAX_ROWS,
      })),
    });
  } catch (e) {
    // CF 对 SQL 语法/运行时错误返回 400(7500 系列):不是异常路径,以 200 + error 字段
    // 交给前端展示在结果区;401/403(权限)等仍走 HTTP 错误由前端 toast
    if (e instanceof CfApiError && e.status === 400) {
      return Response.json({ error: { message: e.message } });
    }
    return handleCfError(e);
  }
};
```

`src/pages/api/d1/[accountId]/[databaseId]/tables.ts` 全文:

```ts
import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { getCachedD1Database } from '@/server/d1';
import { clientForAccount } from '@/server/workersPages';

/** 单次列出的表数上限:每表 2 条语句(PRAGMA + COUNT),100 表 = 200 语句,已远超常规库 */
const MAX_TABLES = 100;

/** SQLite 标识符引用:双引号包裹,内部双引号翻倍 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export const GET: APIRoute = async ({ params, locals }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cached = await getCachedD1Database(db, userEmail, params.accountId!, params.databaseId!);
  if (!cached) return jsonError('Database not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    // sqlite_% 为 SQLite 内部表、_cf_% 为 D1 平台内部表(_cf_KV 等),都不展示
    const listed = await client.queryD1Raw(
      cached.cfAccountId,
      cached.uuid,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`,
    );
    const allNames = (listed[0]?.rows ?? []).map((r) => String(r[0]));
    const names = allNames.slice(0, MAX_TABLES);
    if (names.length === 0) return Response.json({ tables: [], truncated: false });

    // 每表两条语句拼成一个分号批:结果集顺序与语句顺序一致(raw 端点契约)
    const batchSql = names.map((n) => `PRAGMA table_info(${quoteIdent(n)}); SELECT COUNT(*) FROM ${quoteIdent(n)};`).join(' ');
    const results = await client.queryD1Raw(cached.cfAccountId, cached.uuid, batchSql);

    const tables = names.map((name, i) => {
      const info = results[i * 2];
      const count = results[i * 2 + 1];
      // PRAGMA table_info 列序:cid, name, type, notnull, dflt_value, pk
      const col = (label: string) => info?.columns.indexOf(label) ?? -1;
      const [cName, cType, cNotnull, cDflt, cPk] = [col('name'), col('type'), col('notnull'), col('dflt_value'), col('pk')];
      return {
        name,
        rowCount: Number(count?.rows[0]?.[0] ?? 0),
        columns: (info?.rows ?? []).map((r) => ({
          name: String(r[cName] ?? ''),
          type: String(r[cType] ?? ''),
          notnull: Number(r[cNotnull] ?? 0) === 1,
          pk: Number(r[cPk] ?? 0) > 0,
          dflt_value: r[cDflt] == null ? null : String(r[cDflt]),
        })),
      };
    });
    return Response.json({ tables, truncated: allNames.length > names.length });
  } catch (e) {
    return handleCfError(e);
  }
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/d1-api.test.ts`
Expected: PASS(8 个用例)。

- [ ] **Step 5: 门禁 + 提交**

```bash
npm run check && npm run typecheck && npm run test
git add src/pages/api/d1 tests/unit/d1-api.test.ts
git commit -m "feat(d1): API 路由(列表/创建/同步/详情/读复制/删除/查询/表清单)"
```

---

### Task 5: i18n 文案 + 导航入口

**Files:**
- Modify: `src/i18n/index.ts`(zh 与 en 两个字典各追加同一组 key)
- Modify: `src/layouts/MainLayout.astro`(icon import + nav 数组)

**Interfaces:**
- Produces: `nav.d1` 与全部 `d1.*` key,供 Task 6/7 组件与页面引用。`t(locale, key, params)` 用法不变。

- [ ] **Step 1: zh 字典追加**(插在 `r2.*` 分组之后,保持分组邻近):

```ts
  'nav.d1': 'D1 数据库',
  'd1.pageTitle': 'D1 数据库',
  'd1.dbDetailTitle': 'D1 数据库详情',
  'd1.sync': '同步全部账号',
  'd1.syncing': '同步中…',
  'd1.syncDone': '同步完成:{n} 个数据库',
  'd1.syncFailures': ',{m} 个账号失败(详见账号页)',
  'd1.searchPlaceholder': '按库名或账号搜索',
  'd1.empty': '无数据 — 请先添加账号并点击「同步全部账号」',
  'd1.noMatch': '没有匹配的数据库',
  'd1.colName': '名称',
  'd1.colAccount': '账号',
  'd1.colTables': '表数量',
  'd1.colSize': '大小',
  'd1.colCreated': '创建时间',
  'd1.detail': '详情',
  'd1.delete': '删除',
  'd1.deleted': '数据库已删除',
  'd1.deleteTitle': '删除数据库 {name}',
  'd1.deleteTypeToConfirm': '此操作不可恢复,所有数据将永久丢失。请输入库名 {name} 确认:',
  'd1.create': '创建数据库',
  'd1.created': '数据库已创建',
  'd1.createAccountPlaceholder': '选择账号',
  'd1.createNamePlaceholder': '数据库名(小写字母/数字/-/_)',
  'd1.createLocationAuto': '主副本区域:自动',
  'd1.invalidName': '库名不合法:1-63 位小写字母、数字、连字符或下划线,首位为字母或数字',
  'd1.tabTables': '表',
  'd1.tabQuery': '查询',
  'd1.tabSettings': '设置',
  'd1.tablesEmpty': '库中没有表 — 可在「查询」Tab 执行 CREATE TABLE',
  'd1.tablesTruncated': '表太多,仅显示前 100 张',
  'd1.colRowCount': '行数',
  'd1.browse': '浏览数据',
  'd1.colColumn': '列名',
  'd1.colType': '类型',
  'd1.colNotNull': '非空',
  'd1.colDefault': '默认值',
  'd1.colPk': '主键',
  'd1.queryPlaceholder': '输入 SQL,Cmd/Ctrl+Enter 执行',
  'd1.run': '执行',
  'd1.running': '执行中…',
  'd1.writeConfirmTitle': '确认执行写操作?',
  'd1.writeConfirmDesc': '该语句可能修改或删除数据,且无法撤销。',
  'd1.historyTitle': '查询历史',
  'd1.rowsReturned': '{n} 行',
  'd1.duration': '{ms} ms',
  'd1.changes': '变更 {n} 行',
  'd1.truncated': '结果超过 1000 行已截断',
  'd1.resultEmpty': '(无返回行)',
  'd1.prevPage': '上一页',
  'd1.nextPage': '下一页',
  'd1.settingsUuid': 'UUID',
  'd1.settingsVersion': '版本',
  'd1.settingsSize': '大小',
  'd1.settingsTables': '表数量',
  'd1.settingsCreated': '创建时间',
  'd1.settingsReplication': '读复制(read replication)',
  'd1.replicationDesc': 'auto:D1 自动在全球放置只读副本;disabled:不使用副本(删除副本可能需数小时)',
  'd1.replicationUpdated': '读复制设置已更新',
  'd1.dangerZone': '危险区',
  'd1.deleteDbDesc': '删除数据库将永久移除全部数据,不可恢复。',
```

- [ ] **Step 2: en 字典追加**(相同 key,英文文案):

```ts
  'nav.d1': 'D1',
  'd1.pageTitle': 'D1 Databases',
  'd1.dbDetailTitle': 'D1 Database',
  'd1.sync': 'Sync all accounts',
  'd1.syncing': 'Syncing…',
  'd1.syncDone': 'Synced {n} databases',
  'd1.syncFailures': ', {m} accounts failed (see Accounts)',
  'd1.searchPlaceholder': 'Search by database or account',
  'd1.empty': 'No data — add an account and hit "Sync all accounts"',
  'd1.noMatch': 'No matching databases',
  'd1.colName': 'Name',
  'd1.colAccount': 'Account',
  'd1.colTables': 'Tables',
  'd1.colSize': 'Size',
  'd1.colCreated': 'Created',
  'd1.detail': 'Detail',
  'd1.delete': 'Delete',
  'd1.deleted': 'Database deleted',
  'd1.deleteTitle': 'Delete database {name}',
  'd1.deleteTypeToConfirm': 'This cannot be undone; all data will be lost. Type {name} to confirm:',
  'd1.create': 'Create database',
  'd1.created': 'Database created',
  'd1.createAccountPlaceholder': 'Select account',
  'd1.createNamePlaceholder': 'Database name (lowercase/digits/-/_)',
  'd1.createLocationAuto': 'Primary location: auto',
  'd1.invalidName': 'Invalid name: 1-63 lowercase letters, digits, hyphens or underscores, starting alphanumeric',
  'd1.tabTables': 'Tables',
  'd1.tabQuery': 'Query',
  'd1.tabSettings': 'Settings',
  'd1.tablesEmpty': 'No tables yet — run CREATE TABLE in the Query tab',
  'd1.tablesTruncated': 'Too many tables; showing the first 100',
  'd1.colRowCount': 'Rows',
  'd1.browse': 'Browse',
  'd1.colColumn': 'Column',
  'd1.colType': 'Type',
  'd1.colNotNull': 'Not null',
  'd1.colDefault': 'Default',
  'd1.colPk': 'PK',
  'd1.queryPlaceholder': 'Enter SQL, Cmd/Ctrl+Enter to run',
  'd1.run': 'Run',
  'd1.running': 'Running…',
  'd1.writeConfirmTitle': 'Run write statement?',
  'd1.writeConfirmDesc': 'This statement may modify or delete data and cannot be undone.',
  'd1.historyTitle': 'Query history',
  'd1.rowsReturned': '{n} rows',
  'd1.duration': '{ms} ms',
  'd1.changes': '{n} rows changed',
  'd1.truncated': 'Result truncated to 1000 rows',
  'd1.resultEmpty': '(no rows returned)',
  'd1.prevPage': 'Prev',
  'd1.nextPage': 'Next',
  'd1.settingsUuid': 'UUID',
  'd1.settingsVersion': 'Version',
  'd1.settingsSize': 'Size',
  'd1.settingsTables': 'Tables',
  'd1.settingsCreated': 'Created',
  'd1.settingsReplication': 'Read replication',
  'd1.replicationDesc': 'auto: D1 places read replicas worldwide; disabled: no replicas (removal may take hours)',
  'd1.replicationUpdated': 'Read replication updated',
  'd1.dangerZone': 'Danger zone',
  'd1.deleteDbDesc': 'Deleting a database permanently removes all its data.',
```

- [ ] **Step 3: 导航入口**

`src/layouts/MainLayout.astro`:
1. icon import 行追加 `DatabaseZap`(R2 已占用 `Database`):`import { BarChart3, Check, ChevronDown, Database, DatabaseZap, Globe, ... } from 'lucide-react';`
2. `nav` 数组在 r2 之后插入:

```ts
  { href: localizePath(locale, '/d1'), label: t(locale, 'nav.d1'), Icon: DatabaseZap },
```

- [ ] **Step 4: 门禁 + 提交**

Run: `npm run check && npm run typecheck && npm run test`
Expected: 全绿(i18n.test.ts 不校验新 key,但 typecheck 会揪出 t() 引用不存在的 key)。

```bash
git add src/i18n/index.ts src/layouts/MainLayout.astro
git commit -m "feat(d1): i18n 文案与导航入口"
```

---

### Task 6: 列表页(D1Panel + 删除确认模态 + Astro 页面)

**Files:**
- Create: `src/components/d1/DeleteDatabaseModal.tsx`
- Create: `src/components/D1Panel.tsx`
- Create: `src/pages/d1/index.astro`
- Create: `src/pages/en/d1/index.astro`

**Interfaces:**
- Consumes: Task 4 的 `GET/POST /api/d1/databases`、`POST /api/d1/sync`、`DELETE /api/d1/:accountId/:databaseId`;Task 5 i18n key;既有 `/api/accounts`、`/api/accounts/:id/cf-accounts`、`ToastProvider/useToast`、`ConfirmDialogProvider`、`TablePagination`、`usePageshowRefresh`、`accountColor`、`formatBytes`、`relativeTime`、`localizePath`。
- Produces: `DeleteDatabaseModal` props `{ locale: Locale; name: string; deleting: boolean; onCancel: () => void; onConfirm: () => void }`(Task 7 设置 Tab 复用);`D1Panel` props `{ locale: Locale }`。

- [ ] **Step 1: 实现 `src/components/d1/DeleteDatabaseModal.tsx`**(全文):

```tsx
import { useState } from 'react';
import { type Locale, t } from '@/i18n';

/** 输名确认删除模态(列表页与设置 Tab 共用):输入与库名完全一致才放开确认键,防误删 */
export default function DeleteDatabaseModal({
  locale,
  name,
  deleting,
  onCancel,
  onConfirm,
}: {
  locale: Locale;
  name: string;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const matched = typed === name;
  return (
    <dialog open className="modal modal-open">
      <div className="modal-box">
        <h3 className="text-lg font-bold">{t(locale, 'd1.deleteTitle', { name })}</h3>
        <p className="py-3 text-sm">{t(locale, 'd1.deleteTypeToConfirm', { name })}</p>
        <input
          type="text"
          className="input input-bordered input-sm w-full font-mono"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={name}
        />
        <div className="modal-action">
          <button className="btn btn-ghost" disabled={deleting} onClick={onCancel}>
            {t(locale, 'common.cancel')}
          </button>
          <button className="btn btn-error" disabled={!matched || deleting} onClick={onConfirm}>
            {deleting && <span className="loading loading-spinner loading-xs" />}
            {t(locale, 'd1.delete')}
          </button>
        </div>
      </div>
      <form
        method="dialog"
        className="modal-backdrop"
        onSubmit={(e) => {
          e.preventDefault();
          if (!deleting) onCancel();
        }}
      >
        <button type="submit" aria-label={t(locale, 'common.cancel')} />
      </form>
    </dialog>
  );
}
```

- [ ] **Step 2: 实现 `src/components/D1Panel.tsx`**

整体照抄 `R2Panel.tsx` 的骨架(状态、防抖搜索、reload、bfcache 刷新、账号/CF 账号联动下拉、同步进度、骨架屏/空态/错误态、TablePagination),差异点:

- 行类型:

```tsx
interface D1DatabaseItem {
  uuid: string;
  name: string;
  accountId: string;
  accountName: string;
  cfAccountId: string;
  cfAccountName: string | null;
  numTables: number | null;
  fileSize: number | null;
  createdAt: string | null;
  syncedAt: string;
}
```

- 列定义(移动端规则 2:名称+时间+操作永远可见):

```tsx
const COLS = (locale: Locale) =>
  [
    { key: 'name', header: t(locale, 'd1.colName'), className: '' },
    { key: 'account', header: t(locale, 'd1.colAccount'), className: 'hidden md:table-cell' },
    { key: 'tables', header: t(locale, 'd1.colTables'), className: 'hidden sm:table-cell' },
    { key: 'size', header: t(locale, 'd1.colSize'), className: 'hidden sm:table-cell' },
    { key: 'created', header: t(locale, 'd1.colCreated'), className: '' },
    { key: 'actions', header: '', className: '' },
  ] as const;
```

- 详情链接(带 `name` 供详情页面包屑/标题即时显示):

```tsx
const dbHref = useCallback(
  (row: D1DatabaseItem) =>
    localizePath(locale, `/d1/${row.accountId}/${encodeURIComponent(row.uuid)}`) +
    `?name=${encodeURIComponent(row.name)}`,
  [locale],
);
```

- `cellFor`:`name` → `<a className="link-hover font-mono hover:text-primary" href={dbHref(row)}>{row.name}</a>`;`account` 同 R2(accountColor 圆点);`tables` → `<span className="font-mono text-xs">{row.numTables ?? '—'}</span>`;`size` → `formatBytes(row.fileSize)`;`created` → `relativeTime`;`actions`:

```tsx
case 'actions':
  return (
    <span className="inline-flex gap-1">
      <a className="btn btn-xs whitespace-nowrap" href={dbHref(row)}>
        {t(locale, 'd1.detail')}
      </a>
      <button
        className="btn btn-ghost btn-xs whitespace-nowrap text-error"
        disabled={deleteTarget !== null}
        onClick={() => setDeleteTarget(row)}
      >
        {t(locale, 'd1.delete')}
      </button>
    </span>
  );
```

- 数据源:`/api/d1/databases?page&pageSize&search`,响应字段 `databases/total`;同步 `/api/d1/sync`(多账号时按 R2 的 2 并发逐账号进度模式,文案 `d1.syncDone`/`d1.syncFailures`);行 key 用 `row.accountId + '/' + row.uuid`。
- 创建表单(规则 7:`flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start`,输入 `w-full sm:w-48/56`):账号 select、CF 账号 select(>1 时)、名称 input、区域 select(`''` = auto + `['wnam','enam','weur','eeur','apac','oc']`)。提交函数:

```tsx
const DB_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

async function createDatabase() {
  if (!createAccount || !createCfAccount || creating) return;
  const name = createName.trim();
  if (!DB_NAME_RE.test(name)) {
    showToast(t(locale, 'd1.invalidName'), 'error');
    return;
  }
  setCreating(true);
  try {
    const res = await fetch('/api/d1/databases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: createAccount,
        cfAccountId: createCfAccount,
        name,
        ...(createLocation ? { primaryLocationHint: createLocation } : {}),
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      showToast(body?.error ?? t(locale, 'common.requestFailed'), 'error');
      return;
    }
    showToast(t(locale, 'd1.created'), 'success');
    setShowCreate(false);
    setCreateName('');
    setRefreshKey((k) => k + 1);
  } catch {
    showToast(t(locale, 'common.requestFailed'), 'error');
  } finally {
    setCreating(false);
  }
}
```

- 删除:state `deleteTarget: D1DatabaseItem | null` + `deleting: boolean`;组件 JSX 尾部:

```tsx
{deleteTarget && (
  <DeleteDatabaseModal
    locale={locale}
    name={deleteTarget.name}
    deleting={deleting}
    onCancel={() => setDeleteTarget(null)}
    onConfirm={() => void deleteDatabase(deleteTarget)}
  />
)}
```

```tsx
async function deleteDatabase(row: D1DatabaseItem) {
  if (deleting) return;
  setDeleting(true);
  try {
    const res = await fetch(`/api/d1/${encodeURIComponent(row.accountId)}/${encodeURIComponent(row.uuid)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      showToast(body?.error ?? t(locale, 'common.requestFailed'), 'error');
      return;
    }
    showToast(t(locale, 'd1.deleted'), 'success');
    setDeleteTarget(null);
    setRefreshKey((k) => k + 1);
  } catch {
    showToast(t(locale, 'common.requestFailed'), 'error');
  } finally {
    setDeleting(false);
  }
}
```
- 顶层导出仍包 `ToastProvider`(不需要 ConfirmDialogProvider,删除走自有模态):

```tsx
export default function D1Panel({ locale }: { locale: Locale }) {
  return (
    <ToastProvider>
      <D1PanelInner locale={locale} />
    </ToastProvider>
  );
}
```

- 空态图标用 `DatabaseZap`(与导航一致);工具栏创建/同步按钮遵循规则 5/6(`whitespace-nowrap`、窄屏纯图标 + `title`)。

- [ ] **Step 3: Astro 页面**

`src/pages/d1/index.astro` 全文:

```astro
---
import MainLayout from '@/layouts/MainLayout.astro';
import D1Panel from '@/components/D1Panel';
import { t } from '@/i18n';
import { localeFromPath } from '@/i18n/routing';
const locale = localeFromPath(Astro.url.pathname);
---
<MainLayout title={t(locale, 'd1.pageTitle')} locale={locale}>
  <D1Panel client:load locale={locale} />
</MainLayout>
```

`src/pages/en/d1/index.astro`:内容与上文完全相同(locale 由路径推导,`/en/d1` 自动得到英文)。

- [ ] **Step 4: 手动验证**

Run: `npm run dev`,浏览器开 `http://localhost:4321/d1` 与 `/en/d1`。
Expected: 导航出现「D1 数据库」;空态提示;有账号时点同步出现数据库行;创建/删除(输名确认)可用;500px 视口 `document.scrollingElement.scrollWidth === window.innerWidth`。

- [ ] **Step 5: 门禁 + 提交**

```bash
npm run check && npm run typecheck && npm run test
git add src/components/D1Panel.tsx src/components/d1/DeleteDatabaseModal.tsx src/pages/d1 src/pages/en/d1
git commit -m "feat(d1): 数据库列表页(跨账号缓存聚合/创建/删除/同步)"
```

---

### Task 7: 详情页(Tab 壳 + 表/查询/设置 Tab + Astro 页面)

**Files:**
- Create: `src/components/d1/D1DatabaseDetailPanel.tsx`
- Create: `src/components/d1/TablesTab.tsx`
- Create: `src/components/d1/QueryTab.tsx`
- Create: `src/components/d1/SettingsTab.tsx`
- Create: `src/pages/d1/[accountId]/[databaseId].astro`
- Create: `src/pages/en/d1/[accountId]/[databaseId].astro`

**Interfaces:**
- Consumes: Task 4 的 `GET/PATCH/DELETE /api/d1/:accountId/:databaseId`、`POST .../query`、`GET .../tables`;Task 3 `isWriteSql`;Task 6 `DeleteDatabaseModal`;既有 `DetailTabs/useDetailTab`、`ToastProvider/useToast`、`formatBytes`、`localizePath`。
- Produces: `D1DatabaseDetailPanel` props `{ accountId: string; databaseId: string; dbName: string | null; locale: Locale; initialTab?: string | null }`。子 Tab 统一 props:`{ locale: Locale; apiBase: string }`,QueryTab 额外 `browse: { table: string; seq: number } | null`,TablesTab 额外 `onBrowse: (table: string) => void`,SettingsTab 额外 `dbName: string | null`(删除模态展示/匹配库名;为 null 时回退实时详情里的 name)。

- [ ] **Step 1: Tab 壳 `src/components/d1/D1DatabaseDetailPanel.tsx`**(全文):

```tsx
import { useState } from 'react';
import DetailTabs, { useDetailTab } from '@/components/ui/DetailTabs';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { type Locale, t } from '@/i18n';
import QueryTab from './QueryTab';
import SettingsTab from './SettingsTab';
import TablesTab from './TablesTab';

const TAB_KEYS = ['tables', 'query', 'settings'] as const;

export default function D1DatabaseDetailPanel({
  accountId,
  databaseId,
  dbName,
  locale,
  initialTab,
}: {
  accountId: string;
  databaseId: string;
  dbName: string | null;
  locale: Locale;
  initialTab?: string | null;
}) {
  const [tab, switchTab] = useDetailTab(TAB_KEYS, initialTab);
  // 表 Tab 点「浏览数据」→ 切到查询 Tab 并自动执行 SELECT;seq 递增让重复点同一张表也能触发
  const [browse, setBrowse] = useState<{ table: string; seq: number } | null>(null);
  const apiBase = `/api/d1/${encodeURIComponent(accountId)}/${encodeURIComponent(databaseId)}`;
  return (
    <ToastProvider>
      <div className="card border border-base-300 bg-base-100 p-4">
        <DetailTabs
          tabs={[
            { key: 'tables', label: t(locale, 'd1.tabTables') },
            { key: 'query', label: t(locale, 'd1.tabQuery') },
            { key: 'settings', label: t(locale, 'd1.tabSettings') },
          ]}
          active={tab}
          onChange={(k) => switchTab(k as (typeof TAB_KEYS)[number])}
        />
        {/* tab 内容全宽垂直堆叠(移动端规则 10);查询 Tab 常驻挂载保留 SQL/结果,其余按需挂载 */}
        <div className="mt-4">
          {tab === 'tables' && (
            <TablesTab
              locale={locale}
              apiBase={apiBase}
              onBrowse={(table) => {
                setBrowse((b) => ({ table, seq: (b?.seq ?? 0) + 1 }));
                switchTab('query');
              }}
            />
          )}
          <div className={tab === 'query' ? '' : 'hidden'}>
            <QueryTab locale={locale} apiBase={apiBase} browse={browse} />
          </div>
          {tab === 'settings' && <SettingsTab locale={locale} apiBase={apiBase} dbName={dbName} />}
        </div>
      </div>
    </ToastProvider>
  );
}
```

- [ ] **Step 2: `src/components/d1/TablesTab.tsx`**(全文):

```tsx
import { Table2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { type Locale, t } from '@/i18n';

interface TableInfo {
  name: string;
  rowCount: number;
  columns: { name: string; type: string; notnull: boolean; pk: boolean; dflt_value: string | null }[];
}

export default function TablesTab({
  locale,
  apiBase,
  onBrowse,
}: {
  locale: Locale;
  apiBase: string;
  onBrowse: (table: string) => void;
}) {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/tables`);
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      setLoadError(false);
      const data = (await res.json()) as { tables: TableInfo[]; truncated: boolean };
      setTables(data.tables);
      setTruncated(data.truncated);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) return <div className="skeleton h-32 w-full" />;
  if (loadError)
    return (
      <div className="alert alert-error flex items-center gap-3">
        <span className="text-sm">{t(locale, 'common.requestFailed')}</span>
        <button className="btn btn-ghost btn-sm" onClick={() => void reload()}>
          {t(locale, 'common.retry')}
        </button>
      </div>
    );
  if (tables.length === 0)
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <Table2 size={48} strokeWidth={1.75} className="opacity-40" />
        <p className="text-sm opacity-60">{t(locale, 'd1.tablesEmpty')}</p>
      </div>
    );

  return (
    <div className="flex flex-col gap-2">
      {truncated && <div className="alert alert-warning text-sm">{t(locale, 'd1.tablesTruncated')}</div>}
      {tables.map((tb) => (
        <div key={tb.name} className="rounded-box border border-base-300">
          <div className="flex flex-wrap items-center gap-2 p-3">
            <button
              className="link-hover min-w-0 break-all text-left font-mono font-semibold hover:text-primary"
              onClick={() => setExpanded((e) => (e === tb.name ? null : tb.name))}
            >
              {tb.name}
            </button>
            <span className="badge badge-ghost badge-sm shrink-0 whitespace-nowrap">
              {t(locale, 'd1.colRowCount')}: {tb.rowCount}
            </span>
            <button className="btn btn-xs ml-auto shrink-0 whitespace-nowrap" onClick={() => onBrowse(tb.name)}>
              {t(locale, 'd1.browse')}
            </button>
          </div>
          {expanded === tb.name && (
            <div className="overflow-x-auto border-base-300 border-t">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>{t(locale, 'd1.colColumn')}</th>
                    <th>{t(locale, 'd1.colType')}</th>
                    <th className="hidden sm:table-cell">{t(locale, 'd1.colNotNull')}</th>
                    <th className="hidden sm:table-cell">{t(locale, 'd1.colDefault')}</th>
                    <th>{t(locale, 'd1.colPk')}</th>
                  </tr>
                </thead>
                <tbody>
                  {tb.columns.map((c) => (
                    <tr key={c.name}>
                      <td className="font-mono">{c.name}</td>
                      <td className="font-mono text-xs opacity-70">{c.type || '—'}</td>
                      <td className="hidden sm:table-cell">{c.notnull ? '✓' : ''}</td>
                      <td className="hidden font-mono text-xs sm:table-cell">{c.dflt_value ?? '—'}</td>
                      <td>{c.pk ? '✓' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: `src/components/d1/QueryTab.tsx`**(全文):

```tsx
import { Play } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Locale, t } from '@/i18n';
import { isWriteSql } from '@/lib/sqlWrite';

const BROWSE_PAGE_SIZE = 50;
const HISTORY_MAX = 20;

interface QueryResultSet {
  columns: string[];
  rows: unknown[][];
  meta: { duration: number | null; changes: number | null; changed_db: boolean };
  truncated: boolean;
}

type QueryResponse = { results: QueryResultSet[] } | { error: { message: string } };

/** SQLite 标识符引用(浏览模式拼 SELECT 用) */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function browseSql(table: string, page: number): string {
  return `SELECT * FROM ${quoteIdent(table)} LIMIT ${BROWSE_PAGE_SIZE} OFFSET ${page * BROWSE_PAGE_SIZE}`;
}

export default function QueryTab({
  locale,
  apiBase,
  browse,
}: {
  locale: Locale;
  apiBase: string;
  browse: { table: string; seq: number } | null;
}) {
  const [sql, setSql] = useState('');
  const [running, setRunning] = useState(false);
  const [resp, setResp] = useState<QueryResponse | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  // 浏览模式:由表 Tab 触发,分页按钮改写 OFFSET 重跑;手动改动 SQL 后退出浏览模式
  const [browseState, setBrowseState] = useState<{ table: string; page: number } | null>(null);
  const [confirmSql, setConfirmSql] = useState<string | null>(null);
  const historyKey = `d1-query-history:${apiBase}`;
  const lastSeq = useRef(0);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(historyKey);
      if (raw) setHistory((JSON.parse(raw) as string[]).slice(0, HISTORY_MAX));
    } catch {
      // 历史损坏就从空开始
    }
  }, [historyKey]);

  const execute = useCallback(
    async (text: string, browseCtx: { table: string; page: number } | null) => {
      setRunning(true);
      setBrowseState(browseCtx);
      try {
        const res = await fetch(`${apiBase}/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql: text }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setResp({ error: { message: body?.error ?? t(locale, 'common.requestFailed') } });
          return;
        }
        setResp((await res.json()) as QueryResponse);
        if (!browseCtx) {
          setHistory((h) => {
            const next = [text, ...h.filter((x) => x !== text)].slice(0, HISTORY_MAX);
            try {
              localStorage.setItem(historyKey, JSON.stringify(next));
            } catch {
              // 存储满/禁用时历史静默降级
            }
            return next;
          });
        }
      } catch {
        setResp({ error: { message: t(locale, 'common.requestFailed') } });
      } finally {
        setRunning(false);
      }
    },
    [apiBase, historyKey, locale],
  );

  // 表 Tab 的「浏览数据」:填入生成的 SELECT 并直接执行(只读语句,无需确认)
  useEffect(() => {
    if (!browse || browse.seq === lastSeq.current) return;
    lastSeq.current = browse.seq;
    const text = browseSql(browse.table, 0);
    setSql(text);
    void execute(text, { table: browse.table, page: 0 });
  }, [browse, execute]);

  function run() {
    const text = sql.trim();
    if (!text || running) return;
    if (isWriteSql(text)) {
      setConfirmSql(text);
      return;
    }
    void execute(text, null);
  }

  function browsePageTo(page: number) {
    if (!browseState || running || page < 0) return;
    const text = browseSql(browseState.table, page);
    setSql(text);
    void execute(text, { table: browseState.table, page });
  }

  const results = resp && 'results' in resp ? resp.results : null;
  const lastRows = results?.[results.length - 1]?.rows.length ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <textarea
        className="textarea textarea-bordered min-h-28 w-full font-mono text-sm"
        placeholder={t(locale, 'd1.queryPlaceholder')}
        value={sql}
        onChange={(e) => {
          setSql(e.target.value);
          setBrowseState(null);
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            run();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn btn-primary btn-sm whitespace-nowrap"
          disabled={running || sql.trim() === ''}
          onClick={run}
        >
          {running ? <span className="loading loading-spinner loading-xs" /> : <Play size={14} strokeWidth={1.75} />}
          {running ? t(locale, 'd1.running') : t(locale, 'd1.run')}
        </button>
        {history.length > 0 && (
          <details className="dropdown">
            <summary className="btn btn-ghost btn-sm whitespace-nowrap">{t(locale, 'd1.historyTitle')}</summary>
            <ul className="menu dropdown-content z-10 max-h-64 w-72 max-w-[90vw] flex-nowrap overflow-y-auto rounded-box border border-base-300 bg-base-100 p-2 shadow">
              {history.map((h) => (
                <li key={h}>
                  <button
                    className="block truncate font-mono text-xs"
                    title={h}
                    onClick={(e) => {
                      setSql(h);
                      setBrowseState(null);
                      (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
                    }}
                  >
                    {h}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {resp && 'error' in resp && (
        <div className="alert alert-error">
          <pre className="min-w-0 whitespace-pre-wrap break-all font-mono text-xs">{resp.error.message}</pre>
        </div>
      )}

      {results?.map((r, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs opacity-70">
            <span className="shrink-0 whitespace-nowrap">{t(locale, 'd1.rowsReturned', { n: r.rows.length })}</span>
            {r.meta.duration !== null && (
              <span className="shrink-0 whitespace-nowrap">
                {t(locale, 'd1.duration', { ms: Math.round(r.meta.duration * 100) / 100 })}
              </span>
            )}
            {r.meta.changed_db && r.meta.changes !== null && (
              <span className="badge badge-warning badge-sm shrink-0 whitespace-nowrap">
                {t(locale, 'd1.changes', { n: r.meta.changes })}
              </span>
            )}
            {r.truncated && (
              <span className="badge badge-warning badge-sm shrink-0 whitespace-nowrap">
                {t(locale, 'd1.truncated')}
              </span>
            )}
          </div>
          {r.columns.length === 0 || r.rows.length === 0 ? (
            <p className="text-sm opacity-60">{t(locale, 'd1.resultEmpty')}</p>
          ) : (
            <div className="overflow-x-auto rounded-box border border-base-300">
              <table className="table table-sm">
                <thead>
                  <tr>
                    {r.columns.map((c) => (
                      <th key={c} className="font-mono">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci} className="max-w-64 truncate font-mono text-xs" title={String(cell ?? '')}>
                          {cell === null ? <span className="opacity-40">NULL</span> : String(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}

      {browseState && results && (
        <div className="flex items-center gap-2">
          <button
            className="btn btn-sm whitespace-nowrap"
            disabled={running || browseState.page === 0}
            onClick={() => browsePageTo(browseState.page - 1)}
          >
            {t(locale, 'd1.prevPage')}
          </button>
          <span className="font-mono text-xs opacity-60">{browseState.page + 1}</span>
          <button
            className="btn btn-sm whitespace-nowrap"
            disabled={running || lastRows < BROWSE_PAGE_SIZE}
            onClick={() => browsePageTo(browseState.page + 1)}
          >
            {t(locale, 'd1.nextPage')}
          </button>
        </div>
      )}

      {confirmSql !== null && (
        <dialog open className="modal modal-open">
          <div className="modal-box">
            <h3 className="text-lg font-bold">{t(locale, 'd1.writeConfirmTitle')}</h3>
            <p className="py-2 text-sm">{t(locale, 'd1.writeConfirmDesc')}</p>
            <pre className="max-h-40 overflow-auto rounded-box bg-base-200 p-2 font-mono text-xs">{confirmSql}</pre>
            <div className="modal-action">
              <button className="btn btn-ghost" onClick={() => setConfirmSql(null)}>
                {t(locale, 'common.cancel')}
              </button>
              <button
                className="btn btn-warning"
                onClick={() => {
                  setConfirmSql(null);
                  void execute(confirmSql, null);
                }}
              >
                {t(locale, 'common.confirm')}
              </button>
            </div>
          </div>
          <form
            method="dialog"
            className="modal-backdrop"
            onSubmit={(e) => {
              e.preventDefault();
              setConfirmSql(null);
            }}
          >
            <button type="submit" aria-label={t(locale, 'common.cancel')} />
          </form>
        </dialog>
      )}
    </div>
  );
}
```

- [ ] **Step 4: `src/components/d1/SettingsTab.tsx`**(全文):

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/ui/ToastProvider';
import { type Locale, t } from '@/i18n';
import { localizePath } from '@/i18n/routing';
import { formatBytes } from '@/lib/formatBytes';
import DeleteDatabaseModal from './DeleteDatabaseModal';

interface D1Detail {
  uuid: string;
  name: string;
  version: string | null;
  created_at: string | null;
  num_tables: number | null;
  file_size: number | null;
  read_replication_mode: 'auto' | 'disabled' | null;
}

export default function SettingsTab({
  locale,
  apiBase,
  dbName,
}: {
  locale: Locale;
  apiBase: string;
  dbName: string | null;
}) {
  const [detail, setDetail] = useState<D1Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [savingReplication, setSavingReplication] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { showToast } = useToast();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiBase);
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      setLoadError(false);
      setDetail(((await res.json()) as { database: D1Detail }).database);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function toggleReplication(next: 'auto' | 'disabled') {
    if (savingReplication) return;
    setSavingReplication(true);
    try {
      const res = await fetch(apiBase, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(body?.error ?? t(locale, 'common.requestFailed'), 'error');
        return;
      }
      setDetail(((await res.json()) as { database: D1Detail }).database);
      showToast(t(locale, 'd1.replicationUpdated'), 'success');
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setSavingReplication(false);
    }
  }

  async function deleteDatabase() {
    setDeleting(true);
    try {
      const res = await fetch(apiBase, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(body?.error ?? t(locale, 'common.requestFailed'), 'error');
        setDeleting(false);
        return;
      }
      // 删除成功直接回列表页(当前详情页对应的资源已不存在)
      window.location.href = localizePath(locale, '/d1');
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
      setDeleting(false);
    }
  }

  if (loading) return <div className="skeleton h-48 w-full" />;
  if (loadError || !detail)
    return (
      <div className="alert alert-error flex items-center gap-3">
        <span className="text-sm">{t(locale, 'common.requestFailed')}</span>
        <button className="btn btn-ghost btn-sm" onClick={() => void reload()}>
          {t(locale, 'common.retry')}
        </button>
      </div>
    );

  const rows: [string, string][] = [
    [t(locale, 'd1.settingsUuid'), detail.uuid],
    [t(locale, 'd1.settingsVersion'), detail.version ?? '—'],
    [t(locale, 'd1.settingsSize'), formatBytes(detail.file_size)],
    [t(locale, 'd1.settingsTables'), detail.num_tables === null ? '—' : String(detail.num_tables)],
    [t(locale, 'd1.settingsCreated'), detail.created_at ?? '—'],
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto rounded-box border border-base-300">
        <table className="table table-sm">
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label}>
                <td className="whitespace-nowrap opacity-60">{label}</td>
                <td className="min-w-0 break-all font-mono text-xs">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3 rounded-box border border-base-300 p-3">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-sm">{t(locale, 'd1.settingsReplication')}</p>
          <p className="text-xs opacity-60">{t(locale, 'd1.replicationDesc')}</p>
        </div>
        {savingReplication && <span className="loading loading-spinner loading-xs shrink-0" />}
        <input
          type="checkbox"
          className="toggle toggle-primary shrink-0"
          checked={detail.read_replication_mode === 'auto'}
          disabled={savingReplication}
          onChange={(e) => void toggleReplication(e.target.checked ? 'auto' : 'disabled')}
        />
      </div>

      <div className="rounded-box border border-error/40 p-3">
        <p className="font-semibold text-error text-sm">{t(locale, 'd1.dangerZone')}</p>
        <p className="mt-1 text-xs opacity-60">{t(locale, 'd1.deleteDbDesc')}</p>
        <button className="btn btn-error btn-sm mt-3 whitespace-nowrap" onClick={() => setShowDelete(true)}>
          {t(locale, 'd1.delete')}
        </button>
      </div>

      {showDelete && (
        <DeleteDatabaseModal
          locale={locale}
          name={dbName ?? detail.name}
          deleting={deleting}
          onCancel={() => setShowDelete(false)}
          onConfirm={() => void deleteDatabase()}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Astro 详情页**

`src/pages/d1/[accountId]/[databaseId].astro` 全文:

```astro
---
import MainLayout from '@/layouts/MainLayout.astro';
import D1DatabaseDetailPanel from '@/components/d1/D1DatabaseDetailPanel';
import { t } from '@/i18n';
import { localeFromPath, localizePath } from '@/i18n/routing';
const { accountId, databaseId } = Astro.params;
const locale = localeFromPath(Astro.url.pathname);
const initialTab = Astro.url.searchParams.get('tab');
// 列表页链接带 ?name=,面包屑/标题即时显示库名;直链缺省时回退 uuid
const dbName = Astro.url.searchParams.get('name');
---
<MainLayout title={`${t(locale, 'd1.dbDetailTitle')} · ${dbName ?? databaseId}`} locale={locale}>
  <nav class="breadcrumbs mb-4 text-sm">
    <ul>
      <li><a href={localizePath(locale, '/d1')}>{t(locale, 'nav.d1')}</a></li>
      <li class="font-mono">{dbName ?? databaseId}</li>
    </ul>
  </nav>
  <D1DatabaseDetailPanel
    accountId={accountId!}
    databaseId={databaseId!}
    dbName={dbName}
    locale={locale}
    initialTab={initialTab}
    client:load
  />
</MainLayout>
```

`src/pages/en/d1/[accountId]/[databaseId].astro`:内容与上文完全相同。

- [ ] **Step 6: 手动验证**

Run: `npm run dev`。
Expected: 列表页点详情 → 表 Tab 默认展示表清单(行数/列结构展开);点「浏览数据」跳查询 Tab 并出结果、上一页/下一页可用;查询 Tab 手输 `SELECT 1` 直接执行、输 `DELETE FROM x` 弹确认;SQL 语法错误显示在结果区(红色 alert);设置 Tab 信息/读复制开关/输名删除可用,删除后回列表;`?tab=` 直链生效。

- [ ] **Step 7: 门禁 + 提交**

```bash
npm run check && npm run typecheck && npm run test
git add src/components/d1 "src/pages/d1/[accountId]" "src/pages/en/d1/[accountId]"
git commit -m "feat(d1): 详情页(表浏览/SQL 查询控制台/设置)"
```

---

### Task 8: 收尾验证(全量门禁 + workerd + 移动端验收)

**Files:** 无新文件;只验证与必要修补。

- [ ] **Step 1: 全量门禁**

```bash
npm run check:ci && npm run typecheck && npm run test
```
Expected: 三者全部通过,无未提交的 Biome 修改。

- [ ] **Step 2: 真实构建 + workerd 验证**

```bash
npm run build && npm run preview
```
Expected: 构建成功;`wrangler pages dev ./dist` 下打开 `/d1` 走完手工链路——创建库 → 列表出现 → 详情建表(查询 Tab 执行 `CREATE TABLE demo (id INTEGER PRIMARY KEY, name TEXT)`,弹写确认)→ 表 Tab 可见 demo → 插入数据 → 点表名浏览 → 读复制开关 → 删除库(输名确认)→ 列表消失。Node 单测覆盖不到的 workerd fetch/this 绑定问题在这一步暴露。

- [ ] **Step 3: 移动端验收(规则 12)**

500px 视口逐页检查 `/d1`、详情页三个 Tab,浏览器 console 执行:

```js
document.scrollingElement.scrollWidth === window.innerWidth
```
Expected: 全部 `true`(零整页横滚;查询结果宽表在自己的 `overflow-x-auto` 容器内横滚)。1440px 桌面回归无视觉异常。

- [ ] **Step 4: 提交收尾修补(如有)**

```bash
git add -A && git commit -m "fix(d1): 验收修补"
```
仅在 Step 1-3 发现问题修补后需要;无修补则跳过。
