import type { APIRoute } from 'astro';
import { resolveAccountToken } from '@/server/cf/account';
import { CfClient } from '@/server/cf/client';
import { appContext, jsonError } from '@/server/context';
import { getAccount, updateAccountStatus } from '@/server/db/accounts';

export const POST: APIRoute = async ({ params, locals }) => {
  const { db, key, userEmail } = await appContext(locals);
  const account = await getAccount(db, userEmail, params.id!);
  if (!account) return jsonError('Account not found', 404);

  try {
    // OAuth 账号:先 resolveAccountToken(必要时刷新),再用 listAccounts 探活
    //（OAuth token 不支持 /user/tokens/verify);Token 账号沿用 verifyToken。
    const token = await resolveAccountToken(db, key, account);
    const client = new CfClient(token);
    if (account.auth_type === 'oauth') {
      await client.listAccounts();
    } else {
      const verify = await client.verifyToken();
      if (verify.status !== 'active') throw new Error(`token status: ${verify.status}`);
    }
    await updateAccountStatus(db, userEmail, account.id, 'active');
    return Response.json({ status: 'active' });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await updateAccountStatus(db, userEmail, account.id, 'error', message);
    return Response.json({ status: 'error', error: message });
  }
};
