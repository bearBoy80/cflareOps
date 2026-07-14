import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import { CfApiError, CfClient } from '@/server/cf/client';
import type { CfAccount, CfDnsRecordInput, CfPagesProject, CfWorkerScript } from '@/server/cf/types';
import { encryptSecret, importEncryptionKey } from '@/server/crypto';
import { deleteAccount, insertAccount } from '@/server/db/accounts';
import {
  clientForAccount,
  createPagesDnsRecord,
  findZoneForHostname,
  listCachedPagesProjects,
  listCachedWorkersScripts,
  syncWorkersPages,
  workersStats,
} from '@/server/workersPages';

const HEX_KEY = 'b'.repeat(64);
const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';

async function seedAccount(
  db: ReturnType<typeof createTestDb>,
  key: CryptoKey,
  id: string,
  token: string,
  ownerEmail = ALICE,
) {
  await insertAccount(db, {
    id,
    ownerEmail,
    name: `acct-${id}`,
    tokenEncrypted: await encryptSecret(token, key),
    tokenHash: `hash-${id}`,
  });
}

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

describe('syncWorkersPages', () => {
  it('fans out per account and caches scripts + projects with cf_account columns', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedAccount(db, key, 'a2', 'tok-2');

    const clientsByToken: Record<string, ReturnType<typeof fakeClient>> = {
      'tok-1': fakeClient(
        [{ id: 'cf-1', name: 'CF One' }],
        { 'cf-1': [{ id: 'worker-a', usage_model: 'standard', modified_on: '2026-01-01T00:00:00Z' }] },
        { 'cf-1': [{ name: 'proj-a', production_branch: 'main', domains: ['a.pages.dev'] }] },
      ),
      'tok-2': fakeClient(
        [{ id: 'cf-2', name: 'CF Two' }],
        { 'cf-2': [{ id: 'worker-b' }] },
        { 'cf-2': [{ name: 'proj-b', source_repo: 'repo-b', latest_deployment_on: '2026-02-01T00:00:00Z' }] },
      ),
    };
    const result = await syncWorkersPages(db, key, ALICE, (token) => clientsByToken[token]);

    expect(result).toEqual({ scripts: 2, projects: 2, failures: [] });

    const { scripts } = await listCachedWorkersScripts(db, ALICE);
    expect(scripts.map((s) => [s.id, s.accountName, s.cfAccountId, s.cfAccountName])).toEqual([
      ['worker-a', 'acct-a1', 'cf-1', 'CF One'],
      ['worker-b', 'acct-a2', 'cf-2', 'CF Two'],
    ]);
    expect(scripts[0].usageModel).toBe('standard');

    // 默认按 latest_deployment_on 倒序、空值排最后：有部署时间的 proj-b 在前
    const { projects } = await listCachedPagesProjects(db, ALICE);
    expect(projects.map((p) => [p.name, p.accountName, p.cfAccountId, p.cfAccountName])).toEqual([
      ['proj-b', 'acct-a2', 'cf-2', 'CF Two'],
      ['proj-a', 'acct-a1', 'cf-1', 'CF One'],
    ]);
    expect(projects[1].domains).toEqual(['a.pages.dev']);
    expect(projects[1].productionBranch).toBe('main');
    expect(projects[0].sourceRepo).toBe('repo-b');
    expect(projects[0].latestDeploymentOn).toBe('2026-02-01T00:00:00Z');
  });

  it('same script/project name under two CF accounts of one token does not collide', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');

    const result = await syncWorkersPages(db, key, ALICE, () =>
      fakeClient(
        [
          { id: 'cf-1', name: 'CF One' },
          { id: 'cf-2', name: 'CF Two' },
        ],
        { 'cf-1': [{ id: 'api' }], 'cf-2': [{ id: 'api' }] },
        { 'cf-1': [{ name: 'site' }], 'cf-2': [{ name: 'site' }] },
      ),
    );

    expect(result.failures).toEqual([]);
    expect(result.scripts).toBe(2);
    expect(result.projects).toBe(2);
    const { scripts } = await listCachedWorkersScripts(db, ALICE);
    expect(scripts.map((s) => [s.id, s.cfAccountId]).sort()).toEqual([
      ['api', 'cf-1'],
      ['api', 'cf-2'],
    ]);
  });

  it('records failure per account without aborting others', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedAccount(db, key, 'a2', 'tok-2');

    const result = await syncWorkersPages(db, key, ALICE, (token) => {
      if (token === 'tok-1') {
        return {
          ...fakeClient([]),
          listAccounts: async () => {
            throw new Error('boom');
          },
        };
      }
      return fakeClient([{ id: 'cf-2', name: 'CF Two' }], { 'cf-2': [{ id: 'worker-b' }] });
    });

    expect(result.scripts).toBe(1);
    expect(result.failures).toEqual([{ accountId: 'a1', error: 'boom' }]);

    const rows = await db
      .prepare('SELECT id, status, last_error FROM cf_accounts ORDER BY id')
      .all<{ id: string; status: string; last_error: string | null }>();
    expect(rows.results).toEqual([
      { id: 'a1', status: 'error', last_error: 'boom' },
      { id: 'a2', status: 'active', last_error: null },
    ]);
  });

  it('same script id under two local accounts does not collide (composite PK)', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedAccount(db, key, 'a2', 'tok-2');

    // 两个本地账号的 token 看到同名脚本（同一 CF 账号被两处添加的场景）
    const result = await syncWorkersPages(db, key, ALICE, () =>
      fakeClient([{ id: 'cf-shared', name: 'Shared' }], { 'cf-shared': [{ id: 'same-worker' }] }),
    );

    expect(result.failures).toEqual([]);
    const { scripts } = await listCachedWorkersScripts(db, ALICE);
    expect(scripts).toHaveLength(2);
    expect(scripts.every((s) => s.id === 'same-worker')).toBe(true);
    expect(scripts.map((s) => s.accountId).sort()).toEqual(['a1', 'a2']);
  });

  it('resync replaces stale rows (script/project removed upstream disappears)', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');

    await syncWorkersPages(db, key, ALICE, () =>
      fakeClient(
        [{ id: 'cf-1', name: 'CF One' }],
        { 'cf-1': [{ id: 'worker-old' }] },
        { 'cf-1': [{ name: 'proj-old' }] },
      ),
    );
    await syncWorkersPages(db, key, ALICE, () =>
      fakeClient(
        [{ id: 'cf-1', name: 'CF One' }],
        { 'cf-1': [{ id: 'worker-new' }] },
        { 'cf-1': [{ name: 'proj-new' }] },
      ),
    );

    const { scripts } = await listCachedWorkersScripts(db, ALICE);
    expect(scripts.map((s) => s.id)).toEqual(['worker-new']);
    const { projects } = await listCachedPagesProjects(db, ALICE);
    expect(projects.map((p) => p.name)).toEqual(['proj-new']);
  });

  it('isolates owners: BOB lists and stats see nothing of ALICE', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1', ALICE);
    await seedAccount(db, key, 'b1', 'tok-9', BOB);

    const result = await syncWorkersPages(db, key, ALICE, () =>
      fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [{ id: 'worker-a' }] }, { 'cf-1': [{ name: 'proj-a' }] }),
    );

    expect(result.scripts).toBe(1); // 只同步了 ALICE 的账号，未触碰 BOB 的
    expect((await listCachedWorkersScripts(db, BOB)).total).toBe(0);
    expect((await listCachedPagesProjects(db, BOB)).total).toBe(0);
    expect(await workersStats(db, BOB)).toEqual({ scripts: 0, projects: 0 });
  });

  it('keeps the old cache intact when the CF API fails mid-sync (atomic batch replace)', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await syncWorkersPages(db, key, ALICE, () =>
      fakeClient(
        [{ id: 'cf-1', name: 'CF One' }],
        { 'cf-1': [{ id: 'worker-old' }] },
        { 'cf-1': [{ name: 'proj-old' }] },
      ),
    );
    const failing = await syncWorkersPages(db, key, ALICE, () => ({
      listAccounts: async () => [{ id: 'cf-1', name: 'CF One' }],
      listWorkersScripts: async () => {
        throw new Error('api down');
      },
      listPagesProjects: async () => [],
    }));
    expect(failing.failures).toHaveLength(1);
    // 旧缓存原样保留（现状 bug：DELETE 先行会清空缓存）
    const { scripts } = await listCachedWorkersScripts(db, ALICE);
    expect(scripts.map((s) => s.id)).toEqual(['worker-old']);
    const { projects } = await listCachedPagesProjects(db, ALICE);
    expect(projects.map((p) => p.name)).toEqual(['proj-old']);
  });

  it('accountId narrows the sync to a single account', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedAccount(db, key, 'a2', 'tok-2');
    const calls: string[] = [];
    await syncWorkersPages(
      db,
      key,
      ALICE,
      (token) => {
        calls.push(token);
        return fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [{ id: 'w1' }] });
      },
      'a2',
    );
    expect(calls).toEqual(['tok-2']); // 只碰 a2 的 token
    const { scripts } = await listCachedWorkersScripts(db, ALICE);
    expect(scripts.map((s) => s.accountId)).toEqual(['a2']);
  });

  it('a foreign accountId is a no-op (owner filter)', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    const r = await syncWorkersPages(db, key, BOB, () => fakeClient([]), 'a1');
    expect(r).toEqual({ scripts: 0, projects: 0, failures: [] });
  });

  it('deleting the account cascades both cache tables', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await syncWorkersPages(db, key, ALICE, () =>
      fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [{ id: 'worker-a' }] }, { 'cf-1': [{ name: 'proj-a' }] }),
    );

    await deleteAccount(db, ALICE, 'a1');

    const ws = await db.prepare('SELECT COUNT(*) AS cnt FROM workers_scripts').first<{ cnt: number }>();
    const pp = await db.prepare('SELECT COUNT(*) AS cnt FROM pages_projects').first<{ cnt: number }>();
    expect(ws?.cnt).toBe(0);
    expect(pp?.cnt).toBe(0);
  });
});

