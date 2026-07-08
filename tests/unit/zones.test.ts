import { describe, expect, it } from 'vitest';
import type { CfZone } from '../../src/server/cf/types';
import { encryptSecret, importEncryptionKey } from '../../src/server/crypto';
import { insertAccount } from '../../src/server/db/accounts';
import type { Db } from '../../src/server/db/types';
import { clientForZone, getCachedZone, listCachedZones, syncAllZones, zoneStats } from '../../src/server/zones';
import { createTestDb } from '../helpers/d1';

const HEX_KEY = 'b'.repeat(64);
const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';

async function seedAccount(
  db: ReturnType<typeof createTestDb>,
  key: CryptoKey,
  id: string,
  token: string,
  ownerEmail = ALICE,
) {
  await insertAccount(db, {
    id,
    ownerEmail,
    name: `acct-${id}`,
    tokenEncrypted: await encryptSecret(token, key),
    tokenHash: `hash-${id}`,
  });
}

describe('syncAllZones', () => {
  it('fans out per account and caches zones with account name', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedAccount(db, key, 'a2', 'tok-2');

    const zonesByToken: Record<string, CfZone[]> = {
      'tok-1': [{ id: 'z1', name: 'a.com', status: 'active', plan: { name: 'Free' } }],
      'tok-2': [{ id: 'z2', name: 'b.com', status: 'active' }],
    };
    const result = await syncAllZones(db, key, ALICE, (token) => ({
      listZones: async () => zonesByToken[token] ?? [],
    }));

    expect(result.synced).toBe(2);
    expect(result.failures).toEqual([]);
    const { zones: cached } = await listCachedZones(db, ALICE);
    expect(cached.map((z) => [z.id, z.accountName])).toEqual([
      ['z1', 'acct-a1'],
      ['z2', 'acct-a2'],
    ]);
  });

  it('records failure per account without aborting others', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedAccount(db, key, 'a2', 'tok-2');

    const result = await syncAllZones(db, key, ALICE, (token) => ({
      listZones: async () => {
        if (token === 'tok-1') throw new Error('boom');
        return [{ id: 'z2', name: 'b.com', status: 'active' }];
      },
    }));

    expect(result.synced).toBe(1);
    expect(result.failures).toEqual([{ accountId: 'a1', error: 'boom' }]);
  });

  it('replaces stale zones of an account on resync', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');

    await syncAllZones(db, key, ALICE, () => ({
      listZones: async () => [{ id: 'z-old', name: 'old.com', status: 'active' }],
    }));
    await syncAllZones(db, key, ALICE, () => ({
      listZones: async () => [{ id: 'z-new', name: 'new.com', status: 'active' }],
    }));

    const { zones: cached } = await listCachedZones(db, ALICE);
    expect(cached.map((z) => z.id)).toEqual(['z-new']);
  });

  it('scopes sync, reads and zone client to the owner', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1', ALICE);
    await seedAccount(db, key, 'b1', 'tok-9', BOB);

    const result = await syncAllZones(db, key, ALICE, () => ({
      listZones: async () => [{ id: 'z1', name: 'a.com', status: 'active' }],
    }));

    expect(result.synced).toBe(1); // 只同步了 ALICE 的 1 个账号，未触碰 BOB 的
    expect((await listCachedZones(db, BOB)).zones).toEqual([]);
    await expect(clientForZone(db, key, BOB, 'z1')).rejects.toThrow('not found');
  });

  it('two accounts sharing the same CF zone id do not collide (composite PK)', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    // Two accounts with distinct token_hash values belonging to the same owner
    await seedAccount(db, key, 'ac1', 'tok-ac1');
    await seedAccount(db, key, 'ac2', 'tok-ac2');

    // Both accounts return the *same* zone id — simulating a shared/transferred zone
    const sharedZone: CfZone = { id: 'z-shared', name: 'shared.example.com', status: 'active' };
    const result = await syncAllZones(db, key, ALICE, () => ({
      listZones: async () => [sharedZone],
    }));

    // With composite PK (id, account_id) there should be no UNIQUE collision
    expect(result.failures).toEqual([]);
    const { zones: cached } = await listCachedZones(db, ALICE);
    // Both rows should exist: same zone id, different accountId
    expect(cached).toHaveLength(2);
    const accountIds = cached.map((z) => z.accountId).sort();
    expect(accountIds).toEqual(['ac1', 'ac2']);
    expect(cached.every((z) => z.id === 'z-shared')).toBe(true);
  });

  it('keeps the old cache intact when the CF API fails mid-sync (atomic batch replace)', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    // First sync: seed the cache with one zone
    await syncAllZones(db, key, ALICE, () => ({
      listZones: async () => [{ id: 'z-old', name: 'old.com', status: 'active' }],
    }));
    // Second sync: API fails
    const failing = await syncAllZones(db, key, ALICE, () => ({
      listZones: async () => {
        throw new Error('api down');
      },
    }));
    expect(failing.failures).toHaveLength(1);
    // Old cache must be preserved (batch DELETE+INSERT never ran)
    const { zones } = await listCachedZones(db, ALICE);
    expect(zones.map((z) => z.id)).toEqual(['z-old']);
  });

  it('accountId narrows the sync to a single account', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedAccount(db, key, 'a2', 'tok-2');
    const calls: string[] = [];
    await syncAllZones(
      db,
      key,
      ALICE,
      (token) => {
        calls.push(token);
        return { listZones: async () => [{ id: 'z-a2', name: 'a2.com', status: 'active' }] };
      },
      'a2',
    );
    expect(calls).toEqual(['tok-2']); // 只碰 a2 的 token
    const { zones } = await listCachedZones(db, ALICE);
    expect(zones.map((z) => z.accountId)).toEqual(['a2']);
  });

  it('guards status write in catch block to preserve per-account isolation', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedAccount(db, key, 'a2', 'tok-2');

    // Wrap db so UPDATE cf_accounts throws to simulate db failure during status write
    const flakyDb: Db = {
      prepare(sql: string) {
        if (sql.trimStart().startsWith('UPDATE cf_accounts')) {
          throw new Error('db down');
        }
        return db.prepare(sql);
      },
      async batch(statements) {
        return db.batch(statements);
      },
    };

    const result = await syncAllZones(flakyDb, key, ALICE, (token) => ({
      listZones: async () => {
        if (token === 'tok-1') throw new Error('api error');
        return [{ id: 'z2', name: 'b.com', status: 'active' }];
      },
    }));

    // Promise should resolve (not reject), with both accounts recorded as failures
    // tok-1: listZones throws -> caught -> tries updateAccountStatus('error') which also throws
    // tok-2: listZones succeeds -> tries updateAccountStatus('active') which throws -> caught -> tries updateAccountStatus('error') which also throws
    // With the fix, both updateAccountStatus('error') calls are guarded, so both end up in failures[]
    expect(result.synced).toBe(0);
    expect(result.failures.length).toBe(2);
    // 账号并发同步（p-limit），失败顺序不确定 —— 断言集合而非顺序
    expect(result.failures.map((f) => f.accountId).sort()).toEqual(['a1', 'a2']);
  });
});

