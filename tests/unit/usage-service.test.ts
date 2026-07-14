import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import type { CfAccount, CfPagesProject, CfWorkerScript } from '@/server/cf/types';
import { encryptSecret, importEncryptionKey } from '@/server/crypto';
import { insertAccount } from '@/server/db/accounts';
import {
  ensureUsageHourlySnapshots,
  ensureUsageSnapshots,
  queryUsageDaily,
  queryUsageHourly,
  targetDays,
  targetHours,
  usageSeries,
} from '@/server/usage';
import { syncWorkersPages } from '@/server/workersPages';

const HEX_KEY = 'b'.repeat(64);
const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';

// targetDays 的基准时刻：2026-07-07 12:00 UTC → 昨天 = 2026-07-06
const NOW = new Date('2026-07-07T12:00:00Z');

async function seed(db: ReturnType<typeof createTestDb>, ownerEmail = ALICE, id = 'a1') {
  const key = await importEncryptionKey(HEX_KEY);
  await insertAccount(db, {
    id,
    ownerEmail,
    name: `acct-${id}`,
    tokenEncrypted: await encryptSecret(`tok-${id}`, key),
    tokenHash: `hash-${id}`,
  });
  // pages_projects 缓存种子：raw_json 携带 production_script_name（psn 映射来源）
  await syncWorkersPages(db, key, ownerEmail, () => ({
    listAccounts: async () => [{ id: 'cf-1', name: 'CF One' }] as CfAccount[],
    listWorkersScripts: async () => [] as CfWorkerScript[],
    listPagesProjects: async () =>
      [
        {
          name: 'proj-a',
          raw: { production_script_name: 'pages-worker--111-production' },
        },
      ] as unknown as CfPagesProject[],
  }));
}

/** fake UsageClient：记录调用并返回给定日行 */
function fakeUsageClient(
  workerRows: { date: string; scriptName: string; requests: number; errors: number }[],
  pagesRows: { date: string; scriptName: string; requests: number }[] = [],
  calls: { since: string; until: string }[] = [],
) {
  return {
    listAccounts: async () => [{ id: 'cf-1', name: 'CF One' }],
    queryWorkersInvocationsDaily: async (_a: string, since: string, until: string) => {
      calls.push({ since, until });
      return workerRows;
    },
    queryPagesFunctionsInvocationsDaily: async () => pagesRows,
  };
}

describe('targetDays', () => {
  it('returns N full UTC days ascending, ending yesterday', () => {
    expect(targetDays(3, NOW)).toEqual(['2026-07-04', '2026-07-05', '2026-07-06']);
  });
});