describe('listCachedWorkersScripts / listCachedPagesProjects search and pagination', () => {
  async function seedCache(db: ReturnType<typeof createTestDb>, key: CryptoKey) {
    await seedAccount(db, key, 'a1', 'tok-1');
    await syncWorkersPages(db, key, ALICE, () =>
      fakeClient(
        [{ id: 'cf-1', name: 'CF One' }],
        { 'cf-1': [{ id: 'alpha' }, { id: 'beta' }, { id: 'a_b' }, { id: 'axb' }, { id: 'weird\\name' }] },
        { 'cf-1': [{ name: 'proj-alpha' }, { name: 'proj-beta' }, { name: 'proj_x' }] },
      ),
    );
  }

  it('lists default to time desc with nulls last (scripts: modified_on, projects: latest_deployment_on)', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await syncWorkersPages(db, key, ALICE, () =>
      fakeClient(
        [{ id: 'cf-1', name: 'CF One' }],
        {
          'cf-1': [
            { id: 'w-old', modified_on: '2026-01-01T00:00:00Z' },
            { id: 'w-none' },
            { id: 'w-new', modified_on: '2026-06-01T00:00:00Z' },
          ],
        },
        {
          'cf-1': [
            { name: 'p-none' },
            { name: 'p-new', latest_deployment_on: '2026-06-01T00:00:00Z' },
            { name: 'p-old', latest_deployment_on: '2026-01-01T00:00:00Z' },
          ],
        },
      ),
    );

    const { scripts } = await listCachedWorkersScripts(db, ALICE);
    expect(scripts.map((s) => s.id)).toEqual(['w-new', 'w-old', 'w-none']);
    const { projects } = await listCachedPagesProjects(db, ALICE);
    expect(projects.map((p) => p.name)).toEqual(['p-new', 'p-old', 'p-none']);
  });

  it('search escapes %, _ and \\ so they match literally', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedCache(db, key);

    // '%' 不应通配匹配全部
    expect((await listCachedWorkersScripts(db, ALICE, { search: '%' })).total).toBe(0);
    expect((await listCachedPagesProjects(db, ALICE, { search: '%' })).total).toBe(0);

    // '_' 只匹配字面下划线（a_b 而非 axb）
    const underscore = await listCachedWorkersScripts(db, ALICE, { search: 'a_b' });
    expect(underscore.total).toBe(1);
    expect(underscore.scripts[0].id).toBe('a_b');
    const projUnderscore = await listCachedPagesProjects(db, ALICE, { search: 'proj_x' });
    expect(projUnderscore.total).toBe(1);

    // 反斜杠字面匹配且不破坏 ESCAPE 子句
    const backslash = await listCachedWorkersScripts(db, ALICE, { search: 'weird\\name' });
    expect(backslash.total).toBe(1);
    expect(backslash.scripts[0].id).toBe('weird\\name');
  });

  it('search matches the local account label (a.name)', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedCache(db, key);
    await seedAccount(db, key, 'other', 'tok-2');

    const scripts = await listCachedWorkersScripts(db, ALICE, { search: 'ACCT-A1' });
    expect(scripts.total).toBe(5);
    const projects = await listCachedPagesProjects(db, ALICE, { search: 'ACCT-A1' });
    expect(projects.total).toBe(3);
  });

  it('paginates with total independent of the window and clamps page < 1', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedCache(db, key);

    const page1 = await listCachedWorkersScripts(db, ALICE, { page: 1, pageSize: 2 });
    expect(page1.total).toBe(5);
    expect(page1.scripts).toHaveLength(2);
    const page3 = await listCachedWorkersScripts(db, ALICE, { page: 3, pageSize: 2 });
    expect(page3.total).toBe(5);
    expect(page3.scripts).toHaveLength(1);

    const clamped = await listCachedWorkersScripts(db, ALICE, { page: -5, pageSize: 2 });
    expect(clamped.scripts.map((s) => s.id)).toEqual(page1.scripts.map((s) => s.id));

    const projPage = await listCachedPagesProjects(db, ALICE, { page: 2, pageSize: 2 });
    expect(projPage.total).toBe(3);
    expect(projPage.projects).toHaveLength(1);
  });
});

