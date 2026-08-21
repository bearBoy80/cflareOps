// Cloudflare self-managed OAuth(2026-06 GA)协议封装:public client + PKCE(无 client secret),
// 同 wrangler / cf CLI。仅与 dash.cloudflare.com 的 OAuth 端点通信,不碰 api.cloudflare.com。
// 授权码换 token / 刷新均注入 fetchImpl 便于单测。

const AUTHORIZE_URL = 'https://dash.cloudflare.com/oauth2/auth';
const TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
const TOKEN_TIMEOUT_MS = 12_000;

/** 邮件域名 Onboard 与发信功能必需；即使环境变量漏配也始终向 OAuth Client 请求。 */
export const REQUIRED_OAUTH_SCOPES = ['email-sending.read', 'email-sending.write'] as const;

/** 无 code_verifier 也能兑换的 token 端点错误统一形态,路由据此给友好文案(不回显原始细节)。 */
export class OAuthError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export interface OAuthConfig {
  clientId: string;
  redirectUri: string;
  scopes: string; // 空格分隔的 Self-managed OAuth scope ID，与 OAuth Client 允许列表一致
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null; // 刷新未回则为 null,调用方保留旧值
  expiresIn: number; // 秒
  scope: string | null;
}

export type OAuthRefreshCredential = { kind: 'plain'; value: string } | { kind: 'encrypted'; value: string };

/**
 * 授权码兑换在重新同意授权时可能只返回新的 access token。此时沿用该连接
 * 已保存的 refresh token；首次连接没有旧凭证时仍视为 OAuth Client 配置错误。
 */
export function selectAuthorizationRefreshCredential(
  receivedRefreshToken: string | null,
  existingEncryptedRefreshToken?: string | null,
): OAuthRefreshCredential | null {
  if (receivedRefreshToken) return { kind: 'plain', value: receivedRefreshToken };
  if (existingEncryptedRefreshToken) return { kind: 'encrypted', value: existingEncryptedRefreshToken };
  return null;
}

/** workerd 的 fetch 校验 this 指向:统一绑回 globalThis(注入的测试 fetch 绑定亦无害)。 */
function bindFetch(fetchImpl: typeof fetch): typeof fetch {
  return fetchImpl.bind(globalThis);
}

/**
 * 读取并校验 OAuth 配置。client_id 缺失即视为未启用 → 返回 null。
 * redirect_uri 缺省时由请求 origin 推导(须与注册值一致,推荐显式配置)。
 */
export function getOAuthConfig(
  env: { CF_OAUTH_CLIENT_ID?: string; CF_OAUTH_REDIRECT_URI?: string; CF_OAUTH_SCOPES?: string },
  requestOrigin?: string,
): OAuthConfig | null {
  const clientId = env.CF_OAUTH_CLIENT_ID?.trim();
  if (!clientId) return null;
  const redirectUri =
    env.CF_OAUTH_REDIRECT_URI?.trim() || (requestOrigin ? `${requestOrigin}/api/accounts/oauth/callback` : '');
  if (!redirectUri) return null;
  const configured = (env.CF_OAUTH_SCOPES ?? '').trim();
  const scopes = new Set(configured.split(/\s+/).filter(Boolean));
  for (const scope of REQUIRED_OAUTH_SCOPES) scopes.add(scope);
  return { clientId, redirectUri, scopes: Array.from(scopes).join(' ') };
}

export function isOAuthEnabled(env: {
  CF_OAUTH_CLIENT_ID?: string;
  CF_OAUTH_REDIRECT_URI?: string;
  CF_OAUTH_SCOPES?: string;
}): boolean {
  return Boolean(env.CF_OAUTH_CLIENT_ID?.trim());
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** CSRF state:随机不可预测串。 */
export function randomState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

/** PKCE(S256):verifier 为高熵随机,challenge = base64url(sha256(verifier))。 */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64UrlEncode(digest) };
}

export function buildAuthorizeUrl(opts: { config: OAuthConfig; state: string; codeChallenge: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', opts.config.clientId);
  url.searchParams.set('redirect_uri', opts.config.redirectUri);
  url.searchParams.set('scope', opts.config.scopes);
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function postToken(body: URLSearchParams, fetchImpl: typeof fetch): Promise<OAuthTokens> {
  const res = await bindFetch(fetchImpl)(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  } | null;
  if (!res.ok || !json || json.error || !json.access_token) {
    const msg = json?.error_description || json?.error || `token endpoint error (HTTP ${res.status})`;
    throw new OAuthError(msg, res.status);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : 900,
    scope: json.scope ?? null,
  };
}

export function exchangeCode(opts: {
  config: OAuthConfig;
  code: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
}): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    client_id: opts.config.clientId,
    redirect_uri: opts.config.redirectUri,
    code_verifier: opts.codeVerifier,
  });
  return postToken(body, opts.fetchImpl ?? fetch);
}

export function refreshAccessToken(opts: {
  clientId: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
  });
  return postToken(body, opts.fetchImpl ?? fetch);
}