describe('ensureUsageSnapshots', () => {
  it('backfills all missing days and never persists today', async () => {
    const db = createTestDb();
    await seed(db);
    const rows = [
      { date: '2026-07-05', scriptName: 'w1', requests: 10, errors: 1 },
      { date: '2026-07-06', scriptName: 'w1', requests: 20, errors: 0 },
      { date: '2026-07-07', scriptName: 'w1', requests: 5, errors: 0 }, // 今天：必须被丢弃
    ];
    const { failures } = await ensureUsageSnapshots(db, ALICE, 3, async () => fakeUsageClient(rows), NOW);
    expect(failures).toEqual([]);
    const { results } = await db
      .prepare(`SELECT day, requests FROM usage_daily WHERE kind='worker' ORDER BY day`)
      .all<{ day: string; requests: number }>();
    expect(results).toEqual([
      { day: '2026-07-05', requests: 10 },
      { day: '2026-07-06', requests: 20 },
    ]);
  });

  it('only backfills missing days (existing days skipped, query window shrinks)', async () => {
    const db = createTestDb();
    await seed(db);
    await db
      .prepare(
        `INSERT INTO usage_daily (day, kind, account_id, cf_account_id, name, requests, errors, synced_at)
         VALUES ('2026-07-06', 'worker', 'a1', 'cf-1', 'w1', 99, 0, 'x')`,
      )
      .run();
    const calls: { since: string; until: string }[] = [];
    await ensureUsageSnapshots(
      db,
      ALICE,
      2,
      async () => fakeUsageClient([{ date: '2026-07-05', scriptName: 'w1', requests: 7, errors: 0 }], [], calls),
      NOW,
    );
    // 只缺 07-05：窗口 = [07-05T00:00Z, 07-06T00:00Z)
    expect(calls).toEqual([{ since: '2026-07-05T00:00:00Z', until: '2026-07-06T00:00:00Z' }]);
    const row = await db
      .prepare(`SELECT requests FROM usage_daily WHERE day='2026-07-06' AND name='w1'`)
      .first<{ requests: number }>();
    expect(row?.requests).toBe(99); // 已有天未被覆盖
  });

  it('maps pages rows via production_script_name and drops unmatched', async () => {
    const db = createTestDb();
    await seed(db);
    await ensureUsageSnapshots(
      db,
      ALICE,
      1,
      async () =>
        fakeUsageClient(
          [],
          [
            { date: '2026-07-06', scriptName: 'pages-worker--111-production', requests: 42 },
            { date: '2026-07-06', scriptName: 'pages-worker--999-production', requests: 7 },
          ],
        ),
      NOW,
    );
    const { results } = await db
      .prepare(`SELECT name, requests FROM usage_daily WHERE kind='pages'`)
      .all<{ name: string; requests: number }>();
    expect(results).toEqual([{ name: 'proj-a', requests: 42 }]);
  });

  it('backfills a newly added account even when another account already has those days', async () => {
    const db = createTestDb();
    await seed(db, ALICE, 'a1');
    await seed(db, ALICE, 'a2');
    // a1 已有昨天
    await db
      .prepare(
        `INSERT INTO usage_daily (day, kind, account_id, cf_account_id, name, requests, errors, synced_at)
         VALUES ('2026-07-06', 'worker', 'a1', 'cf-1', 'w1', 1, 0, 'x')`,
      )
      .run();
    const a2Calls: { since: string; until: string }[] = [];
    await ensureUsageSnapshots(
      db,
      ALICE,
      1,
      async (accountId) =>
        accountId === 'a2'
          ? fakeUsageClient([{ date: '2026-07-06', scriptName: 'w2', requests: 3, errors: 0 }], [], a2Calls)
          : fakeUsageClient([]),
      NOW,
    );
    expect(a2Calls).toHaveLength(1); // a2 的缺失天不被 a1 的已有天遮蔽
  });

  it('a failing account degrades into failures without blocking others', async () => {
    const db = createTestDb();
    await seed(db, ALICE, 'a1');
    await seed(db, ALICE, 'a2');
    const { failures } = await ensureUsageSnapshots(
      db,
      ALICE,
      1,
      async (accountId) => {
        if (accountId === 'a1') throw new Error('token dead');
        return fakeUsageClient([{ date: '2026-07-06', scriptName: 'w2', requests: 3, errors: 0 }]);
      },
      NOW,
    );
    expect(failures).toEqual([{ accountId: 'a1', error: 'token dead' }]);
    const cnt = await db.prepare(`SELECT COUNT(*) AS c FROM usage_daily WHERE account_id='a2'`).first<{ c: number }>();
    expect(cnt?.c).toBe(1);
  });

  it('account-chunk atomicity: a bad row rolls back the whole account chunk; a second account is unaffected', async () => {
    // Two missing days for a1: day1 has one valid + one schema-violating row; day2 has a valid row.
    // Both days are in the same chunk (well under 500 statements) → the whole batch rolls back →
    // a1 has ZERO rows on BOTH days.  a2 (clean data) is processed in its own chunk and commits.
    const db = createTestDb();
    await seed(db, ALICE, 'a1');
    await seed(db, ALICE, 'a2');

    // Use NOW baseline: target(2, NOW) = ['2026-07-05', '2026-07-06']
    const workerRows = [
      { date: '2026-07-05', scriptName: 'good', requests: 10, errors: 0 },
      // null violates requests INTEGER NOT NULL → batch throws → entire a1 chunk rolls back
      { date: '2026-07-05', scriptName: 'bad', requests: null as unknown as number, errors: 0 },
      { date: '2026-07-06', scriptName: 'ok', requests: 5, errors: 0 },
    ];

    const { failures } = await ensureUsageSnapshots(
      db,
      ALICE,
      2,
      async (accountId) =>
        accountId === 'a1'
          ? fakeUsageClient(workerRows)
          : fakeUsageClient([{ date: '2026-07-06', scriptName: 'w2', requests: 3, errors: 0 }]),
      NOW,
    );

    // a1 must appear in failures (chunk batch error)
    expect(failures.some((f) => f.accountId === 'a1')).toBe(true);

    // Chunk atomicity pin: a1 has ZERO rows on BOTH days (entire chunk rolled back)
    const a1Day1 = await db
      .prepare(`SELECT COUNT(*) AS c FROM usage_daily WHERE account_id='a1' AND day='2026-07-05'`)
      .first<{ c: number }>();
    expect(a1Day1?.c).toBe(0);

    const a1Day2 = await db
      .prepare(`SELECT COUNT(*) AS c FROM usage_daily WHERE account_id='a1' AND day='2026-07-06'`)
      .first<{ c: number }>();
    expect(a1Day2?.c).toBe(0);

    // a2 is unaffected: its chunk committed independently
    const a2Count = await db
      .prepare(`SELECT COUNT(*) AS c FROM usage_daily WHERE account_id='a2'`)
      .first<{ c: number }>();
    expect(a2Count?.c).toBe(1);
  });
});

