import type { CfClient } from '@/server/cf/client';
import type { ProviderSendOk, ProviderSendParams } from '@/server/email/types';

/** 不直接 fetch：Cloudflare API 只经 CfClient（sendEmail 方法），维持项目边界约定 */
export async function sendViaCloudflare(
  client: Pick<CfClient, 'sendEmail'>,
  cfAccountId: string,
  params: ProviderSendParams,
): Promise<ProviderSendOk> {
  const r = await client.sendEmail(cfAccountId, {
    from: params.fromName ? { address: params.from, name: params.fromName } : params.from,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject,
    html: params.html,
    text: params.text,
  });
  return { messageId: r.messageId ?? null };
}
