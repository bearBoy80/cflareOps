import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import { GET as lookup } from '@/pages/api/zones/lookup';
import { encryptSecret, importEncryptionKey } from '@/server/crypto';
import { insertAccount } from '@/server/db/accounts';

const HEX_KEY = 'b'.repeat(64);
const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';

async function seedAccount(db: ReturnType<typeof createTestDb>, id: string, ownerEmail = ALICE) {
  const key = await importEncryptionKey(HEX_KEY);
  await insertAccount(db, {
    id,
    ownerEmail,
    name: `acct-${id}`,
    tokenEncrypted: await encryptSecret(`tok-${id}`, key),
    tokenHash: `hash-${id}`,
  });
}

async function seedZone(
  db: ReturnType<typeof createTestDb>,
  zoneId: string,
  accountId: string,
  name: string,
  cfAccountId: string | null = null,
) {
  await db
    .prepare(
      `INSERT INTO zones (id, account_id, name, status, paused, type, development_mode,
         name_servers, original_name_servers, original_registrar,
         cf_account_id, cf_account_name, plan_id, plan_name,
         created_on, modified_on, activated_on, raw_json, synced_at)
       VALUES (?, ?, ?, 'active', 0, 'full', 0, '[]', '[]', null, ?, null, null, null,
               null, null, null, '{}', '2024-01-01T00:00:00Z')`,
    )
    .bind(zoneId, accountId, name, cfAccountId)
    .run();
}

function makeContext(db: unknown, url: string, userEmail = ALICE) {
  return {
    locals: {
      userEmail,
      runtime: { env: { DB: db, ENCRYPTION_KEY: HEX_KEY } },
    },
    request: new Request(url),
    params: {},
  } as unknown as Parameters<typeof lookup>[0];
}

describe('GET /api/zones/lookup', () => {
  it('rejects a malformed hostname with 400 invalidHostname', async () => {
    const db = createTestDb();
    const res = await lookup(makeContext(db, 'http://localhost/api/zones/lookup?hostname=bad%20host'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('invalidHostname');
  });

  it('returns the matched zone with cfAccountId, or null when nothing matches', async () => {
    const db = createTestDb();
    await seedAccount(db, 'a1');
    await seedZone(db, 'z1', 'a1', 'example.com', 'cf-1');

    const hit = await lookup(makeContext(db, 'http://localhost/api/zones/lookup?hostname=www.example.com'));
    expect(hit.status).toBe(200);
    expect(await hit.json()).toEqual({
      zone: { zoneId: 'z1', zoneName: 'example.com', accountId: 'a1', cfAccountId: 'cf-1' },
    });

    const miss = await lookup(makeContext(db, 'http://localhost/api/zones/lookup?hostname=other.dev'));
    expect(await miss.json()).toEqual({ zone: null });
  });

  it("isolates owners: BOB never matches ALICE's zones", async () => {
    const db = createTestDb();
    await seedAccount(db, 'a1', ALICE);
    await seedZone(db, 'z1', 'a1', 'example.com');

    const res = await lookup(makeContext(db, 'http://localhost/api/zones/lookup?hostname=www.example.com', BOB));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ zone: null });
  });

  it('filters by cfAccountId: a zone in another CF account does not match', async () => {
    const db = createTestDb();
    await seedAccount(db, 'a1');
    await seedZone(db, 'z1', 'a1', 'example.com', 'cf-1');

    const filteredOut = await lookup(
      makeContext(db, 'http://localhost/api/zones/lookup?hostname=www.example.com&cfAccountId=cf-2'),
    );
    expect(await filteredOut.json()).toEqual({ zone: null });

    const filteredIn = await lookup(
      makeContext(db, 'http://localhost/api/zones/lookup?hostname=www.example.com&cfAccountId=cf-1'),
    );
    expect(await filteredIn.json()).toEqual({
      zone: { zoneId: 'z1', zoneName: 'example.com', accountId: 'a1', cfAccountId: 'cf-1' },
    });
  });
});