// 基准 2026-07-07T12:30:00Z → 当前整点 12:00（进行中，排除）；最近已完成整点末位 = 11:00
const HNOW = new Date('2026-07-07T12:30:00Z');

function fakeHourlyClient(
  workerRows: { bucket: string; scriptName: string; requests: number; errors: number }[],
  pagesRows: { bucket: string; scriptName: string; requests: number }[] = [],
  calls: { since: string; until: string }[] = [],
) {
  return {
    listAccounts: async () => [{ id: 'cf-1', name: 'CF One' }],
    queryWorkersInvocationsHourly: async (_a: string, since: string, until: string) => {
      calls.push({ since, until });
      return workerRows;
    },
    queryPagesFunctionsInvocationsHourly: async () => pagesRows,
  };
}

describe('targetHours', () => {
  it('returns 24 completed UTC hours ascending, excluding the in-progress hour', () => {
    const hrs = targetHours(HNOW);
    expect(hrs).toHaveLength(24);
    expect(hrs[hrs.length - 1]).toBe('2026-07-07T11:00:00Z'); // 末位 = 上一个完整整点
    expect(hrs[0]).toBe('2026-07-06T12:00:00Z'); // 24 小时前
    expect(hrs.includes('2026-07-07T12:00:00Z')).toBe(false); // 当前进行中整点被排除
  });
});

