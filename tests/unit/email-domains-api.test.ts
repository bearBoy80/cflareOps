import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it, vi } from 'vitest';
import { GET as getCfAccounts } from '@/pages/api/accounts/[id]/cf-accounts';
import { DELETE, PUT } from '@/pages/api/email/domains/[id]';
import { GET, POST } from '@/pages/api/email/domains/index';
import { CfApiError, CfClient } from '@/server/cf/client';
import { encryptSecret, importEncryptionKey } from '@/server/crypto';
import { insertAccount } from '@/server/db/accounts';
import { getEmailDomain } from '@/server/db/emailDomains';
import type { Db } from '@/server/db/types';

const HEX_KEY = 'e'.repeat(64);
const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';

function ctx(
  db: unknown,
  opts: { method?: string; body?: unknown; userEmail?: string; id?: string; query?: string } = {},
) {
  const url = `http://localhost/api/email/domains${opts.query ?? ''}`;
  return {
    locals: { userEmail: opts.userEmail ?? ALICE, runtime: { env: { DB: db, ENCRYPTION_KEY: HEX_KEY } } },
    request: new Request(url, {
      method: opts.method ?? 'GET',
      ...(opts.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) } : {}),
    }),
    params: opts.id ? { id: opts.id } : {},
  } as unknown as Parameters<typeof POST>[0];
}

