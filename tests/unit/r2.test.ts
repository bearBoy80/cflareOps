import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import type { CfAccount, CfR2Bucket } from '@/server/cf/types';
import { encryptSecret, importEncryptionKey } from '@/server/crypto';
import { deleteAccount, insertAccount } from '@/server/db/accounts';
import { classifyR2Action, getCachedR2Bucket, listCachedR2Buckets, syncR2Buckets } from '@/server/r2';

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

function fakeClient(
  cfAccounts: CfAccount[],
  bucketsByCf: Record<string, CfR2Bucket[]> = {},
  snapshotByCf: Record<
    string,
    { bucketName: string; payloadSize: number; metadataSize: number; objectCount: number }[]
  > = {},
) {
  return {
    listAccounts: async () => cfAccounts,
    listR2Buckets: async (id: string) => bucketsByCf[id] ?? [],
    queryR2StorageSnapshot: async (id: string) => snapshotByCf[id] ?? [],
  };
}

describe('r2_buckets migration', () => {
  it('creates the table with cascade delete from cf_accounts', async () => {
    const db = createTestDb();
    const row = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='r2_buckets'`)
      .first<{ name: string }>();
    expect(row?.name).toBe('r2_buckets');
  });
});

describe('syncR2Buckets', () => {
  it('fans out per account, joins storage snapshot into cache columns', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');

    const r = await syncR2Buckets(db, key, ALICE, () =>
      fakeClient(
        [{ id: 'cf-1', name: 'CF One' }],
        {
          'cf-1': [
            { name: 'b1', creation_date: '2026-01-01T00:00:00Z', location: 'apac', storage_class: 'Standard' },
            { name: 'b2' },
          ],
        },
        { 'cf-1': [{ bucketName: 'b1', payloadSize: 100, metadataSize: 5, objectCount: 3 }] },
      ),
    );
    expect(r).toEqual({ buckets: 2, failures: [] });

    const { buckets, total } = await listCachedR2Buckets(db, ALICE);
    expect(total).toBe(2);
    const b1 = buckets.find((b) => b.name === 'b1')!;
    expect(b1).toMatchObject({
      accountName: 'acct-a1',
      cfAccountId: 'cf-1',
      cfAccountName: 'CF One',
      location: 'apac',
      storageClass: 'Standard',
      payloadSize: 100,
      metadataSize: 5,
      objectCount: 3,
    });
    const b2 = buckets.find((b) => b.name === 'b2')!;
    expect(b2.payloadSize).toBeNull(); // 快照没有该桶 → 列留空
  });

  it('storage snapshot failure degrades to null metrics, bucket rows still cached', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');

    const r = await syncR2Buckets(db, key, ALICE, () => ({
      ...fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [{ name: 'b1' }] }),
      queryR2StorageSnapshot: async () => {
        throw new Error('graphql down');
      },
    }));
    expect(r.failures).toEqual([]);
    const { buckets } = await listCachedR2Buckets(db, ALICE);
    expect(buckets[0].name).toBe('b1');
    expect(buckets[0].payloadSize).toBeNull();
  });

  it('keeps old cache when listR2Buckets throws mid-sync (atomic batch)', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await syncR2Buckets(db, key, ALICE, () =>
      fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [{ name: 'old' }] }),
    );

    const failing = await syncR2Buckets(db, key, ALICE, () => ({
      ...fakeClient([{ id: 'cf-1', name: 'CF One' }]),
      listR2Buckets: async () => {
        throw new Error('api down');
      },
    }));
    expect(failing.failures).toHaveLength(1);
    const { buckets } = await listCachedR2Buckets(db, ALICE);
    expect(buckets.map((b) => b.name)).toEqual(['old']);
  });

  it('per-account failure does not abort others and records status', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedAccount(db, key, 'a2', 'tok-2');

    const r = await syncR2Buckets(db, key, ALICE, (token) =>
      token === 'tok-1'
        ? {
            ...fakeClient([]),
            listAccounts: async () => {
              throw new Error('boom');
            },
          }
        : fakeClient([{ id: 'cf-2', name: 'CF Two' }], { 'cf-2': [{ name: 'b' }] }),
    );
    expect(r.buckets).toBe(1);
    expect(r.failures).toEqual([{ accountId: 'a1', error: 'boom' }]);
    const rows = await db
      .prepare('SELECT id, status FROM cf_accounts ORDER BY id')
      .all<{ id: string; status: string }>();
    expect(rows.results).toEqual([
      { id: 'a1', status: 'error' },
      { id: 'a2', status: 'active' },
    ]);
  });

  it('isolates owners and supports accountId narrowing', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1', ALICE);
    await seedAccount(db, key, 'b1', 'tok-9', BOB);

    await syncR2Buckets(db, key, ALICE, () =>
      fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [{ name: 'mine' }] }),
    );
    expect((await listCachedR2Buckets(db, BOB)).total).toBe(0);

    // 他人 accountId 是 no-op
    const r = await syncR2Buckets(db, key, BOB, () => fakeClient([]), 'a1');
    expect(r).toEqual({ buckets: 0, failures: [] });
  });

  it('search matches bucket name and account label; pagination clamps', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await syncR2Buckets(db, key, ALICE, () =>
      fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [{ name: 'assets' }, { name: 'a_b' }, { name: 'axb' }] }),
    );
    expect((await listCachedR2Buckets(db, ALICE, { search: 'a_b' })).total).toBe(1); // _ 字面匹配
    expect((await listCachedR2Buckets(db, ALICE, { search: 'ACCT-A1' })).total).toBe(3);
    const page = await listCachedR2Buckets(db, ALICE, { page: -3, pageSize: 2 });
    expect(page.buckets).toHaveLength(2);
    expect(page.total).toBe(3);
  });

  it('getCachedR2Bucket enforces owner scope', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await syncR2Buckets(db, key, ALICE, () =>
      fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [{ name: 'b1' }] }),
    );

    expect((await getCachedR2Bucket(db, ALICE, 'a1', 'b1'))?.cfAccountId).toBe('cf-1');
    expect(await getCachedR2Bucket(db, BOB, 'a1', 'b1')).toBeNull();
    expect(await getCachedR2Bucket(db, ALICE, 'a1', 'nope')).toBeNull();
  });

  it('deleting the account cascades the bucket cache', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await syncR2Buckets(db, key, ALICE, () =>
      fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [{ name: 'b1' }] }),
    );
    await deleteAccount(db, ALICE, 'a1');
    const cnt = await db.prepare('SELECT COUNT(*) AS cnt FROM r2_buckets').first<{ cnt: number }>();
    expect(cnt?.cnt).toBe(0);
  });
});

describe('classifyR2Action', () => {
  it('maps mutating/list actions to A, reads to B, unknown to B', () => {
    expect(classifyR2Action('PutObject')).toBe('A');
    expect(classifyR2Action('ListObjects')).toBe('A');
    expect(classifyR2Action('CreateMultipartUpload')).toBe('A');
    expect(classifyR2Action('GetObject')).toBe('B');
    expect(classifyR2Action('HeadObject')).toBe('B');
    expect(classifyR2Action('SomethingNew')).toBe('B');
  });
});
