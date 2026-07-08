import pLimit from 'p-limit';
import type { CfClient } from './cf/client';
import { listAccounts } from './db/accounts';
import type { Db, DbStatement } from './db/types';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
// 账号回填有界并发（对齐 sync 路径 workersPages.ts）——避免几十账号同时 fan-out CF
const CONCURRENCY = 3;

export type UsageClient = Pick<
  CfClient,
  'listAccounts' | 'queryWorkersInvocationsDaily' | 'queryPagesFunctionsInvocationsDaily'
>;

/** 最近 days 个完整 UTC 自然日（升序，末位=昨天） */
export function targetDays(days: number, now: Date = new Date()): string[] {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: string[] = [];
  for (let i = days; i >= 1; i--) {
    out.push(new Date(todayUtc - i * DAY_MS).toISOString().slice(0, 10));
  }
  return out;
}

/** 最近 24 个已完成 UTC 整点（升序，末位=上一个完整整点，排除当前进行中整点） */
export function targetHours(now: Date = new Date()): string[] {
  const curHourStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours());
  const out: string[] = [];
  for (let i = 24; i >= 1; i--) {
    out.push(new Date(curHourStart - i * HOUR_MS).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  }
  return out;
}

/** production_script_name → 项目名（owner 过滤；与 invocations 路由同源 SQL） */
async function buildPsnMap(db: Db, ownerEmail: string): Promise<Map<string, string>> {
  const { results } = await db
    .prepare(
      `SELECT p.name, p.cf_account_id,
              json_extract(p.raw_json, '$.production_script_name') AS psn
       FROM pages_projects p JOIN cf_accounts a ON a.id = p.account_id
       WHERE a.owner_email = ?`,
    )
    .bind(ownerEmail)
    .all<{ name: string; cf_account_id: string; psn: string | null }>();
  return new Map(results.filter((r) => r.psn).map((r) => [`${r.cf_account_id}/${r.psn}`, r.name]));
}

/** 按账号绑定的回填数据源：CF 账号列表 + 已归一为 bucket 的两类查询 */
interface PerAccount {
  listCfAccounts(): Promise<{ id: string; name: string }[]>;
  queryWorker(
    cfId: string,
    sinceISO: string,
    untilISO: string,
  ): Promise<{ bucket: string; scriptName: string; requests: number; errors: number }[]>;
  queryPages(
    cfId: string,
    sinceISO: string,
    untilISO: string,
  ): Promise<{ bucket: string; scriptName: string; requests: number }[]>;
}

/** 桶形状参数（daily=天 / hourly=整点）；cleanupBefore 提供时把 DELETE 旧行摊进写批 */
interface BackfillCore {
  table: 'usage_daily' | 'usage_hourly';
  bucketCol: 'day' | 'hour';
  targets: string[]; // 升序目标桶
  bucketStartISO: (bucket: string) => string; // 桶起始瞬间
  bucketEndISO: (bucket: string) => string; // 桶结束瞬间（下一桶起点）
  cleanupBefore?: string; // 删除 bucketCol < 此值的行（当前账号）
  // 覆盖标记表：提供时用它（而非 data 表）判定「缺失」，并为每个已抓取的桶写一条覆盖标记。
  // 让零流量桶（data 表无行）也算「已回填」，避免每次访问都重新 fan-out。随 cleanupBefore 同步清理。
  coverageTable?: string;
}

/** 参数化回填核：daily/hourly 共用。按账号探测缺失桶 → 只补缺失桶 → 分块原子批写；
 *  cleanupBefore 时把 DELETE 摊进该账号写批（即使无缺失桶也执行清理）。单账号失败进 failures。 */