describe('zoneStats', () => {
  it('returns zeros and null lastSyncedAt for empty owner', async () => {
    const db = createTestDb();
    const stats = await zoneStats(db, ALICE);
    expect(stats).toEqual({ total: 0, lastSyncedAt: null });
  });

  it('counts zones and returns lastSyncedAt', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await syncAllZones(db, key, ALICE, () => ({
      listZones: async () => [
        { id: 'z1', name: 'a.com', status: 'active' },
        { id: 'z2', name: 'b.com', status: 'active' },
      ],
    }));
    const stats = await zoneStats(db, ALICE);
    expect(stats.total).toBe(2);
    expect(typeof stats.lastSyncedAt).toBe('string');
  });

  it('isolates zone stats between owners (BOB sees no ALICE zones)', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1', ALICE);
    await syncAllZones(db, key, ALICE, () => ({
      listZones: async () => [{ id: 'z1', name: 'a.com', status: 'active' }],
    }));
    const bobStats = await zoneStats(db, BOB);
    expect(bobStats).toEqual({ total: 0, lastSyncedAt: null });
  });
});

describe('listCachedZones pagination and search', () => {
  async function seedZones(
    db: ReturnType<typeof createTestDb>,
    key: CryptoKey,
    accountId: string,
    zones: Array<{ id: string; name: string }>,
    ownerEmail = ALICE,
  ) {
    await insertAccount(db, {
      id: accountId,
      ownerEmail,
      name: `acct-${accountId}`,
      tokenEncrypted: await encryptSecret('tok', key),
      tokenHash: `hash-${accountId}`,
    });
    for (const z of zones) {
      await db
        .prepare(
          `INSERT INTO zones (id, account_id, name, status, paused, type, development_mode,
             name_servers, original_name_servers, original_registrar,
             cf_account_id, cf_account_name, plan_id, plan_name,
             created_on, modified_on, activated_on, raw_json, synced_at)
           VALUES (?, ?, ?, 'active', 0, 'full', 0, '[]', '[]', null, null, null, null, null,
                   null, null, null, '{}', '2024-01-01T00:00:00Z')`,
        )
        .bind(z.id, accountId, z.name)
        .run();
    }
  }

  it('paginates: 3 zones pageSize 2 → page 1 returns 2, page 2 returns 1, total 3', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedZones(db, key, 'ax', [
      { id: 'z1', name: 'alpha.com' },
      { id: 'z2', name: 'beta.com' },
      { id: 'z3', name: 'gamma.com' },
    ]);
    const page1 = await listCachedZones(db, ALICE, { page: 1, pageSize: 2 });
    expect(page1.total).toBe(3);
    expect(page1.zones).toHaveLength(2);
    expect(page1.zones.map((z) => z.name)).toEqual(['alpha.com', 'beta.com']);

    const page2 = await listCachedZones(db, ALICE, { page: 2, pageSize: 2 });
    expect(page2.total).toBe(3);
    expect(page2.zones).toHaveLength(1);
    expect(page2.zones[0].name).toBe('gamma.com');
  });

  it('search filters by zone name case-insensitively', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedZones(db, key, 'ax', [
      { id: 'z1', name: 'foo.example.com' },
      { id: 'z2', name: 'bar.example.com' },
    ]);
    const result = await listCachedZones(db, ALICE, { search: 'FOO' });
    expect(result.total).toBe(1);
    expect(result.zones[0].id).toBe('z1');
  });

  it('search filters by account name case-insensitively', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    // account name will be 'acct-myacct'
    await seedZones(db, key, 'myacct', [{ id: 'z1', name: 'site.com' }]);
    await seedZones(db, key, 'other', [{ id: 'z2', name: 'other.com' }]);
    const result = await listCachedZones(db, ALICE, { search: 'MYACCT' });
    expect(result.total).toBe(1);
    expect(result.zones[0].id).toBe('z1');
  });

  it('search with % special character does not wildcard (escaping works)', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedZones(db, key, 'ax', [
      { id: 'z1', name: 'anything.com' },
      { id: 'z2', name: 'other.com' },
    ]);
    // '%' should not wildcard and match everything; it should match literally
    const result = await listCachedZones(db, ALICE, { search: '%' });
    expect(result.total).toBe(0);
  });

  it('search with _ special character matches literally, not any-single-char', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedZones(db, key, 'ax', [
      { id: 'z1', name: 'a_b.com' },
      { id: 'z2', name: 'axb.com' },
    ]);
    const result = await listCachedZones(db, ALICE, { search: 'a_b' });
    expect(result.total).toBe(1);
    expect(result.zones[0].name).toBe('a_b.com');
  });

  it('search with backslash matches literally and does not break the ESCAPE clause', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedZones(db, key, 'ax', [
      { id: 'z1', name: 'weird\\name.com' },
      { id: 'z2', name: 'normal.com' },
    ]);
    const result = await listCachedZones(db, ALICE, { search: 'weird\\name' });
    expect(result.total).toBe(1);
    expect(result.zones[0].name).toBe('weird\\name.com');
  });

  it('isolates zones between owners: BOB total is 0 when only ALICE has zones', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedZones(db, key, 'ax', [{ id: 'z1', name: 'alice.com' }], ALICE);
    const result = await listCachedZones(db, BOB);
    expect(result.total).toBe(0);
    expect(result.zones).toEqual([]);
  });

  it('clamps page < 1 to 1', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedZones(db, key, 'ax', [{ id: 'z1', name: 'a.com' }]);
    const result = await listCachedZones(db, ALICE, { page: -5 });
    expect(result.total).toBe(1);
    expect(result.zones).toHaveLength(1);
  });

  it('status filter: non-paused value filters by z.status exact match', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await insertAccount(db, {
      id: 'ax',
      ownerEmail: ALICE,
      name: 'acct-ax',
      tokenEncrypted: await encryptSecret('tok', key),
      tokenHash: 'hash-ax',
    });
    // seed with different statuses
    for (const [id, name, status] of [
      ['z1', 'active.com', 'active'],
      ['z2', 'pending.com', 'pending'],
      ['z3', 'moved.com', 'moved'],
    ] as [string, string, string][]) {
      await db
        .prepare(
          `INSERT INTO zones (id, account_id, name, status, paused, type, development_mode,
             name_servers, original_name_servers, original_registrar,
             cf_account_id, cf_account_name, plan_id, plan_name,
             created_on, modified_on, activated_on, raw_json, synced_at)
           VALUES (?, 'ax', ?, ?, 0, 'full', 0, '[]', '[]', null, null, null, null, null,
                   null, null, null, '{}', '2024-01-01T00:00:00Z')`,
        )
        .bind(id, name, status)
        .run();
    }
    const result = await listCachedZones(db, ALICE, { status: 'active' });
    expect(result.total).toBe(1);
    expect(result.zones[0].id).toBe('z1');
  });

  it('status filter: "paused" value filters by z.paused = 1', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await insertAccount(db, {
      id: 'ax',
      ownerEmail: ALICE,
      name: 'acct-ax',
      tokenEncrypted: await encryptSecret('tok', key),
      tokenHash: 'hash-ax',
    });
    for (const [id, name, paused] of [
      ['z1', 'paused.com', 1],
      ['z2', 'running.com', 0],
    ] as [string, string, number][]) {
      await db
        .prepare(
          `INSERT INTO zones (id, account_id, name, status, paused, type, development_mode,
             name_servers, original_name_servers, original_registrar,
             cf_account_id, cf_account_name, plan_id, plan_name,
             created_on, modified_on, activated_on, raw_json, synced_at)
           VALUES (?, 'ax', ?, 'active', ?, 'full', 0, '[]', '[]', null, null, null, null, null,
                   null, null, null, '{}', '2024-01-01T00:00:00Z')`,
        )
        .bind(id, name, paused)
        .run();
    }
    const result = await listCachedZones(db, ALICE, { status: 'paused' });
    expect(result.total).toBe(1);
    expect(result.zones[0].id).toBe('z1');
  });

  it('accountId filter: returns only zones for that account', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedZones(db, key, 'acct1', [{ id: 'z1', name: 'a1.com' }]);
    await seedZones(db, key, 'acct2', [{ id: 'z2', name: 'a2.com' }]);
    const result = await listCachedZones(db, ALICE, { accountId: 'acct1' });
    expect(result.total).toBe(1);
    expect(result.zones[0].id).toBe('z1');
  });

  it('search + status combined filter is AND', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await insertAccount(db, {
      id: 'ax',
      ownerEmail: ALICE,
      name: 'acct-ax',
      tokenEncrypted: await encryptSecret('tok', key),
      tokenHash: 'hash-ax',
    });
    for (const [id, name, status] of [
      ['z1', 'foo-active.com', 'active'],
      ['z2', 'foo-pending.com', 'pending'],
      ['z3', 'bar-active.com', 'active'],
    ] as [string, string, string][]) {
      await db
        .prepare(
          `INSERT INTO zones (id, account_id, name, status, paused, type, development_mode,
             name_servers, original_name_servers, original_registrar,
             cf_account_id, cf_account_name, plan_id, plan_name,
             created_on, modified_on, activated_on, raw_json, synced_at)
           VALUES (?, 'ax', ?, ?, 0, 'full', 0, '[]', '[]', null, null, null, null, null,
                   null, null, null, '{}', '2024-01-01T00:00:00Z')`,
        )
        .bind(id, name, status)
        .run();
    }
    const result = await listCachedZones(db, ALICE, { search: 'foo', status: 'active' });
    expect(result.total).toBe(1);
    expect(result.zones[0].id).toBe('z1');
  });

  it('cross-owner: accountId from another owner returns total 0', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    // BOB's account
    await insertAccount(db, {
      id: 'bob-acct',
      ownerEmail: BOB,
      name: 'bob-account',
      tokenEncrypted: await encryptSecret('tok', key),
      tokenHash: 'hash-bob',
    });
    await db
      .prepare(
        `INSERT INTO zones (id, account_id, name, status, paused, type, development_mode,
           name_servers, original_name_servers, original_registrar,
           cf_account_id, cf_account_name, plan_id, plan_name,
           created_on, modified_on, activated_on, raw_json, synced_at)
         VALUES ('z-bob', 'bob-acct', 'bob.com', 'active', 0, 'full', 0, '[]', '[]', null, null, null, null, null,
                 null, null, null, '{}', '2024-01-01T00:00:00Z')`,
      )
      .run();
    // ALICE queries with BOB's accountId - owner filter prevents cross-access
    const result = await listCachedZones(db, ALICE, { accountId: 'bob-acct' });
    expect(result.total).toBe(0);
  });
});

