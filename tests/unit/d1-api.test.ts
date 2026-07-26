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

  it('400s on a malformed cfAccountId before touching CF (path-splice guard)', async () => {
    const db = createTestDb();
    await seed(db);
    const res = await databasesPost(
      ctx(db, 'http://localhost/api/d1/databases', {
        method: 'POST',
        body: JSON.stringify({ accountId: 'a1', cfAccountId: 'x/d1/database/../../../zones', name: 'ok-name' }),
      }),
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

  it('400s when params contains a non-string element', async () => {
    const db = createTestDb();
    await seed(db);
    const res = await queryPost(
      ctx(
        db,
        'http://localhost/api/d1/a1/u1/query',
        { method: 'POST', body: JSON.stringify({ sql: 'SELECT 1', params: [1] }) },
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

describe('PATCH /api/d1/:accountId/:databaseId cache consistency', () => {
  it('updates the flat column, raw_json and synced_at together on success', async () => {
    const db = createTestDb();
    await seed(db);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: { uuid: 'u1', name: 'db-one', read_replication: { mode: 'auto' } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;
    try {
      const res = await dbPatch(
        ctx(
          db,
          'http://localhost/api/d1/a1/u1',
          { method: 'PATCH', body: JSON.stringify({ mode: 'auto' }) },
          { accountId: 'a1', databaseId: 'u1' },
        ),
      );
      expect(res.status).toBe(200);
      const row = await db
        .prepare('SELECT read_replication_mode, raw_json, synced_at FROM d1_databases WHERE uuid = ?')
        .bind('u1')
        .first<{ read_replication_mode: string; raw_json: string; synced_at: string }>();
      expect(row?.read_replication_mode).toBe('auto');
      // raw_json 与平铺列必须同步,否则缓存行自相矛盾
      expect((JSON.parse(row!.raw_json) as { read_replication?: { mode?: string } }).read_replication?.mode).toBe(
        'auto',
      );
      expect(row?.synced_at).not.toBe('2026-07-22T00:00:00Z');
    } finally {
      globalThis.fetch = origFetch;
    }
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

  it('purges the cached row even when CF says the database is already gone (404)', async () => {
    const db = createTestDb();
    await seed(db);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ success: false, errors: [{ code: 7404, message: 'not found' }], messages: [], result: null }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;
    try {
      const res = await dbDelete(
        ctx(db, 'http://localhost/api/d1/a1/u1', { method: 'DELETE' }, { accountId: 'a1', databaseId: 'u1' }),
      );
      // 远端已不存在也要清缓存返回成功,否则该行卡死:重试永远 404,只有全量同步能救
      expect(res.status).toBe(200);
      const row = await db.prepare('SELECT COUNT(*) AS c FROM d1_databases').first<{ c: number }>();
      expect(row?.c).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('GET /api/d1/:accountId/:databaseId/tables', () => {
  it('pairs PRAGMA/COUNT result sets with the right tables', async () => {
    const db = createTestDb();
    await seed(db);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const sql = String((JSON.parse(String(init?.body ?? '{}')) as { sql?: string }).sql ?? '');
      const pragmaCols = ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'];
      // 第一轮:sqlite_master 表名列表;第二轮:每表 PRAGMA+COUNT 各一个结果集,顺序与语句一致
      const result = sql.includes('sqlite_master')
        ? [{ success: true, results: { columns: ['name'], rows: [['logs'], ['users']] }, meta: {} }]
        : [
            { success: true, results: { columns: pragmaCols, rows: [[0, 'msg', 'TEXT', 0, null, 0]] }, meta: {} },
            { success: true, results: { columns: ['COUNT(*)'], rows: [[7]] }, meta: {} },
            { success: true, results: { columns: pragmaCols, rows: [[0, 'id', 'INTEGER', 1, null, 1]] }, meta: {} },
            { success: true, results: { columns: ['COUNT(*)'], rows: [[42]] }, meta: {} },
          ];
      return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const res = await tablesGet(
        ctx(db, 'http://localhost/api/d1/a1/u1/tables', undefined, { accountId: 'a1', databaseId: 'u1' }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        tables: {
          name: string;
          rowCount: number;
          columns: { name: string; type: string; notnull: boolean; pk: boolean }[];
        }[];
        truncated: boolean;
      };
      expect(body.truncated).toBe(false);
      expect(body.tables).toHaveLength(2);
      // 配对错位(i*2 偏移出错)会让行数/列结构串到相邻表上——两表用不同行数和列名锁死
      expect(body.tables[0]).toMatchObject({ name: 'logs', rowCount: 7 });
      expect(body.tables[0].columns[0]).toMatchObject({ name: 'msg', type: 'TEXT', notnull: false, pk: false });
      expect(body.tables[1]).toMatchObject({ name: 'users', rowCount: 42 });
      expect(body.tables[1].columns[0]).toMatchObject({ name: 'id', type: 'INTEGER', notnull: true, pk: true });
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
