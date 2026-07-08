import pLimit from 'p-limit';
import { CfClient } from './cf/client';
import { NotFoundError } from './context';
import { decryptSecret } from './crypto';
import { getAccount, updateAccountStatus } from './db/accounts';
import type { Db, DbStatement } from './db/types';

export interface WorkerScriptItem {
  id: string;
  accountId: string; // 本系统账号记录 id
  accountName: string; // 本系统账号备注名
  cfAccountId: string | null; // CF 侧账号 id（accounts.list）
  cfAccountName: string | null; // CF 侧账号名
  createdOn: string | null;
  modifiedOn: string | null;
  usageModel: string | null;
  lastDeployedFrom: string | null;
  syncedAt: string;
}

export interface PagesProjectItem {
  name: string;
  accountId: string; // 本系统账号记录 id
  accountName: string; // 本系统账号备注名
  cfAccountId: string | null; // CF 侧账号 id（accounts.list）
  cfAccountName: string | null; // CF 侧账号名
  subdomain: string | null;
  productionBranch: string | null;
  domains: string[];
  sourceRepo: string | null;
  createdOn: string | null;
  latestDeploymentOn: string | null;
  syncedAt: string;
}

const CONCURRENCY = 3;

type SyncClient = Pick<CfClient, 'listAccounts' | 'listWorkersScripts' | 'listPagesProjects'>;

