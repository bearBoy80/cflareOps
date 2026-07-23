import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import type { CfAccount, CfD1Database } from '@/server/cf/types';
import { encryptSecret, importEncryptionKey } from '@/server/crypto';
import { getCachedD1Database, listCachedD1Databases, syncD1Databases } from '@/server/d1';
import { deleteAccount, insertAccount } from '@/server/db/accounts';

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

function db1(uuid: string, name: string, extra: Partial<CfD1Database> = {}): CfD1Database {
  return {
    uuid,
    name,
    version: null,
    created_at: null,
    num_tables: null,
    file_size: null,
    read_replication_mode: null,
    ...extra,
  };
}

function fakeClient(cfAccounts: CfAccount[], dbsByCf: Record<string, CfD1Database[]> = {}) {
  return {
    listAccounts: async () => cfAccounts,
    listD1Databases: async (id: string) => dbsByCf[id] ?? [],
  };
}

describe('d1_databases migration', () => {
  it('creates the table', async () => {
    const db = createTestDb();
    const row = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='d1_databases'`)
      .first<{ name: string }>();
    expect(row?.name).toBe('d1_databases');
  });

  it('cascade-deletes cached rows when the account is removed', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await syncD1Databases(db, key, ALICE, () =>
      fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [db1('u1', 'db1')] }),
    );
    await deleteAccount(db, ALICE, 'a1');
    const { total } = await listCachedD1Databases(db, ALICE);
    expect(total).toBe(0);
  });
});

describe('syncD1Databases', () => {
  it('fans out per account and caches database fields', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');

    const r = await syncD1Databases(db, key, ALICE, () =>
      fakeClient([{ id: 'cf-1', name: 'CF One' }], {
        'cf-1': [
          db1('u1', 'db-one', {
            version: 'production',
            created_at: '2026-01-01T00:00:00Z',
            num_tables: 4,
            file_size: 2048,
            read_replication_mode: 'auto',
          }),
          db1('u2', 'db-two'),
        ],
      }),
    );
    expect(r).toEqual({ databases: 2, failures: [] });

    const { databases, total } = await listCachedD1Databases(db, ALICE);
    expect(total).toBe(2);
    const one = databases.find((d) => d.uuid === 'u1')!;
    expect(one).toMatchObject({
      name: 'db-one',
      accountName: 'acct-a1',
      cfAccountId: 'cf-1',
      cfAccountName: 'CF One',
      version: 'production',
      numTables: 4,
      fileSize: 2048,
      readReplicationMode: 'auto',
    });
    expect(databases.find((d) => d.uuid === 'u2')!.fileSize).toBeNull();
  });

  it('keeps old cache when listD1Databases throws mid-sync (atomic batch)', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await syncD1Databases(db, key, ALICE, () =>
      fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [db1('u-old', 'old-db')] }),
    );

    const failing = await syncD1Databases(db, key, ALICE, () => ({
      ...fakeClient([{ id: 'cf-1', name: 'CF One' }]),
      listD1Databases: async () => {
        throw new Error('api down');
      },
    }));
    expect(failing.failures).toHaveLength(1);
    expect(failing.failures[0]).toMatchObject({ accountId: 'a1' });

    const { databases } = await listCachedD1Databases(db, ALICE);
    expect(databases.map((d) => d.uuid)).toEqual(['u-old']);
  });

  it('one failing account does not block the other (per-account isolation)', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedAccount(db, key, 'a2', 'tok-2');

    const r = await syncD1Databases(db, key, ALICE, (token) =>
      token === 'tok-1'
        ? fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [db1('u1', 'db1')] })
        : {
            listAccounts: async () => {
              throw new Error('bad token');
            },
            listD1Databases: async () => [],
          },
    );
    expect(r.databases).toBe(1);
    expect(r.failures).toEqual([{ accountId: 'a2', error: 'bad token' }]);
  });

  it('accountId narrows the sync to a single account', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedAccount(db, key, 'a2', 'tok-2');
    const r = await syncD1Databases(
      db,
      key,
      ALICE,
      () => fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [db1('u1', 'db1')] }),
      'a1',
    );
    expect(r.databases).toBe(1);
  });
});

describe('listCachedD1Databases / getCachedD1Database', () => {
  it('scopes rows by owner_email', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1', ALICE);
    await seedAccount(db, key, 'b1', 'tok-2', BOB);
    await syncD1Databases(db, key, ALICE, () =>
      fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [db1('ua', 'alice-db')] }),
    );
    await syncD1Databases(db, key, BOB, () =>
      fakeClient([{ id: 'cf-2', name: 'CF Two' }], { 'cf-2': [db1('ub', 'bob-db')] }),
    );

    const alice = await listCachedD1Databases(db, ALICE);
    expect(alice.databases.map((d) => d.uuid)).toEqual(['ua']);
    expect(await getCachedD1Database(db, ALICE, 'b1', 'ub')).toBeNull(); // 跨用户 → null
    expect((await getCachedD1Database(db, ALICE, 'a1', 'ua'))?.name).toBe('alice-db');
  });

  it('searches by database name or account name and paginates', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await syncD1Databases(db, key, ALICE, () =>
      fakeClient([{ id: 'cf-1', name: 'CF One' }], {
        'cf-1': [db1('u1', 'prod-app'), db1('u2', 'staging-app'), db1('u3', 'scratch')],
      }),
    );
    const hit = await listCachedD1Databases(db, ALICE, { search: 'app' });
    expect(hit.total).toBe(2);
    const page = await listCachedD1Databases(db, ALICE, { page: 2, pageSize: 2 });
    expect(page.total).toBe(3);
    expect(page.databases).toHaveLength(1);
  });
});
