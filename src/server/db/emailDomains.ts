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

export async function listEmailDomains(db: Db, ownerEmail: string): Promise<EmailDomainRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM email_domains WHERE owner_email = ? ORDER BY created_at')
    .bind(ownerEmail)
    .all<EmailDomainRow>();
  return results;
}

export async function getEmailDomain(db: Db, ownerEmail: string, id: string): Promise<EmailDomainRow | null> {
  return db
    .prepare('SELECT * FROM email_domains WHERE id = ? AND owner_email = ?')
    .bind(id, ownerEmail)
    .first<EmailDomainRow>();
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
