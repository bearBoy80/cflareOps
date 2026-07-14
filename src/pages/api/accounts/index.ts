import type { APIRoute } from 'astro';
import { CfApiError, CfClient } from '@/server/cf/client';
import { appContext, jsonError } from '@/server/context';
import { encryptSecret, sha256Hex } from '@/server/crypto';
import { insertAccount, listAccounts } from '@/server/db/accounts';

export const GET: APIRoute = async ({ locals, request }) => {
  const { db, userEmail } = await appContext(locals);
  const url = new URL(request.url);
  const rawPage = parseInt(url.searchParams.get('page') ?? '1', 10);
  const rawPageSize = parseInt(url.searchParams.get('pageSize') ?? '100', 10);
  const search = url.searchParams.get('search') ?? '';
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1 ? Math.min(100, rawPageSize) : 100;
  const result = await listAccounts(db, userEmail, { page, pageSize, search });
  return Response.json({ accounts: result.accounts, total: result.total, page, pageSize });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const body = (await request.json().catch(() => null)) as { name?: string; token?: string } | null;
  if (!body?.name?.trim() || !body?.token?.trim()) {
    return jsonError('name and token are required', 400, 'fieldsRequired');
  }

  try {
    const verify = await new CfClient(body.token).verifyToken();
    if (verify.status !== 'active') return jsonError(`Token is not active: ${verify.status}`, 400, 'tokenNotActive');
  } catch (e) {
    if (e instanceof CfApiError) return jsonError(`Token verification failed: ${e.message}`, 400, 'tokenVerifyFailed');
    throw e;
  }

  const { db, key, userEmail } = await appContext(locals);
  const id = crypto.randomUUID();
  try {
    await insertAccount(db, {
      id,
      ownerEmail: userEmail,
      name: body.name.trim(),
      tokenEncrypted: await encryptSecret(body.token, key),
      tokenHash: await sha256Hex(body.token),
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes('already exists')) {
      return jsonError('This token was already added', 409, 'duplicateToken');
    }
    throw e;
  }
  return Response.json({ account: { id, name: body.name.trim(), status: 'unchecked' } }, { status: 201 });
};
