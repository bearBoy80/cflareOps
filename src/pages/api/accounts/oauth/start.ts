import type { APIRoute } from 'astro';
import { buildAuthorizeUrl, createPkcePair, getOAuthConfig, randomState } from '@/server/cf/oauth';
import { appContext, jsonError } from '@/server/context';
import { encryptSecret } from '@/server/crypto';
import { getAccount } from '@/server/db/accounts';
import { runtimeEnv } from '@/server/env';

export const STATE_COOKIE = 'cf_oauth_state';
const STATE_TTL_MS = 600_000; // 10 分钟

/**
 * 发起「用 Cloudflare 授权」:生成 state + PKCE,把 {state, verifier, redirectUri, exp}
 * 用 ENCRYPTION_KEY 加密写入 HttpOnly cookie(防 CSRF/篡改),302 跳 dash 授权页。
 */
export const GET: APIRoute = async ({ locals, request, cookies }) => {
  const { db, key, userEmail } = await appContext(locals);
  const env = runtimeEnv(locals);
  const origin = new URL(request.url).origin;
  const config = getOAuthConfig(env, origin);
  if (!config) return jsonError('OAuth is not configured', 404, 'oauthNotConfigured');
  const reconnectId = new URL(request.url).searchParams.get('reconnect');
  if (reconnectId) {
    const account = await getAccount(db, userEmail, reconnectId);
    if (!account || account.auth_type !== 'oauth') {
      return jsonError('OAuth account not found', 404, 'accountNotFound');
    }
  }

  const state = randomState();
  const { verifier, challenge } = await createPkcePair();
  const payload = JSON.stringify({
    state,
    verifier,
    redirectUri: config.redirectUri,
    exp: Date.now() + STATE_TTL_MS,
    reconnectId,
  });

  cookies.set(STATE_COOKIE, await encryptSecret(payload, key), {
    httpOnly: true,
    secure: new URL(request.url).protocol === 'https:',
    sameSite: 'lax',
    path: '/api/accounts/oauth',
    maxAge: STATE_TTL_MS / 1000,
  });

  return new Response(null, {
    status: 302,
    headers: { Location: buildAuthorizeUrl({ config, state, codeChallenge: challenge }) },
  });
};