describe('workersStats', () => {
  it('counts scripts and projects per owner', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    expect(await workersStats(db, ALICE)).toEqual({ scripts: 0, projects: 0 });

    await seedAccount(db, key, 'a1', 'tok-1');
    await syncWorkersPages(db, key, ALICE, () =>
      fakeClient(
        [{ id: 'cf-1', name: 'CF One' }],
        { 'cf-1': [{ id: 'w1' }, { id: 'w2' }] },
        { 'cf-1': [{ name: 'p1' }] },
      ),
    );

    expect(await workersStats(db, ALICE)).toEqual({ scripts: 2, projects: 1 });
    expect(await workersStats(db, BOB)).toEqual({ scripts: 0, projects: 0 });
  });
});

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

describe('findZoneForHostname', () => {
  it('matches the exact zone name', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedZone(db, 'z1', 'a1', 'example.com');

    expect(await findZoneForHostname(db, ALICE, 'example.com')).toEqual({
      zoneId: 'z1',
      zoneName: 'example.com',
      accountId: 'a1',
      cfAccountId: null,
    });
  });

  it('matches a subdomain of the zone', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedZone(db, 'z1', 'a1', 'example.com');

    expect(await findZoneForHostname(db, ALICE, 'www.example.com')).toEqual({
      zoneId: 'z1',
      zoneName: 'example.com',
      accountId: 'a1',
      cfAccountId: null,
    });
    // 后缀必须以 '.' 边界匹配：notexample.com 不应命中 example.com
    expect(await findZoneForHostname(db, ALICE, 'notexample.com')).toBeNull();
  });

  it('prefers the longest matching zone when zones overlap', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedAccount(db, key, 'a2', 'tok-2');
    await seedZone(db, 'z-short', 'a1', 'example.com');
    await seedZone(db, 'z-long', 'a2', 'b.example.com');

    expect(await findZoneForHostname(db, ALICE, 'a.b.example.com')).toEqual({
      zoneId: 'z-long',
      zoneName: 'b.example.com',
      accountId: 'a2',
      cfAccountId: null,
    });
    // 不在长 zone 下的主机名仍落到短 zone
    expect(await findZoneForHostname(db, ALICE, 'x.example.com')).toEqual({
      zoneId: 'z-short',
      zoneName: 'example.com',
      accountId: 'a1',
      cfAccountId: null,
    });
  });

  it('filters by cfAccountId: a zone in another CF account never matches', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedZone(db, 'z1', 'a1', 'example.com', 'cf-1');
    await seedZone(db, 'z2', 'a1', 'other.dev', 'cf-2');

    // 未传过滤：跨 CF 账号也命中（向后兼容）
    expect((await findZoneForHostname(db, ALICE, 'www.example.com'))?.zoneId).toBe('z1');
    // 过滤到 zone 所在 CF 账号：命中并回带 cfAccountId
    expect(await findZoneForHostname(db, ALICE, 'www.example.com', 'cf-1')).toEqual({
      zoneId: 'z1',
      zoneName: 'example.com',
      accountId: 'a1',
      cfAccountId: 'cf-1',
    });
    // 过滤到另一个 CF 账号：不得命中他账号的 zone
    expect(await findZoneForHostname(db, ALICE, 'www.example.com', 'cf-2')).toBeNull();
    // 最长后缀匹配仍限定在过滤后的候选集内
    await seedZone(db, 'z3', 'a1', 'b.example.com', 'cf-2');
    expect((await findZoneForHostname(db, ALICE, 'a.b.example.com', 'cf-1'))?.zoneId).toBe('z1');
  });

  it("does not leak across owners: BOB never sees ALICE's zones", async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1', ALICE);
    await seedZone(db, 'z1', 'a1', 'example.com');

    expect(await findZoneForHostname(db, BOB, 'www.example.com')).toBeNull();
  });

  it('returns null when nothing matches', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedZone(db, 'z1', 'a1', 'example.com');

    expect(await findZoneForHostname(db, ALICE, 'other.dev')).toBeNull();
  });

  it('normalizes trailing dot and uppercase', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedZone(db, 'z1', 'a1', 'example.com');

    expect(await findZoneForHostname(db, ALICE, 'WWW.Example.COM.')).toEqual({
      zoneId: 'z1',
      zoneName: 'example.com',
      accountId: 'a1',
      cfAccountId: null,
    });
  });
});

