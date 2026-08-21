import type { APIRoute } from 'astro';
import { CfClient } from '@/server/cf/client';
import {
  exchangeCode,
  getOAuthConfig,
  type OAuthTokens,
  selectAuthorizationRefreshCredential,
} from '@/server/cf/oauth';
import type { CfAccount } from '@/server/cf/types';
import { appContext } from '@/server/context';
import { decryptSecret, encryptSecret, sha256Hex } from '@/server/crypto';
import { getAccount, upsertOAuthAccount } from '@/server/db/accounts';
import { runtimeEnv } from '@/server/env';
import { syncAllZones } from '@/server/zones';
import { STATE_COOKIE } from './start';

/** 回跳落地页(zh 默认);带 connected/oauth_error 查询供前端 Toast。 */
function redirectAccounts(param: string): Response {
  return new Response(null, { status: 302, headers: { Location: `/accounts?${param}` } });
}

function logOAuthFailure(stage: string, error: unknown): void {
  // 不记录 code/access token/refresh token；仅保留失败阶段和上游异常供服务端诊断。
  console.error(`[oauth callback] ${stage} failed`, error);
}

export const GET: APIRoute = async ({ locals, request, cookies }) => {
  const { db, key, userEmail } = await appContext(locals);
  const env = runtimeEnv(locals);
  const url = new URL(request.url);

  const clearCookie = () => cookies.delete(STATE_COOKIE, { path: '/api/accounts/oauth' });

  // 用户在 dash 拒绝授权或上游报错
  const upstreamError = url.searchParams.get('error');
  if (upstreamError) {
    clearCookie();
    return redirectAccounts('oauth_error=denied');
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookie = cookies.get(STATE_COOKIE)?.value;
  clearCookie();
  if (!code || !state || !cookie) return redirectAccounts('oauth_error=state');

  // 校验加密 state cookie:解密 → state 一致 → 未过期
  let stored: { state: string; verifier: string; redirectUri: string; exp: number; reconnectId?: string | null };
  try {
    stored = JSON.parse(await decryptSecret(cookie, key));
  } catch {
    return redirectAccounts('oauth_error=state');
  }
  if (stored.state !== state || Date.now() > stored.exp) return redirectAccounts('oauth_error=state');

  const config = getOAuthConfig(env, url.origin);
  if (!config) return redirectAccounts('oauth_error=config');

  const reconnectAccount = stored.reconnectId ? await getAccount(db, userEmail, stored.reconnectId) : null;
  if (stored.reconnectId && reconnectAccount?.auth_type !== 'oauth') {
    return redirectAccounts('oauth_error=state');
  }

  let tokens: OAuthTokens;
  try {
    tokens = await exchangeCode({
      config: { ...config, redirectUri: stored.redirectUri },
      code,
      codeVerifier: stored.verifier,
    });
  } catch (error) {
    logOAuthFailure('token exchange', error);
    return redirectAccounts('oauth_error=exchange');
  }

  const refreshCredential = selectAuthorizationRefreshCredential(
    tokens.refreshToken,
    reconnectAccount?.oauth_refresh_encrypted,
  );
  if (!refreshCredential) {
    logOAuthFailure('refresh token', new Error('authorization response did not include a refresh token'));
    return redirectAccounts('oauth_error=refresh');
  }

  let cfAccounts: CfAccount[];
  try {
    // Cloudflare Access 已负责本应用的用户身份；这里只需 API 授权，不请求 OIDC openid/userinfo。
    // 初次连接用可见 CF 账号集合作为去重指纹；明确“重新授权”时沿用目标行的稳定标识。
    const client = new CfClient(tokens.accessToken);
    cfAccounts = await client.listAccounts();
  } catch (error) {
    logOAuthFailure('account discovery', error);
    return redirectAccounts('oauth_error=accounts');
  }
  if (cfAccounts.length === 0) return redirectAccounts('oauth_error=accounts');

  try {
    const client = new CfClient(tokens.accessToken);
    const accountIds = cfAccounts.map((account) => account.id).sort();
    const connectionIdentity = `${config.clientId}:${accountIds.join(',')}`;
    const connectionName = cfAccounts.length === 1 ? cfAccounts[0].name : `Cloudflare (${cfAccounts.length} accounts)`;
    const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();

    const saved = await upsertOAuthAccount(db, {
      id: crypto.randomUUID(),
      ownerEmail: userEmail,
      name: connectionName,
      tokenEncrypted: await encryptSecret(tokens.accessToken, key),
      // 明确重连时沿用本地稳定标识；授权范围增减不会改变连接 ID 或与缓存/邮件域名的关联。
      tokenHash: reconnectAccount?.token_hash ?? (await sha256Hex(`oauth:${connectionIdentity}`)),
      clientId: config.clientId,
      refreshEncrypted:
        refreshCredential.kind === 'plain'
          ? await encryptSecret(refreshCredential.value, key)
          : refreshCredential.value,
      expiresAt,
      scope: tokens.scope,
      sub: null,
      replaceId: stored.reconnectId ?? undefined,
    });
    const id = saved.id;

    // OAuth 回调成功后立即填充该连接的 Zone 缓存。即使 Zone 同步因权限
    // 或瞬时网络问题失败，也保留已经建立的 OAuth 连接，用户可稍后重试。
    try {
      await syncAllZones(db, key, userEmail, () => client, id);
    } catch {
      // syncAllZones 通常会自行收集并记录失败；这里只防止存储层异常把
      // 已成功的 OAuth 连接错误地呈现成 code exchange 失败。
    }
    return redirectAccounts('connected=1');
  } catch (error) {
    logOAuthFailure('account save', error);
    return redirectAccounts('oauth_error=save');
  }
};
