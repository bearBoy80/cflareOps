import { describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCode,
  getOAuthConfig,
  isOAuthEnabled,
  OAuthError,
  randomState,
  refreshAccessToken,
  selectAuthorizationRefreshCredential,
} from '@/server/cf/oauth';

const CONFIG = {
  clientId: 'client-123',
  redirectUri: 'https://app.example/api/accounts/oauth/callback',
  scopes: 'zone.read offline_access',
};

/** 断言 body 为 form-urlencoded 并解析成键值对 */
function formOf(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(init?.body));
}

describe('getOAuthConfig / isOAuthEnabled', () => {
  it('returns null when client id is missing', () => {
    expect(getOAuthConfig({})).toBeNull();
    expect(isOAuthEnabled({})).toBe(false);
  });

  it('derives redirect, de-duplicates configured scopes, and adds Email Sending permissions', () => {
    const cfg = getOAuthConfig(
      { CF_OAUTH_CLIENT_ID: 'c1', CF_OAUTH_SCOPES: 'zone.read offline_access zone.read' },
      'https://x.dev',
    );
    expect(cfg?.redirectUri).toBe('https://x.dev/api/accounts/oauth/callback');
    expect(cfg?.scopes.split(' ')).toEqual([
      'zone.read',
      'offline_access',
      'email-sending.read',
      'email-sending.write',
    ]);
    expect(isOAuthEnabled({ CF_OAUTH_CLIENT_ID: 'c1' })).toBe(true);
  });

  it('prefers explicit redirect uri over origin', () => {
    const cfg = getOAuthConfig(
      { CF_OAUTH_CLIENT_ID: 'c1', CF_OAUTH_REDIRECT_URI: 'https://fixed/cb' },
      'https://ignored.dev',
    );
    expect(cfg?.redirectUri).toBe('https://fixed/cb');
  });
});

describe('buildAuthorizeUrl / PKCE / state', () => {
  it('includes all required authorize params', () => {
    const url = new URL(buildAuthorizeUrl({ config: CONFIG, state: 'st', codeChallenge: 'chal' }));
    expect(url.origin + url.pathname).toBe('https://dash.cloudflare.com/oauth2/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get('scope')).toBe(CONFIG.scopes);
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('state is non-trivial and pkce challenge is sha256(verifier) base64url', async () => {
    expect(randomState().length).toBeGreaterThan(20);
    const { verifier, challenge } = await createPkcePair();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    let bin = '';
    for (const b of digest) bin += String.fromCharCode(b);
    const expected = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });
});

describe('exchangeCode', () => {
  it('posts form-urlencoded authorization_code with PKCE and no secret', async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(
        JSON.stringify({ access_token: 'oauth:at', refresh_token: 'oauth:rt', expires_in: 900, scope: 'zone.read' }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const tok = await exchangeCode({ config: CONFIG, code: 'the-code', codeVerifier: 'ver', fetchImpl });
    expect(tok).toEqual({ accessToken: 'oauth:at', refreshToken: 'oauth:rt', expiresIn: 900, scope: 'zone.read' });
    expect(captured!.url).toBe('https://dash.cloudflare.com/oauth2/token');
    const body = formOf(captured!.init);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('client_id')).toBe('client-123');
    expect(body.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(body.get('code_verifier')).toBe('ver');
    expect(body.get('client_secret')).toBeNull();
  });

  it('throws OAuthError on error response', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'bad code' }), {
        status: 400,
      })) as unknown as typeof fetch;
    await expect(exchangeCode({ config: CONFIG, code: 'x', codeVerifier: 'v', fetchImpl })).rejects.toBeInstanceOf(
      OAuthError,
    );
  });
});

describe('selectAuthorizationRefreshCredential', () => {
  it('prefers a newly returned refresh token', () => {
    expect(selectAuthorizationRefreshCredential('oauth:new', 'encrypted-old')).toEqual({
      kind: 'plain',
      value: 'oauth:new',
    });
  });

  it('keeps the encrypted existing token when reconnect omits a refresh token', () => {
    expect(selectAuthorizationRefreshCredential(null, 'encrypted-old')).toEqual({
      kind: 'encrypted',
      value: 'encrypted-old',
    });
  });

  it('rejects an initial authorization without any refresh token', () => {
    expect(selectAuthorizationRefreshCredential(null, null)).toBeNull();
  });
});

describe('refreshAccessToken', () => {
  it('posts refresh_token grant with only client_id', async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ access_token: 'oauth:at2', refresh_token: 'oauth:rt2', expires_in: 900 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const tok = await refreshAccessToken({ clientId: 'client-123', refreshToken: 'oauth:rt', fetchImpl });
    expect(tok.accessToken).toBe('oauth:at2');
    expect(tok.refreshToken).toBe('oauth:rt2');
    const body = formOf(captured);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('oauth:rt');
    expect(body.get('client_id')).toBe('client-123');
    expect(body.get('client_secret')).toBeNull();
  });

  it('defaults missing refresh_token to null and expires_in to 900', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ access_token: 'oauth:at3' }), { status: 200 })) as unknown as typeof fetch;
    const tok = await refreshAccessToken({ clientId: 'c', refreshToken: 'r', fetchImpl });
    expect(tok.refreshToken).toBeNull();
    expect(tok.expiresIn).toBe(900);
  });
});