async function createResendDomain(db: Db, domain = 'mail.example.com'): Promise<string> {
  await seedAuthorizedZone(db, ALICE);
  const res = await POST(ctx(db, { method: 'POST', body: { domain, provider: 'resend', apiKey: 're_key_1' } }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { domain: { id: string } };
  return body.domain.id;
}

async function seedAuthorizedZone(db: Db, ownerEmail: string, accountId = `acct-${ownerEmail}`): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO cf_accounts
       (id, owner_email, name, token_encrypted, token_hash, created_at, updated_at)
       VALUES (?, ?, ?, 'enc', ?, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`,
    )
    .bind(accountId, ownerEmail, accountId, `hash-${accountId}`)
    .run();
  await db
    .prepare(
      `INSERT OR IGNORE INTO zones (id, account_id, name, cf_account_id, raw_json, synced_at)
       VALUES ('zone-example', ?, 'example.com', 'cf-1', '{}', '2026-08-20T00:00:00.000Z')`,
    )
    .bind(accountId)
    .run();
}

describe('email domains API', () => {
  it('POST validates domain format', async () => {
    const db = createTestDb();
    const res = await POST(
      ctx(db, { method: 'POST', body: { domain: 'not a domain', provider: 'resend', apiKey: 'k' } }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalidDomain');
  });

  it('POST requires provider-specific credentials', async () => {
    const db = createTestDb();
    const noKey = await POST(ctx(db, { method: 'POST', body: { domain: 'mail.example.com', provider: 'resend' } }));
    expect(noKey.status).toBe(400);
    const noAcct = await POST(
      ctx(db, { method: 'POST', body: { domain: 'mail.example.com', provider: 'cloudflare' } }),
    );
    expect(noAcct.status).toBe(400);
  });

  it('POST rejects a domain outside the current Cloudflare authorization', async () => {
    const db = createTestDb();
    await seedAuthorizedZone(db, ALICE);
    const res = await POST(
      ctx(db, { method: 'POST', body: { domain: 'class6x.com', provider: 'resend', apiKey: 're_key_1' } }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('domainNotAuthorized');
  });

  it('POST rejects a cloudflare accountId owned by another user with 404', async () => {
    const db = createTestDb();
    await insertAccount(db, { id: 'a1', ownerEmail: BOB, name: 'bob', tokenEncrypted: 'x', tokenHash: 'h1' });
    const res = await POST(
      ctx(db, {
        method: 'POST',
        body: { domain: 'mail.example.com', provider: 'cloudflare', accountId: 'a1', cfAccountId: 'cf-1' },
      }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('accountNotFound');
  });

  it('POST stores the resend key encrypted and GET never returns it', async () => {
    const db = createTestDb();
    const id = await createResendDomain(db);
    const row = (await getEmailDomain(db, ALICE, id))!;
    expect(row.api_key_ciphertext).not.toContain('re_key_1');
    const res = await GET(ctx(db));
    const text = await res.text();
    expect(text).not.toContain('re_key_1');
    expect(text).not.toContain(row.api_key_ciphertext);
    expect(text).toContain('"apiKeyHint"');
  });

  it('POST onboards a Cloudflare sending domain before storing it locally', async () => {
    const db = createTestDb();
    await seedAuthorizedZone(db, ALICE, 'a1');
    const key = await importEncryptionKey(HEX_KEY);
    await db
      .prepare('UPDATE cf_accounts SET token_encrypted = ? WHERE id = ? AND owner_email = ?')
      .bind(await encryptSecret('cf-token', key), 'a1', ALICE)
      .run();
    const onboard = vi.spyOn(CfClient.prototype, 'onboardEmailSendingDomain').mockResolvedValue({
      id: 'sending-1',
      name: 'mail.example.com',
      enabled: true,
      dkimSelector: 'cf-bounce',
      returnPathDomain: 'cf-bounce.mail.example.com',
    });

    try {
      const res = await POST(
        ctx(db, {
          method: 'POST',
          body: { domain: 'mail.example.com', provider: 'cloudflare', accountId: 'a1', cfAccountId: 'cf-1' },
        }),
      );
      expect(res.status).toBe(201);
      expect(onboard).toHaveBeenCalledWith('zone-example', 'mail.example.com');
      expect((await res.json()) as unknown).toMatchObject({
        emailSending: { enabled: true, dkimSelector: 'cf-bounce' },
      });
      const list = (await (await GET(ctx(db))).json()) as { domains: { provider: string }[] };
      expect(list.domains).toHaveLength(1);
      expect(list.domains[0]?.provider).toBe('cloudflare');
    } finally {
      onboard.mockRestore();
    }
  });

  it('POST does not store a Cloudflare domain when Email Sending Onboard is forbidden', async () => {
    const db = createTestDb();
    await seedAuthorizedZone(db, ALICE, 'a1');
    const key = await importEncryptionKey(HEX_KEY);
    await db
      .prepare('UPDATE cf_accounts SET token_encrypted = ? WHERE id = ? AND owner_email = ?')
      .bind(await encryptSecret('cf-token', key), 'a1', ALICE)
      .run();
    const onboard = vi
      .spyOn(CfClient.prototype, 'onboardEmailSendingDomain')
      .mockRejectedValue(new CfApiError(403, ['Authentication error']));

    try {
      const res = await POST(
        ctx(db, {
          method: 'POST',
          body: { domain: 'mail.example.com', provider: 'cloudflare', accountId: 'a1', cfAccountId: 'cf-1' },
        }),
      );
      expect(res.status).toBe(403);
      expect((await res.json()) as unknown).toMatchObject({ code: 'emailOnboardForbidden' });
      const list = (await (await GET(ctx(db))).json()) as { total: number };
      expect(list.total).toBe(0);
    } finally {
      onboard.mockRestore();
    }
  });

  it('POST returns 409 duplicateDomain for the same user, 201 for another user', async () => {
    const db = createTestDb();
    await createResendDomain(db);
    const dup = await POST(
      ctx(db, { method: 'POST', body: { domain: 'MAIL.example.com', provider: 'resend', apiKey: 'k2' } }),
    );
    expect(dup.status).toBe(409);
    await seedAuthorizedZone(db, BOB);
    const other = await POST(
      ctx(db, {
        method: 'POST',
        body: { domain: 'mail.example.com', provider: 'resend', apiKey: 'k2' },
        userEmail: BOB,
      }),
    );
    expect(other.status).toBe(201);
  });

  it('PUT keeps the old resend key when apiKey is blank, replaces it when provided', async () => {
    const db = createTestDb();
    const id = await createResendDomain(db);
    const before = (await getEmailDomain(db, ALICE, id))!;
    const keep = await PUT(ctx(db, { method: 'PUT', id, body: { provider: 'resend' } }));
    expect(keep.status).toBe(200);
    expect((await getEmailDomain(db, ALICE, id))!.api_key_hash).toBe(before.api_key_hash);
    const swap = await PUT(ctx(db, { method: 'PUT', id, body: { provider: 'resend', apiKey: 're_key_2' } }));
    expect(swap.status).toBe(200);
    expect((await getEmailDomain(db, ALICE, id))!.api_key_hash).not.toBe(before.api_key_hash);
  });

  it('PUT onboards before switching an existing Resend domain to Cloudflare', async () => {
    const db = createTestDb();
    const id = await createResendDomain(db);
    const key = await importEncryptionKey(HEX_KEY);
    await db
      .prepare('UPDATE cf_accounts SET token_encrypted = ? WHERE id = ? AND owner_email = ?')
      .bind(await encryptSecret('cf-token', key), `acct-${ALICE}`, ALICE)
      .run();
    const onboard = vi.spyOn(CfClient.prototype, 'onboardEmailSendingDomain').mockResolvedValue({
      id: 'sending-1',
      name: 'mail.example.com',
      enabled: true,
      dkimSelector: 'cf-bounce',
      returnPathDomain: null,
    });
    try {
      const res = await PUT(
        ctx(db, {
          method: 'PUT',
          id,
          body: { provider: 'cloudflare', accountId: `acct-${ALICE}`, cfAccountId: 'cf-1' },
        }),
      );
      expect(res.status).toBe(200);
      expect(onboard).toHaveBeenCalledWith('zone-example', 'mail.example.com');
      expect((await getEmailDomain(db, ALICE, id))?.provider).toBe('cloudflare');
    } finally {
      onboard.mockRestore();
    }
  });

  it('PUT keeps the previous provider when Cloudflare onboard is forbidden', async () => {
    const db = createTestDb();
    const id = await createResendDomain(db);
    const key = await importEncryptionKey(HEX_KEY);
    await db
      .prepare('UPDATE cf_accounts SET token_encrypted = ? WHERE id = ? AND owner_email = ?')
      .bind(await encryptSecret('cf-token', key), `acct-${ALICE}`, ALICE)
      .run();
    const onboard = vi
      .spyOn(CfClient.prototype, 'onboardEmailSendingDomain')
      .mockRejectedValue(new CfApiError(403, ['missing email-sending.write']));
    try {
      const res = await PUT(
        ctx(db, {
          method: 'PUT',
          id,
          body: { provider: 'cloudflare', accountId: `acct-${ALICE}`, cfAccountId: 'cf-1' },
        }),
      );
      expect(res.status).toBe(403);
      expect((await res.json()) as unknown).toMatchObject({ code: 'emailOnboardForbidden' });
      expect((await getEmailDomain(db, ALICE, id))?.provider).toBe('resend');
    } finally {
      onboard.mockRestore();
    }
  });

  it('PUT/DELETE are owner-scoped (BOB gets 404 on ALICE domain)', async () => {
    const db = createTestDb();
    const id = await createResendDomain(db);
    const put = await PUT(ctx(db, { method: 'PUT', id, userEmail: BOB, body: { provider: 'resend', apiKey: 'k' } }));
    expect(put.status).toBe(404);
    const del = await DELETE(ctx(db, { method: 'DELETE', id, userEmail: BOB }));
    expect(del.status).toBe(404);
    const delOk = await DELETE(ctx(db, { method: 'DELETE', id }));
    expect(delOk.status).toBe(204);
  });

  it('hides and blocks a configured domain after its Zone is no longer authorized', async () => {
    const db = createTestDb();
    const id = await createResendDomain(db);
    await db.prepare('DELETE FROM zones').run();

    const list = (await (await GET(ctx(db))).json()) as { domains: unknown[]; total: number };
    expect(list).toMatchObject({ domains: [], total: 0 });
    expect((await PUT(ctx(db, { method: 'PUT', id, body: { provider: 'resend' } }))).status).toBe(404);
    expect((await DELETE(ctx(db, { method: 'DELETE', id }))).status).toBe(404);
    expect(await getEmailDomain(db, ALICE, id)).not.toBeNull();
  });

  describe('GET /api/email/domains pagination', () => {
    it('returns paging metadata and paginates', async () => {
      const db = createTestDb();
      for (let i = 1; i <= 3; i++) await createResendDomain(db, `d${i}.example.com`);

      const res = await GET(ctx(db, { query: '?page=1&pageSize=2' }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { domains: unknown[]; total: number; page: number; pageSize: number };
      expect(body).toMatchObject({ total: 3, page: 1, pageSize: 2 });
      expect(body.domains).toHaveLength(2);
    });

    it('clamps invalid page/pageSize to defaults', async () => {
      const db = createTestDb();
      await createResendDomain(db, 'only.example.com');
      const res = await GET(ctx(db, { query: '?page=0&pageSize=-5' }));
      const body = (await res.json()) as { page: number; pageSize: number; total: number };
      expect(body).toMatchObject({ page: 1, pageSize: 20, total: 1 });
    });

    it('pageSize=100 returns the full list for the send dropdown', async () => {
      const db = createTestDb();
      for (let i = 1; i <= 5; i++) await createResendDomain(db, `d${i}.example.com`);
      const res = await GET(ctx(db, { query: '?pageSize=100' }));
      const body = (await res.json()) as { domains: unknown[]; total: number };
      expect(body.domains).toHaveLength(5);
      expect(body.total).toBe(5);
    });

    it('still never leaks credentials in the list', async () => {
      const db = createTestDb();
      await createResendDomain(db, 'secret.example.com');
      const text = await (await GET(ctx(db, { query: '?page=1&pageSize=20' }))).text();
      expect(text).toContain('"apiKeyHint"');
      expect(text).not.toContain('re_key_1');
    });
  });
});

describe('GET /api/accounts/[id]/cf-accounts', () => {
  it("returns 404 for another user's account without touching the CF API", async () => {
    const db = createTestDb();
    await insertAccount(db, { id: 'a1', ownerEmail: BOB, name: 'bob', tokenEncrypted: 'x', tokenHash: 'h1' });
    const res = await getCfAccounts(ctx(db, { id: 'a1' }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('accountNotFound');
  });
});