async function backfillSnapshots(
  db: Db,
  ownerEmail: string,
  clientFor: (accountId: string) => Promise<PerAccount>,
  core: BackfillCore,
  now: Date,
): Promise<{ failures: { accountId: string; error: string }[] }> {
  const failures: { accountId: string; error: string }[] = [];
  const { accounts } = await listAccounts(db, ownerEmail);
  if (accounts.length === 0) return { failures };
  const psnMap = await buildPsnMap(db, ownerEmail);
  const syncedAt = now.toISOString();
  const { table, bucketCol, targets } = core;

  const insertWorker = db.prepare(
    `INSERT OR REPLACE INTO ${table}
     (${bucketCol}, kind, account_id, cf_account_id, name, requests, errors, synced_at)
     VALUES (?, 'worker', ?, ?, ?, ?, ?, ?)`,
  );
  const insertPages = db.prepare(
    `INSERT OR REPLACE INTO ${table}
     (${bucketCol}, kind, account_id, cf_account_id, name, requests, errors, synced_at)
     VALUES (?, 'pages', ?, ?, ?, ?, 0, ?)`,
  );
  const insertCovered = core.coverageTable
    ? db.prepare(`INSERT OR REPLACE INTO ${core.coverageTable} (account_id, ${bucketCol}, synced_at) VALUES (?, ?, ?)`)
    : null;
  // 覆盖标记表提供时用它判定缺失（含零流量桶）；否则回退到 data 表（daily 现状）
  const detectTable = core.coverageTable ?? table;

  const limit = pLimit(CONCURRENCY);
  await Promise.all(
    accounts.map((acct) =>
      limit(async () => {
        try {
          const placeholders = targets.map(() => '?').join(',');
          const { results } = await db
            .prepare(
              `SELECT DISTINCT ${bucketCol} AS b FROM ${detectTable} WHERE account_id = ? AND ${bucketCol} IN (${placeholders})`,
            )
            .bind(acct.id, ...targets)
            .all<{ b: string }>();
          const have = new Set(results.map((r) => r.b));
          const missing = targets.filter((t) => !have.has(t));
          const missingSet = new Set(missing);
          const byBucket = new Map<string, DbStatement[]>();
          for (const b of missing) byBucket.set(b, []);

          if (missing.length > 0) {
            const sinceISO = core.bucketStartISO(missing[0]);
            const untilISO = core.bucketEndISO(missing[missing.length - 1]);
            const pa = await clientFor(acct.id);
            const cfAccounts = await pa.listCfAccounts();
            for (const cf of cfAccounts) {
              const [w, p] = await Promise.all([
                pa.queryWorker(cf.id, sinceISO, untilISO),
                pa.queryPages(cf.id, sinceISO, untilISO),
              ]);
              for (const row of w) {
                if (!missingSet.has(row.bucket)) continue;
                byBucket
                  .get(row.bucket)!
                  .push(
                    insertWorker.bind(row.bucket, acct.id, cf.id, row.scriptName, row.requests, row.errors, syncedAt),
                  );
              }
              for (const row of p) {
                if (!missingSet.has(row.bucket)) continue;
                const projectName = psnMap.get(`${cf.id}/${row.scriptName}`);
                if (!projectName) continue;
                byBucket
                  .get(row.bucket)!
                  .push(insertPages.bind(row.bucket, acct.id, cf.id, projectName, row.requests, syncedAt));
              }
            }
            // 每个已抓取的缺失桶写一条覆盖标记（零流量桶也算已覆盖，随其桶批原子提交）
            if (insertCovered) {
              for (const b of missing) {
                byBucket.get(b)!.push(insertCovered.bind(acct.id, b, syncedAt));
              }
            }
          }

          // 分块 ≤500；cleanup DELETE 摊进最后一批（即使无 missing 也执行清理）
          // 原子性粒度是「单桶」而非「单账号」：一桶的 data INSERT + coverage 标记总在同一 db.batch 中提交；
          // 账号超 500 条语句时写入会跨多个 batch，cleanup DELETE 亦可能另起最终批，并非账号级整体原子。
          const CHUNK_LIMIT = 500;
          const ordered = [...byBucket.entries()].sort(([a], [b]) => a.localeCompare(b));
          let chunk: DbStatement[] = [];
          const flush = async () => {
            if (chunk.length === 0) return;
            try {
              await db.batch(chunk);
            } catch (e) {
              failures.push({ accountId: acct.id, error: e instanceof Error ? e.message : String(e) });
            }
            chunk = [];
          };
          for (const [, stmts] of ordered) {
            if (chunk.length > 0 && chunk.length + stmts.length > CHUNK_LIMIT) await flush();
            chunk.push(...stmts);
          }
          if (core.cleanupBefore) {
            const cleanup: DbStatement[] = [
              db
                .prepare(`DELETE FROM ${table} WHERE account_id = ? AND ${bucketCol} < ?`)
                .bind(acct.id, core.cleanupBefore),
            ];
            if (core.coverageTable) {
              cleanup.push(
                db
                  .prepare(`DELETE FROM ${core.coverageTable} WHERE account_id = ? AND ${bucketCol} < ?`)
                  .bind(acct.id, core.cleanupBefore),
              );
            }
            // 保证末批不超过 CHUNK_LIMIT（cleanup 语句摊入时先冲掉将满的当前批）
            if (chunk.length > 0 && chunk.length + cleanup.length > CHUNK_LIMIT) await flush();
            chunk.push(...cleanup);
          }
          await flush();
        } catch (e) {
          failures.push({ accountId: acct.id, error: e instanceof Error ? e.message : String(e) });
        }
      }),
    ),
  );
  return { failures };
}

