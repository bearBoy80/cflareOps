import pLimit from 'p-limit';
import { CfClient } from './cf/client';
import { NotFoundError } from './context';
import { decryptSecret } from './crypto';
import { getAccount, updateAccountStatus } from './db/accounts';
import type { Db, DbStatement } from './db/types';

export interface ZoneItem {
  id: string;
  accountId: string; // 本系统账号记录 id
  accountName: string; // 本系统账号备注名
  cfAccountId: string | null; // Zone.account.id
  cfAccountName: string | null; // Zone.account.name
  name: string;
  status: string | null;
  paused: boolean;
  type: string | null;
  planName: string | null;
  nameServers: string[];
  createdOn: string | null;
  modifiedOn: string | null;
  syncedAt: string;
}

const CONCURRENCY = 3;

export async function syncAllZones(
  db: Db,
  key: CryptoKey,
  ownerEmail: string,
  makeClient: (token: string) => Pick<CfClient, 'listZones'> = (t) => new CfClient(t),
  accountId?: string,
): Promise<{ synced: number; failures: { accountId: string; error: string }[] }> {
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
  let synced = 0;

  await Promise.all(
    accounts.map((account) =>
      limit(async () => {
        try {
          const token = await decryptSecret(account.token_encrypted, key);
          const zones = await makeClient(token).listZones();
          const syncedAt = new Date().toISOString();

          // Collect all statements first: DELETE then all INSERTs.
          // Atomic batch replace: if listZones threw before reaching here, the batch
          // never runs and the old cache is preserved.
          const stmts: DbStatement[] = [db.prepare('DELETE FROM zones WHERE account_id = ?').bind(account.id)];
          for (const zone of zones) {
            stmts.push(
              db
                .prepare(
                  `INSERT INTO zones (
                     id, account_id, name, status, paused, type, development_mode,
                     name_servers, original_name_servers, original_registrar,
                     cf_account_id, cf_account_name, plan_id, plan_name,
                     created_on, modified_on, activated_on, raw_json, synced_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                  zone.id,
                  account.id,
                  zone.name,
                  zone.status ?? null,
                  zone.paused ? 1 : 0,
                  zone.type ?? null,
                  zone.development_mode ?? null,
                  zone.name_servers ? JSON.stringify(zone.name_servers) : null,
                  zone.original_name_servers ? JSON.stringify(zone.original_name_servers) : null,
                  zone.original_registrar ?? null,
                  zone.account?.id ?? null,
                  zone.account?.name ?? null,
                  zone.plan?.id ?? null,
                  zone.plan?.name ?? null,
                  zone.created_on ?? null,
                  zone.modified_on ?? null,
                  zone.activated_on ?? null,
                  JSON.stringify(zone.raw ?? zone),
                  syncedAt,
                ),
            );
          }

          // Single atomic batch: DELETE + all INSERTs commit together.
          await db.batch(stmts);
          await updateAccountStatus(db, account.id, 'active');
          synced += zones.length;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          failures.push({ accountId: account.id, error: message });
          try {
            await updateAccountStatus(db, account.id, 'error', message);
          } catch {
            // Failure is already recorded in failures[]; if recording the failure
            // itself throws, that shouldn't abort the entire batch.
          }
        }
      }),
    ),
  );

  return { synced, failures };
}

export interface ZonePage {
  zones: ZoneItem[];
  total: number;
}

export async function listCachedZones(
  db: Db,
  ownerEmail: string,
  opts?: {
    page?: number;
    pageSize?: number;
    search?: string;
    status?: string;
    accountId?: string;
  },
): Promise<ZonePage> {
  const rawPage = opts?.page ?? 1;
  const page = Math.max(1, rawPage);
  const rawSize = opts?.pageSize ?? 20;
  const pageSize = Math.min(100, Math.max(1, rawSize));
  const rawSearch = opts?.search?.trim() ?? '';
  const useSearch = rawSearch !== '';
  const escapedSearch = rawSearch.replace(/[\\%_]/g, '\\$&');
  const pattern = `%${escapedSearch}%`;
  const status = opts?.status?.trim() ?? '';
  const accountId = opts?.accountId?.trim() ?? '';

  const conditions: string[] = ['a.owner_email = ?'];
  const params: unknown[] = [ownerEmail];

  if (useSearch) {
    conditions.push(`(z.name LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\')`);
    params.push(pattern, pattern);
  }
  if (status === 'paused') {
    conditions.push('z.paused = 1');
  } else if (status !== '') {
    conditions.push('z.status = ?');
    params.push(status);
  }
  if (accountId !== '') {
    conditions.push('z.account_id = ?');
    params.push(accountId);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS cnt FROM zones z JOIN cf_accounts a ON a.id = z.account_id ${where}`)
    .bind(...params)
    .first<{ cnt: number }>();
  const total = countRow?.cnt ?? 0;

  const offset = (page - 1) * pageSize;
  const { results } = await db
    .prepare(
      `SELECT z.id, z.account_id, a.name AS account_name, z.cf_account_id, z.cf_account_name,
              z.name, z.status, z.paused, z.type, z.plan_name, z.name_servers,
              z.created_on, z.modified_on, z.synced_at
       FROM zones z JOIN cf_accounts a ON a.id = z.account_id
       ${where} ORDER BY z.name LIMIT ? OFFSET ?`,
    )
    .bind(...params, pageSize, offset)
    .all<{
      id: string;
      account_id: string;
      account_name: string;
      cf_account_id: string | null;
      cf_account_name: string | null;
      name: string;
      status: string | null;
      paused: number;
      type: string | null;
      plan_name: string | null;
      name_servers: string | null;
      created_on: string | null;
      modified_on: string | null;
      synced_at: string;
    }>();

  const zones = results.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    accountName: r.account_name,
    cfAccountId: r.cf_account_id,
    cfAccountName: r.cf_account_name,
    name: r.name,
    status: r.status,
    paused: r.paused === 1,
    type: r.type,
    planName: r.plan_name,
    nameServers: r.name_servers ? (JSON.parse(r.name_servers) as string[]) : [],
    createdOn: r.created_on,
    modifiedOn: r.modified_on,
    syncedAt: r.synced_at,
  }));

  return { zones, total };
}

export async function getCachedZone(
  db: Db,
  ownerEmail: string,
  zoneId: string,
): Promise<{ id: string; name: string } | null> {
  return db
    .prepare(
      `SELECT z.id, z.name FROM zones z JOIN cf_accounts a ON a.id = z.account_id
       WHERE z.id = ? AND a.owner_email = ?`,
    )
    .bind(zoneId, ownerEmail)
    .first<{ id: string; name: string }>();
}

export async function zoneStats(db: Db, ownerEmail: string): Promise<{ total: number; lastSyncedAt: string | null }> {
  const row = await db
    .prepare(
      'SELECT COUNT(*) AS total, MAX(z.synced_at) AS last FROM zones z JOIN cf_accounts a ON a.id = z.account_id WHERE a.owner_email = ?',
    )
    .bind(ownerEmail)
    .first<{ total: number; last: string | null }>();
  return { total: row?.total ?? 0, lastSyncedAt: row?.last ?? null };
}

export async function clientForZone(db: Db, key: CryptoKey, ownerEmail: string, zoneId: string): Promise<CfClient> {
  // .first() intentionally picks any one owning account when the same CF zone id is cached
  // under multiple accounts (e.g. shared / transferred zone). This is a deliberate choice:
  // any account that has the zone in its cache is authorised to operate on it.
  const zone = await db
    .prepare(
      'SELECT z.account_id FROM zones z JOIN cf_accounts a ON a.id = z.account_id WHERE z.id = ? AND a.owner_email = ?',
    )
    .bind(zoneId, ownerEmail)
    .first<{ account_id: string }>();
  if (!zone) throw new NotFoundError('zone not found in cache; run sync first');
  const account = await getAccount(db, ownerEmail, zone.account_id);
  if (!account) throw new NotFoundError('owning account not found');
  return new CfClient(await decryptSecret(account.token_encrypted, key));
}