describe('ensureUsageHourlySnapshots', () => {
  it('backfills missing completed hours and never persists the in-progress hour', async () => {
    const db = createTestDb();
    await seed(db); // ALICE + a1 + pages_projects 缓存（psn 映射）
    const rows = [
      { bucket: '2026-07-07T10:00:00Z', scriptName: 'w1', requests: 5, errors: 0 },
      { bucket: '2026-07-07T11:00:00Z', scriptName: 'w1', requests: 7, errors: 1 },
      { bucket: '2026-07-07T12:00:00Z', scriptName: 'w1', requests: 3, errors: 0 }, // 进行中：必被丢弃
    ];
    const { failures } = await ensureUsageHourlySnapshots(db, ALICE, async () => fakeHourlyClient(rows), HNOW);
    expect(failures).toEqual([]);
    const { results } = await db
      .prepare(`SELECT hour, requests FROM usage_hourly WHERE kind='worker' ORDER BY hour`)
      .all<{ hour: string; requests: number }>();
    expect(results).toEqual([
      { hour: '2026-07-07T10:00:00Z', requests: 5 },
      { hour: '2026-07-07T11:00:00Z', requests: 7 },
    ]);
  });

  it('amortized cleanup deletes rows older than 25h in the same backfill', async () => {
    const db = createTestDb();
    await seed(db);
    // 预置一条 26 小时前的老行（应被清）+ 一条 2 小时前的行（应保留）
    await db
      .prepare(
        `INSERT INTO usage_hourly (hour, kind, account_id, cf_account_id, name, requests, errors, synced_at)
         VALUES ('2026-07-06T10:00:00Z', 'worker', 'a1', 'cf-1', 'old', 1, 0, 'x')`,
      )
      .run();
    await ensureUsageHourlySnapshots(
      db,
      ALICE,
      async () => fakeHourlyClient([{ bucket: '2026-07-07T11:00:00Z', scriptName: 'w1', requests: 9, errors: 0 }]),
      HNOW,
    );
    const old = await db
      .prepare(`SELECT COUNT(*) AS c FROM usage_hourly WHERE hour='2026-07-06T10:00:00Z'`)
      .first<{ c: number }>();
    expect(old?.c).toBe(0); // 26h 前的行已清
    const fresh = await db
      .prepare(`SELECT COUNT(*) AS c FROM usage_hourly WHERE hour='2026-07-07T11:00:00Z'`)
      .first<{ c: number }>();
    expect(fresh?.c).toBe(1);
  });

  it('maps pages hourly rows via production_script_name and drops unmatched', async () => {
    const db = createTestDb();
    await seed(db); // seed 的 pages_projects raw_json 携带 production_script_name = 'pages-worker--111-production'
    await ensureUsageHourlySnapshots(
      db,
      ALICE,
      async () =>
        fakeHourlyClient(
          [],
          [
            { bucket: '2026-07-07T11:00:00Z', scriptName: 'pages-worker--111-production', requests: 42 },
            { bucket: '2026-07-07T11:00:00Z', scriptName: 'pages-worker--999-production', requests: 7 },
          ],
        ),
      HNOW,
    );
    const { results } = await db
      .prepare(`SELECT name, requests FROM usage_hourly WHERE kind='pages'`)
      .all<{ name: string; requests: number }>();
    expect(results).toEqual([{ name: 'proj-a', requests: 42 }]);
  });

  it('marks fetched hours as covered so zero-traffic hours are not re-queried on revisit', async () => {
    const db = createTestDb();
    await seed(db);
    let workerFetches = 0;
    // 全零流量：worker/pages 均空——若无覆盖标记，usage_hourly 无行，每次访问都会重抓
    const clientFor = async () => ({
      listAccounts: async () => [{ id: 'cf-1', name: 'CF One' }],
      queryWorkersInvocationsHourly: async () => {
        workerFetches++;
        return [];
      },
      queryPagesFunctionsInvocationsHourly: async () => [],
    });
    await ensureUsageHourlySnapshots(db, ALICE, clientFor, HNOW);
    expect(workerFetches).toBe(1); // 首访：24 桶全缺 → 抓一次
    // 覆盖表应记满 24 个已完成整点（含零流量）
    const covered = await db
      .prepare(`SELECT COUNT(*) AS c FROM usage_hourly_covered WHERE account_id='a1'`)
      .first<{ c: number }>();
    expect(covered?.c).toBe(24);
    // 二访（同一小时）：全部已覆盖 → 不再 fan-out CF
    await ensureUsageHourlySnapshots(db, ALICE, clientFor, HNOW);
    expect(workerFetches).toBe(1);
  });

  it('amortized cleanup also prunes covered markers older than 25h', async () => {
    const db = createTestDb();
    await seed(db);
    await db
      .prepare(
        `INSERT INTO usage_hourly_covered (account_id, hour, synced_at)
         VALUES ('a1', '2026-07-06T10:00:00Z', 'x')`,
      )
      .run();
    await ensureUsageHourlySnapshots(
      db,
      ALICE,
      async () => fakeHourlyClient([{ bucket: '2026-07-07T11:00:00Z', scriptName: 'w1', requests: 9, errors: 0 }]),
      HNOW,
    );
    const old = await db
      .prepare(`SELECT COUNT(*) AS c FROM usage_hourly_covered WHERE hour='2026-07-06T10:00:00Z'`)
      .first<{ c: number }>();
    expect(old?.c).toBe(0); // 26h 前的覆盖标记随数据一并清理
  });

  it('failed CF fetch does not mark hours as covered (coverage written only on success)', async () => {
    // Safety-critical invariant: a coverage marker must only be written when the CF fetch
    // succeeded.  If queryWorkersInvocationsHourly throws, the per-account try/catch catches
    // it before the coverage-write loop is reached — so no hour is falsely "covered".
    const db = createTestDb();
    await seed(db); // ALICE + a1
    const clientFor = async () => ({
      listAccounts: async () => [{ id: 'cf-1', name: 'CF One' }],
      queryWorkersInvocationsHourly: async (): Promise<never> => {
        throw new Error('cf boom');
      },
      queryPagesFunctionsInvocationsHourly: async () => [],
    });
    const { failures } = await ensureUsageHourlySnapshots(db, ALICE, clientFor, HNOW);
    // No coverage rows must exist — the hour must NOT be falsely marked covered
    const covered = await db
      .prepare(`SELECT COUNT(*) AS c FROM usage_hourly_covered WHERE account_id='a1'`)
      .first<{ c: number }>();
    expect(covered?.c).toBe(0);
    // The failing account must appear in failures
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures.some((f) => f.accountId === 'a1')).toBe(true);
  });
});

