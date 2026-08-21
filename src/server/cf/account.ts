// 账号 token 解析的唯一 choke point:token 账号直解密;oauth 账号惰性续期(过期前 60s)。
// 续期所需 client_id / refresh_token / 过期时间全在账号行里,故对上层(clientForAccount、
// 各同步 fan-out)完全透明——无需向调用方传任何 OAuth 配置。

import { decryptSecret, encryptSecret } from '../crypto';
import { getAccount, releaseOAuthRefresh, tryClaimOAuthRefresh, updateOAuthTokens } from '../db/accounts';
import type { Db } from '../db/types';
import { CfClient } from './client';
import { refreshAccessToken } from './oauth';

/** resolveAccountToken 所需的账号行子集(fan-out 的窄 SELECT 与 getAccount 的整行均满足)。 */
export interface ResolvableAccount {
  id: string;
  owner_email: string;
  token_encrypted: string;
  auth_type?: string | null;
  oauth_client_id?: string | null;
  oauth_refresh_encrypted?: string | null;
  oauth_expires_at?: string | null;
}

/** 各同步 fan-out 的窄 SELECT 复用此列集,确保 resolveAccountToken 拿到续期所需全部字段。 */
export const ACCOUNT_TOKEN_COLUMNS =
  'id, owner_email, token_encrypted, auth_type, oauth_client_id, oauth_refresh_encrypted, oauth_expires_at';

export type AccountTokenRow = {
  id: string;
  owner_email: string;
  token_encrypted: string;
  auth_type: string;
  oauth_client_id: string | null;
  oauth_refresh_encrypted: string | null;
  oauth_expires_at: string | null;
};

const REFRESH_SKEW_MS = 60_000;
const REFRESH_LOCK_MS = 15_000;
// token 端点 12s 超时；等待方覆盖该窗口，claim 租约再留 3s 写库余量。
const REFRESH_WAIT_ATTEMPTS = 260;

function tokenIsFresh(expiresAt: string | null | undefined): boolean {
  const exp = expiresAt ? Date.parse(expiresAt) : 0;
  return Number.isFinite(exp) && exp > 0 && Date.now() < exp - REFRESH_SKEW_MS;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 返回该账号「当前有效」的 CF API token(access token / API Token)。
 * oauth 账号过期(或即将过期)时刷新并原子回写轮换后的凭证。
 */
export async function resolveAccountToken(
  db: Db,
  key: CryptoKey,
  account: ResolvableAccount,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if ((account.auth_type ?? 'token') !== 'oauth') {
    return decryptSecret(account.token_encrypted, key);
  }

  if (tokenIsFresh(account.oauth_expires_at)) {
    return decryptSecret(account.token_encrypted, key);
  }

  // 先重读，避免调用方持有的旧行导致已经刷新过的 token 再次被刷新。
  let current = (await getAccount(db, account.owner_email, account.id)) ?? account;
  if (tokenIsFresh(current.oauth_expires_at)) return decryptSecret(current.token_encrypted, key);

  let claimed = false;
  for (let attempt = 0; attempt < REFRESH_WAIT_ATTEMPTS; attempt++) {
    const now = new Date();
    claimed = await tryClaimOAuthRefresh(
      db,
      account.owner_email,
      account.id,
      current.oauth_expires_at ?? null,
      now.toISOString(),
      new Date(now.getTime() + REFRESH_LOCK_MS).toISOString(),
    );
    if (claimed) break;
    await wait(50);
    const latest = await getAccount(db, account.owner_email, account.id);
    if (!latest) throw new Error('OAuth account no longer exists');
    if (tokenIsFresh(latest.oauth_expires_at)) return decryptSecret(latest.token_encrypted, key);
    current = latest;
  }
  if (!claimed) throw new Error('OAuth token refresh is already in progress — retry shortly');

  if (!current.oauth_client_id || !current.oauth_refresh_encrypted) {
    await releaseOAuthRefresh(db, account.owner_email, account.id);
    throw new Error('OAuth account is missing refresh credentials — reconnect required');
  }
  try {
    const refreshToken = await decryptSecret(current.oauth_refresh_encrypted, key);
    const tok = await refreshAccessToken({ clientId: current.oauth_client_id, refreshToken, fetchImpl });
    const expiresAt = new Date(Date.now() + tok.expiresIn * 1000).toISOString();
    // CF 会轮换 refresh token;未回则保留旧值
    const nextRefresh = tok.refreshToken ?? refreshToken;
    await updateOAuthTokens(db, account.owner_email, account.id, {
      tokenEncrypted: await encryptSecret(tok.accessToken, key),
      refreshEncrypted: await encryptSecret(nextRefresh, key),
      expiresAt,
    });
    return tok.accessToken;
  } catch (e) {
    await releaseOAuthRefresh(db, account.owner_email, account.id);
    throw e;
  }
}

export async function cfClientForAccount(
  db: Db,
  key: CryptoKey,
  account: ResolvableAccount,
  fetchImpl: typeof fetch = fetch,
): Promise<CfClient> {
  return new CfClient(await resolveAccountToken(db, key, account, fetchImpl));
}
