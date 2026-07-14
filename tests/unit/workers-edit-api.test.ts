import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import { POST as postDeployment } from '@/pages/api/pages/projects/[accountId]/[name]/deployments';
import { GET as getPagesDomains, POST as postPagesDomain } from '@/pages/api/pages/projects/[accountId]/[name]/domains';
import { POST as purgeBuildCache } from '@/pages/api/pages/projects/[accountId]/[name]/purge-build-cache';
import { PUT as putCrons } from '@/pages/api/workers/scripts/[accountId]/[name]/crons';
import { POST as postWorkerDomain } from '@/pages/api/workers/scripts/[accountId]/[name]/domains';
import { GET as getSecrets, PUT as putSecret } from '@/pages/api/workers/scripts/[accountId]/[name]/secrets';
import { PUT as putSettings } from '@/pages/api/workers/scripts/[accountId]/[name]/settings';
import { GET as getSubdomain, PUT as putSubdomain } from '@/pages/api/workers/scripts/[accountId]/[name]/subdomain';
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

/** 种子：ALICE 的账号 a1，缓存脚本 worker-a 与项目 proj-a（编辑档路由的 owner 隔离靠这两行缓存判定） */
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

async function seedZone(
  db: ReturnType<typeof createTestDb>,
  zoneId: string,
  accountId: string,
  name: string,
  cfAccountId: string | null = null,
) {
  await db
    .prepare(
      `INSERT INTO zones (id, account_id, name, status, paused, type, development_mode,
         name_servers, original_name_servers, original_registrar,
         cf_account_id, cf_account_name, plan_id, plan_name,
         created_on, modified_on, activated_on, raw_json, synced_at)
       VALUES (?, ?, ?, 'active', 0, 'full', 0, '[]', '[]', null, ?, null, null, null,
               null, null, null, '{}', '2024-01-01T00:00:00Z')`,
    )
    .bind(zoneId, accountId, name, cfAccountId)
    .run();
}

function makeContext(
  db: unknown,
  url: string,
  params: Record<string, string>,
  opts: { userEmail?: string; method?: string; body?: unknown } = {},
) {
  const init: RequestInit =
    opts.method && opts.method !== 'GET'
      ? {
          method: opts.method,
          ...(opts.body !== undefined
            ? { body: JSON.stringify(opts.body), headers: { 'content-type': 'application/json' } }
            : {}),
        }
      : {};
  return {
    locals: {
      userEmail: opts.userEmail ?? ALICE,
      runtime: { env: { DB: db, ENCRYPTION_KEY: HEX_KEY } },
    },
    request: new Request(url, init),
    params,
  } as unknown as Parameters<typeof putCrons>[0];
}

describe('PUT /api/workers/scripts/[accountId]/[name]/crons', () => {
  it('returns 404 for a script not in cache', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await putCrons(
      makeContext(
        db,
        'http://localhost/api/workers/scripts/a1/nope/crons',
        { accountId: 'a1', name: 'nope' },
        { method: 'PUT', body: { crons: ['* * * * *'] } },
      ),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 for a cached script owned by another user', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await putCrons(
      makeContext(
        db,
        'http://localhost/api/workers/scripts/a1/worker-a/crons',
        { accountId: 'a1', name: 'worker-a' },
        { userEmail: BOB, method: 'PUT', body: { crons: ['* * * * *'] } },
      ),
    );
    expect(res.status).toBe(404);
  });

  it('rejects invalid cron expressions with 400 before reaching CF', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await putCrons(
      makeContext(
        db,
        'http://localhost/api/workers/scripts/a1/worker-a/crons',
        { accountId: 'a1', name: 'worker-a' },
        { method: 'PUT', body: { crons: ['not valid !!'] } },
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe('invalidCron');
    expect(body.error).toBe('invalid cron expression at index 0');
  });
});

