import type { APIRoute } from 'astro';
import { appContext, jsonError } from '@/server/context';
import { encryptSecret, sha256Hex } from '@/server/crypto';
import { getAccount } from '@/server/db/accounts';
import { insertEmailDomain, listEmailDomains, toPublic } from '@/server/db/emailDomains';

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

export const GET: APIRoute = async ({ locals }) => {
  const { db, userEmail } = await appContext(locals);
  const page = await listEmailDomains(db, userEmail);
  return Response.json({ domains: page.domains.map(toPublic) });
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
  if (body.provider === 'cloudflare' && !(await getAccount(db, userEmail, body.accountId!))) {
    return jsonError('Account not found', 404, 'accountNotFound');
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
  return Response.json({ domain: { id, domain, provider: body.provider } }, { status: 201 });
};
