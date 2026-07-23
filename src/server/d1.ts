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
