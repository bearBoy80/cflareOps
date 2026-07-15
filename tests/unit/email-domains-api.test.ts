import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import { GET as getCfAccounts } from '@/pages/api/accounts/[id]/cf-accounts';
import { DELETE, PUT } from '@/pages/api/email/domains/[id]';
import { GET, POST } from '@/pages/api/email/domains/index';
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
  const res = await POST(ctx(db, { method: 'POST', body: { domain, provider: 'resend', apiKey: 're_key_1' } }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { domain: { id: string } };
  return body.domain.id;
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

  it('POST returns 409 duplicateDomain for the same user, 201 for another user', async () => {
    const db = createTestDb();
    await createResendDomain(db);
    const dup = await POST(
      ctx(db, { method: 'POST', body: { domain: 'MAIL.example.com', provider: 'resend', apiKey: 'k2' } }),
    );
    expect(dup.status).toBe(409);
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
