import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import { GET as getDetail } from '@/pages/api/email/log/[id]';
import { GET as getList } from '@/pages/api/email/log/index';
import { insertEmailLog } from '@/server/db/emailLog';
import type { Db } from '@/server/db/types';

const HEX_KEY = 'a'.repeat(64);
const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';

function ctx(db: unknown, opts: { url?: string; userEmail?: string; id?: string } = {}) {
  return {
    locals: { userEmail: opts.userEmail ?? ALICE, runtime: { env: { DB: db, ENCRYPTION_KEY: HEX_KEY } } },
    request: new Request(opts.url ?? 'http://localhost/api/email/log'),
    params: opts.id ? { id: opts.id } : {},
  } as unknown as Parameters<typeof getList>[0];
}

async function seed(db: Db, id: string, ownerEmail = ALICE): Promise<void> {
  await insertEmailLog(db, {
    id,
    ownerEmail,
    domainId: null,
    provider: 'resend',
    fromAddress: 'no-reply@mail.example.com',
    recipients: { to: ['a@b.co'], cc: [], bcc: [] },
    subject: `s-${id}`,
    format: 'markdown',
    content: `# secret-body-${id}`,
    status: 'sent',
    messageId: `mid-${id}`,
    error: null,
  });
}

describe('email log API', () => {
  it('lists with paging metadata and never includes content', async () => {
    const db = createTestDb();
    for (let i = 1; i <= 3; i++) await seed(db, `l${i}`);
    const res = await getList(ctx(db, { url: 'http://localhost/api/email/log?page=1&pageSize=2' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: unknown[]; total: number; page: number; pageSize: number };
    expect(body).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(body.logs).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain('secret-body');
  });

  it('detail includes content; cross-user detail is 404', async () => {
    const db = createTestDb();
    await seed(db, 'l1');
    const ok = await getDetail(ctx(db, { id: 'l1' }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { log: { content: string } }).log.content).toBe('# secret-body-l1');
    const denied = await getDetail(ctx(db, { id: 'l1', userEmail: BOB }));
    expect(denied.status).toBe(404);
  });

  it('list is owner-scoped', async () => {
    const db = createTestDb();
    await seed(db, 'l1', ALICE);
    await seed(db, 'b1', BOB);
    const res = await getList(ctx(db, { userEmail: BOB }));
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(1);
  });
});
