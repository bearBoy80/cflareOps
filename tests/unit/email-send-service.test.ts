import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it, vi } from 'vitest';
import { CfApiError } from '@/server/cf/client';
import { NotFoundError } from '@/server/context';
import { encryptSecret, importEncryptionKey, sha256Hex } from '@/server/crypto';
import { insertAccount } from '@/server/db/accounts';
import { insertEmailDomain } from '@/server/db/emailDomains';
import type { Db } from '@/server/db/types';
import { sendEmail } from '@/server/email';
import { type EmailMessage, EmailValidationError } from '@/server/email/types';

const HEX_KEY = 'd'.repeat(64);
const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';

async function setup(): Promise<{ db: Db; key: CryptoKey }> {
  const db = createTestDb();
  const key = await importEncryptionKey(HEX_KEY);
  await insertAccount(db, {
    id: 'a1',
    ownerEmail: ALICE,
    name: 'acct',
    tokenEncrypted: await encryptSecret('cf-token-1', key),
    tokenHash: await sha256Hex('cf-token-1'),
  });
  await insertEmailDomain(db, {
    id: 'dom-resend',
    ownerEmail: ALICE,
    domain: 'mail.example.com',
    provider: 'resend',
    apiKeyCiphertext: await encryptSecret('re_key_1', key),
    apiKeyHash: await sha256Hex('re_key_1'),
    accountId: null,
    cfAccountId: null,
  });
  await insertEmailDomain(db, {
    id: 'dom-cf',
    ownerEmail: ALICE,
    domain: 'cf.example.com',
    provider: 'cloudflare',
    apiKeyCiphertext: null,
    apiKeyHash: null,
    accountId: 'a1',
    cfAccountId: 'cf-tag-1',
  });
  return { db, key };
}

function msg(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    from: 'no-reply@mail.example.com',
    to: ['a@b.co'],
    subject: 'Hi',
    format: 'markdown',
    content: '# hello',
    ...overrides,
  };
}

/** 让 email_log 的 INSERT 抛错，其余 SQL 正常透传：模拟审计写入的瞬时 D1 故障 */
function withBrokenLogWrites(db: Db): Db {
  return {
    ...db,
    prepare(sql: string) {
      if (sql.includes('INSERT INTO email_log')) throw new Error('d1 write failed');
      return db.prepare(sql);
    },
  };
}

async function countLogs(db: Db): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS cnt FROM email_log').first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

describe('sendEmail service', () => {
  it('resend path: decrypts the key, renders markdown with text fallback, logs sent', async () => {
    const { db, key } = await setup();
    let seenKey = '';
    let seenParams: Record<string, unknown> = {};
    const result = await sendEmail({ db, key, userEmail: ALICE }, 'dom-resend', msg(), {
      resend: async (apiKey, params) => {
        seenKey = apiKey;
        seenParams = params as unknown as Record<string, unknown>;
        return { messageId: 'rid-1' };
      },
    });
    expect(seenKey).toBe('re_key_1');
    expect(seenParams.html).toContain('<h1');
    expect(seenParams.text).toBe('# hello');
    expect(result).toMatchObject({ status: 'sent', messageId: 'rid-1', error: null });
    const log = await db
      .prepare('SELECT status, message_id, provider, content FROM email_log WHERE id = ?')
      .bind(result.logId)
      .first<{ status: string; message_id: string; provider: string; content: string }>();
    expect(log).toMatchObject({ status: 'sent', message_id: 'rid-1', provider: 'resend', content: '# hello' });
  });

  it("cloudflare path: decrypts the account token and sends via the domain's cf_account_id", async () => {
    const { db, key } = await setup();
    let seenToken = '';
    let seenCfAccount = '';
    const result = await sendEmail({ db, key, userEmail: ALICE }, 'dom-cf', msg({ from: 'ops@cf.example.com' }), {
      makeCfClient: (token) => ({
        async sendEmail(cfAccountId) {
          seenToken = token;
          seenCfAccount = cfAccountId;
          return { messageId: 'mid-1' };
        },
      }),
    });
    expect(seenToken).toBe('cf-token-1');
    expect(seenCfAccount).toBe('cf-tag-1');
    expect(result.status).toBe('sent');
  });

  it('rejects a cross-user domainId with NotFoundError and writes no log', async () => {
    const { db, key } = await setup();
    await expect(sendEmail({ db, key, userEmail: BOB }, 'dom-resend', msg())).rejects.toThrow(NotFoundError);
    expect(await countLogs(db)).toBe(0);
  });

  it('rejects a from address on a different domain (400, no provider call, no log)', async () => {
    const { db, key } = await setup();
    let called = false;
    const call = sendEmail({ db, key, userEmail: ALICE }, 'dom-resend', msg({ from: 'x@other.com' }), {
      resend: async () => {
        called = true;
        return { messageId: 'nope' };
      },
    });
    await expect(call).rejects.toThrow(EmailValidationError);
    await expect(
      sendEmail({ db, key, userEmail: ALICE }, 'dom-resend', msg({ from: 'x@other.com' })),
    ).rejects.toMatchObject({ code: 'fromDomainMismatch' });
    expect(called).toBe(false);
    expect(await countLogs(db)).toBe(0);
  });

  it('matches the from domain case-insensitively', async () => {
    const { db, key } = await setup();
    const result = await sendEmail({ db, key, userEmail: ALICE }, 'dom-resend', msg({ from: 'Ops@MAIL.Example.COM' }), {
      resend: async () => ({ messageId: 'rid-2' }),
    });
    expect(result.status).toBe('sent');
  });

  it('logs a failed attempt and rethrows when the provider errors', async () => {
    const { db, key } = await setup();
    const boom = new CfApiError(403, ['missing Email Sending scope']);
    const call = sendEmail({ db, key, userEmail: ALICE }, 'dom-resend', msg(), {
      resend: async () => {
        throw boom;
      },
    });
    await expect(call).rejects.toBe(boom);
    const log = await db
      .prepare('SELECT status, error, message_id FROM email_log WHERE owner_email = ?')
      .bind(ALICE)
      .first<{ status: string; error: string; message_id: string | null }>();
    expect(log).toMatchObject({ status: 'failed', message_id: null });
    expect(log?.error).toContain('missing Email Sending scope');
  });

  it('still rethrows the original provider error when the failed-log write itself throws', async () => {
    const { db, key } = await setup();
    const boom = new CfApiError(403, ['missing Email Sending scope']);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const call = sendEmail({ db: withBrokenLogWrites(db), key, userEmail: ALICE }, 'dom-resend', msg(), {
        resend: async () => {
          throw boom;
        },
      });
      await expect(call).rejects.toBe(boom);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
    expect(await countLogs(db)).toBe(0);
  });
});
