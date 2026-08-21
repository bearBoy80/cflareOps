import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import { resolveAccountToken } from '@/server/cf/account';
import { decryptSecret, encryptSecret, importEncryptionKey } from '@/server/crypto';
import { getAccount, insertAccount, upsertOAuthAccount } from '@/server/db/accounts';

const HEX_KEY = 'c'.repeat(64);
const ALICE = 'alice@ops.dev';

const neverFetch = (async () => {
  throw new Error('fetch must not be called');
}) as unknown as typeof fetch;

describe('resolveAccountToken', () => {
  it('token account: decrypts without any network call', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await insertAccount(db, {
      id: 'a1',
      ownerEmail: ALICE,
      name: 'tok',
      tokenEncrypted: await encryptSecret('api-token', key),
      tokenHash: 'h1',
    });
    const row = await getAccount(db, ALICE, 'a1');
    expect(await resolveAccountToken(db, key, row!, neverFetch)).toBe('api-token');
  });

  async function seedOAuth(db: ReturnType<typeof createTestDb>, key: CryptoKey, expiresAt: string) {
    await upsertOAuthAccount(db, {
      id: 'o1',
      ownerEmail: ALICE,
      name: 'oauth',
      tokenEncrypted: await encryptSecret('oauth:at', key),
      tokenHash: 'oauth:sub-1',
      clientId: 'client-123',
      refreshEncrypted: await encryptSecret('oauth:rt', key),
      expiresAt,
      scope: 'zone.read',
      sub: 'sub-1',
    });
  }

  it('oauth account not near expiry: returns stored access token, no refresh', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedOAuth(db, key, new Date(Date.now() + 10 * 60_000).toISOString());
    const row = await getAccount(db, ALICE, 'o1');
    expect(await resolveAccountToken(db, key, row!, neverFetch)).toBe('oauth:at');
  });

  it('oauth account expired: refreshes, persists rotated tokens, returns new access token', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedOAuth(db, key, new Date(Date.now() - 1000).toISOString());

    let refreshBody: URLSearchParams | null = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      refreshBody = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify({ access_token: 'oauth:at2', refresh_token: 'oauth:rt2', expires_in: 900 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const row = await getAccount(db, ALICE, 'o1');
    const token = await resolveAccountToken(db, key, row!, fetchImpl);
    expect(token).toBe('oauth:at2');
    expect(refreshBody!.get('grant_type')).toBe('refresh_token');
    expect(refreshBody!.get('refresh_token')).toBe('oauth:rt');

    // 回写:DB 里 access/refresh 已轮换、过期时间前移
    const after = await getAccount(db, ALICE, 'o1');
    expect(await decryptSecret(after!.token_encrypted, key)).toBe('oauth:at2');
    expect(await decryptSecret(after!.oauth_refresh_encrypted!, key)).toBe('oauth:rt2');
    expect(Date.parse(after!.oauth_expires_at!)).toBeGreaterThan(Date.now());
  });

  it('oauth refresh that omits refresh_token keeps the previous one', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedOAuth(db, key, new Date(Date.now() - 1000).toISOString());
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ access_token: 'oauth:at9', expires_in: 900 }), {
        status: 200,
      })) as unknown as typeof fetch;
    const row = await getAccount(db, ALICE, 'o1');
    await resolveAccountToken(db, key, row!, fetchImpl);
    const after = await getAccount(db, ALICE, 'o1');
    expect(await decryptSecret(after!.oauth_refresh_encrypted!, key)).toBe('oauth:rt');
  });

  it('serializes concurrent refreshes so a rotated refresh token is consumed only once', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedOAuth(db, key, new Date(Date.now() - 1000).toISOString());
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(
        JSON.stringify({ access_token: 'oauth:concurrent', refresh_token: 'oauth:rotated', expires_in: 900 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const stale = (await getAccount(db, ALICE, 'o1'))!;
    const [a, b] = await Promise.all([
      resolveAccountToken(db, key, stale, fetchImpl),
      resolveAccountToken(db, key, stale, fetchImpl),
    ]);
    expect([a, b]).toEqual(['oauth:concurrent', 'oauth:concurrent']);
    expect(calls).toBe(1);
  });
});

describe('upsertOAuthAccount', () => {
  it('stores oauth metadata and reuses the connection matched by owner + token_hash', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    const base = {
      ownerEmail: ALICE,
      name: 'oauth',
      tokenEncrypted: await encryptSecret('oauth:at', key),
      tokenHash: 'oauth:sub-1',
      clientId: 'client-123',
      refreshEncrypted: await encryptSecret('oauth:rt', key),
      expiresAt: new Date().toISOString(),
      scope: 'zone.read',
      sub: 'sub-1',
    };
    await upsertOAuthAccount(db, { id: 'o1', ...base });
    const row = await getAccount(db, ALICE, 'o1');
    expect(row?.auth_type).toBe('oauth');
    expect(row?.oauth_client_id).toBe('client-123');
    expect(row?.oauth_sub).toBe('sub-1');
    expect(row?.status).toBe('active');
    expect(await upsertOAuthAccount(db, { id: 'o2', ...base })).toEqual({ id: 'o1', created: false });
  });

  it('replaces the explicitly reconnected OAuth row without changing its stable identity', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    const base = {
      ownerEmail: ALICE,
      name: 'oauth',
      tokenEncrypted: await encryptSecret('oauth:at', key),
      tokenHash: 'oauth:old-set',
      clientId: 'client-123',
      refreshEncrypted: await encryptSecret('oauth:rt', key),
      expiresAt: new Date().toISOString(),
      scope: 'zone.read',
      sub: null,
    };
    await upsertOAuthAccount(db, { id: 'o1', ...base });
    const saved = await upsertOAuthAccount(db, {
      id: 'new-id',
      ...base,
      tokenHash: 'oauth:old-set',
      replaceId: 'o1',
    });
    expect(saved).toEqual({ id: 'o1', created: false });
    expect((await getAccount(db, ALICE, 'o1'))?.token_hash).toBe('oauth:old-set');
  });
});
