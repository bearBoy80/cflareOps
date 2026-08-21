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
  auth_type: string;
  oauth_client_id: string | null;
  oauth_refresh_encrypted: string | null;
  oauth_expires_at: string | null;
  oauth_scope: string | null;
  oauth_sub: string | null;
  oauth_refresh_lock_until: string | null;
}

export interface AccountPublic {
  id: string;
  name: string;
  status: string;
  lastCheck: string | null;
  lastError: string | null;
  authType: string;
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

export async function upsertOAuthAccount(
  db: Db,
  input: {
    id: string;
    ownerEmail: string;
    name: string;
    tokenEncrypted: string;
    tokenHash: string;
    clientId: string;
    refreshEncrypted: string;
    expiresAt: string;
    scope: string | null;
    sub: string | null;
    replaceId?: string;
  },
): Promise<{ id: string; created: boolean }> {
  // OAuth 去重键由回调层根据 client id + 可见 CF 账号集合生成。
  // access/refresh token 会轮换，不能直接拿它们做稳定 hash。再次授权同一连接时
  // 原地更新 token/scope，保留账号 ID 及其 Zone/邮件域名等关联数据。
  const existing = await db
    .prepare(
      input.replaceId
        ? 'SELECT id, auth_type FROM cf_accounts WHERE owner_email = ? AND id = ?'
        : 'SELECT id, auth_type FROM cf_accounts WHERE owner_email = ? AND token_hash = ?',
    )
    .bind(input.ownerEmail, input.replaceId ?? input.tokenHash)
    .first<{ id: string; auth_type: string }>();
  const ts = now();
  if (input.replaceId && !existing) throw new Error('OAuth account to reconnect no longer exists');
  if (existing) {
    if (existing.auth_type !== 'oauth') throw new Error('account with this token already exists');
    await db
      .prepare(
        `UPDATE cf_accounts SET
           name = ?, token_encrypted = ?, token_hash = ?, status = 'active', last_check = ?, last_error = NULL,
           oauth_client_id = ?, oauth_refresh_encrypted = ?, oauth_expires_at = ?, oauth_scope = ?, oauth_sub = ?,
           oauth_refresh_lock_until = NULL,
           updated_at = ?
         WHERE id = ? AND owner_email = ?`,
      )
      .bind(
        input.name,
        input.tokenEncrypted,
        input.tokenHash,
        ts,
        input.clientId,
        input.refreshEncrypted,
        input.expiresAt,
        input.scope,
        input.sub,
        ts,
        existing.id,
        input.ownerEmail,
      )
      .run();
    return { id: existing.id, created: false };
  }
  await db
    .prepare(
      `INSERT INTO cf_accounts (
         id, owner_email, name, token_encrypted, token_hash, status, last_check,
         auth_type, oauth_client_id, oauth_refresh_encrypted, oauth_expires_at, oauth_scope, oauth_sub,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'active', ?, 'oauth', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.ownerEmail,
      input.name,
      input.tokenEncrypted,
      input.tokenHash,
      ts,
      input.clientId,
      input.refreshEncrypted,
      input.expiresAt,
      input.scope,
      input.sub,
      ts,
      ts,
    )
    .run();
  return { id: input.id, created: true };
}

/** OAuth 续期回写:按 owner_email + id 更新 access/refresh/过期时间。 */
export async function updateOAuthTokens(
  db: Db,
  ownerEmail: string,
  id: string,
  input: { tokenEncrypted: string; refreshEncrypted: string; expiresAt: string },
): Promise<void> {
  await db
    .prepare(
      'UPDATE cf_accounts SET token_encrypted = ?, oauth_refresh_encrypted = ?, oauth_expires_at = ?, oauth_refresh_lock_until = NULL, updated_at = ? WHERE id = ? AND owner_email = ?',
    )
    .bind(input.tokenEncrypted, input.refreshEncrypted, input.expiresAt, now(), id, ownerEmail)
    .run();
}

export async function tryClaimOAuthRefresh(
  db: Db,
  ownerEmail: string,
  id: string,
  expectedExpiresAt: string | null,
  nowIso: string,
  lockUntil: string,
): Promise<boolean> {
  const result = (await db
    .prepare(
      `UPDATE cf_accounts SET oauth_refresh_lock_until = ?
       WHERE id = ? AND owner_email = ? AND oauth_expires_at IS ?
         AND (oauth_refresh_lock_until IS NULL OR oauth_refresh_lock_until < ?)`,
    )
    .bind(lockUntil, id, ownerEmail, expectedExpiresAt, nowIso)
    .run()) as { changes?: number; meta?: { changes?: number } };
  return (result.meta?.changes ?? result.changes ?? 0) > 0;
}

export async function releaseOAuthRefresh(db: Db, ownerEmail: string, id: string): Promise<void> {
  await db
    .prepare('UPDATE cf_accounts SET oauth_refresh_lock_until = NULL WHERE id = ? AND owner_email = ?')
    .bind(id, ownerEmail)
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
      `SELECT id, name, status, last_check, last_error, auth_type FROM cf_accounts ${where} ORDER BY created_at LIMIT ? OFFSET ?`,
    )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all<{
      id: string;
      name: string;
      status: string;
      last_check: string | null;
      last_error: string | null;
      auth_type: string;
    }>();
  const accounts = results.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    lastCheck: r.last_check,
    lastError: r.last_error,
    authType: r.auth_type,
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
  ownerEmail: string,
  id: string,
  status: 'active' | 'error',
  error?: string,
): Promise<void> {
  await db
    .prepare(
      'UPDATE cf_accounts SET status = ?, last_check = ?, last_error = ?, updated_at = ? WHERE id = ? AND owner_email = ?',
    )
    .bind(status, now(), error ?? null, now(), id, ownerEmail)
    .run();
}
