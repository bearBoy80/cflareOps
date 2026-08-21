import { createTestDb } from '@tests/helpers/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/pages/api/accounts/index';

const HEX_KEY = '9'.repeat(64);
const ALICE = 'alice@ops.dev';

function ctx(db: unknown, body: unknown) {
  return {
    locals: { userEmail: ALICE, runtime: { env: { DB: db, ENCRYPTION_KEY: HEX_KEY } } },
    request: new Request('http://localhost/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params: {},
  } as unknown as Parameters<typeof POST>[0];
}

function envelope(result: unknown, resultInfo?: Record<string, number>): Response {
  return Response.json({ success: true, errors: [], messages: [], result, result_info: resultInfo });
}

afterEach(() => vi.unstubAllGlobals());

describe('POST /api/accounts', () => {
  it('automatically syncs the new account Zones after token verification', async () => {
    const db = createTestDb();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/user/tokens/verify')) {
          return envelope({ id: 'token-id', status: 'active' });
        }
        if (url.pathname.endsWith('/zones')) {
          const page = Number(url.searchParams.get('page') ?? '1');
          const result =
            page === 1
              ? [
                  {
                    id: 'zone-class6x',
                    name: 'class6x.com',
                    status: 'active',
                    account: { id: 'cf-account-1', name: 'Cloudflare account' },
                  },
                ]
              : [];
          return envelope(result, {
            page,
            per_page: 50,
            count: result.length,
            total_count: 1,
            total_pages: 1,
          });
        }
        throw new Error(`unexpected Cloudflare request: ${url.pathname}`);
      }),
    );

    const res = await POST(ctx(db, { name: 'second account', token: 'token-value' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      account: { id: string; status: string };
      zoneSync: { synced: number; failures: unknown[] };
    };
    expect(body.account.status).toBe('active');
    expect(body.zoneSync).toEqual({ synced: 1, failures: [] });

    const zone = await db
      .prepare(
        `SELECT z.name, z.cf_account_id, a.owner_email
         FROM zones z JOIN cf_accounts a ON a.id = z.account_id
         WHERE z.account_id = ?`,
      )
      .bind(body.account.id)
      .first<{ name: string; cf_account_id: string; owner_email: string }>();
    expect(zone).toEqual({ name: 'class6x.com', cf_account_id: 'cf-account-1', owner_email: ALICE });
  });

  it('keeps the added account when automatic Zone sync is forbidden', async () => {
    const db = createTestDb();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/user/tokens/verify')) {
          return envelope({ id: 'token-id', status: 'active' });
        }
        return Response.json(
          { success: false, errors: [{ code: 9109, message: 'missing zone read permission' }], result: null },
          { status: 403 },
        );
      }),
    );

    const res = await POST(ctx(db, { name: 'limited account', token: 'limited-token' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      account: { id: string; status: string };
      zoneSync: { synced: number; failures: { accountId: string; error: string }[] };
    };
    expect(body.account.status).toBe('error');
    expect(body.zoneSync.synced).toBe(0);
    expect(body.zoneSync.failures[0]?.error).toContain('missing zone read permission');
    expect(await db.prepare('SELECT id FROM cf_accounts WHERE id = ?').bind(body.account.id).first()).not.toBeNull();
  });
});
