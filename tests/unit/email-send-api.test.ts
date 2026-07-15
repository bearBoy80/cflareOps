import { createTestDb } from '@tests/helpers/d1';
import { afterEach, describe, expect, it } from 'vitest';
import { __setSendDeps, POST } from '@/pages/api/email/send';
import { CfApiError } from '@/server/cf/client';
import { encryptSecret, importEncryptionKey, sha256Hex } from '@/server/crypto';
import { insertEmailDomain } from '@/server/db/emailDomains';
import type { Db } from '@/server/db/types';

const HEX_KEY = 'f'.repeat(64);
const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';

function ctx(db: unknown, body: unknown, userEmail = ALICE) {
  return {
    locals: { userEmail, runtime: { env: { DB: db, ENCRYPTION_KEY: HEX_KEY } } },
    request: new Request('http://localhost/api/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params: {},
  } as unknown as Parameters<typeof POST>[0];
}

async function seedResendDomain(db: Db): Promise<void> {
  const key = await importEncryptionKey(HEX_KEY);
  await insertEmailDomain(db, {
    id: 'dom-1',
    ownerEmail: ALICE,
    domain: 'mail.example.com',
    provider: 'resend',
    apiKeyCiphertext: await encryptSecret('re_key_1', key),
    apiKeyHash: await sha256Hex('re_key_1'),
    accountId: null,
    cfAccountId: null,
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    domainId: 'dom-1',
    from: 'no-reply@mail.example.com',
    to: ['a@b.co'],
    subject: 'Hi',
    format: 'markdown',
    content: '# hello',
    ...overrides,
  };
}

async function countLogs(db: Db): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS cnt FROM email_log').first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

afterEach(() => __setSendDeps(undefined));

describe('POST /api/email/send', () => {
  it('sends via the injected provider and returns the SendResult', async () => {
    const db = createTestDb();
    await seedResendDomain(db);
    __setSendDeps({ resend: async () => ({ messageId: 'rid-1' }) });
    const res = await POST(ctx(db, validBody()));
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toMatchObject({ status: 'sent', messageId: 'rid-1' });
    expect(await countLogs(db)).toBe(1);
  });

  it('400 fieldsRequired for missing to/subject/content/bad format, without logging', async () => {
    const db = createTestDb();
    await seedResendDomain(db);
    for (const bad of [{ to: [] }, { subject: ' ' }, { content: '' }, { format: 'rtf' }]) {
      const res = await POST(ctx(db, validBody(bad)));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('fieldsRequired');
    }
    expect(await countLogs(db)).toBe(0);
  });

  it('400 invalidRecipient names the bad address', async () => {
    const db = createTestDb();
    await seedResendDomain(db);
    const res = await POST(ctx(db, validBody({ cc: ['not-an-email'] })));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('invalidRecipient');
    expect(body.error).toContain('not-an-email');
  });

  it('400 fromDomainMismatch comes from the service layer, no log', async () => {
    const db = createTestDb();
    await seedResendDomain(db);
    const res = await POST(ctx(db, validBody({ from: 'x@other.com' })));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('fromDomainMismatch');
    expect(await countLogs(db)).toBe(0);
  });

  it('404 for a cross-user domainId', async () => {
    const db = createTestDb();
    await seedResendDomain(db);
    const res = await POST(ctx(db, validBody(), BOB));
    expect(res.status).toBe(404);
    expect(await countLogs(db)).toBe(0);
  });

  it('provider 403 maps to emailSendForbidden and the failure is logged', async () => {
    const db = createTestDb();
    await seedResendDomain(db);
    __setSendDeps({
      resend: async () => {
        throw new CfApiError(403, ['missing Email Sending scope']);
      },
    });
    const res = await POST(ctx(db, validBody()));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('emailSendForbidden');
    expect(await countLogs(db)).toBe(1);
    const log = await db.prepare('SELECT status FROM email_log').first<{ status: string }>();
    expect(log?.status).toBe('failed');
  });

  it('provider 5xx maps to 502 via handleCfError', async () => {
    const db = createTestDb();
    await seedResendDomain(db);
    __setSendDeps({
      resend: async () => {
        throw new CfApiError(500, ['upstream down']);
      },
    });
    const res = await POST(ctx(db, validBody()));
    expect(res.status).toBe(502);
  });
});
