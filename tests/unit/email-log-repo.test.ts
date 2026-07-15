import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import { getEmailLog, insertEmailLog, listEmailLogs } from '@/server/db/emailLog';
import type { Db } from '@/server/db/types';

const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';

function logInput(id: string, ownerEmail = ALICE, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ownerEmail,
    domainId: null,
    provider: 'resend',
    fromAddress: 'no-reply@mail.example.com',
    recipients: { to: ['a@b.co'], cc: [], bcc: [] },
    subject: `subject-${id}`,
    format: 'markdown',
    content: `# body ${id}`,
    status: 'sent' as const,
    messageId: `mid-${id}`,
    error: null,
    ...overrides,
  };
}

/** 不同用户用不同 id 前缀，避免主键冲突 */
async function seedLogs(db: Db, n: number, ownerEmail = ALICE): Promise<void> {
  const prefix = ownerEmail === ALICE ? 'l' : 'b';
  for (let i = 1; i <= n; i++) {
    await insertEmailLog(db, logInput(`${prefix}${i}`, ownerEmail));
  }
}

describe('emailLog repo', () => {
  it('lists newest first with paging, excluding content', async () => {
    const db = createTestDb();
    await seedLogs(db, 3);
    const page1 = await listEmailLogs(db, ALICE, { page: 1, pageSize: 2 });
    expect(page1.total).toBe(3);
    expect(page1.logs).toHaveLength(2);
    // 倒序：后插入的 l3 在最前（同秒插入时按 created_at 字符串稳定排序，l3 >= l1）
    expect(page1.logs[0].subject >= page1.logs[1].subject).toBe(true);
    for (const log of page1.logs) {
      expect('content' in log).toBe(false);
      expect(log.recipients.to).toEqual(['a@b.co']);
    }
    const page2 = await listEmailLogs(db, ALICE, { page: 2, pageSize: 2 });
    expect(page2.logs).toHaveLength(1);
  });

  it('detail includes content and failure fields', async () => {
    const db = createTestDb();
    await insertEmailLog(db, logInput('l1', ALICE, { status: 'failed', messageId: null, error: 'boom' }));
    const detail = await getEmailLog(db, ALICE, 'l1');
    expect(detail).toMatchObject({ content: '# body l1', status: 'failed', error: 'boom', messageId: null });
  });

  it('is owner-scoped for both list and detail', async () => {
    const db = createTestDb();
    await seedLogs(db, 2, ALICE);
    await seedLogs(db, 1, BOB);
    expect((await listEmailLogs(db, BOB, { page: 1, pageSize: 10 })).total).toBe(1);
    expect(await getEmailLog(db, BOB, 'l1')).toBeNull();
  });
});
