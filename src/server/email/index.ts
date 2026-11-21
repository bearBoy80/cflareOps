import { resolveAccountToken } from '@/server/cf/account';
import { CfClient } from '@/server/cf/client';
import { NotFoundError } from '@/server/context';
import { decryptSecret } from '@/server/crypto';
import { getAccount } from '@/server/db/accounts';
import { getUsableEmailDomain } from '@/server/db/emailDomains';
import { finishEmailLog, getEmailLogByIdempotencyKey, insertEmailLog } from '@/server/db/emailLog';
import type { Db } from '@/server/db/types';
import { type CloudflareEmailClient, sendViaCloudflare } from './providers/cloudflare';
import { sendViaResend } from './providers/resend';
import { renderBody } from './render';
import {
  type EmailMessage,
  EmailSendConflictError,
  EmailValidationError,
  type ProviderSendOk,
  type SendResult,
} from './types';

/** 测试注入口：风格同 syncAllZones 的 makeClient 参数 */
export interface SendDeps {
  makeCfClient?: (token: string) => CloudflareEmailClient;
  resend?: typeof sendViaResend;
}

export async function sendEmail(
  ctx: { db: Db; key: CryptoKey; userEmail: string },
  domainId: string,
  msg: EmailMessage,
  deps: SendDeps = {},
  idempotencyKey?: string,
): Promise<SendResult> {
  const row = await getUsableEmailDomain(ctx.db, ctx.userEmail, domainId);
  if (!row) throw new NotFoundError('sending domain not found');

  // from 的域名部分必须等于配置域名：防止借该配置的凭证用未验证域名发信
  const fromDomain = msg.from.split('@')[1]?.toLowerCase();
  if (fromDomain !== row.domain.toLowerCase()) {
    throw new EmailValidationError('from address does not match the configured domain', 'fromDomainMismatch');
  }

  // 渲染异常按 400 校验错误处理：不调 provider、不写 log
  let body: { html?: string; text?: string };
  try {
    body = renderBody(msg.format, msg.content);
  } catch (e) {
    throw new EmailValidationError(e instanceof Error ? e.message : 'failed to render body', 'renderFailed');
  }

  const params = {
    from: msg.from,
    fromName: msg.fromName,
    to: msg.to,
    cc: msg.cc,
    bcc: msg.bcc,
    subject: msg.subject,
    html: body.html,
    text: body.text,
  };

  const logId = crypto.randomUUID();
  const writeLog = (
    status: 'pending' | 'sent' | 'partial' | 'failed',
    messageId: string | null,
    error: string | null,
  ) =>
    insertEmailLog(ctx.db, {
      id: logId,
      ownerEmail: ctx.userEmail,
      domainId: row.id,
      provider: row.provider,
      fromAddress: msg.from,
      recipients,
      subject: msg.subject,
      format: msg.format,
      content: msg.content,
      status,
      messageId,
      error,
      idempotencyKey,
    });

  const recipients = { to: msg.to, cc: msg.cc ?? [], bcc: msg.bcc ?? [] };
  const replay = async (): Promise<SendResult | null> => {
    if (!idempotencyKey) return null;
    const existing = await getEmailLogByIdempotencyKey(ctx.db, ctx.userEmail, idempotencyKey);
    if (!existing) return null;
    // 同一 key 只能重放「同一封」邮件：内容/收件人/发件地址任一不同就是新的发送意图，
    // 若照旧重放会把改过的邮件谎报为已发送而实际从未发出。
    const prev = existing.request;
    const same =
      prev.domainId === row.id &&
      prev.fromAddress === msg.from &&
      JSON.stringify(prev.recipients) === JSON.stringify(recipients) &&
      prev.subject === msg.subject &&
      prev.format === msg.format &&
      prev.content === msg.content;
    if (!same) throw new EmailSendConflictError('requestMismatch');
    if (existing.status === 'sent' || existing.status === 'partial') {
      return {
        logId: existing.id,
        status: existing.status,
        messageId: existing.messageId,
        error: existing.error,
        delivered: [],
        queued: [],
        permanentBounces: [],
        logged: true,
      };
    }
    throw new EmailSendConflictError(existing.status === 'pending' ? 'sendInProgress' : 'sendAlreadyFailed');
  };

  const previous = await replay();
  if (previous) return previous;
  if (idempotencyKey) {
    try {
      await writeLog('pending', null, null);
    } catch (e) {
      const raced = await replay();
      if (raced) return raced;
      throw e;
    }
  }

  let sent: ProviderSendOk;
  try {
    if (row.provider === 'resend') {
      const apiKey = await decryptSecret(row.api_key_ciphertext!, ctx.key);
      sent = await (deps.resend ?? sendViaResend)(apiKey, params);
    } else {
      const account = await getAccount(ctx.db, ctx.userEmail, row.account_id!);
      if (!account) throw new NotFoundError('cloudflare account for this domain not found');
      const token = await resolveAccountToken(ctx.db, ctx.key, account);
      const client = (deps.makeCfClient ?? ((t: string) => new CfClient(t)))(token);
      sent = await sendViaCloudflare(client, row.cf_account_id!, params);
    }
  } catch (e) {
    // 失败也写记录（审计完整），再向上重抛给路由映射 HTTP 状态；
    // 审计写入自身失败不得掩盖原始 provider 错误
    try {
      const error = e instanceof Error ? e.message : String(e);
      if (idempotencyKey) await finishEmailLog(ctx.db, ctx.userEmail, logId, 'failed', null, error);
      else await writeLog('failed', null, error);
    } catch (logError) {
      console.error('email_log write failed after send failure', logError);
    }
    throw e;
  }

  const delivered = sent.delivered ?? [];
  const queued = sent.queued ?? [];
  const permanentBounces = sent.permanentBounces ?? [];
  const acceptedCount = delivered.length + queued.length;
  const status: SendResult['status'] =
    permanentBounces.length === 0 ? 'sent' : acceptedCount === 0 ? 'failed' : 'partial';
  const error = permanentBounces.length ? `Permanent bounce: ${permanentBounces.join(', ')}` : null;
  let logged = true;
  try {
    if (idempotencyKey) {
      await finishEmailLog(ctx.db, ctx.userEmail, logId, status, sent.messageId, error);
    } else {
      await writeLog(status, sent.messageId, error);
    }
  } catch (logError) {
    // Provider 已经接受发送，绝不能因审计落库失败向客户端伪报“发送失败”，否则重试会造成重复邮件。
    logged = false;
    console.error('email_log write failed after provider accepted send', logError);
  }
  return {
    logId,
    status,
    messageId: sent.messageId,
    error,
    delivered,
    queued,
    permanentBounces,
    logged,
  };
}