describe('createPagesDnsRecord', () => {
  it('creates a proxied CNAME in the matched zone with the owning account token', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedZone(db, 'z1', 'a1', 'example.com');

    const calls: { token: string; zoneId: string; data: CfDnsRecordInput }[] = [];
    const result = await createPagesDnsRecord(
      db,
      key,
      ALICE,
      { hostname: 'App.Example.com.', target: 'my-proj.pages.dev' },
      (token) => ({
        createDnsRecord: async (zoneId, data) => {
          calls.push({ token, zoneId, data });
          return { id: 'rec-1', ...data };
        },
      }),
    );

    expect(result).toEqual({ created: true, zoneName: 'example.com' });
    expect(calls).toEqual([
      {
        token: 'tok-1',
        zoneId: 'z1',
        data: {
          type: 'CNAME',
          name: 'app.example.com',
          content: 'my-proj.pages.dev',
          ttl: 1,
          proxied: true,
        },
      },
    ]);
  });

  it('returns created:false with "no matching zone" when no zone covers the hostname', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedZone(db, 'z1', 'a1', 'example.com');

    const result = await createPagesDnsRecord(
      db,
      key,
      ALICE,
      { hostname: 'app.other.dev', target: 'my-proj.pages.dev' },
      () => ({
        createDnsRecord: async () => {
          throw new Error('should not be called');
        },
      }),
    );

    expect(result).toEqual({ created: false, error: 'no matching zone' });
  });

  it('surfaces CfApiError (e.g. record already exists) without throwing', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedZone(db, 'z1', 'a1', 'example.com');

    const result = await createPagesDnsRecord(
      db,
      key,
      ALICE,
      { hostname: 'app.example.com', target: 'my-proj.pages.dev' },
      () => ({
        createDnsRecord: async () => {
          throw new CfApiError(400, ['An identical record already exists. (81053)']);
        },
      }),
    );

    expect(result).toEqual({
      created: false,
      zoneName: 'example.com',
      error: 'An identical record already exists. (81053)',
    });
  });

  it('returns created:false instead of throwing when decryption fails mid-flow (non-CfApiError)', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedZone(db, 'z1', 'a1', 'example.com');

    // 用错误密钥解密 token：decryptSecret 抛非 CfApiError，不得逃逸成 500
    const wrongKey = await importEncryptionKey('c'.repeat(64));
    const result = await createPagesDnsRecord(
      db,
      wrongKey,
      ALICE,
      { hostname: 'app.example.com', target: 'my-proj.pages.dev' },
      () => ({
        createDnsRecord: async () => {
          throw new Error('should not be called');
        },
      }),
    );

    expect(result.created).toBe(false);
    expect(result.zoneName).toBe('example.com');
    expect(typeof result.error).toBe('string');
  });

  it('returns created:false when createDnsRecord throws a plain (non-CfApiError) error', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    await seedZone(db, 'z1', 'a1', 'example.com');

    const result = await createPagesDnsRecord(
      db,
      key,
      ALICE,
      { hostname: 'app.example.com', target: 'my-proj.pages.dev' },
      () => ({
        createDnsRecord: async () => {
          throw new TypeError('network down');
        },
      }),
    );

    expect(result).toEqual({ created: false, zoneName: 'example.com', error: 'network down' });
  });
});

describe('clientForAccount', () => {
  it('returns a CfClient for an owned account', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1');
    const client = await clientForAccount(db, key, ALICE, 'a1');
    expect(client).toBeInstanceOf(CfClient);
  });

  it("throws NotFoundError for another owner's account or a missing id", async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    await seedAccount(db, key, 'a1', 'tok-1', ALICE);
    await expect(clientForAccount(db, key, BOB, 'a1')).rejects.toThrow('account not found');
    await expect(clientForAccount(db, key, ALICE, 'nope')).rejects.toThrow('account not found');
  });
});
