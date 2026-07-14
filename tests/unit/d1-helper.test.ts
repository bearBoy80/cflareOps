import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';

describe('createTestDb', () => {
  it('applies schema and supports bind/first/all/run', async () => {
    const db = createTestDb();
    await db
      .prepare(
        'INSERT INTO cf_accounts (id, owner_email, name, token_encrypted, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind('a1', 'alice@ops.dev', 'Acme', 'enc', 'hash1', '2026-07-04T00:00:00Z', '2026-07-04T00:00:00Z')
      .run();

    const row = await db.prepare('SELECT * FROM cf_accounts WHERE id = ?').bind('a1').first<{ name: string }>();
    expect(row?.name).toBe('Acme');

    const all = await db.prepare('SELECT * FROM cf_accounts').all();
    expect(all.results).toHaveLength(1);
  });

  it('bind() returns independent bound statements from same prepare()', async () => {
    const db = createTestDb();
    // Insert two rows
    await db
      .prepare(
        'INSERT INTO cf_accounts (id, owner_email, name, token_encrypted, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind('a1', 'alice@ops.dev', 'Acme', 'enc', 'hash1', '2026-07-04T00:00:00Z', '2026-07-04T00:00:00Z')
      .run();

    await db
      .prepare(
        'INSERT INTO cf_accounts (id, owner_email, name, token_encrypted, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind('a2', 'bob@ops.dev', 'Beta', 'enc', 'hash2', '2026-07-04T00:00:00Z', '2026-07-04T00:00:00Z')
      .run();

    // Create two bound statements from the same prepare()
    const stmt = db.prepare('SELECT * FROM cf_accounts WHERE id = ?');
    const first = stmt.bind('a1');
    const second = stmt.bind('a2');

    // Each should maintain its own params and return correct row
    const firstRow = await first.first<{ name: string }>();
    const secondRow = await second.first<{ name: string }>();

    expect(firstRow?.name).toBe('Acme');
    expect(secondRow?.name).toBe('Beta');
  });
});
