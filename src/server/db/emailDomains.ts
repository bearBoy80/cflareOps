import type { Db } from './types';

export interface EmailDomainRow {
  id: string;
  owner_email: string;
  domain: string;
  provider: 'resend' | 'cloudflare';
  api_key_ciphertext: string | null;
  api_key_hash: string | null;
  account_id: string | null;
  cf_account_id: string | null;
  created_at: string;
}

export interface EmailDomainPublic {
  id: string;
  domain: string;
  provider: 'resend' | 'cloudflare';
  apiKeyHint: string | null;
  accountId: string | null;
  cfAccountId: string | null;
  createdAt: string;
}

/** 对外形状：resend 凭证只暴露 hash 前 8 位识别位，永不返回密文/明文 */
export function toPublic(r: EmailDomainRow): EmailDomainPublic {
  return {
    id: r.id,
    domain: r.domain,
    provider: r.provider,
    apiKeyHint: r.api_key_hash ? r.api_key_hash.slice(0, 8) : null,
    accountId: r.account_id,
    cfAccountId: r.cf_account_id,
    createdAt: r.created_at,
  };
}

export interface EmailDomainInput {
  id: string;
  ownerEmail: string;
  domain: string;
  provider: 'resend' | 'cloudflare';
  apiKeyCiphertext: string | null;
  apiKeyHash: string | null;
  accountId: string | null;
  cfAccountId: string | null;
}

export async function insertEmailDomain(db: Db, input: EmailDomainInput): Promise<void> {
  const existing = await db
    .prepare('SELECT id FROM email_domains WHERE owner_email = ? AND domain = ?')
    .bind(input.ownerEmail, input.domain)
    .first();
  if (existing) throw new Error('domain already configured');
  await db
    .prepare(
      `INSERT INTO email_domains (id, owner_email, domain, provider, api_key_ciphertext, api_key_hash,
         account_id, cf_account_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.ownerEmail,
      input.domain,
      input.provider,
      input.apiKeyCiphertext,
      input.apiKeyHash,
      input.accountId,
      input.cfAccountId,
      new Date().toISOString(),
    )
    .run();
}

export interface EmailDomainPage {
  domains: EmailDomainRow[];
  total: number;
}

/**
 * A sending domain is usable only while it belongs to a Zone visible through
 * one of the owner's connected Cloudflare accounts. Subdomains are accepted
 * (for example mail.example.com belongs to the example.com Zone).
 *
 * Cloudflare Email Sending configurations are additionally pinned to the
 * local/Cloudflare account selected when the domain was configured. Resend
 * credentials are provider-owned, so any currently visible owner Zone is
 * sufficient.
 */
const USABLE_DOMAIN_EXISTS = `EXISTS (
  SELECT 1
  FROM zones z
  JOIN cf_accounts a ON a.id = z.account_id
  WHERE a.owner_email = d.owner_email
    AND (
      LOWER(d.domain) = LOWER(z.name)
      OR LOWER(d.domain) LIKE '%.' || LOWER(z.name)
    )
    AND (
      d.provider = 'resend'
      OR (
        d.account_id = z.account_id
        AND d.cf_account_id = z.cf_account_id
      )
    )
)`;

export async function listEmailDomains(
  db: Db,
  ownerEmail: string,
  opts?: { page?: number; pageSize?: number },
): Promise<EmailDomainPage> {
  const page = Math.max(1, opts?.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts?.pageSize ?? 20));

  const countRow = await db
    .prepare('SELECT COUNT(*) AS cnt FROM email_domains WHERE owner_email = ?')
    .bind(ownerEmail)
    .first<{ cnt: number }>();
  const total = countRow?.cnt ?? 0;

  const { results } = await db
    .prepare('SELECT * FROM email_domains WHERE owner_email = ? ORDER BY created_at LIMIT ? OFFSET ?')
    .bind(ownerEmail, pageSize, (page - 1) * pageSize)
    .all<EmailDomainRow>();
  return { domains: results, total };
}

export async function listUsableEmailDomains(
  db: Db,
  ownerEmail: string,
  opts?: { page?: number; pageSize?: number },
): Promise<EmailDomainPage> {
  const page = Math.max(1, opts?.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts?.pageSize ?? 20));
  const where = `d.owner_email = ? AND ${USABLE_DOMAIN_EXISTS}`;

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS cnt FROM email_domains d WHERE ${where}`)
    .bind(ownerEmail)
    .first<{ cnt: number }>();
  const total = countRow?.cnt ?? 0;

  const { results } = await db
    .prepare(`SELECT d.* FROM email_domains d WHERE ${where} ORDER BY d.created_at LIMIT ? OFFSET ?`)
    .bind(ownerEmail, pageSize, (page - 1) * pageSize)
    .all<EmailDomainRow>();
  return { domains: results, total };
}