describe('queryUsageDaily', () => {
  async function seedRows(db: ReturnType<typeof createTestDb>) {
    await seed(db);
    const ins = (day: string, name: string, req: number, err = 0) =>
      db
        .prepare(
          `INSERT INTO usage_daily (day, kind, account_id, cf_account_id, name, requests, errors, synced_at)
           VALUES (?, 'worker', 'a1', 'cf-1', ?, ?, ?, 'x')`,
        )
        .bind(day, name, req, err)
        .run();
    await ins('2026-07-05', 'alpha', 10, 2);
    await ins('2026-07-06', 'alpha', 5, 1);
    await ins('2026-07-06', 'beta_x', 100);
    await ins('2026-06-01', 'alpha', 999); // 窗口外
  }

  it('aggregates across days within the window and sorts by requests desc', async () => {
    const db = createTestDb();
    await seedRows(db);
    const { rows, total, sinceDay, untilDay } = await queryUsageDaily(db, ALICE, {
      kind: 'worker',
      days: 7,
      page: 1,
      pageSize: 20,
      now: NOW,
    });
    expect({ sinceDay, untilDay }).toEqual({ sinceDay: '2026-06-30', untilDay: '2026-07-06' });
    expect(total).toBe(2);
    expect(rows.map((r) => [r.name, r.requests, r.errors])).toEqual([
      ['beta_x', 100, 0],
      ['alpha', 15, 3],
    ]);
    expect(rows[0].accountName).toBe('acct-a1');
  });

  it('paginates and filters by escaped LIKE search', async () => {
    const db = createTestDb();
    await seedRows(db);
    const page2 = await queryUsageDaily(db, ALICE, { kind: 'worker', days: 7, page: 2, pageSize: 1, now: NOW });
    expect(page2.total).toBe(2);
    expect(page2.rows.map((r) => r.name)).toEqual(['alpha']);
    // '_' 字面匹配（beta_x 而非任意字符）
    const search = await queryUsageDaily(db, ALICE, {
      kind: 'worker',
      days: 7,
      search: 'a_x',
      page: 1,
      pageSize: 20,
      now: NOW,
    });
    expect(search.rows.map((r) => r.name)).toEqual(['beta_x']);
  });

  it('filters by accountId and isolates owners', async () => {
    const db = createTestDb();
    await seedRows(db);
    const other = await queryUsageDaily(db, ALICE, {
      kind: 'worker',
      days: 7,
      accountId: 'nope',
      page: 1,
      pageSize: 20,
      now: NOW,
    });
    expect(other.total).toBe(0);
    const bob = await queryUsageDaily(db, BOB, { kind: 'worker', days: 7, page: 1, pageSize: 20, now: NOW });
    expect(bob.total).toBe(0);
  });
});

