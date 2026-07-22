import pLimit from 'p-limit';
import { CfClient } from './cf/client';
import { decryptSecret } from './crypto';
import { updateAccountStatus } from './db/accounts';
import type { Db, DbStatement } from './db/types';

export interface R2BucketItem {
  name: string;
  accountId: string; // 本系统账号记录 id
  accountName: string; // 本系统账号备注名
  cfAccountId: string; // CF 侧账号 id
  cfAccountName: string | null;
  location: string | null;
  storageClass: string | null;
  creationDate: string | null;
  payloadSize: number | null; // GraphQL 存储快照；快照失败为 null
  metadataSize: number | null;
  objectCount: number | null;
  syncedAt: string;
}

const CONCURRENCY = 3;

type SyncClient = Pick<CfClient, 'listAccounts' | 'listR2Buckets' | 'queryR2StorageSnapshot'>;

/**
 * R2 桶缓存同步：复刻 workersPages.ts 的原子 batch 替换模式。
 * 每 CF 账号「列桶 + 一次存储快照查询」；快照失败非致命（列留 NULL），列桶失败该账号整体失败。
 */
export async function syncR2Buckets(
  db: Db,
  key: CryptoKey,
  ownerEmail: string,
  makeClient: (token: string) => SyncClient = (t) => new CfClient(t),
  accountId?: string,
): Promise<{ buckets: number; failures: { accountId: string; error: string }[] }> {
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
  let buckets = 0;

  await Promise.all(
    accounts.map((account) =>
      limit(async () => {
        try {
          const token = await decryptSecret(account.token_encrypted, key);
          const client = makeClient(token);
          const cfAccounts = await client.listAccounts();
          const syncedAt = new Date().toISOString();

          // 先收集全部语句再单批执行：任一上游抛错则批不跑，旧缓存原样保留
          const stmts: DbStatement[] = [db.prepare('DELETE FROM r2_buckets WHERE account_id = ?').bind(account.id)];
          let localBuckets = 0;

          for (const cfAccount of cfAccounts) {
            const list = await client.listR2Buckets(cfAccount.id);
            // 存储快照失败降级：桶行照常写入，体积/对象数列留 NULL
            let snapshot = new Map<string, { payloadSize: number; metadataSize: number; objectCount: number }>();
            try {
              snapshot = new Map((await client.queryR2StorageSnapshot(cfAccount.id)).map((s) => [s.bucketName, s]));
            } catch {
              // 非致命：GraphQL 数据集权限缺失或暂不可用时仍要有桶列表
            }
            for (const b of list) {
              const m = snapshot.get(b.name);
              stmts.push(
                db
                  .prepare(
                    `INSERT OR REPLACE INTO r2_buckets (
                       account_id, cf_account_id, cf_account_name, name,
                       location, storage_class, creation_date,
                       payload_size, metadata_size, object_count,
                       raw_json, synced_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  )
                  .bind(
                    account.id,
                    cfAccount.id,
                    cfAccount.name,
                    b.name,
                    b.location ?? null,
                    b.storage_class ?? null,
                    b.creation_date ?? null,
                    m?.payloadSize ?? null,
                    m?.metadataSize ?? null,
                    m?.objectCount ?? null,
                    JSON.stringify(b.raw ?? b),
                    syncedAt,
                  ),
              );
            }
            localBuckets += list.length;
          }

          await db.batch(stmts);
          await updateAccountStatus(db, account.id, 'active');
          buckets += localBuckets;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          failures.push({ accountId: account.id, error: message });
          try {
            await updateAccountStatus(db, account.id, 'error', message);
          } catch {
            // 失败已记录在 failures[]；状态落库失败不应中断整个同步
          }
        }
      }),
    ),
  );

  return { buckets, failures };
}

interface BucketRow {
  name: string;
  account_id: string;
  account_name: string;
  cf_account_id: string;
  cf_account_name: string | null;
  location: string | null;
  storage_class: string | null;
  creation_date: string | null;
  payload_size: number | null;
  metadata_size: number | null;
  object_count: number | null;
  synced_at: string;
}

function toItem(r: BucketRow): R2BucketItem {
  return {
    name: r.name,
    accountId: r.account_id,
    accountName: r.account_name,
    cfAccountId: r.cf_account_id,
    cfAccountName: r.cf_account_name,
    location: r.location,
    storageClass: r.storage_class,
    creationDate: r.creation_date,
    payloadSize: r.payload_size,
    metadataSize: r.metadata_size,
    objectCount: r.object_count,
    syncedAt: r.synced_at,
  };
}

const ROW_COLUMNS = `b.name, b.account_id, a.name AS account_name, b.cf_account_id, b.cf_account_name,
       b.location, b.storage_class, b.creation_date,
       b.payload_size, b.metadata_size, b.object_count, b.synced_at`;

export async function listCachedR2Buckets(
  db: Db,
  ownerEmail: string,
  opts?: { page?: number; pageSize?: number; search?: string },
): Promise<{ buckets: R2BucketItem[]; total: number }> {
  const page = Math.max(1, opts?.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts?.pageSize ?? 20));
  const rawSearch = opts?.search?.trim() ?? '';

  const conditions: string[] = ['a.owner_email = ?'];
  const params: unknown[] = [ownerEmail];
  if (rawSearch !== '') {
    const pattern = `%${rawSearch.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(`(b.name LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\')`);
    params.push(pattern, pattern);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS cnt FROM r2_buckets b JOIN cf_accounts a ON a.id = b.account_id ${where}`)
    .bind(...params)
    .first<{ cnt: number }>();
  const total = countRow?.cnt ?? 0;

  const { results } = await db
    .prepare(
      `SELECT ${ROW_COLUMNS}
       FROM r2_buckets b JOIN cf_accounts a ON a.id = b.account_id
       ${where} ORDER BY (b.creation_date IS NULL), b.creation_date DESC, b.name LIMIT ? OFFSET ?`,
    )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all<BucketRow>();

  return { buckets: results.map(toItem), total };
}

/** 详情页/路由归属校验：owner 隔离取单桶缓存行，不存在返回 null（路由映射 404） */
export async function getCachedR2Bucket(
  db: Db,
  ownerEmail: string,
  accountId: string,
  name: string,
  cfAccountId?: string,
): Promise<R2BucketItem | null> {
  const cfCond = cfAccountId ? ' AND b.cf_account_id = ?' : '';
  const params = cfAccountId ? [name, accountId, ownerEmail, cfAccountId] : [name, accountId, ownerEmail];
  const r = await db
    .prepare(
      `SELECT ${ROW_COLUMNS}
       FROM r2_buckets b JOIN cf_accounts a ON a.id = b.account_id
       WHERE b.name = ? AND b.account_id = ? AND a.owner_email = ?${cfCond}
       ORDER BY b.cf_account_id LIMIT 1`,
    )
    .bind(...params)
    .first<BucketRow>();
  return r ? toItem(r) : null;
}

/**
 * R2 计费操作分类（用量 tab 汇总 Class A/B）。
 * A 类 = 变更/列举类（计费更贵），B 类 = 读取类；未知 actionType 归 B（保守低估不虚高）。
 */
const CLASS_A_ACTIONS = new Set([
  'ListBuckets',
  'PutBucket',
  'ListObjects',
  'PutObject',
  'CopyObject',
  'CompleteMultipartUpload',
  'CreateMultipartUpload',
  'ListMultipartUploads',
  'UploadPart',
  'UploadPartCopy',
  'ListParts',
  'PutBucketEncryption',
  'PutBucketCors',
  'PutBucketLifecycleConfiguration',
  'LifecycleStorageTierTransition',
]);

export function classifyR2Action(actionType: string): 'A' | 'B' {
  return CLASS_A_ACTIONS.has(actionType) ? 'A' : 'B';
}