/**
 * 惰性回填：把 owner 各账号最近 days 个完整自然日中缺失的天补进 usage_daily。
 * 按账号粒度探测缺失（新账号不被其他账号的已有天遮蔽）；今天/窗口外的行丢弃；
 * 0 调用的天无行落库、下次会重查（接受的取舍，见 spec）。单账号失败进 failures。
 */
export async function ensureUsageSnapshots(
  db: Db,
  ownerEmail: string,
  days: number,
  clientFor: (accountId: string) => Promise<UsageClient>,
  now: Date = new Date(),
): Promise<{ failures: { accountId: string; error: string }[] }> {
  return backfillSnapshots(
    db,
    ownerEmail,
    async (id): Promise<PerAccount> => {
      const c = await clientFor(id);
      return {
        listCfAccounts: () => c.listAccounts(),
        queryWorker: async (cf, s, u) =>
          (await c.queryWorkersInvocationsDaily(cf, s, u)).map((r) => ({
            bucket: r.date,
            scriptName: r.scriptName,
            requests: r.requests,
            errors: r.errors,
          })),
        queryPages: async (cf, s, u) =>
          (await c.queryPagesFunctionsInvocationsDaily(cf, s, u)).map((r) => ({
            bucket: r.date,
            scriptName: r.scriptName,
            requests: r.requests,
          })),
      };
    },
    {
      table: 'usage_daily',
      bucketCol: 'day',
      targets: targetDays(days, now),
      bucketStartISO: (b) => `${b}T00:00:00Z`,
      bucketEndISO: (b) => new Date(Date.parse(`${b}T00:00:00Z`) + DAY_MS).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    },
    now,
  );
}

export type UsageHourlyClient = Pick<
  CfClient,
  'listAccounts' | 'queryWorkersInvocationsHourly' | 'queryPagesFunctionsInvocationsHourly'
>;

