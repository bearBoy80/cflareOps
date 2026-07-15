import { Resend } from 'resend';
import { CfApiError } from '@/server/cf/client';
import type { ProviderSendOk, ProviderSendParams } from '@/server/email/types';

/** Resend 官方错误名 → HTTP 状态（对齐 resend.com/docs/api-reference/errors），未知名归 502（上游错误） */
const RESEND_ERROR_STATUS: Record<string, number> = {
  validation_error: 400,
  missing_required_field: 422,
  invalid_from_address: 422,
  invalid_attachment: 422,
  missing_api_key: 401,
  restricted_api_key: 401,
  invalid_api_key: 403,
  not_found: 404,
  rate_limit_exceeded: 429,
  daily_quota_exceeded: 429,
};

/** resend SDK 的最小结构面：便于测试注入替身（真实 Resend 实例结构兼容） */
export interface ResendClient {
  emails: {
    send(payload: Record<string, unknown>): Promise<{
      data: { id: string } | null;
      error: { name: string; message: string } | null;
    }>;
  };
}

export async function sendViaResend(
  apiKey: string,
  params: ProviderSendParams,
  makeClient: (apiKey: string) => ResendClient = (k) => new Resend(k) as unknown as ResendClient,
): Promise<ProviderSendOk> {
  const { data, error } = await makeClient(apiKey).emails.send({
    from: params.fromName ? `${params.fromName} <${params.from}>` : params.from,
    to: params.to,
    subject: params.subject,
    ...(params.cc?.length ? { cc: params.cc } : {}),
    ...(params.bcc?.length ? { bcc: params.bcc } : {}),
    ...(params.html ? { html: params.html } : {}),
    ...(params.text ? { text: params.text } : {}),
  });
  // resend SDK 不抛错而是返回 {data, error}：归一化为 CfApiError，与 CF 侧错误同走 handleCfError 映射
  if (error) throw new CfApiError(RESEND_ERROR_STATUS[error.name] ?? 502, [error.message]);
  return { messageId: data?.id ?? null };
}
