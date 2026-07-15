import { CfClient } from '@/server/cf/client';
import { NotFoundError } from '@/server/context';
import { decryptSecret } from '@/server/crypto';
import { getAccount } from '@/server/db/accounts';
import { getEmailDomain } from '@/server/db/emailDomains';
import { insertEmailLog } from '@/server/db/emailLog';
import type { Db } from '@/server/db/types';
import { sendViaCloudflare } from './providers/cloudflare';
import { sendViaResend } from './providers/resend';
import { renderBody } from './render';
import { type EmailMessage, EmailValidationError, type SendResult } from './types';

/** 测试注入口：风格同 syncAllZones 的 makeClient 参数 */
export interface SendDeps {
  makeCfClient?: (token: string) => Pick<CfClient, 'sendEmail'>;
  resend?: typeof sendViaResend;
}

export async function sendEmail(
  ctx: { db: Db; key: CryptoKey; userEmail: string },
  domainId: string,
  msg: EmailMessage,
  deps: SendDeps = {},
): Promise<SendResult> {
  const row = await getEmailDomain(ctx.db, ctx.userEmail, domainId);
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
  const writeLog = (status: 'sent' | 'failed', messageId: string | null, error: string | null) =>
    insertEmailLog(ctx.db, {
      id: logId,
      ownerEmail: ctx.userEmail,
      domainId: row.id,
      provider: row.provider,
      fromAddress: msg.from,
      recipients: { to: msg.to, cc: msg.cc ?? [], bcc: msg.bcc ?? [] },
      subject: msg.subject,
      format: msg.format,
      content: msg.content,
      status,
      messageId,
      error,
    });

  try {
    let messageId: string | null;
    if (row.provider === 'resend') {
      const apiKey = await decryptSecret(row.api_key_ciphertext!, ctx.key);
      ({ messageId } = await (deps.resend ?? sendViaResend)(apiKey, params));
    } else {
      const account = await getAccount(ctx.db, ctx.userEmail, row.account_id!);
      if (!account) throw new NotFoundError('cloudflare account for this domain not found');
      const token = await decryptSecret(account.token_encrypted, ctx.key);
      const client = (deps.makeCfClient ?? ((t: string) => new CfClient(t)))(token);
      ({ messageId } = await sendViaCloudflare(client, row.cf_account_id!, params));
    }
    await writeLog('sent', messageId, null);
    return { logId, status: 'sent', messageId, error: null };
  } catch (e) {
    // 失败也写记录（审计完整），再向上重抛给路由映射 HTTP 状态；
    // 审计写入自身失败不得掩盖原始 provider 错误
    try {
      await writeLog('failed', null, e instanceof Error ? e.message : String(e));
    } catch (logError) {
      console.error('email_log write failed after send failure', logError);
    }
    throw e;
  }
}