export async function ensureUsageHourlySnapshots(
  db: Db,
  ownerEmail: string,
  clientFor: (accountId: string) => Promise<UsageHourlyClient>,
  now: Date = new Date(),
): Promise<{ failures: { accountId: string; error: string }[] }> {
  const targets = targetHours(now);
  // 清理阈值 = 最老目标整点再往前 1 小时（保 25h、窗口显示 24h）
  const cleanupBefore = new Date(Date.parse(targets[0]) - HOUR_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return backfillSnapshots(
    db,
    ownerEmail,
    async (id): Promise<PerAccount> => {
      const c = await clientFor(id);
      return {
        listCfAccounts: () => c.listAccounts(),
        queryWorker: (cf, s, u) => c.queryWorkersInvocationsHourly(cf, s, u),
        queryPages: (cf, s, u) => c.queryPagesFunctionsInvocationsHourly(cf, s, u),
      };
    },
    {
      table: 'usage_hourly',
      bucketCol: 'hour',
      targets,
      bucketStartISO: (b) => b,
      bucketEndISO: (b) => new Date(Date.parse(b) + HOUR_MS).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      cleanupBefore,
      coverageTable: 'usage_hourly_covered',
    },
    now,
  );
}

export interface UsageDailyRow {
  accountId: string;
  accountName: string;
  cfAccountId: string;
  name: string;
  requests: number;
  errors: number;
  /** 日历今天的请求数（按 locale 时区的日界，客户端传 todayStart 时才有）；7d/30d 档不含 */
  todayRequests?: number;
}

export async function queryUsageHourly(
  db: Db,
  ownerEmail: string,
  opts: {
    kind: 'worker' | 'pages';
    search?: string;
    accountId?: string;
    page: number;
    pageSize: number;
    now?: Date;
    /** 日历今天起点（UTC ISO 整点）；提供时每行附带该起点之后的请求数 today_requests */
    todayStart?: string;
  },
): Promise<{ rows: UsageDailyRow[]; total: number; sinceHour: string; untilHour: string }> {
  const targets = targetHours(opts.now ?? new Date());
  const sinceHour = targets[0];
  const untilHour = targets[targets.length - 1];
  const page = Math.max(1, opts.page);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize));

  const conditions = ['a.owner_email = ?', 'u.kind = ?', 'u.hour >= ?', 'u.hour <= ?'];
  const params: unknown[] = [ownerEmail, opts.kind, sinceHour, untilHour];
  const rawSearch = opts.search?.trim() ?? '';
  if (rawSearch !== '') {
    conditions.push(`u.name LIKE ? ESCAPE '\\'`);
    params.push(`%${rawSearch.replace(/[\\%_]/g, '\\$&')}%`);
  }
  if (opts.accountId) {
    conditions.push('u.account_id = ?');
    params.push(opts.accountId);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const groupBy = 'GROUP BY u.account_id, u.cf_account_id, u.name';

  const countRow = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM (
         SELECT 1 FROM usage_hourly u JOIN cf_accounts a ON a.id = u.account_id ${where} ${groupBy}
       )`,
    )
    .bind(...params)
    .first<{ cnt: number }>();
  const total = countRow?.cnt ?? 0;

  // 缺省 todayStart 用一个恒大于任何桶的哨兵 → CASE 恒 false → today_requests=0
  const today = opts.todayStart ?? '9999-12-31T23:59:59Z';
  const { results } = await db
    .prepare(
      `SELECT u.account_id, a.name AS account_name, u.cf_account_id, u.name,
              SUM(u.requests) AS requests, SUM(u.errors) AS errors,
              SUM(CASE WHEN u.hour >= ? THEN u.requests ELSE 0 END) AS today_requests
       FROM usage_hourly u JOIN cf_accounts a ON a.id = u.account_id
       ${where} ${groupBy}
       ORDER BY requests DESC, u.name ASC LIMIT ? OFFSET ?`,
    )
    .bind(today, ...params, pageSize, (page - 1) * pageSize)
    .all<{
      account_id: string;
      account_name: string;
      cf_account_id: string;
      name: string;
      requests: number;
      errors: number;
      today_requests: number;
    }>();

  return {
    rows: results.map((r) => ({
      accountId: r.account_id,
      accountName: r.account_name,
      cfAccountId: r.cf_account_id,
      name: r.name,
      requests: r.requests,
      errors: r.errors,
      todayRequests: r.today_requests,
    })),
    total,
    sinceHour,
    untilHour,
  };
}

export async function usageSeries(
  db: Db,
  ownerEmail: string,
  opts: {
    kind: 'worker' | 'pages';
    range: '24h' | '7d' | '30d';
    search?: string;
    accountId?: string;
    now?: Date;
  },
): Promise<{ bucket: string; requests: number; errors: number }[]> {
  const now = opts.now ?? new Date();
  const isHour = opts.range === '24h';
  const table = isHour ? 'usage_hourly' : 'usage_daily';
  const col = isHour ? 'hour' : 'day';
  const buckets = isHour ? targetHours(now) : targetDays(opts.range === '7d' ? 7 : 30, now);

  const conditions = ['a.owner_email = ?', 'u.kind = ?', `u.${col} >= ?`, `u.${col} <= ?`];
  const params: unknown[] = [ownerEmail, opts.kind, buckets[0], buckets[buckets.length - 1]];
  const rawSearch = opts.search?.trim() ?? '';
  if (rawSearch !== '') {
    conditions.push(`u.name LIKE ? ESCAPE '\\'`);
    params.push(`%${rawSearch.replace(/[\\%_]/g, '\\$&')}%`);
  }
  if (opts.accountId) {
    conditions.push('u.account_id = ?');
    params.push(opts.accountId);
  }

  const { results } = await db
    .prepare(
      `SELECT u.${col} AS bucket, SUM(u.requests) AS requests, SUM(u.errors) AS errors
       FROM ${table} u JOIN cf_accounts a ON a.id = u.account_id
       WHERE ${conditions.join(' AND ')}
       GROUP BY u.${col}`,
    )
    .bind(...params)
    .all<{ bucket: string; requests: number; errors: number }>();

  const agg = new Map(results.map((r) => [r.bucket, r]));
  return buckets.map((b) => agg.get(b) ?? { bucket: b, requests: 0, errors: 0 });
}

/** 快照聚合分页查询（7d/30d 档；窗口=完整自然日） */
export async function queryUsageDaily(
  db: Db,
  ownerEmail: string,
  opts: {
    kind: 'worker' | 'pages';
    days: number;
    search?: string;
    accountId?: string;
    page: number;
    pageSize: number;
    now?: Date;
  },
): Promise<{ rows: UsageDailyRow[]; total: number; sinceDay: string; untilDay: string }> {
  const target = targetDays(opts.days, opts.now ?? new Date());
  const sinceDay = target[0];
  const untilDay = target[target.length - 1];
  const page = Math.max(1, opts.page);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize));

  const conditions = ['a.owner_email = ?', 'u.kind = ?', 'u.day >= ?', 'u.day <= ?'];
  const params: unknown[] = [ownerEmail, opts.kind, sinceDay, untilDay];
  const rawSearch = opts.search?.trim() ?? '';
  if (rawSearch !== '') {
    conditions.push(`u.name LIKE ? ESCAPE '\\'`);
    params.push(`%${rawSearch.replace(/[\\%_]/g, '\\$&')}%`);
  }
  if (opts.accountId) {
    conditions.push('u.account_id = ?');
    params.push(opts.accountId);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const groupBy = 'GROUP BY u.account_id, u.cf_account_id, u.name';

  const countRow = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM (
         SELECT 1 FROM usage_daily u JOIN cf_accounts a ON a.id = u.account_id ${where} ${groupBy}
       )`,
    )
    .bind(...params)
    .first<{ cnt: number }>();
  const total = countRow?.cnt ?? 0;

  const { results } = await db
    .prepare(
      `SELECT u.account_id, a.name AS account_name, u.cf_account_id, u.name,
              SUM(u.requests) AS requests, SUM(u.errors) AS errors
       FROM usage_daily u JOIN cf_accounts a ON a.id = u.account_id
       ${where} ${groupBy}
       ORDER BY requests DESC, u.name ASC LIMIT ? OFFSET ?`,
    )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all<{
      account_id: string;
      account_name: string;
      cf_account_id: string;
      name: string;
      requests: number;
      errors: number;
    }>();

  return {
    rows: results.map((r) => ({
      accountId: r.account_id,
      accountName: r.account_name,
      cfAccountId: r.cf_account_id,
      name: r.name,
      requests: r.requests,
      errors: r.errors,
    })),
    total,
    sinceDay,
    untilDay,
  };
}
