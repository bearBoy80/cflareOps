import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import { GET as getInvocations } from '@/pages/api/usage/invocations';
import { encryptSecret, importEncryptionKey } from '@/server/crypto';
import { insertAccount } from '@/server/db/accounts';

const HEX_KEY = 'b'.repeat(64);
const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';

function makeContext(db: unknown, url: string, userEmail = ALICE) {
  return {
    locals: { userEmail, runtime: { env: { DB: db, ENCRYPTION_KEY: HEX_KEY } } },
    request: new Request(url),
    params: {},
  } as unknown as Parameters<typeof getInvocations>[0];
}

describe('GET /api/usage/invocations', () => {
  it('rejects an invalid range with 400 invalidRange', async () => {
    const db = createTestDb();
    const res = await getInvocations(makeContext(db, 'http://localhost/api/usage/invocations?range=90d'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('invalidRange');
  });

  it('rejects an invalid kind with 400 invalidKind', async () => {
    const db = createTestDb();
    const res = await getInvocations(makeContext(db, 'http://localhost/api/usage/invocations?kind=zones'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('invalidKind');
  });

  it('rejects prototype-chain properties as kind (toString, constructor, etc.) with 400 invalidKind', async () => {
    const db = createTestDb();
    for (const proto of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      const res = await getInvocations(makeContext(db, `http://localhost/api/usage/invocations?kind=${proto}`));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe('invalidKind');
    }
  });

  it('returns an empty page for an owner with no accounts (isolation), for both 24h and 7d', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await insertAccount(db, {
      id: 'a1',
      ownerEmail: ALICE,
      name: 'acct-a1',
      tokenEncrypted: await encryptSecret('tok-1', key),
      tokenHash: 'hash-a1',
    });
    for (const range of ['24h', '7d']) {
      const res = await getInvocations(makeContext(db, `http://localhost/api/usage/invocations?range=${range}`, BOB));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rows: unknown[]; total: number; failures: unknown[] };
      expect(body.rows).toEqual([]);
      expect(body.total).toBe(0);
      expect(body.failures).toEqual([]);
    }
  });

  it('24h response includes a zero-filled series and D1-backed empty rows for an owner with no accounts', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await insertAccount(db, {
      id: 'a1',
      ownerEmail: ALICE,
      name: 'acct-a1',
      tokenEncrypted: await encryptSecret('tok-1', key),
      tokenHash: 'hash-a1',
    });
    // BOB 无账号：24h 走 D1，rows 空、series 仍是完整 24 桶零填充
    const res = await getInvocations(makeContext(db, 'http://localhost/api/usage/invocations?range=24h', BOB));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; total: number; series: unknown[]; failures: unknown[] };
    expect(body.rows).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.series).toHaveLength(24);
    expect(body.failures).toEqual([]);
  });
});
