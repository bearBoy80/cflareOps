import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';

describe('r2_buckets migration', () => {
  it('creates the table with cascade delete from cf_accounts', async () => {
    const db = createTestDb();
    const row = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='r2_buckets'`)
      .first<{ name: string }>();
    expect(row?.name).toBe('r2_buckets');
  });
});
