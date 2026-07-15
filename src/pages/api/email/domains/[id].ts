import type { APIRoute } from 'astro';
import { appContext, jsonError } from '@/server/context';
import { encryptSecret, sha256Hex } from '@/server/crypto';
import { getAccount } from '@/server/db/accounts';
import { deleteEmailDomain, getEmailDomain, updateEmailDomain } from '@/server/db/emailDomains';
import { type DomainBody, validateProviderFields } from './index';

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const body = (await request.json().catch(() => null)) as DomainBody | null;
  if (!body) return jsonError('provider is required', 400, 'fieldsRequired');
  const invalid = validateProviderFields(body);
  if (invalid) return invalid;

  const { db, key, userEmail } = await appContext(locals);
  const row = await getEmailDomain(db, userEmail, params.id!);
  if (!row) return jsonError('Sending domain not found', 404, 'domainNotFound');

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
    if (!(await getAccount(db, userEmail, body.accountId!))) {
      return jsonError('Account not found', 404, 'accountNotFound');
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
  if (!(await getEmailDomain(db, userEmail, params.id!))) {
    return jsonError('Sending domain not found', 404, 'domainNotFound');
  }
  // email_log.domain_id ON DELETE SET NULL + 快照列：发送历史保留
  await deleteEmailDomain(db, userEmail, params.id!);
  return new Response(null, { status: 204 });
};