export async function syncWorkersPages(
  db: Db,
  key: CryptoKey,
  ownerEmail: string,
  makeClient: (token: string) => SyncClient = (t) => new CfClient(t),
  accountId?: string,
): Promise<{ scripts: number; projects: number; failures: { accountId: string; error: string }[] }> {
  const params: unknown[] = [ownerEmail];
  let sql = 'SELECT id, token_encrypted FROM cf_accounts WHERE owner_email = ?';
  if (accountId) {
    sql += ' AND id = ?';
    params.push(accountId);
  }
  const { results: accounts } = await db
    .prepare(sql)
    .bind(...params)
    .all<{ id: string; token_encrypted: string }>();

  const limit = pLimit(CONCURRENCY);
  const failures: { accountId: string; error: string }[] = [];
  let scripts = 0;
  let projects = 0;

  await Promise.all(
    accounts.map((account) =>
      limit(async () => {
        try {
          const token = await decryptSecret(account.token_encrypted, key);
          const client = makeClient(token);
          const cfAccounts = await client.listAccounts();
          const syncedAt = new Date().toISOString();

          // Collect all statements first: DELETE then all INSERTs.
          // Atomic batch replace: if any fetch throws before this point, the batch
          // never runs and the old cache is preserved (no partial-delete bug).
          const stmts: DbStatement[] = [
            db.prepare('DELETE FROM workers_scripts WHERE account_id = ?').bind(account.id),
            db.prepare('DELETE FROM pages_projects WHERE account_id = ?').bind(account.id),
          ];

          let localScripts = 0;
          let localProjects = 0;
          for (const cfAccount of cfAccounts) {
            const [scriptList, projectList] = await Promise.all([
              client.listWorkersScripts(cfAccount.id),
              client.listPagesProjects(cfAccount.id),
            ]);
            for (const s of scriptList) {
              stmts.push(
                db
                  .prepare(
                    `INSERT OR REPLACE INTO workers_scripts (
                       id, account_id, cf_account_id, cf_account_name,
                       created_on, modified_on, usage_model, last_deployed_from,
                       raw_json, synced_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  )
                  .bind(
                    s.id,
                    account.id,
                    cfAccount.id,
                    cfAccount.name,
                    s.created_on ?? null,
                    s.modified_on ?? null,
                    s.usage_model ?? null,
                    s.last_deployed_from ?? null,
                    JSON.stringify(s.raw ?? s),
                    syncedAt,
                  ),
              );
            }
            for (const p of projectList) {
              stmts.push(
                db
                  .prepare(
                    `INSERT OR REPLACE INTO pages_projects (
                       name, account_id, cf_account_id, cf_account_name,
                       subdomain, production_branch, domains, source_repo,
                       created_on, latest_deployment_on, raw_json, synced_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  )
                  .bind(
                    p.name,
                    account.id,
                    cfAccount.id,
                    cfAccount.name,
                    p.subdomain ?? null,
                    p.production_branch ?? null,
                    JSON.stringify(p.domains ?? []),
                    p.source_repo ?? null,
                    p.created_on ?? null,
                    p.latest_deployment_on ?? null,
                    JSON.stringify(p.raw ?? p),
                    syncedAt,
                  ),
              );
            }
            localScripts += scriptList.length;
            localProjects += projectList.length;
          }

          // Single atomic batch: any failure (including subrequest-limit exceeded)
          // rolls back entirely, leaving the old cache intact.
          await db.batch(stmts);
          await updateAccountStatus(db, account.id, 'active');
          scripts += localScripts;
          projects += localProjects;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          failures.push({ accountId: account.id, error: message });
          try {
            await updateAccountStatus(db, account.id, 'error', message);
          } catch {
            // Failure is already recorded in failures[]; if recording the failure
            // itself throws, that shouldn't abort the entire batch.
          }
        }
      }),
    ),
  );

  return { scripts, projects, failures };
}

export interface WorkerScriptPage {
  scripts: WorkerScriptItem[];
  total: number;
}

export async function listCachedWorkersScripts(
  db: Db,
  ownerEmail: string,
  opts?: { page?: number; pageSize?: number; search?: string },
): Promise<WorkerScriptPage> {
  const page = Math.max(1, opts?.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts?.pageSize ?? 20));
  const rawSearch = opts?.search?.trim() ?? '';

  const conditions: string[] = ['a.owner_email = ?'];
  const params: unknown[] = [ownerEmail];

  if (rawSearch !== '') {
    const pattern = `%${rawSearch.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(`(w.id LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\')`);
    params.push(pattern, pattern);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS cnt FROM workers_scripts w JOIN cf_accounts a ON a.id = w.account_id ${where}`)
    .bind(...params)
    .first<{ cnt: number }>();
  const total = countRow?.cnt ?? 0;

  const { results } = await db
    .prepare(
      `SELECT w.id, w.account_id, a.name AS account_name, w.cf_account_id, w.cf_account_name,
              w.created_on, w.modified_on, w.usage_model, w.last_deployed_from, w.synced_at
       FROM workers_scripts w JOIN cf_accounts a ON a.id = w.account_id
       ${where} ORDER BY (w.modified_on IS NULL), w.modified_on DESC, w.id LIMIT ? OFFSET ?`,
    )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all<{
      id: string;
      account_id: string;
      account_name: string;
      cf_account_id: string | null;
      cf_account_name: string | null;
      created_on: string | null;
      modified_on: string | null;
      usage_model: string | null;
      last_deployed_from: string | null;
      synced_at: string;
    }>();

  const scripts = results.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    accountName: r.account_name,
    cfAccountId: r.cf_account_id,
    cfAccountName: r.cf_account_name,
    createdOn: r.created_on,
    modifiedOn: r.modified_on,
    usageModel: r.usage_model,
    lastDeployedFrom: r.last_deployed_from,
    syncedAt: r.synced_at,
  }));

  return { scripts, total };
}

export interface PagesProjectPage {
  projects: PagesProjectItem[];
  total: number;
}

export async function listCachedPagesProjects(
  db: Db,
  ownerEmail: string,
  opts?: { page?: number; pageSize?: number; search?: string },
): Promise<PagesProjectPage> {
  const page = Math.max(1, opts?.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts?.pageSize ?? 20));
  const rawSearch = opts?.search?.trim() ?? '';

  const conditions: string[] = ['a.owner_email = ?'];
  const params: unknown[] = [ownerEmail];

  if (rawSearch !== '') {
    const pattern = `%${rawSearch.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(`(p.name LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\')`);
    params.push(pattern, pattern);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS cnt FROM pages_projects p JOIN cf_accounts a ON a.id = p.account_id ${where}`)
    .bind(...params)
    .first<{ cnt: number }>();
  const total = countRow?.cnt ?? 0;

  const { results } = await db
    .prepare(
      `SELECT p.name, p.account_id, a.name AS account_name, p.cf_account_id, p.cf_account_name,
              p.subdomain, p.production_branch, p.domains, p.source_repo,
              p.created_on, p.latest_deployment_on, p.synced_at
       FROM pages_projects p JOIN cf_accounts a ON a.id = p.account_id
       ${where} ORDER BY (p.latest_deployment_on IS NULL), p.latest_deployment_on DESC, p.name LIMIT ? OFFSET ?`,
    )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all<{
      name: string;
      account_id: string;
      account_name: string;
      cf_account_id: string | null;
      cf_account_name: string | null;
      subdomain: string | null;
      production_branch: string | null;
      domains: string | null;
      source_repo: string | null;
      created_on: string | null;
      latest_deployment_on: string | null;
      synced_at: string;
    }>();

  const projects = results.map((r) => ({
    name: r.name,
    accountId: r.account_id,
    accountName: r.account_name,
    cfAccountId: r.cf_account_id,
    cfAccountName: r.cf_account_name,
    subdomain: r.subdomain,
    productionBranch: r.production_branch,
    domains: r.domains ? (JSON.parse(r.domains) as string[]) : [],
    sourceRepo: r.source_repo,
    createdOn: r.created_on,
    latestDeploymentOn: r.latest_deployment_on,
    syncedAt: r.synced_at,
  }));

  return { projects, total };
}

/** 详情页取单条缓存脚本行（owner 隔离：join cf_accounts 过滤 owner_email），不存在返回 null。 */
export async function getCachedWorkerScript(
  db: Db,
  ownerEmail: string,
  accountId: string,
  name: string,
  cfAccountId?: string,
): Promise<WorkerScriptItem | null> {
  // 同名脚本可存在于同一 token 的多个 CF 账号：给 cfAccountId 时精确定位，
  // 未给时按 cf_account_id 排序取第一条保证确定性
  const cfCond = cfAccountId ? ' AND w.cf_account_id = ?' : '';
  const params = cfAccountId ? [name, accountId, ownerEmail, cfAccountId] : [name, accountId, ownerEmail];
  const r = await db
    .prepare(
      `SELECT w.id, w.account_id, a.name AS account_name, w.cf_account_id, w.cf_account_name,
              w.created_on, w.modified_on, w.usage_model, w.last_deployed_from, w.synced_at
       FROM workers_scripts w JOIN cf_accounts a ON a.id = w.account_id
       WHERE w.id = ? AND w.account_id = ? AND a.owner_email = ?${cfCond}
       ORDER BY w.cf_account_id LIMIT 1`,
    )
    .bind(...params)
    .first<{
      id: string;
      account_id: string;
      account_name: string;
      cf_account_id: string | null;
      cf_account_name: string | null;
      created_on: string | null;
      modified_on: string | null;
      usage_model: string | null;
      last_deployed_from: string | null;
      synced_at: string;
    }>();
  if (!r) return null;
  return {
    id: r.id,
    accountId: r.account_id,
    accountName: r.account_name,
    cfAccountId: r.cf_account_id,
    cfAccountName: r.cf_account_name,
    createdOn: r.created_on,
    modifiedOn: r.modified_on,
    usageModel: r.usage_model,
    lastDeployedFrom: r.last_deployed_from,
    syncedAt: r.synced_at,
  };
}

/** 详情页取单条缓存 Pages 项目行（owner 隔离），不存在返回 null。 */
export async function getCachedPagesProject(
  db: Db,
  ownerEmail: string,
  accountId: string,
  name: string,
  cfAccountId?: string,
): Promise<PagesProjectItem | null> {
  const cfCond = cfAccountId ? ' AND p.cf_account_id = ?' : '';
  const params = cfAccountId ? [name, accountId, ownerEmail, cfAccountId] : [name, accountId, ownerEmail];
  const r = await db
    .prepare(
      `SELECT p.name, p.account_id, a.name AS account_name, p.cf_account_id, p.cf_account_name,
              p.subdomain, p.production_branch, p.domains, p.source_repo,
              p.created_on, p.latest_deployment_on, p.synced_at
       FROM pages_projects p JOIN cf_accounts a ON a.id = p.account_id
       WHERE p.name = ? AND p.account_id = ? AND a.owner_email = ?${cfCond}
       ORDER BY p.cf_account_id LIMIT 1`,
    )
    .bind(...params)
    .first<{
      name: string;
      account_id: string;
      account_name: string;
      cf_account_id: string | null;
      cf_account_name: string | null;
      subdomain: string | null;
      production_branch: string | null;
      domains: string | null;
      source_repo: string | null;
      created_on: string | null;
      latest_deployment_on: string | null;
      synced_at: string;
    }>();
  if (!r) return null;
  return {
    name: r.name,
    accountId: r.account_id,
    accountName: r.account_name,
    cfAccountId: r.cf_account_id,
    cfAccountName: r.cf_account_name,
    subdomain: r.subdomain,
    productionBranch: r.production_branch,
    domains: r.domains ? (JSON.parse(r.domains) as string[]) : [],
    sourceRepo: r.source_repo,
    createdOn: r.created_on,
    latestDeploymentOn: r.latest_deployment_on,
    syncedAt: r.synced_at,
  };
}

export async function workersStats(db: Db, ownerEmail: string): Promise<{ scripts: number; projects: number }> {
  const scriptsRow = await db
    .prepare(
      'SELECT COUNT(*) AS cnt FROM workers_scripts w JOIN cf_accounts a ON a.id = w.account_id WHERE a.owner_email = ?',
    )
    .bind(ownerEmail)
    .first<{ cnt: number }>();
  const projectsRow = await db
    .prepare(
      'SELECT COUNT(*) AS cnt FROM pages_projects p JOIN cf_accounts a ON a.id = p.account_id WHERE a.owner_email = ?',
    )
    .bind(ownerEmail)
    .first<{ cnt: number }>();
  return { scripts: scriptsRow?.cnt ?? 0, projects: projectsRow?.cnt ?? 0 };
}

/**
 * zones 缓存表最长后缀匹配：hostname === zone.name 或 hostname 以 '.' + zone.name 结尾。
 * owner 隔离（JOIN cf_accounts 过滤 owner_email）；多个候选取 zone 名最长者
 * （a.b.example.com 命中 example.com 和 b.example.com 时选 b.example.com）。
 * 一条 SQL 拉 owner 全部 zone 后在 JS 里比较——zone 数量小，且避免 LIKE 注入语义问题。
 * cfAccountId 给定时只在该 CF 账号的 zone 内匹配（跨 CF 账号 zone_id 挂载会被 CF 拒绝）。
 * 返回的 accountId 为本系统账号记录 id，cfAccountId 为 CF 侧账号 id（可能为 null）。
 */
export async function findZoneForHostname(
  db: Db,
  ownerEmail: string,
  hostname: string,
  cfAccountId?: string,
): Promise<{ zoneId: string; zoneName: string; accountId: string; cfAccountId: string | null } | null> {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (normalized === '') return null;

  const cfCond = cfAccountId ? ' AND z.cf_account_id = ?' : '';
  const params = cfAccountId ? [ownerEmail, cfAccountId] : [ownerEmail];
  const { results } = await db
    .prepare(
      `SELECT z.id, z.name, z.account_id, z.cf_account_id
       FROM zones z JOIN cf_accounts a ON a.id = z.account_id
       WHERE a.owner_email = ?${cfCond}`,
    )
    .bind(...params)
    .all<{ id: string; name: string; account_id: string; cf_account_id: string | null }>();

  let best: { id: string; name: string; account_id: string; cf_account_id: string | null } | null = null;
  for (const z of results) {
    const zoneName = z.name.toLowerCase();
    if (normalized !== zoneName && !normalized.endsWith(`.${zoneName}`)) continue;
    if (!best || zoneName.length > best.name.length) best = { ...z, name: zoneName };
  }
  if (!best) return null;
  return { zoneId: best.id, zoneName: best.name, accountId: best.account_id, cfAccountId: best.cf_account_id };
}

/**
 * 为 Pages 自定义域创建 CNAME → target（如 my-proj.pages.dev）。
 * 任何失败（zone 未命中、解密失败、CF API 报错如 81053 记录已存在）都不抛出，
 * 通过返回值分字段报告，由调用方决定如何呈现——DNS 创建失败不应回滚域名添加。
 * makeClient 仅测试注入用；zone→账号→token 的解析内联（等价 clientForZone 的查询语义）。
 */
export async function createPagesDnsRecord(
  db: Db,
  key: CryptoKey,
  ownerEmail: string,
  opts: { hostname: string; target: string },
  makeClient: (token: string) => Pick<CfClient, 'createDnsRecord'> = (t) => new CfClient(t),
): Promise<{ created: boolean; zoneName?: string; error?: string }> {
  let zoneName: string | undefined;
  try {
    const zone = await findZoneForHostname(db, ownerEmail, opts.hostname);
    if (!zone) return { created: false, error: 'no matching zone' };
    zoneName = zone.zoneName;

    const account = await getAccount(db, ownerEmail, zone.accountId);
    if (!account) return { created: false, zoneName, error: 'owning account not found' };

    const client = makeClient(await decryptSecret(account.token_encrypted, key));
    const name = opts.hostname.trim().toLowerCase().replace(/\.$/, '');
    await client.createDnsRecord(zone.zoneId, {
      type: 'CNAME',
      name,
      content: opts.target,
      ttl: 1,
      proxied: true,
    });
    return { created: true, zoneName };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { created: false, ...(zoneName !== undefined ? { zoneName } : {}), error: message };
  }
}

export async function clientForAccount(
  db: Db,
  key: CryptoKey,
  ownerEmail: string,
  accountId: string,
): Promise<CfClient> {
  const account = await getAccount(db, ownerEmail, accountId);
  if (!account) throw new NotFoundError('account not found');
  return new CfClient(await decryptSecret(account.token_encrypted, key));
}
