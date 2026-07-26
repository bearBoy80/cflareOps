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
      const url = new URL(String(input));
      if (!seenUrl) seenUrl = String(input);
      // V4PagePaginationArray:迭代在某页返回 0 条时终止(同 cf-client.test.ts listZones 用例)
      const page = Number(url.searchParams.get('page') ?? '1');
      const result =
        page === 1
          ? [
              {
                uuid: 'u1',
                name: 'db-one',
                version: 'production',
                created_at: '2026-01-01T00:00:00Z',
                num_tables: 4,
                file_size: 2048,
              },
              { uuid: 'u2', name: 'db-two' }, // 最小字段:num_tables/file_size 缺失 → null
            ]
          : [];
      return jsonResponse(envelope(result, { page, per_page: 100, count: result.length, total_count: 2 }));
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
            results: {
              columns: ['id', 'name'],
              rows: [
                [1, 'a'],
                [2, 'b'],
              ],
            },
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
    expect(results[0].rows).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(results[0].meta).toEqual({ duration: 0.5, changes: 0, changed_db: false, rows_read: 2, rows_written: 0 });
  });

  it('queryD1Raw forwards bind params in the request body', async () => {
    let seenBody = '';
    const fetchImpl: typeof fetch = async (_input, init) => {
      seenBody = String(init?.body ?? '');
      return jsonResponse(envelope([{ success: true, results: { columns: ['a'], rows: [['x']] }, meta: {} }]));
    };
    await new CfClient('tok', fetchImpl).queryD1Raw('cf-1', 'u1', 'SELECT * FROM t WHERE a = ?', ['x']);
    // params 丢失/改名会让控制台的参数化查询静默绑定不上——锁死请求体形状
    expect(JSON.parse(seenBody)).toEqual({ sql: 'SELECT * FROM t WHERE a = ?', params: ['x'] });
  });

  it('queryD1Raw surfaces SQL errors as CfApiError with the CF message', async () => {
    const failing: typeof fetch = async () =>
      jsonResponse(
        { success: false, errors: [{ code: 7500, message: 'near "SELEC": syntax error at offset 0' }], result: null },
        400,
      );
    await expect(new CfClient('tok', failing).queryD1Raw('cf-1', 'u1', 'SELEC 1')).rejects.toThrowError(/syntax error/);
  });
});
