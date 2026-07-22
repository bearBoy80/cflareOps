import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import { GET as contentGet } from '@/pages/api/r2/[accountId]/[bucket]/content';
import { DELETE as objectsDelete, GET as objectsGet } from '@/pages/api/r2/[accountId]/[bucket]/objects';
import { POST as presignPost } from '@/pages/api/r2/[accountId]/[bucket]/presign';
import { GET as bucketsGet, POST as bucketsPost } from '@/pages/api/r2/buckets';
import { encryptSecret, importEncryptionKey } from '@/server/crypto';
import { insertAccount } from '@/server/db/accounts';

const HEX_KEY = 'a'.repeat(64);
const ALICE = 'alice@ops.dev';

function ctx(db: unknown, url: string, init?: RequestInit, params?: Record<string, string>) {
  return {
    locals: { userEmail: ALICE, runtime: { env: { DB: db, ENCRYPTION_KEY: HEX_KEY } } },
    request: new Request(url, init),
    params: params ?? {},
  } as never;
}

async function seed(db: ReturnType<typeof createTestDb>) {
  const key = await importEncryptionKey(HEX_KEY);
  await insertAccount(db, {
    id: 'a1',
    ownerEmail: ALICE,
    name: 'acct-a1',
    tokenEncrypted: await encryptSecret('tok-1', key),
    tokenHash: 'h1',
  });
  await db
    .prepare(
      `INSERT INTO r2_buckets (account_id, cf_account_id, cf_account_name, name, raw_json, synced_at)
       VALUES ('a1', 'cf-1', 'CF One', 'b1', '{}', '2026-07-21T00:00:00Z')`,
    )
    .run();
}

describe('GET /api/r2/buckets', () => {
  it('lists cached buckets scoped to the owner', async () => {
    const db = createTestDb();
    await seed(db);
    const res = await bucketsGet(ctx(db, 'http://localhost/api/r2/buckets'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { buckets: { name: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.buckets[0].name).toBe('b1');
  });
});

describe('POST /api/r2/buckets validation', () => {
  it('400s on a bad bucket name before touching CF', async () => {
    const db = createTestDb();
    await seed(db);
    const res = await bucketsPost(
      ctx(db, 'http://localhost/api/r2/buckets', {
        method: 'POST',
        body: JSON.stringify({ accountId: 'a1', cfAccountId: 'cf-1', name: 'Bad_Name!' }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('bucket ownership guard', () => {
  it('404s for a bucket outside the owner scope (objects + presign)', async () => {
    const db = createTestDb();
    await seed(db);
    const objRes = await objectsGet(
      ctx(db, 'http://localhost/api/r2/a1/nope/objects', undefined, { accountId: 'a1', bucket: 'nope' }),
    );
    expect(objRes.status).toBe(404);
    const preRes = await presignPost(
      ctx(
        db,
        'http://localhost/api/r2/a1/nope/presign',
        { method: 'POST', body: JSON.stringify({ key: 'k', op: 'get' }) },
        { accountId: 'a1', bucket: 'nope' },
      ),
    );
    expect(preRes.status).toBe(404);
  });

  it('400s objects DELETE when neither key nor prefix is given', async () => {
    const db = createTestDb();
    await seed(db);
    const res = await objectsDelete(
      ctx(db, 'http://localhost/api/r2/a1/b1/objects', { method: 'DELETE' }, { accountId: 'a1', bucket: 'b1' }),
    );
    expect(res.status).toBe(400);
  });

  it('400s presign on an invalid op or empty key', async () => {
    const db = createTestDb();
    await seed(db);
    const res = await presignPost(
      ctx(
        db,
        'http://localhost/api/r2/a1/b1/presign',
        { method: 'POST', body: JSON.stringify({ key: '', op: 'get' }) },
        { accountId: 'a1', bucket: 'b1' },
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/r2/:accountId/:bucket/content', () => {
  it('400s on an empty key before touching CF', async () => {
    const db = createTestDb();
    await seed(db);
    const res = await contentGet(
      ctx(db, 'http://localhost/api/r2/a1/b1/content', undefined, { accountId: 'a1', bucket: 'b1' }),
    );
    expect(res.status).toBe(400);
  });

  it('404s for a bucket outside the owner scope', async () => {
    const db = createTestDb();
    await seed(db);
    const res = await contentGet(
      ctx(db, 'http://localhost/api/r2/a1/nope/content?key=a.txt', undefined, { accountId: 'a1', bucket: 'nope' }),
    );
    expect(res.status).toBe(404);
  });
});
