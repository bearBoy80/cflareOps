import type { APIRoute } from 'astro';
import { CfClient } from '@/server/cf/client';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { decryptSecret } from '@/server/crypto';
import { getAccount } from '@/server/db/accounts';

/** 该账号 token 可见的 CF 侧账号列表：email 域名配置（provider=cloudflare）的二级下拉用 */
export const GET: APIRoute = async ({ params, locals }) => {
  const { db, key, userEmail } = await appContext(locals);
  const account = await getAccount(db, userEmail, params.id!);
  if (!account) return jsonError('Account not found', 404, 'accountNotFound');
  try {
    const token = await decryptSecret(account.token_encrypted, key);
    const cfAccounts = await new CfClient(token).listAccounts();
    return Response.json({ cfAccounts });
  } catch (e) {
    return handleCfError(e);
  }
};
