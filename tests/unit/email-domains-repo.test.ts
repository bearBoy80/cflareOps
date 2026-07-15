import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, importEncryptionKey, sha256Hex } from '@/server/crypto';
import { deleteAccount, insertAccount } from '@/server/db/accounts';
import {
  deleteEmailDomain,
  getEmailDomain,
  insertEmailDomain,
  listEmailDomains,
  toPublic,
  updateEmailDomain,
} from '@/server/db/emailDomains';
import type { Db } from '@/server/db/types';

const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';
const TS = '2026-07-14T00:00:00.000Z';

async function seedAccount(db: Db, id = 'a1', ownerEmail = ALICE): Promise<void> {
  await insertAccount(db, {
    id,
    ownerEmail,
    name: `acct-${id}`,
    tokenEncrypted: 'enc',
    tokenHash: `hash-${id}`,
  });
}

function insertDomainRaw(db: Db, id: string, owner: string, domain: string, provider = 'resend') {
  return db
    .prepare('INSERT INTO email_domains (id, owner_email, domain, provider, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, owner, domain, provider, TS)
    .run();
}

function insertLogRaw(db: Db, id: string, owner: string, domainId: string | null) {
  return db
    .prepare(
      `INSERT INTO email_log (id, owner_email, domain_id, provider, from_address, recipients_json,
         subject, format, content, status, message_id, error, created_at)
       VALUES (?, ?, ?, 'resend', 'no-reply@mail.example.com', '{"to":["a@b.co"],"cc":[],"bcc":[]}',
         'subj', 'text', 'body', 'sent', 'mid-1', NULL, ?)`,
    )
    .bind(id, owner, domainId, TS)
    .run();
}

describe('0002_email schema semantics', () => {
  it('enforces UNIQUE(owner_email, domain) but allows the same domain for different users', async () => {
    const db = createTestDb();
    await insertDomainRaw(db, 'd1', ALICE, 'mail.example.com');
    await expect(insertDomainRaw(db, 'd2', ALICE, 'mail.example.com')).rejects.toThrow(/UNIQUE/i);
    await expect(insertDomainRaw(db, 'd3', BOB, 'mail.example.com')).resolves.toBeTruthy();
  });

  it('rejects unknown provider values via CHECK', async () => {
    const db = createTestDb();
    await expect(insertDomainRaw(db, 'd1', ALICE, 'mail.example.com', 'smtp')).rejects.toThrow(/CHECK/i);
  });

  it('deleting the cf account cascades its email domains', async () => {
    const db = createTestDb();
    await seedAccount(db, 'a1');
    await db
      .prepare(
        'INSERT INTO email_domains (id, owner_email, domain, provider, account_id, cf_account_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind('d1', ALICE, 'mail.example.com', 'cloudflare', 'a1', 'cf-tag-1', TS)
      .run();
    await deleteAccount(db, ALICE, 'a1');
    const row = await db.prepare('SELECT COUNT(*) AS cnt FROM email_domains').first<{ cnt: number }>();
    expect(row?.cnt).toBe(0);
  });

  it('deleting a domain sets email_log.domain_id to NULL and keeps the log row', async () => {
    const db = createTestDb();
    await insertDomainRaw(db, 'd1', ALICE, 'mail.example.com');
    await insertLogRaw(db, 'l1', ALICE, 'd1');
    await db.prepare('DELETE FROM email_domains WHERE id = ?').bind('d1').run();
    const log = await db
      .prepare('SELECT domain_id, from_address FROM email_log WHERE id = ?')
      .bind('l1')
      .first<{ domain_id: string | null; from_address: string }>();
    expect(log).not.toBeNull();
    expect(log?.domain_id).toBeNull();
    expect(log?.from_address).toBe('no-reply@mail.example.com');
  });
});

describe('emailDomains repo', () => {
  const HEX_KEY = 'c'.repeat(64);

  function resendInput(id: string, domain: string, ownerEmail = ALICE) {
    return {
      id,
      ownerEmail,
      domain,
      provider: 'resend' as const,
      apiKeyCiphertext: `ct-${id}`,
      apiKeyHash: `hash-${id}`,
      accountId: null,
      cfAccountId: null,
    };
  }

  it('insert + get + list roundtrip, scoped by owner_email', async () => {
    const db = createTestDb();
    await insertEmailDomain(db, resendInput('d1', 'mail.example.com'));
    await insertEmailDomain(db, resendInput('d2', 'news.example.com', BOB));

    const aliceRows = await listEmailDomains(db, ALICE);
    expect(aliceRows.map((r) => r.id)).toEqual(['d1']);

    expect(await getEmailDomain(db, ALICE, 'd1')).toMatchObject({ domain: 'mail.example.com', provider: 'resend' });
    // 隔离：ALICE 拿不到 BOB 的配置
    expect(await getEmailDomain(db, ALICE, 'd2')).toBeNull();
  });

  it('rejects a duplicate domain for the same user with a stable error message', async () => {
    const db = createTestDb();
    await insertEmailDomain(db, resendInput('d1', 'mail.example.com'));
    await expect(insertEmailDomain(db, resendInput('d2', 'mail.example.com'))).rejects.toThrow(
      'domain already configured',
    );
  });

  it('update switches provider and swaps credential columns', async () => {
    const db = createTestDb();
    await seedAccount(db, 'a1');
    await insertEmailDomain(db, resendInput('d1', 'mail.example.com'));
    await updateEmailDomain(db, ALICE, 'd1', {
      provider: 'cloudflare',
      apiKeyCiphertext: null,
      apiKeyHash: null,
      accountId: 'a1',
      cfAccountId: 'cf-tag-1',
    });
    const row = await getEmailDomain(db, ALICE, 'd1');
    expect(row).toMatchObject({ provider: 'cloudflare', account_id: 'a1', cf_account_id: 'cf-tag-1' });
    expect(row?.api_key_ciphertext).toBeNull();
  });

  it('delete is owner-scoped: BOB cannot delete ALICE domain', async () => {
    const db = createTestDb();
    await insertEmailDomain(db, resendInput('d1', 'mail.example.com'));
    await deleteEmailDomain(db, BOB, 'd1');
    expect(await getEmailDomain(db, ALICE, 'd1')).not.toBeNull();
    await deleteEmailDomain(db, ALICE, 'd1');
    expect(await getEmailDomain(db, ALICE, 'd1')).toBeNull();
  });

  it('toPublic exposes only an 8-char hash hint, never ciphertext', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    const apiKey = 're_secret_123';
    await insertEmailDomain(db, {
      ...resendInput('d1', 'mail.example.com'),
      apiKeyCiphertext: await encryptSecret(apiKey, key),
      apiKeyHash: await sha256Hex(apiKey),
    });
    const row = (await getEmailDomain(db, ALICE, 'd1'))!;
    // 加密往返：密文可解回原文（发送时用）
    expect(await decryptSecret(row.api_key_ciphertext!, key)).toBe(apiKey);
    const pub = toPublic(row);
    expect(pub.apiKeyHint).toHaveLength(8);
    expect(JSON.stringify(pub)).not.toContain(row.api_key_ciphertext);
    expect(JSON.stringify(pub)).not.toContain(apiKey);
  });
});