describe('getCachedZone', () => {
  async function seedOneZone(
    db: ReturnType<typeof createTestDb>,
    key: CryptoKey,
    ownerEmail: string,
    accountId: string,
    zoneId: string,
    zoneName: string,
  ) {
    await insertAccount(db, {
      id: accountId,
      ownerEmail,
      name: `acct-${accountId}`,
      tokenEncrypted: await encryptSecret('tok', key),
      tokenHash: `hash-${accountId}`,
    });
    await db
      .prepare(
        `INSERT INTO zones (id, account_id, name, status, paused, type, development_mode,
           name_servers, original_name_servers, original_registrar,
           cf_account_id, cf_account_name, plan_id, plan_name,
           created_on, modified_on, activated_on, raw_json, synced_at)
         VALUES (?, ?, ?, 'active', 0, 'full', 0, '[]', '[]', null, null, null, null, null,
                 null, null, null, '{}', '2024-01-01T00:00:00Z')`,
      )
      .bind(zoneId, accountId, zoneName)
      .run();
  }

  it('returns id and name for a zone owned by the caller', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedOneZone(db, key, ALICE, 'a1', 'zone-1', 'mysite.com');
    const zone = await getCachedZone(db, ALICE, 'zone-1');
    expect(zone).toEqual({ id: 'zone-1', name: 'mysite.com' });
  });

  it('returns null for a non-existent zone id', async () => {
    const db = createTestDb();
    const zone = await getCachedZone(db, ALICE, 'does-not-exist');
    expect(zone).toBeNull();
  });

  it('returns null when zone exists but belongs to a different owner', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedOneZone(db, key, ALICE, 'a1', 'zone-1', 'alice.com');
    const zone = await getCachedZone(db, BOB, 'zone-1');
    expect(zone).toBeNull();
  });
});
