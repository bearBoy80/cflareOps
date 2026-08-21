import type { APIRoute } from 'astro';
import { CfApiError, CfClient } from '@/server/cf/client';
import { appContext, jsonError } from '@/server/context';
import { encryptSecret, sha256Hex } from '@/server/crypto';
import { deleteAccount, getAccount, updateAccount } from '@/server/db/accounts';

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const body = (await request.json().catch(() => null)) as { name?: string; token?: string } | null;
  const name = body?.name?.trim();
  if (!name) return jsonError('name is required', 400, 'nameRequired');

  const { db, key, userEmail } = await appContext(locals);
  const id = params.id!;
  const existingAccount = await getAccount(db, userEmail, id);
  if (!existingAccount) return jsonError('Account not found', 404, 'accountNotFound');

  // OAuth 账号凭证由授权托管,不接受手动换 Token(否则会与 oauth_* 列不一致);仅允许改名
  const token = existingAccount.auth_type === 'oauth' ? undefined : body?.token?.trim();
  if (token) {
    try {
      const verify = await new CfClient(token).verifyToken();
      if (verify.status !== 'active') return jsonError(`Token is not active: ${verify.status}`, 400, 'tokenNotActive');
    } catch (e) {
      if (e instanceof CfApiError)
        return jsonError(`Token verification failed: ${e.message}`, 400, 'tokenVerifyFailed');
      throw e;
    }
    try {
      await updateAccount(db, userEmail, id, {
        name,
        tokenEncrypted: await encryptSecret(token, key),
        tokenHash: await sha256Hex(token),
      });
    } catch (e) {
      if (e instanceof Error && e.message.includes('already exists')) {
        return jsonError('This token was already added', 409, 'duplicateToken');
      }
      throw e;
    }
  } else {
    await updateAccount(db, userEmail, id, { name });
  }
  return Response.json({ ok: true });
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  const { db, userEmail } = await appContext(locals);
  const id = params.id!;
  if (!(await getAccount(db, userEmail, id))) return jsonError('Account not found', 404, 'accountNotFound');
  await deleteAccount(db, userEmail, id);
  return new Response(null, { status: 204 });
};