export async function getEmailDomain(db: Db, ownerEmail: string, id: string): Promise<EmailDomainRow | null> {
  return db
    .prepare('SELECT * FROM email_domains WHERE id = ? AND owner_email = ?')
    .bind(id, ownerEmail)
    .first<EmailDomainRow>();
}

export async function getUsableEmailDomain(db: Db, ownerEmail: string, id: string): Promise<EmailDomainRow | null> {
  return db
    .prepare(`SELECT d.* FROM email_domains d WHERE d.id = ? AND d.owner_email = ? AND ${USABLE_DOMAIN_EXISTS}`)
    .bind(id, ownerEmail)
    .first<EmailDomainRow>();
}

export async function isEmailDomainAuthorized(
  db: Db,
  ownerEmail: string,
  domain: string,
  binding?: { accountId: string; cfAccountId: string },
): Promise<boolean> {
  return (await findAuthorizedEmailZone(db, ownerEmail, domain, binding)) !== null;
}

export interface AuthorizedEmailZone {
  zoneId: string;
  zoneName: string;
  cfAccountId: string;
}

/** 返回域名所属的、当前用户与所选连接均有权访问的最长匹配 Zone。 */
export async function findAuthorizedEmailZone(
  db: Db,
  ownerEmail: string,
  domain: string,
  binding?: { accountId: string; cfAccountId: string },
): Promise<AuthorizedEmailZone | null> {
  const conditions = ['a.owner_email = ?', `(LOWER(?) = LOWER(z.name) OR LOWER(?) LIKE '%.' || LOWER(z.name))`];
  const params: unknown[] = [ownerEmail, domain, domain];
  if (binding) {
    conditions.push('z.account_id = ?', 'z.cf_account_id = ?');
    params.push(binding.accountId, binding.cfAccountId);
  }
  const row = await db
    .prepare(
      `SELECT z.id AS zone_id, z.name AS zone_name, z.cf_account_id
       FROM zones z JOIN cf_accounts a ON a.id = z.account_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY LENGTH(z.name) DESC LIMIT 1`,
    )
    .bind(...params)
    .first<{ zone_id: string; zone_name: string; cf_account_id: string }>();
  return row ? { zoneId: row.zone_id, zoneName: row.zone_name, cfAccountId: row.cf_account_id } : null;
}

export async function updateEmailDomain(
  db: Db,
  ownerEmail: string,
  id: string,
  input: {
    provider: 'resend' | 'cloudflare';
    apiKeyCiphertext: string | null;
    apiKeyHash: string | null;
    accountId: string | null;
    cfAccountId: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE email_domains SET provider = ?, api_key_ciphertext = ?, api_key_hash = ?,
         account_id = ?, cf_account_id = ?
       WHERE id = ? AND owner_email = ?`,
    )
    .bind(input.provider, input.apiKeyCiphertext, input.apiKeyHash, input.accountId, input.cfAccountId, id, ownerEmail)
    .run();
}

export async function deleteEmailDomain(db: Db, ownerEmail: string, id: string): Promise<void> {
  await db.prepare('DELETE FROM email_domains WHERE id = ? AND owner_email = ?').bind(id, ownerEmail).run();
}
