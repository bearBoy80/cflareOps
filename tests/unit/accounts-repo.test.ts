import { describe, expect, it } from 'vitest';
import {
  countAccounts,
  deleteAccount,
  getAccount,
  insertAccount,
  listAccounts,
  updateAccount,
  updateAccountStatus,
} from '../../src/server/db/accounts';
import { createTestDb } from '../helpers/d1';

const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';
const input = { id: 'a1', ownerEmail: ALICE, name: 'Acme', tokenEncrypted: 'enc', tokenHash: 'h1' };

describe('accounts repository', () => {
  it('inserts and lists without exposing secrets', async () => {
    const db = createTestDb();
    await insertAccount(db, input);
    const { accounts, total } = await listAccounts(db, ALICE);
    expect(total).toBe(1);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toEqual({
      id: 'a1',
      name: 'Acme',
      status: 'unchecked',
      lastCheck: null,
      lastError: null,
    });
    expect(JSON.stringify(accounts)).not.toContain('enc');
  });

  it('isolates data between owners', async () => {
    const db = createTestDb();
    await insertAccount(db, input);
    expect(await listAccounts(db, BOB)).toEqual({ accounts: [], total: 0 });
    expect(await getAccount(db, BOB, 'a1')).toBeNull();
    await deleteAccount(db, BOB, 'a1');
    expect(await getAccount(db, ALICE, 'a1')).not.toBeNull();
  });

  it('rejects duplicate token hash for the same owner only', async () => {
    const db = createTestDb();
    await insertAccount(db, input);
    await expect(insertAccount(db, { ...input, id: 'a2' })).rejects.toThrow('already exists');
    await insertAccount(db, { ...input, id: 'a3', ownerEmail: BOB });
    expect((await listAccounts(db, BOB)).accounts).toHaveLength(1);
  });

  it('updates status and health info', async () => {
    const db = createTestDb();
    await insertAccount(db, input);
    await updateAccountStatus(db, 'a1', 'error', 'Invalid token');
    const row = await getAccount(db, ALICE, 'a1');
    expect(row?.status).toBe('error');
    expect(row?.last_error).toBe('Invalid token');
    expect(row?.last_check).not.toBeNull();
  });

  it('deletes own account', async () => {
    const db = createTestDb();
    await insertAccount(db, input);
    await deleteAccount(db, ALICE, 'a1');
    expect(await getAccount(db, ALICE, 'a1')).toBeNull();
  });

  it('cascades zone cache deletion when the account is removed', async () => {
    const db = createTestDb();
    await insertAccount(db, input);
    await db
      .prepare('INSERT INTO zones (id, account_id, name, raw_json, synced_at) VALUES (?, ?, ?, ?, ?)')
      .bind('z1', 'a1', 'example.com', '{}', new Date().toISOString())
      .run();
    await deleteAccount(db, ALICE, 'a1');
    const row = await db.prepare('SELECT id FROM zones WHERE account_id = ?').bind('a1').first();
    expect(row).toBeNull();
  });

  describe('listAccounts search and pagination', () => {
    async function seedMany(db: ReturnType<typeof createTestDb>) {
      for (let i = 1; i <= 5; i++) {
        await insertAccount(db, {
          id: `a${i}`,
          ownerEmail: ALICE,
          name: i <= 3 ? `prod-${i}` : `dev-${i}`,
          tokenEncrypted: 'enc',
          tokenHash: `h${i}`,
        });
      }
    }

    it('filters by name case-insensitively with escaped LIKE', async () => {
      const db = createTestDb();
      await seedMany(db);
      const { accounts, total } = await listAccounts(db, ALICE, { search: 'PROD' });
      expect(total).toBe(3);
      expect(accounts.map((a) => a.name)).toEqual(['prod-1', 'prod-2', 'prod-3']);
      // '%' 只作字面量匹配
      expect((await listAccounts(db, ALICE, { search: '%' })).total).toBe(0);
    });

    it('paginates with total independent of page window', async () => {
      const db = createTestDb();
      await seedMany(db);
      const page1 = await listAccounts(db, ALICE, { page: 1, pageSize: 2 });
      expect(page1.total).toBe(5);
      expect(page1.accounts).toHaveLength(2);
      const page3 = await listAccounts(db, ALICE, { page: 3, pageSize: 2 });
      expect(page3.accounts).toHaveLength(1);
    });
  });

  describe('updateAccount', () => {
    it('renames without touching token or status', async () => {
      const db = createTestDb();
      await insertAccount(db, input);
      await updateAccountStatus(db, 'a1', 'error', 'boom');
      await updateAccount(db, ALICE, 'a1', { name: 'Renamed' });
      const row = await getAccount(db, ALICE, 'a1');
      expect(row?.name).toBe('Renamed');
      expect(row?.token_hash).toBe('h1');
      expect(row?.status).toBe('error');
    });

    it('replaces token, resets status to active and clears last_error', async () => {
      const db = createTestDb();
      await insertAccount(db, input);
      await updateAccountStatus(db, 'a1', 'error', 'boom');
      await updateAccount(db, ALICE, 'a1', { name: 'Acme', tokenEncrypted: 'enc2', tokenHash: 'h2' });
      const row = await getAccount(db, ALICE, 'a1');
      expect(row?.token_hash).toBe('h2');
      expect(row?.status).toBe('active');
      expect(row?.last_error).toBeNull();
    });

    it('rejects a token already used by another account of the same owner', async () => {
      const db = createTestDb();
      await insertAccount(db, input);
      await insertAccount(db, { ...input, id: 'a2', tokenHash: 'h2' });
      await expect(
        updateAccount(db, ALICE, 'a2', { name: 'B', tokenEncrypted: 'enc', tokenHash: 'h1' }),
      ).rejects.toThrow('already exists');
    });

    it('does not update accounts of another owner', async () => {
      const db = createTestDb();
      await insertAccount(db, input);
      await updateAccount(db, BOB, 'a1', { name: 'hijacked' });
      const row = await getAccount(db, ALICE, 'a1');
      expect(row?.name).toBe('Acme');
    });
  });

  describe('countAccounts', () => {
    it('returns zeros for empty owner', async () => {
      const db = createTestDb();
      const stats = await countAccounts(db, ALICE);
      expect(stats).toEqual({ total: 0, errors: 0 });
    });

    it('counts total and error accounts correctly', async () => {
      const db = createTestDb();
      await insertAccount(db, input); // a1, ALICE
      await insertAccount(db, { id: 'a2', ownerEmail: ALICE, name: 'B', tokenEncrypted: 'enc2', tokenHash: 'h2' });
      await updateAccountStatus(db, 'a1', 'error', 'bad token');
      const stats = await countAccounts(db, ALICE);
      expect(stats.total).toBe(2);
      expect(stats.errors).toBe(1);
    });

    it('isolates counts between owners (BOB sees no ALICE data)', async () => {
      const db = createTestDb();
      await insertAccount(db, input); // a1, ALICE
      await updateAccountStatus(db, 'a1', 'error', 'bad token');
      const bobStats = await countAccounts(db, BOB);
      expect(bobStats).toEqual({ total: 0, errors: 0 });
    });
  });
});
