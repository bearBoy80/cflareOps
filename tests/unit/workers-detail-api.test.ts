import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import { GET as getDeployments } from '@/pages/api/pages/projects/[accountId]/[name]/deployments';
import { GET as getContent } from '@/pages/api/workers/scripts/[accountId]/[name]/content';
import { GET as getHistory } from '@/pages/api/workers/scripts/[accountId]/[name]/history';
import type { CfAccount, CfPagesProject, CfWorkerScript } from '@/server/cf/types';
import { encryptSecret, importEncryptionKey } from '@/server/crypto';
import { insertAccount } from '@/server/db/accounts';
import { syncWorkersPages } from '@/server/workersPages';

const HEX_KEY = 'b'.repeat(64);
const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';

function fakeClient(
  cfAccounts: CfAccount[],
  scriptsByCf: Record<string, CfWorkerScript[]> = {},
  projectsByCf: Record<string, CfPagesProject[]> = {},
) {
  return {
    listAccounts: async () => cfAccounts,
    listWorkersScripts: async (accountId: string) => scriptsByCf[accountId] ?? [],
    listPagesProjects: async (accountId: string) => projectsByCf[accountId] ?? [],
  };
}

/** 种子：ALICE 的账号 a1，缓存一条 workers 脚本 worker-a 和一条 pages 项目 proj-a */
async function seedCache(db: ReturnType<typeof createTestDb>) {
  const key = await importEncryptionKey(HEX_KEY);
  await insertAccount(db, {
    id: 'a1',
    ownerEmail: ALICE,
    name: 'acct-a1',
    tokenEncrypted: await encryptSecret('tok-1', key),
    tokenHash: 'hash-a1',
  });
  await syncWorkersPages(db, key, ALICE, () =>
    fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [{ id: 'worker-a' }] }, { 'cf-1': [{ name: 'proj-a' }] }),
  );
}

function makeContext(db: unknown, url: string, params: Record<string, string>, userEmail = ALICE) {
  return {
    locals: {
      userEmail,
      runtime: { env: { DB: db, ENCRYPTION_KEY: HEX_KEY } },
    },
    request: new Request(url),
    params,
  } as unknown as Parameters<typeof getContent>[0];
}

describe('GET /api/workers/scripts/[accountId]/[name]/content', () => {
  it('returns 404 for a script not in cache', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await getContent(
      makeContext(db, 'http://localhost/api/workers/scripts/a1/nope/content', {
        accountId: 'a1',
        name: 'nope',
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Script not found');
  });

  it('returns 404 for a cached script owned by another user', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await getContent(
      makeContext(
        db,
        'http://localhost/api/workers/scripts/a1/worker-a/content',
        { accountId: 'a1', name: 'worker-a' },
        BOB,
      ),
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /api/workers/scripts/[accountId]/[name]/history', () => {
  it('returns 404 for a script not in cache', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await getHistory(
      makeContext(db, 'http://localhost/api/workers/scripts/a1/nope/history', {
        accountId: 'a1',
        name: 'nope',
      }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 for a cached script owned by another user', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await getHistory(
      makeContext(
        db,
        'http://localhost/api/workers/scripts/a1/worker-a/history',
        { accountId: 'a1', name: 'worker-a' },
        BOB,
      ),
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /api/pages/projects/[accountId]/[name]/deployments', () => {
  it('returns 404 for an unknown project', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await getDeployments(
      makeContext(db, 'http://localhost/api/pages/projects/a1/nope/deployments', {
        accountId: 'a1',
        name: 'nope',
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Project not found');
  });

  it('returns 404 for a cached project owned by another user', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await getDeployments(
      makeContext(
        db,
        'http://localhost/api/pages/projects/a1/proj-a/deployments',
        { accountId: 'a1', name: 'proj-a' },
        BOB,
      ),
    );
    expect(res.status).toBe(404);
  });
});
