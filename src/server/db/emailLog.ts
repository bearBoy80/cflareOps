import type { Db } from './types';

export interface EmailRecipients {
  to: string[];
  cc: string[];
  bcc: string[];
}

export interface EmailLogInput {
  id: string;
  ownerEmail: string;
  domainId: string | null;
  provider: string;
  fromAddress: string;
  recipients: EmailRecipients;
  subject: string;
  format: string;
  content: string;
  status: 'pending' | 'sent' | 'partial' | 'failed';
  messageId: string | null;
  error: string | null;
  idempotencyKey?: string | null;
}

export interface EmailLogListItem {
  id: string;
  provider: string;
  fromAddress: string;
  recipients: EmailRecipients;
  subject: string;
  format: string;
  status: string;
  messageId: string | null;
  error: string | null;
  createdAt: string;
}

export interface EmailLogDetail extends EmailLogListItem {
  content: string;
}

interface LogRow {
  id: string;
  provider: string;
  from_address: string;
  recipients_json: string;
  subject: string;
  format: string;
  status: string;
  message_id: string | null;
  error: string | null;
  created_at: string;
}

function parseRecipients(json: string): EmailRecipients {
  try {
    const r = JSON.parse(json) as Partial<EmailRecipients>;
    return { to: r.to ?? [], cc: r.cc ?? [], bcc: r.bcc ?? [] };
  } catch {
    return { to: [], cc: [], bcc: [] };
  }
}

function toItem(r: LogRow): EmailLogListItem {
  return {
    id: r.id,
    provider: r.provider,
    fromAddress: r.from_address,
    recipients: parseRecipients(r.recipients_json),
    subject: r.subject,
    format: r.format,
    status: r.status,
    messageId: r.message_id,
    error: r.error,
    createdAt: r.created_at,
  };
}

export async function insertEmailLog(db: Db, input: EmailLogInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO email_log (id, owner_email, domain_id, provider, from_address, recipients_json,
         subject, format, content, status, message_id, error, created_at, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.ownerEmail,
      input.domainId,
      input.provider,
      input.fromAddress,
      JSON.stringify(input.recipients),
      input.subject,
      input.format,
      input.content,
      input.status,
      input.messageId,
      input.error,
      new Date().toISOString(),
      input.idempotencyKey ?? null,
    )
    .run();
}

export async function finishEmailLog(
  db: Db,
  ownerEmail: string,
  id: string,
  status: 'sent' | 'partial' | 'failed',
  messageId: string | null,
  error: string | null,
): Promise<void> {
  await db
    .prepare('UPDATE email_log SET status = ?, message_id = ?, error = ? WHERE id = ? AND owner_email = ?')
    .bind(status, messageId, error, id, ownerEmail)
    .run();
}

/** 幂等重放比对用的请求快照：同一 idempotency key 只能对应同一封邮件 */
export interface EmailRequestSnapshot {
  domainId: string | null;
  fromAddress: string;
  recipients: EmailRecipients;
  subject: string;
  format: string;
  content: string;
}

export async function getEmailLogByIdempotencyKey(
  db: Db,
  ownerEmail: string,
  idempotencyKey: string,
): Promise<{
  id: string;
  status: string;
  messageId: string | null;
  error: string | null;
  request: EmailRequestSnapshot;
} | null> {
  const row = await db
    .prepare(
      `SELECT id, status, message_id, error, domain_id, from_address, recipients_json, subject, format, content
       FROM email_log WHERE owner_email = ? AND idempotency_key = ?`,
    )
    .bind(ownerEmail, idempotencyKey)
    .first<{
      id: string;
      status: string;
      message_id: string | null;
      error: string | null;
      domain_id: string | null;
      from_address: string;
      recipients_json: string;
      subject: string;
      format: string;
      content: string;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    messageId: row.message_id,
    error: row.error,
    request: {
      domainId: row.domain_id,
      fromAddress: row.from_address,
      recipients: parseRecipients(row.recipients_json),
      subject: row.subject,
      format: row.format,
      content: row.content,
    },
  };
}

/** 列表不含 content：正文可能很大，回看单条时再取 */
export async function listEmailLogs(
  db: Db,
  ownerEmail: string,
  opts: { page: number; pageSize: number; search?: string },
): Promise<{ logs: EmailLogListItem[]; total: number }> {
  const search = opts.search?.trim().toLowerCase() ?? '';
  const searchSql = search
    ? ` AND (
         instr(lower(from_address), ?) > 0 OR
         instr(lower(recipients_json), ?) > 0 OR
         instr(lower(subject), ?) > 0
       )`
    : '';
  const searchBindings = search ? [search, search, search] : [];
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS cnt FROM email_log WHERE owner_email = ?${searchSql}`)
    .bind(ownerEmail, ...searchBindings)
    .first<{ cnt: number }>();
  const { results } = await db
    .prepare(
      `SELECT id, provider, from_address, recipients_json, subject, format, status, message_id, error, created_at
       FROM email_log WHERE owner_email = ?${searchSql}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .bind(ownerEmail, ...searchBindings, opts.pageSize, (opts.page - 1) * opts.pageSize)
    .all<LogRow>();
  return { logs: results.map(toItem), total: countRow?.cnt ?? 0 };
}

export async function getEmailLog(db: Db, ownerEmail: string, id: string): Promise<EmailLogDetail | null> {
  const row = await db
    .prepare('SELECT * FROM email_log WHERE id = ? AND owner_email = ?')
    .bind(id, ownerEmail)
    .first<LogRow & { content: string }>();
  if (!row) return null;
  return { ...toItem(row), content: row.content };
}
