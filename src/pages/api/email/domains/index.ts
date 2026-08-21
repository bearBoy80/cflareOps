import type { APIRoute } from 'astro';
import { resolveAccountToken } from '@/server/cf/account';
import { CfApiError, CfClient } from '@/server/cf/client';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { encryptSecret, sha256Hex } from '@/server/crypto';
import { getAccount } from '@/server/db/accounts';
import { findAuthorizedEmailZone, insertEmailDomain, listUsableEmailDomains, toPublic } from '@/server/db/emailDomains';

export const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export interface DomainBody {
  domain?: string;
  provider?: string;
  apiKey?: string;
  accountId?: string;
  cfAccountId?: string;
}

/** POST/PUT 共用的 provider 凭证校验；通过时返回 null，否则返回错误 Response */
export function validateProviderFields(body: DomainBody): Response | null {
  if (body.provider !== 'resend' && body.provider !== 'cloudflare') {
    return jsonError('provider must be resend or cloudflare', 400, 'fieldsRequired');
  }
  if (body.provider === 'cloudflare' && (!body.accountId || !body.cfAccountId)) {
    return jsonError('accountId and cfAccountId are required for cloudflare', 400, 'fieldsRequired');
  }
  return null;
}

export const GET: APIRoute = async ({ locals, request }) => {
  const { db, userEmail } = await appContext(locals);
  const url = new URL(request.url);
  const rawPage = parseInt(url.searchParams.get('page') ?? '1', 10);
  const rawPageSize = parseInt(url.searchParams.get('pageSize') ?? '20', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1 ? Math.min(100, rawPageSize) : 20;
  const { domains, total } = await listUsableEmailDomains(db, userEmail, { page, pageSize });
  return Response.json({ domains: domains.map(toPublic), total, page, pageSize });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const body = (await request.json().catch(() => null)) as DomainBody | null;
  const domain = body?.domain?.trim().toLowerCase();
  if (!body || !domain || !DOMAIN_RE.test(domain)) return jsonError('invalid domain', 400, 'invalidDomain');
  const invalid = validateProviderFields(body);
  if (invalid) return invalid;
  if (body.provider === 'resend' && !body.apiKey?.trim()) {
    return jsonError('apiKey is required for resend', 400, 'fieldsRequired');
  }

  const { db, key, userEmail } = await appContext(locals);
  const account = body.provider === 'cloudflare' ? await getAccount(db, userEmail, body.accountId!) : null;
  if (body.provider === 'cloudflare' && !account) {
    return jsonError('Account not found', 404, 'accountNotFound');
  }
  const binding =
    body.provider === 'cloudflare' ? { accountId: body.accountId!, cfAccountId: body.cfAccountId! } : undefined;
  const zone = await findAuthorizedEmailZone(db, userEmail, domain, binding);
  if (!zone) {
    return jsonError('Domain is not visible to the selected Cloudflare authorization', 403, 'domainNotAuthorized');
  }

  // Cloudflare provider 的“添加域名”同时完成 Email Sending Onboard。官方 API 会创建并
  // 托管 cf-bounce MX/SPF、DKIM 与 DMARC；上游失败时不写本地配置，避免出现不可用域名。
  let emailSending: { enabled: boolean; dkimSelector: string | null; returnPathDomain: string | null } | undefined;
  if (body.provider === 'cloudflare') {
    try {
      const token = await resolveAccountToken(db, key, account!);
      const onboarded = await new CfClient(token).onboardEmailSendingDomain(zone.zoneId, domain);
      emailSending = {
        enabled: onboarded.enabled,
        dkimSelector: onboarded.dkimSelector,
        returnPathDomain: onboarded.returnPathDomain,
      };
    } catch (e) {
      if (e instanceof CfApiError && (e.status === 401 || e.status === 403)) {
        return jsonError(e.message, e.status, 'emailOnboardForbidden');
      }
      return handleCfError(e);
    }
  }

  const apiKey = body.apiKey?.trim();
  const id = crypto.randomUUID();
  try {
    await insertEmailDomain(db, {
      id,
      ownerEmail: userEmail,
      domain,
      provider: body.provider as 'resend' | 'cloudflare',
      apiKeyCiphertext: body.provider === 'resend' ? await encryptSecret(apiKey!, key) : null,
      apiKeyHash: body.provider === 'resend' ? await sha256Hex(apiKey!) : null,
      accountId: body.provider === 'cloudflare' ? body.accountId! : null,
      cfAccountId: body.provider === 'cloudflare' ? body.cfAccountId! : null,
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes('already configured')) {
      return jsonError('This domain is already configured', 409, 'duplicateDomain');
    }
    throw e;
  }
  return Response.json({ domain: { id, domain, provider: body.provider }, emailSending }, { status: 201 });
};
