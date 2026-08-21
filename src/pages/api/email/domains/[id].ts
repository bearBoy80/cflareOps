import type { APIRoute } from 'astro';
import { cfClientForAccount } from '@/server/cf/account';
import { CfApiError } from '@/server/cf/client';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { encryptSecret, sha256Hex } from '@/server/crypto';
import { getAccount } from '@/server/db/accounts';
import {
  deleteEmailDomain,
  findAuthorizedEmailZone,
  getUsableEmailDomain,
  updateEmailDomain,
} from '@/server/db/emailDomains';
import { type DomainBody, validateProviderFields } from './index';

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const body = (await request.json().catch(() => null)) as DomainBody | null;
  if (!body) return jsonError('provider is required', 400, 'fieldsRequired');
  const invalid = validateProviderFields(body);
  if (invalid) return invalid;

  const { db, key, userEmail } = await appContext(locals);
  const row = await getUsableEmailDomain(db, userEmail, params.id!);
  if (!row) return jsonError('Sending domain not found', 404, 'domainNotFound');

  const binding =
    body.provider === 'cloudflare' ? { accountId: body.accountId!, cfAccountId: body.cfAccountId! } : undefined;
  const zone = await findAuthorizedEmailZone(db, userEmail, row.domain, binding);
  if (!zone) {
    return jsonError('Domain is not visible to the selected Cloudflare authorization', 403, 'domainNotAuthorized');
  }

  if (body.provider === 'resend') {
    const apiKey = body.apiKey?.trim();
    // 换 key 时重新加密；留空且原来就是 resend → 保留旧凭证
    if (!apiKey && row.provider !== 'resend') return jsonError('apiKey is required for resend', 400, 'fieldsRequired');
    await updateEmailDomain(db, userEmail, row.id, {
      provider: 'resend',
      apiKeyCiphertext: apiKey ? await encryptSecret(apiKey, key) : row.api_key_ciphertext,
      apiKeyHash: apiKey ? await sha256Hex(apiKey) : row.api_key_hash,
      accountId: null,
      cfAccountId: null,
    });
  } else {
    const account = await getAccount(db, userEmail, body.accountId!);
    if (!account) {
      return jsonError('Account not found', 404, 'accountNotFound');
    }
    // 从 Resend 切换到 Cloudflare，或更换 Cloudflare 账号绑定时，也必须先完成
    // Email Sending onboard；失败则保留原配置，避免数据库出现“已切换但不可发送”的状态。
    if (row.provider !== 'cloudflare' || row.account_id !== body.accountId || row.cf_account_id !== body.cfAccountId) {
      try {
        const client = await cfClientForAccount(db, key, account);
        await client.onboardEmailSendingDomain(zone.zoneId, row.domain);
      } catch (e) {
        if (e instanceof CfApiError && (e.status === 401 || e.status === 403)) {
          return jsonError(e.message, e.status, 'emailOnboardForbidden');
        }
        return handleCfError(e);
      }
    }
    await updateEmailDomain(db, userEmail, row.id, {
      provider: 'cloudflare',
      apiKeyCiphertext: null,
      apiKeyHash: null,
      accountId: body.accountId!,
      cfAccountId: body.cfAccountId!,
    });
  }
  return Response.json({ ok: true });
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  const { db, userEmail } = await appContext(locals);
  if (!(await getUsableEmailDomain(db, userEmail, params.id!))) {
    return jsonError('Sending domain not found', 404, 'domainNotFound');
  }
  // email_log.domain_id ON DELETE SET NULL + 快照列：发送历史保留
  await deleteEmailDomain(db, userEmail, params.id!);
  return new Response(null, { status: 204 });
};