describe('queryUsageHourly', () => {
  it('aggregates across the rolling 24h window, sorts by requests desc', async () => {
    const db = createTestDb();
    await seed(db);
    const ins = (hour: string, name: string, req: number, err = 0) =>
      db
        .prepare(
          `INSERT INTO usage_hourly (hour, kind, account_id, cf_account_id, name, requests, errors, synced_at)
           VALUES (?, 'worker', 'a1', 'cf-1', ?, ?, ?, 'x')`,
        )
        .bind(hour, name, req, err)
        .run();
    await ins('2026-07-07T10:00:00Z', 'alpha', 10, 1);
    await ins('2026-07-07T11:00:00Z', 'alpha', 5, 0);
    await ins('2026-07-07T11:00:00Z', 'beta', 100);
    await ins('2026-07-05T00:00:00Z', 'alpha', 999); // 窗口外
    const { rows, total } = await queryUsageHourly(db, ALICE, {
      kind: 'worker',
      page: 1,
      pageSize: 20,
      now: HNOW,
    });
    expect(total).toBe(2);
    expect(rows.map((r) => [r.name, r.requests, r.errors])).toEqual([
      ['beta', 100, 0],
      ['alpha', 15, 1],
    ]);
  });

  it('todayRequests sums only buckets at/after todayStart; window requests unaffected', async () => {
    const db = createTestDb();
    await seed(db);
    const ins = (hour: string, name: string, req: number) =>
      db
        .prepare(
          `INSERT INTO usage_hourly (hour, kind, account_id, cf_account_id, name, requests, errors, synced_at)
           VALUES (?, 'worker', 'a1', 'cf-1', ?, ?, 0, 'x')`,
        )
        .bind(hour, name, req)
        .run();
    await ins('2026-07-06T20:00:00Z', 'alpha', 7); // 窗口内、todayStart 之前 → 不计今日
    await ins('2026-07-07T10:00:00Z', 'alpha', 10);
    await ins('2026-07-07T11:00:00Z', 'alpha', 5);
    await ins('2026-07-07T11:00:00Z', 'beta', 100);
    const { rows } = await queryUsageHourly(db, ALICE, {
      kind: 'worker',
      page: 1,
      pageSize: 20,
      now: HNOW,
      todayStart: '2026-07-07T00:00:00Z',
    });
    expect(rows.map((r) => [r.name, r.requests, r.todayRequests])).toEqual([
      ['beta', 100, 100],
      ['alpha', 22, 15],
    ]);
  });

  it('todayRequests is 0 when todayStart is omitted', async () => {
    const db = createTestDb();
    await seed(db);
    await db
      .prepare(
        `INSERT INTO usage_hourly (hour, kind, account_id, cf_account_id, name, requests, errors, synced_at)
         VALUES ('2026-07-07T11:00:00Z', 'worker', 'a1', 'cf-1', 'alpha', 42, 0, 'x')`,
      )
      .run();
    const { rows } = await queryUsageHourly(db, ALICE, {
      kind: 'worker',
      page: 1,
      pageSize: 20,
      now: HNOW,
    });
    expect(rows.map((r) => [r.name, r.requests, r.todayRequests])).toEqual([['alpha', 42, 0]]);
  });
});

describe('usageSeries', () => {
  it('zero-fills missing hourly buckets across the 24h window', async () => {
    const db = createTestDb();
    await seed(db);
    await db
      .prepare(
        `INSERT INTO usage_hourly (hour, kind, account_id, cf_account_id, name, requests, errors, synced_at)
         VALUES ('2026-07-07T11:00:00Z', 'worker', 'a1', 'cf-1', 'alpha', 42, 3, 'x')`,
      )
      .run();
    const series = await usageSeries(db, ALICE, { kind: 'worker', range: '24h', now: HNOW });
    expect(series).toHaveLength(24); // 完整 24 桶
    const bucketMap = new Map(series.map((s) => [s.bucket, s]));
    expect(bucketMap.get('2026-07-07T11:00:00Z')).toEqual({
      bucket: '2026-07-07T11:00:00Z',
      requests: 42,
      errors: 3,
    });
    // 无数据的整点补 0
    expect(bucketMap.get('2026-07-07T10:00:00Z')).toEqual({
      bucket: '2026-07-07T10:00:00Z',
      requests: 0,
      errors: 0,
    });
  });

  it('zero-fills daily buckets for 7d', async () => {
    const db = createTestDb();
    await seed(db);
    await db
      .prepare(
        `INSERT INTO usage_daily (day, kind, account_id, cf_account_id, name, requests, errors, synced_at)
         VALUES ('2026-07-06', 'worker', 'a1', 'cf-1', 'alpha', 20, 0, 'x')`,
      )
      .run();
    const series = await usageSeries(db, ALICE, { kind: 'worker', range: '7d', now: HNOW });
    expect(series).toHaveLength(7);
    expect(series.find((s) => s.bucket === '2026-07-06')?.requests).toBe(20);
    expect(series.filter((s) => s.requests === 0)).toHaveLength(6);
  });
});
