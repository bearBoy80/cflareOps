import type { Db } from './types';

export interface AccountRow {
  id: string;
  owner_email: string;
  name: string;
  token_encrypted: string;
  token_hash: string;
  status: string;
  last_check: string | null;
  last_error: string | null;
}

export interface AccountPublic {
  id: string;
  name: string;
  status: string;
  lastCheck: string | null;
  lastError: string | null;
}

function now(): string {
  return new Date().toISOString();
}

export async function insertAccount(
  db: Db,
  input: { id: string; ownerEmail: string; name: string; tokenEncrypted: string; tokenHash: string },
): Promise<void> {
  const existing = await db
    .prepare('SELECT id FROM cf_accounts WHERE owner_email = ? AND token_hash = ?')
    .bind(input.ownerEmail, input.tokenHash)
    .first();
  if (existing) throw new Error('account with this token already exists');
  const ts = now();
  await db
    .prepare(
      'INSERT INTO cf_accounts (id, owner_email, name, token_encrypted, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(input.id, input.ownerEmail, input.name, input.tokenEncrypted, input.tokenHash, ts, ts)
    .run();
}

export interface AccountPage {
  accounts: AccountPublic[];
  total: number;
}

export async function listAccounts(
  db: Db,
  ownerEmail: string,
  opts?: { page?: number; pageSize?: number; search?: string },
): Promise<AccountPage> {
  const page = Math.max(1, opts?.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts?.pageSize ?? 100));
  const rawSearch = opts?.search?.trim() ?? '';

  const conditions: string[] = ['owner_email = ?'];
  const params: unknown[] = [ownerEmail];
  if (rawSearch !== '') {
    const pattern = `%${rawSearch.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(`name LIKE ? ESCAPE '\\'`);
    params.push(pattern);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS cnt FROM cf_accounts ${where}`)
    .bind(...params)
    .first<{ cnt: number }>();
  const total = countRow?.cnt ?? 0;

  const { results } = await db
    .prepare(
      `SELECT id, name, status, last_check, last_error FROM cf_accounts ${where} ORDER BY created_at LIMIT ? OFFSET ?`,
    )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all<{ id: string; name: string; status: string; last_check: string | null; last_error: string | null }>();
  const accounts = results.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    lastCheck: r.last_check,
    lastError: r.last_error,
  }));
  return { accounts, total };
}

export async function countAccounts(db: Db, ownerEmail: string): Promise<{ total: number; errors: number }> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors FROM cf_accounts WHERE owner_email = ?",
    )
    .bind(ownerEmail)
    .first<{ total: number; errors: number | null }>();
  return { total: row?.total ?? 0, errors: row?.errors ?? 0 };
}

export async function getAccount(db: Db, ownerEmail: string, id: string): Promise<AccountRow | null> {
  return db
    .prepare('SELECT * FROM cf_accounts WHERE id = ? AND owner_email = ?')
    .bind(id, ownerEmail)
    .first<AccountRow>();
}

export async function deleteAccount(db: Db, ownerEmail: string, id: string): Promise<void> {
  // 单条语句 + zones.account_id ON DELETE CASCADE，账号与其 zones 缓存原子删除
  await db.prepare('DELETE FROM cf_accounts WHERE id = ? AND owner_email = ?').bind(id, ownerEmail).run();
}

export async function updateAccount(
  db: Db,
  ownerEmail: string,
  id: string,
  input: { name: string; tokenEncrypted?: string; tokenHash?: string },
): Promise<void> {
  if (input.tokenEncrypted && input.tokenHash) {
    const dup = await db
      .prepare('SELECT id FROM cf_accounts WHERE owner_email = ? AND token_hash = ? AND id != ?')
      .bind(ownerEmail, input.tokenHash, id)
      .first();
    if (dup) throw new Error('account with this token already exists');
    // 换 Token 时路由层已先 verify 通过，状态直接置 active 并清除旧错误
    await db
      .prepare(
        "UPDATE cf_accounts SET name = ?, token_encrypted = ?, token_hash = ?, status = 'active', last_check = ?, last_error = NULL, updated_at = ? WHERE id = ? AND owner_email = ?",
      )
      .bind(input.name, input.tokenEncrypted, input.tokenHash, now(), now(), id, ownerEmail)
      .run();
    return;
  }
  await db
    .prepare('UPDATE cf_accounts SET name = ?, updated_at = ? WHERE id = ? AND owner_email = ?')
    .bind(input.name, now(), id, ownerEmail)
    .run();
}

export async function updateAccountStatus(
  db: Db,
  id: string,
  status: 'active' | 'error',
  error?: string,
): Promise<void> {
  await db
    .prepare('UPDATE cf_accounts SET status = ?, last_check = ?, last_error = ?, updated_at = ? WHERE id = ?')
    .bind(status, now(), error ?? null, now(), id)
    .run();
}