describe('GET/PUT /api/workers/scripts/[accountId]/[name]/secrets', () => {
  it('GET returns 404 for a script not in cache', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await getSecrets(
      makeContext(db, 'http://localhost/api/workers/scripts/a1/nope/secrets', { accountId: 'a1', name: 'nope' }),
    );
    expect(res.status).toBe(404);
  });

  it('GET returns 404 for a cached script owned by another user', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await getSecrets(
      makeContext(
        db,
        'http://localhost/api/workers/scripts/a1/worker-a/secrets',
        { accountId: 'a1', name: 'worker-a' },
        { userEmail: BOB },
      ),
    );
    expect(res.status).toBe(404);
  });

  it('PUT rejects an invalid secret name with 400 before reaching CF', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await putSecret(
      makeContext(
        db,
        'http://localhost/api/workers/scripts/a1/worker-a/secrets',
        { accountId: 'a1', name: 'worker-a' },
        { method: 'PUT', body: { name: '1bad', text: 'v' } },
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('invalidSecretName');
  });
});

describe('POST /api/workers/scripts/[accountId]/[name]/domains', () => {
  it('returns 404 for a script not in cache', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await postWorkerDomain(
      makeContext(
        db,
        'http://localhost/api/workers/scripts/a1/nope/domains',
        { accountId: 'a1', name: 'nope' },
        { method: 'POST', body: { hostname: 'w.example.com' } },
      ),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 for a cached script owned by another user', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await postWorkerDomain(
      makeContext(
        db,
        'http://localhost/api/workers/scripts/a1/worker-a/domains',
        { accountId: 'a1', name: 'worker-a' },
        { userEmail: BOB, method: 'POST', body: { hostname: 'w.example.com' } },
      ),
    );
    expect(res.status).toBe(404);
  });

  it('rejects a malformed hostname with 400 before reaching CF', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await postWorkerDomain(
      makeContext(
        db,
        'http://localhost/api/workers/scripts/a1/worker-a/domains',
        { accountId: 'a1', name: 'worker-a' },
        { method: 'POST', body: { hostname: 'bad host' } },
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('invalidHostname');
  });

  it('rejects a hostname outside aggregated zones with 400 zoneNotFound', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await postWorkerDomain(
      makeContext(
        db,
        'http://localhost/api/workers/scripts/a1/worker-a/domains',
        { accountId: 'a1', name: 'worker-a' },
        { method: 'POST', body: { hostname: 'w.example.com' } },
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('zoneNotFound');
  });

  it('rejects a zone that belongs to another CF account with 400 zoneNotFound (never sends a foreign zone_id)', async () => {
    const db = createTestDb();
    await seedCache(db); // worker-a 挂在 cf-1 下
    await seedZone(db, 'z-foreign', 'a1', 'example.com', 'cf-other');
    const res = await postWorkerDomain(
      makeContext(
        db,
        'http://localhost/api/workers/scripts/a1/worker-a/domains',
        { accountId: 'a1', name: 'worker-a' },
        { method: 'POST', body: { hostname: 'w.example.com' } },
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('zoneNotFound');
  });
});

describe('GET /api/pages/projects/[accountId]/[name]/domains', () => {
  it('returns 404 for an unknown project', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await getPagesDomains(
      makeContext(db, 'http://localhost/api/pages/projects/a1/nope/domains', { accountId: 'a1', name: 'nope' }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 for a cached project owned by another user', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await getPagesDomains(
      makeContext(
        db,
        'http://localhost/api/pages/projects/a1/proj-a/domains',
        { accountId: 'a1', name: 'proj-a' },
        { userEmail: BOB },
      ),
    );
    expect(res.status).toBe(404);
  });

  it('POST rejects a malformed hostname with 400 before reaching CF', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await postPagesDomain(
      makeContext(
        db,
        'http://localhost/api/pages/projects/a1/proj-a/domains',
        { accountId: 'a1', name: 'proj-a' },
        { method: 'POST', body: { domain: 'bad host' } },
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('invalidHostname');
  });
});

describe('POST /api/pages/projects/[accountId]/[name]/deployments', () => {
  it('returns 404 for an unknown project', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await postDeployment(
      makeContext(
        db,
        'http://localhost/api/pages/projects/a1/nope/deployments',
        { accountId: 'a1', name: 'nope' },
        { method: 'POST' },
      ),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 for a cached project owned by another user', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await postDeployment(
      makeContext(
        db,
        'http://localhost/api/pages/projects/a1/proj-a/deployments',
        { accountId: 'a1', name: 'proj-a' },
        { userEmail: BOB, method: 'POST' },
      ),
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/pages/projects/[accountId]/[name]/purge-build-cache', () => {
  it('returns 404 for an unknown project', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await purgeBuildCache(
      makeContext(
        db,
        'http://localhost/api/pages/projects/a1/nope/purge-build-cache',
        { accountId: 'a1', name: 'nope' },
        { method: 'POST' },
      ),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 for a cached project owned by another user', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await purgeBuildCache(
      makeContext(
        db,
        'http://localhost/api/pages/projects/a1/proj-a/purge-build-cache',
        { accountId: 'a1', name: 'proj-a' },
        { userEmail: BOB, method: 'POST' },
      ),
    );
    expect(res.status).toBe(404);
  });
});

describe('GET/PUT /api/workers/scripts/[accountId]/[name]/subdomain', () => {
  it('GET returns 404 for a script not in cache', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await getSubdomain(
      makeContext(db, 'http://localhost/api/workers/scripts/a1/nope/subdomain', { accountId: 'a1', name: 'nope' }),
    );
    expect(res.status).toBe(404);
  });

  it('GET returns 404 for a cached script owned by another user', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await getSubdomain(
      makeContext(
        db,
        'http://localhost/api/workers/scripts/a1/worker-a/subdomain',
        { accountId: 'a1', name: 'worker-a' },
        { userEmail: BOB },
      ),
    );
    expect(res.status).toBe(404);
  });

  it('PUT rejects non-boolean flags with 400 invalidBody before reaching CF', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await putSubdomain(
      makeContext(
        db,
        'http://localhost/api/workers/scripts/a1/worker-a/subdomain',
        { accountId: 'a1', name: 'worker-a' },
        { method: 'PUT', body: { enabled: 'yes', previewsEnabled: true } },
      ),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('invalidBody');
  });
});

describe('PUT /api/workers/scripts/[accountId]/[name]/settings', () => {
  it('returns 404 for a cached script owned by another user', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await putSettings(
      makeContext(
        db,
        'http://localhost/api/workers/scripts/a1/worker-a/settings',
        { accountId: 'a1', name: 'worker-a' },
        { userEmail: BOB, method: 'PUT', body: { bindings: [] } },
      ),
    );
    expect(res.status).toBe(404);
  });

  it('rejects a missing bindings array with 400 invalidBody', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await putSettings(
      makeContext(
        db,
        'http://localhost/api/workers/scripts/a1/worker-a/settings',
        { accountId: 'a1', name: 'worker-a' },
        { method: 'PUT', body: { compatibilityDate: '2026-07-06' } },
      ),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('invalidBody');
  });

  it('rejects a malformed compatibilityDate with 400 invalidCompatDate', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await putSettings(
      makeContext(
        db,
        'http://localhost/api/workers/scripts/a1/worker-a/settings',
        { accountId: 'a1', name: 'worker-a' },
        { method: 'PUT', body: { bindings: [], compatibilityDate: '2026/07/06' } },
      ),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('invalidCompatDate');
  });

  it('rejects an invalid binding entry with 400 invalidBinding', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await putSettings(
      makeContext(
        db,
        'http://localhost/api/workers/scripts/a1/worker-a/settings',
        { accountId: 'a1', name: 'worker-a' },
        { method: 'PUT', body: { bindings: [{ kind: 'kv_namespace', name: 'KV' }] } },
      ),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('invalidBinding');
  });

  it('rejects non-string compatibilityFlags with 400 invalidBody', async () => {
    const db = createTestDb();
    await seedCache(db);
    const res = await putSettings(
      makeContext(
        db,
        'http://localhost/api/workers/scripts/a1/worker-a/settings',
        { accountId: 'a1', name: 'worker-a' },
        { method: 'PUT', body: { bindings: [], compatibilityFlags: [1] } },
      ),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('invalidBody');
  });
});
