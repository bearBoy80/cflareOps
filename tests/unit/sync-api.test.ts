import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import { POST as postWorkers } from '@/pages/api/workers/sync';
import { POST as postZones } from '@/pages/api/zones/sync';
import { encryptSecret, importEncryptionKey } from '@/server/crypto';
import { insertAccount } from '@/server/db/accounts';

const HEX_KEY = 'b'.repeat(64);
const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';

function makeContext(db: unknown, url: string, userEmail = ALICE) {
  return {
    locals: { userEmail, runtime: { env: { DB: db, ENCRYPTION_KEY: HEX_KEY } } },
    request: new Request(url, { method: 'POST' }),
    params: {},
  } as unknown as Parameters<typeof postWorkers>[0];
}

describe('POST /api/workers/sync and POST /api/zones/sync', () => {
  it("workers/sync returns empty results for an accountId owned by another user (BOB accessing ALICE's a1)", async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    // Insert ALICE's account
    await insertAccount(db, {
      id: 'a1',
      ownerEmail: ALICE,
      name: 'acct-a1',
      tokenEncrypted: await encryptSecret('tok-1', key),
      tokenHash: 'hash-a1',
    });
    // BOB calls with ?accountId=a1 (ALICE's account)
    const res = await postWorkers(makeContext(db, 'http://localhost/api/workers/sync?accountId=a1', BOB));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scripts: number; projects: number; failures: unknown[] };
    expect(body.scripts).toBe(0);
    expect(body.projects).toBe(0);
    expect(body.failures).toEqual([]);
  });

  it("zones/sync returns empty results for an accountId owned by another user (BOB accessing ALICE's a1)", async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    // Insert ALICE's account
    await insertAccount(db, {
      id: 'a1',
      ownerEmail: ALICE,
      name: 'acct-a1',
      tokenEncrypted: await encryptSecret('tok-1', key),
      tokenHash: 'hash-a1',
    });
    // BOB calls with ?accountId=a1 (ALICE's account)
    const res = await postZones(makeContext(db, 'http://localhost/api/zones/sync?accountId=a1', BOB));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { synced: number; failures: unknown[] };
    expect(body.synced).toBe(0);
    expect(body.failures).toEqual([]);
  });
});
