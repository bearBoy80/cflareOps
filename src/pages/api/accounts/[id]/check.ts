import type { APIRoute } from 'astro';
import { CfClient } from '../../../../server/cf/client';
import { appContext, jsonError } from '../../../../server/context';
import { decryptSecret } from '../../../../server/crypto';
import { getAccount, updateAccountStatus } from '../../../../server/db/accounts';

export const POST: APIRoute = async ({ params, locals }) => {
  const { db, key, userEmail } = await appContext(locals);
  const account = await getAccount(db, userEmail, params.id!);
  if (!account) return jsonError('Account not found', 404);

  try {
    const token = await decryptSecret(account.token_encrypted, key);
    const verify = await new CfClient(token).verifyToken();
    if (verify.status !== 'active') throw new Error(`token status: ${verify.status}`);
    await updateAccountStatus(db, account.id, 'active');
    return Response.json({ status: 'active' });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await updateAccountStatus(db, account.id, 'error', message);
    return Response.json({ status: 'error', error: message });
  }
};
