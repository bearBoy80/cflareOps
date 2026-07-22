import Cloudflare from 'cloudflare';
import type {
  CfAccount,
  CfDnsRecord,
  CfDnsRecordInput,
  CfPagesDeployment,
  CfPagesDomain,
  CfPagesProject,
  CfR2Bucket,
  CfR2CorsRule,
  CfR2CustomDomain,
  CfR2LifecycleRule,
  CfR2ManagedDomain,
  CfR2Object,
  CfScriptSubdomain,
  CfTokenVerify,
  CfWorkerBinding,
  CfWorkerContent,
  CfWorkerCron,
  CfWorkerDeployment,
  CfWorkerDomain,
  CfWorkerScript,
  CfWorkerSettings,
  CfWorkerVersion,
  CfZone,
} from './types';

const API_BASE = 'https://api.cloudflare.com/client/v4';

export class CfApiError extends Error {
  constructor(
    public status: number,
    public messages: string[],
  ) {
    super(messages.join('; ') || `Cloudflare API error (HTTP ${status})`);
    this.name = 'CfApiError';
  }
}

/**
 * SDK 把 objectKey 原样拼进 URL 路径不做编码——空格/特殊字符会产生非法 URL，
 * 斜杠又必须保留为路径分隔：逐段 encodeURIComponent（deleteR2Object / getR2ObjectContent 共用）。
 */
function encodeR2ObjectKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/** 对象超出服务端中转预览上限时的稳定标记错误（content 路由映射为 413 objectTooLarge） */
export class R2ObjectTooLargeError extends Error {
  constructor() {
    super('object exceeds preview size limit');
    this.name = 'R2ObjectTooLargeError';
  }
}

function extractMessages(e: InstanceType<typeof Cloudflare.APIError>): string[] {
  const maybe = e as unknown as { errors?: { message: string }[] };
  if (Array.isArray(maybe.errors) && maybe.errors.length > 0) return maybe.errors.map((x) => x.message);
  return [e.message];
}

function toDnsRecord(r: unknown): CfDnsRecord {
  const rec = r as {
    id: string;
    type: string;
    name: string;
    content?: string;
    ttl?: number;
    proxied?: boolean;
    priority?: number;
  };
  return {
    id: rec.id,
    type: rec.type,
    name: rec.name,
    content: rec.content ?? '',
    ttl: rec.ttl ?? 1,
    proxied: rec.proxied ?? false,
    priority: rec.priority,
  };
}

function toPagesProject(p: unknown): CfPagesProject {
  const proj = p as {
    name?: string;
    subdomain?: string;
    production_branch?: string;
    domains?: string[];
    created_on?: string;
    source?: { config?: { repo_name?: string } } | null;
    latest_deployment?: { modified_on?: string } | null;
  };
  return {
    name: proj.name ?? '',
    subdomain: proj.subdomain,
    production_branch: proj.production_branch,
    domains: proj.domains,
    source_repo: proj.source?.config?.repo_name ?? null,
    created_on: proj.created_on,
    latest_deployment_on: proj.latest_deployment?.modified_on ?? null,
    raw: p,
  };
}

function toPagesDeployment(d: unknown): CfPagesDeployment {
  const dep = d as {
    id?: string;
    environment?: string;
    url?: string;
    created_on?: string;
    latest_stage?: { name?: string; status?: string } | null;
    deployment_trigger?: { metadata?: { branch?: string; commit_hash?: string } } | null;
  };
  return {
    id: dep.id ?? '',
    environment: dep.environment,
    url: dep.url,
    created_on: dep.created_on,
    latest_stage_status: dep.latest_stage?.status ?? null,
    latest_stage_name: dep.latest_stage?.name ?? null,
    deployment_trigger_branch: dep.deployment_trigger?.metadata?.branch ?? null,
    deployment_trigger_commit_hash: dep.deployment_trigger?.metadata?.commit_hash ?? null,
  };
}

/** 按绑定类型 best-effort 提取目标资源标识（字段名以 SDK ScriptAndVersionSettingGetResponse 绑定联合类型为准） */
function bindingTarget(b: Record<string, unknown>): string | null {
  const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  switch (b.type) {
    case 'kv_namespace':
      return s(b.namespace_id);
    case 'd1':
      return s(b.database_id) ?? s(b.id); // id 为 database_id 的旧名
    case 'r2_bucket':
      return s(b.bucket_name);
    case 'service':
      return s(b.service);
    case 'queue':
      return s(b.queue_name);
    case 'durable_object_namespace':
      return s(b.class_name);
    default:
      return null;
  }
}

function toWorkerBinding(b: unknown): CfWorkerBinding {
  const bind = b as Record<string, unknown>;
  return {
    type: typeof bind.type === 'string' ? bind.type : 'unknown',
    name: typeof bind.name === 'string' ? bind.name : '',
    target: bindingTarget(bind),
  };
}

/** 版本列表项：annotations 在 SDK 列表 typings 中未声明但运行时返回，best-effort 读取 */
function toWorkerVersion(v: unknown): CfWorkerVersion {
  const ver = v as {
    id?: string;
    number?: number;
    metadata?: { created_on?: string; source?: string };
    annotations?: { 'workers/message'?: string; 'workers/triggered_by'?: string };
  };
  return {
    id: ver.id ?? '',
    number: ver.number ?? null,
    created_on: ver.metadata?.created_on ?? null,
    message: ver.annotations?.['workers/message'] ?? null,
    triggered_by: ver.annotations?.['workers/triggered_by'] ?? ver.metadata?.source ?? null,
  };
}

function toWorkerDeployment(d: unknown): CfWorkerDeployment {
  const dep = d as {
    id?: string;
    strategy?: string;
    created_on?: string;
    author_email?: string;
    annotations?: { 'workers/message'?: string };
    versions?: { version_id?: string; percentage?: number }[];
  };
  return {
    id: dep.id ?? '',
    strategy: dep.strategy ?? null,
    created_on: dep.created_on ?? null,
    author_email: dep.author_email ?? null,
    message: dep.annotations?.['workers/message'] ?? null,
    versions: (dep.versions ?? []).map((v) => ({ version_id: v.version_id ?? '', percentage: v.percentage ?? 0 })),
  };
}

/** etag 归一化：去掉弱校验前缀 W/ 与首尾引号；空值归 null */
function normalizeEtag(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.replace(/^W\//i, '').replace(/^"|"$/g, '');
  return trimmed === '' ? null : trimmed;
}

/** etag 响应头缺失时的乐观锁回退：入口模块内容的 SHA-256 hex（WebCrypto，workerd/Node ≥18 均可用） */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** sourcemap part 不算真实模块：upload_source_maps 会让单模块 Worker 看起来像多模块 */
function isSourceMapPart(name: string, filename: string, type: string): boolean {
  return name.endsWith('.map') || filename.endsWith('.map') || type === 'application/source-map';
}

function toPagesDomain(d: unknown): CfPagesDomain {
  const dom = d as {
    id?: string;
    name?: string;
    status?: string | null;
    validation_data?: { status?: string | null } | null;
  };
  return {
    id: dom.id ?? '',
    name: dom.name ?? '',
    status: dom.status ?? null,
    validation_status: dom.validation_data?.status ?? null,
  };
}

export class CfClient {
  private sdk: Cloudflare;

  constructor(
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {
    // workerd 的 fetch 会校验 this 指向：以 this.fetchImpl(...) 属性方式调用时 this 是
    // CfClient 实例，抛 "Illegal invocation"（Node 不校验，单测发现不了）——统一绑回 globalThis
    this.fetchImpl = fetchImpl.bind(globalThis);
    // Cast fetchImpl to avoid minor RequestInfo vs RequestInfo|URL type mismatch between
    // the SDK's internal Fetch type and the global fetch signature in Node 18+.
    this.sdk = new Cloudflare({
      apiToken: token,
      fetch: fetchImpl as (url: RequestInfo, init?: RequestInit) => Promise<Response>,
      maxRetries: 1,
    });
  }

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Cloudflare.APIError) throw new CfApiError(e.status ?? 500, extractMessages(e));
      throw e;
    }
  }

  /** REST fetch fallback：仅供官方 SDK 未覆盖的端点使用，业务代码不得绕过 CfClient 直接 fetch。 */
  async raw<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await this.rawEnvelope<T>(path, init)).result;
  }

  /** raw() 的完整信封版本：需要 result_info（如 total_count 分页）时使用，错误处理与 raw() 一致 */
  private async rawEnvelope<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<{ result: T; result_info?: { page?: number; per_page?: number; count?: number; total_count?: number } }> {
    // new Headers() 归一化：spread 一个 Headers 实例会得到空对象，丢失所有调用方头部
    const headers = new Headers(init.headers);
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${this.token}`);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const res = await this.fetchImpl(`${API_BASE}${path}`, { ...init, headers });
    const body = (await res.json().catch(() => null)) as {
      success: boolean;
      errors?: { message: string }[];
      result: T;
      result_info?: { page?: number; per_page?: number; count?: number; total_count?: number };
    } | null;
    if (!body) throw new CfApiError(res.status, [`Non-JSON response (HTTP ${res.status})`]);
    if (!res.ok || !body.success) {
      throw new CfApiError(
        res.status,
        (body.errors ?? []).map((e) => e.message),
      );
    }
    return { result: body.result, result_info: body.result_info };
  }

  /**
   * GraphQL Analytics API（POST /graphql）。响应是 {data, errors} 而非 v4 信封
   * （无 success/result 字段），不能复用 raw()/rawEnvelope()——这是 CfClient 内
   * 与 raw() 并列的第二个 SDK 未覆盖端点通道。errors 非空按 CfApiError 抛出。
   */
  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`${API_BASE}/graphql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json().catch(() => null)) as {
      data?: T | null;
      errors?: { message: string }[] | null;
    } | null;
    if (!body) throw new CfApiError(res.status, [`Non-JSON response (HTTP ${res.status})`]);
    if (body.errors && body.errors.length > 0) {
      throw new CfApiError(
        res.status,
        body.errors.map((e) => e.message),
      );
    }
    if (!body.data) throw new CfApiError(res.status, ['GraphQL response missing data']);
    return body.data;
  }

  verifyToken(): Promise<CfTokenVerify> {
    return this.wrap(async () => {
      const r = await this.sdk.user.tokens.verify();
      return { id: r.id, status: String(r.status) };
    });
  }

  listZones(): Promise<CfZone[]> {
    return this.wrap(async () => {
      const out: CfZone[] = [];
      for await (const zone of this.sdk.zones.list({ per_page: 50 })) {
        const z = zone as unknown as CfZone & { status?: string };
        out.push({
          id: z.id,
          name: z.name,
          status: String(z.status ?? 'unknown'),
          paused: z.paused,
          type: z.type,
          development_mode: z.development_mode,
          name_servers: z.name_servers,
          original_name_servers: z.original_name_servers,
          original_registrar: z.original_registrar,
          account: z.account,
          plan: z.plan,
          created_on: z.created_on,
          modified_on: z.modified_on,
          activated_on: z.activated_on,
          raw: zone,
        });
      }
      return out;
    });
  }

  listDnsRecords(zoneId: string): Promise<CfDnsRecord[]> {
    return this.wrap(async () => {
      const out: CfDnsRecord[] = [];
      for await (const r of this.sdk.dns.records.list({ zone_id: zoneId, per_page: 100 })) {
        out.push(toDnsRecord(r));
      }
      return out;
    });
  }

  createDnsRecord(zoneId: string, data: CfDnsRecordInput): Promise<CfDnsRecord> {
    return this.wrap(async () => {
      const params = { zone_id: zoneId, ...data } as Parameters<Cloudflare['dns']['records']['create']>[0];
      return toDnsRecord(await this.sdk.dns.records.create(params));
    });
  }

  updateDnsRecord(zoneId: string, recordId: string, data: CfDnsRecordInput): Promise<CfDnsRecord> {
    return this.wrap(async () => {
      const params = { zone_id: zoneId, ...data } as Parameters<Cloudflare['dns']['records']['update']>[1];
      return toDnsRecord(await this.sdk.dns.records.update(recordId, params));
    });
  }

  deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    return this.wrap(async () => {
      await this.sdk.dns.records.delete(recordId, { zone_id: zoneId });
    });
  }

  /** token 可见的全部 CF 账号（V4 分页迭代） */
  listAccounts(): Promise<CfAccount[]> {
    return this.wrap(async () => {
      const out: CfAccount[] = [];
      for await (const a of this.sdk.accounts.list({ per_page: 50 })) {
        out.push({ id: a.id, name: a.name });
      }
      return out;
    });
  }

  listWorkersScripts(accountId: string): Promise<CfWorkerScript[]> {
    return this.wrap(async () => {
      const out: CfWorkerScript[] = [];
      for await (const s of this.sdk.workers.scripts.list({ account_id: accountId })) {
        out.push({
          id: s.id ?? '',
          created_on: s.created_on,
          modified_on: s.modified_on,
          usage_model: s.usage_model,
          last_deployed_from: s.last_deployed_from,
          raw: s,
        });
      }
      return out;
    });
  }

  /** Workers cron 触发器（schedules）；SDK 返回 { schedules: [...] } */
  listWorkerCrons(accountId: string, scriptName: string): Promise<CfWorkerCron[]> {
    return this.wrap(async () => {
      const r = await this.sdk.workers.scripts.schedules.get(scriptName, { account_id: accountId });
      return (r.schedules ?? []).map((s) => ({
        cron: s.cron,
        created_on: s.created_on,
        modified_on: s.modified_on,
      }));
    });
  }

  /** 账号级 Workers 自定义域列表（调用方按 service=script 过滤） */
  listWorkerDomains(accountId: string): Promise<CfWorkerDomain[]> {
    return this.wrap(async () => {
      const out: CfWorkerDomain[] = [];
      for await (const d of this.sdk.workers.domains.list({ account_id: accountId })) {
        out.push({
          id: d.id,
          hostname: d.hostname,
          service: d.service,
          environment: d.environment,
          zone_name: d.zone_name,
        });
      }
      return out;
    });
  }

  listPagesProjects(accountId: string): Promise<CfPagesProject[]> {
    return this.wrap(async () => {
      const out: CfPagesProject[] = [];
      // 注意：/pages/projects 端点显式传 per_page 会被 400（错误码 8000024），交给 SDK 默认分页
      for await (const p of this.sdk.pages.projects.list({ account_id: accountId })) {
        out.push(toPagesProject(p));
      }
      return out;
    });
  }

  getPagesProject(accountId: string, projectName: string): Promise<CfPagesProject> {
    return this.wrap(async () => {
      const p = await this.sdk.pages.projects.get(projectName, { account_id: accountId });
      return toPagesProject(p);
    });
  }

  /** 最近部署：只取第一页并截断到 10 条（详情页展示用，不做全量分页） */
  listPagesDeployments(accountId: string, projectName: string): Promise<CfPagesDeployment[]> {
    return this.wrap(async () => {
      const page = await this.sdk.pages.projects.deployments.list(projectName, {
        account_id: accountId,
        per_page: 10,
      });
      return page.getPaginatedItems().slice(0, 10).map(toPagesDeployment);
    });
  }

  /**
   * Worker 源码：content.get 返回原始 Response（GET .../content/v2，绕过 JSON 信封）。
   * 单模块 Worker 也可能返回 multipart（T0 真机验证）；入口文件名在 cf-entrypoint 响应头
   * （缺失时回退唯一模块名）。multipart 用平台 formData() 解析——手写 boundary 切分会被
   * 源码中形似 boundary 的行破坏。multiModule 由模块 part 数 > 1 判定，sourcemap 不计入。
   */
  getWorkerScriptContent(cfAccountId: string, scriptName: string): Promise<CfWorkerContent> {
    return this.wrap(async () => {
      const res = await this.sdk.workers.scripts.content.get(scriptName, { account_id: cfAccountId });
      const text = await res.text();
      const contentType = res.headers.get('content-type') ?? '';
      const headerEtag = normalizeEtag(res.headers.get('etag'));
      let mainModule = res.headers.get('cf-entrypoint');
      if (!contentType.toLowerCase().includes('multipart/form-data')) {
        return { content: text, mainModule, multiModule: false, etag: headerEtag ?? (await sha256Hex(text)) };
      }
      const form = await new Response(text, { headers: { 'content-type': contentType } }).formData();
      const files: { name: string; filename: string; body: string; type: string }[] = [];
      for (const [name, value] of form.entries()) {
        if (typeof value === 'string') continue; // 非文件字段不是模块
        files.push({ name, filename: value.name, body: await value.text(), type: value.type });
      }
      if (files.length === 0) {
        return { content: text, mainModule, multiModule: false, etag: headerEtag ?? (await sha256Hex(text)) };
      }
      const modules = files.filter((f) => !isSourceMapPart(f.name, f.filename, f.type));
      const candidates = modules.length > 0 ? modules : files;
      const entry =
        (mainModule ? candidates.find((f) => f.filename === mainModule || f.name === mainModule) : undefined) ??
        candidates[0];
      if (!mainModule && candidates.length === 1) mainModule = entry.filename || entry.name;
      return {
        content: entry.body,
        mainModule,
        multiModule: modules.length > 1,
        etag: headerEtag ?? (await sha256Hex(entry.body)),
      };
    });
  }

  /**
   * 只更新 Worker 代码（PUT .../content，multipart）：bindings/compat/secrets 由端点保留，
   * 并产生新版本（T0 真机验证）。mainModule 为入口文件名（ES module 语法）。
   * 返回归一化后的新 etag（SDK 响应 Script.etag，可能缺失）。
   */
  updateWorkerScriptContent(
    cfAccountId: string,
    scriptName: string,
    mainModule: string,
    content: string,
  ): Promise<{ etag: string | null }> {
    return this.wrap(async () => {
      const file = new File([content], mainModule, { type: 'application/javascript+module' });
      const script = await this.sdk.workers.scripts.content.update(scriptName, {
        account_id: cfAccountId,
        metadata: { main_module: mainModule },
        files: [file],
      });
      return { etag: normalizeEtag((script as { etag?: string }).etag) };
    });
  }

  /** 整组替换 Worker cron 触发器（PUT .../schedules，body 为 [{cron}...] 数组） */
  updateWorkerCrons(cfAccountId: string, scriptName: string, crons: string[]): Promise<CfWorkerCron[]> {
    return this.wrap(async () => {
      const r = await this.sdk.workers.scripts.schedules.update(scriptName, {
        account_id: cfAccountId,
        body: crons.map((cron) => ({ cron })),
      });
      return (r.schedules ?? []).map((s) => ({
        cron: s.cron,
        created_on: s.created_on,
        modified_on: s.modified_on,
      }));
    });
  }

  /** 账号级 workers.dev 子域名；账号未注册时 CF 报错 → 返回 null（不抛） */
  async getWorkersSubdomain(cfAccountId: string): Promise<string | null> {
    try {
      const r = await this.sdk.workers.subdomains.get({ account_id: cfAccountId });
      return r.subdomain ?? null;
    } catch {
      return null;
    }
  }

  /** 脚本是否挂在 workers.dev（生产/预览两个开关） */
  getWorkerScriptSubdomain(cfAccountId: string, scriptName: string): Promise<CfScriptSubdomain> {
    return this.wrap(async () => {
      const r = await this.sdk.workers.scripts.subdomain.get(scriptName, { account_id: cfAccountId });
      return { enabled: r.enabled, previews_enabled: r.previews_enabled };
    });
  }

  /** 切换 workers.dev 开关（POST；CF 要求 enabled 必填，previews_enabled 一并带上防漂移） */
  setWorkerScriptSubdomain(
    cfAccountId: string,
    scriptName: string,
    enabled: boolean,
    previewsEnabled: boolean,
  ): Promise<CfScriptSubdomain> {
    return this.wrap(async () => {
      const r = await this.sdk.workers.scripts.subdomain.create(scriptName, {
        account_id: cfAccountId,
        enabled,
        previews_enabled: previewsEnabled,
      });
      return { enabled: r.enabled, previews_enabled: r.previews_enabled };
    });
  }

  /** Worker secrets 列表（只有 name/type，值不可读取；SinglePage 迭代） */
  listWorkerSecrets(cfAccountId: string, scriptName: string): Promise<{ name: string; type: string }[]> {
    return this.wrap(async () => {
      const out: { name: string; type: string }[] = [];
      for await (const s of this.sdk.workers.scripts.secrets.list(scriptName, { account_id: cfAccountId })) {
        out.push({ name: s.name, type: s.type });
      }
      return out;
    });
  }

  /** 新增或覆盖 Worker secret（PUT .../secrets，type 固定 secret_text） */
  putWorkerSecret(cfAccountId: string, scriptName: string, name: string, text: string): Promise<void> {
    return this.wrap(async () => {
      await this.sdk.workers.scripts.secrets.update(scriptName, {
        account_id: cfAccountId,
        name,
        text,
        type: 'secret_text',
      });
    });
  }

  deleteWorkerSecret(cfAccountId: string, scriptName: string, name: string): Promise<void> {
    return this.wrap(async () => {
      await this.sdk.workers.scripts.secrets.delete(scriptName, name, { account_id: cfAccountId });
    });
  }

  /** 挂载 Worker 自定义域（PUT /accounts/:id/workers/domains，幂等 upsert） */
  attachWorkerDomain(
    cfAccountId: string,
    opts: { hostname: string; service: string; zoneId: string },
  ): Promise<CfWorkerDomain> {
    return this.wrap(async () => {
      const d = await this.sdk.workers.domains.update({
        account_id: cfAccountId,
        hostname: opts.hostname,
        service: opts.service,
        environment: 'production',
        zone_id: opts.zoneId,
      });
      return {
        id: d.id,
        hostname: d.hostname,
        service: d.service,
        environment: d.environment,
        zone_name: d.zone_name,
      };
    });
  }

  detachWorkerDomain(cfAccountId: string, domainId: string): Promise<void> {
    return this.wrap(async () => {
      await this.sdk.workers.domains.delete(domainId, { account_id: cfAccountId });
    });
  }

  /**
   * Worker 绑定与配置。注意：SDK 的 scripts.settings.get 实际打 /script-settings（仅
   * logpush/tags/tail_consumers）；bindings/compatibility_date/usage_model 所在的
   * GET /workers/scripts/:name/settings 对应 scripts.scriptAndVersionSettings.get。
   */
  getWorkerScriptSettings(cfAccountId: string, scriptName: string): Promise<CfWorkerSettings> {
    return this.wrap(async () => {
      const r = await this.sdk.workers.scripts.scriptAndVersionSettings.get(scriptName, {
        account_id: cfAccountId,
      });
      return {
        bindings: (r.bindings ?? []).map(toWorkerBinding),
        compatibility_date: r.compatibility_date ?? null,
        compatibility_flags: r.compatibility_flags ?? [],
        usage_model: r.usage_model ?? null,
        tail_consumers: r.tail_consumers?.map((t) => ({ service: t.service })) ?? null,
        raw: r,
      };
    });
  }

  /**
   * PATCH .../settings：改 bindings/compatibility。bindings 为整组替换语义——
   * 调用方必须把要保留的绑定以 {type:'inherit', name} 传入（含 secret_text），否则会被删除。
   * 每次调用产生一个新版本。settings 由路由层用 workerSettingsEdit 构造，这里原样透传。
   *
   * SDK 命名陷阱（与 URL 路径相反）：
   *   scripts.settings.edit       → PATCH /script-settings（仅 logpush/tail_consumers，不含 bindings）
   *   scripts.scriptAndVersionSettings.edit → PATCH /settings（含 bindings/compatibility_date/flags）
   * 此方法用 scriptAndVersionSettings.edit，与 getWorkerScriptSettings 对称。
   */
  updateWorkerScriptSettings(
    cfAccountId: string,
    scriptName: string,
    settings: {
      bindings?: Record<string, unknown>[];
      compatibility_date?: string;
      compatibility_flags?: string[];
    },
  ): Promise<CfWorkerSettings> {
    return this.wrap(async () => {
      // scriptAndVersionSettings.edit → PATCH /settings。settings as never 绕过 SDK 极宽联合类型
      const r = await this.sdk.workers.scripts.scriptAndVersionSettings.edit(scriptName, {
        account_id: cfAccountId,
        settings: settings as never,
      });
      // SDK 的 EditResponse typings 未声明这些运行时实际返回的字段，收窄以便映射（同 getWorkerScriptSettings 处理）
      const rr = r as unknown as {
        bindings?: unknown[];
        compatibility_date?: string;
        compatibility_flags?: string[];
        usage_model?: string;
        tail_consumers?: { service: string }[];
      };
      return {
        bindings: (rr.bindings ?? []).map(toWorkerBinding),
        compatibility_date: rr.compatibility_date ?? null,
        compatibility_flags: rr.compatibility_flags ?? [],
        usage_model: rr.usage_model ?? null,
        tail_consumers: rr.tail_consumers?.map((t) => ({ service: t.service })) ?? null,
        raw: r,
      };
    });
  }

  /** Worker 版本历史：只取第一页 ≤20 条（V4PagePagination，items 在 result.items），不自动翻页 */
  listWorkerVersions(cfAccountId: string, scriptName: string): Promise<CfWorkerVersion[]> {
    return this.wrap(async () => {
      const page = await this.sdk.workers.scripts.versions.list(scriptName, {
        account_id: cfAccountId,
        per_page: 20,
      });
      return page.getPaginatedItems().map(toWorkerVersion);
    });
  }

  /** Worker 部署历史：非分页端点，SDK 返回 { deployments: [...] }，首条为当前生效部署 */
  listWorkerDeployments(cfAccountId: string, scriptName: string): Promise<CfWorkerDeployment[]> {
    return this.wrap(async () => {
      const r = await this.sdk.workers.scripts.deployments.list(scriptName, { account_id: cfAccountId });
      return (r.deployments ?? []).map(toWorkerDeployment);
    });
  }

  /**
   * Pages 部署分页列表（带 total_count）。SDK 分页对象 V4PagePaginationArray 的
   * result_info 类型只暴露 page/per_page，拿不到 total_count，因此此端点走 REST
   * 信封（设计文档明确允许），字段映射复用 toPagesDeployment。
   */
  listPagesDeploymentsPage(
    cfAccountId: string,
    projectName: string,
    page: number,
    perPage: number,
  ): Promise<{ deployments: CfPagesDeployment[]; totalCount: number }> {
    return this.wrap(async () => {
      const qs = new URLSearchParams({ page: String(page), per_page: String(perPage) });
      const { result, result_info } = await this.rawEnvelope<unknown[]>(
        `/accounts/${cfAccountId}/pages/projects/${projectName}/deployments?${qs}`,
      );
      const deployments = (result ?? []).map(toPagesDeployment);
      return { deployments, totalCount: result_info?.total_count ?? deployments.length };
    });
  }

  /** Pages 部署构建日志（GET .../deployments/:id/history/logs），data 为 { ts, line } 数组 */
  getPagesDeploymentLogs(
    cfAccountId: string,
    projectName: string,
    deploymentId: string,
  ): Promise<{ lines: { ts: string | null; line: string }[]; total: number }> {
    return this.wrap(async () => {
      const r = await this.sdk.pages.projects.deployments.history.logs.get(projectName, deploymentId, {
        account_id: cfAccountId,
      });
      const lines = (r.data ?? []).map((d) => ({ ts: d.ts ?? null, line: d.line ?? '' }));
      return { lines, total: r.total ?? lines.length };
    });
  }

  /** 重试部署（POST .../deployments/:id/retry），返回更新后的 deployment */
  retryPagesDeployment(cfAccountId: string, projectName: string, deploymentId: string): Promise<CfPagesDeployment> {
    return this.wrap(async () => {
      const d = await this.sdk.pages.projects.deployments.retry(projectName, deploymentId, {
        account_id: cfAccountId,
      });
      return toPagesDeployment(d);
    });
  }

  /** 回滚到指定部署（POST .../deployments/:id/rollback），仅 production 成功部署可回滚 */
  rollbackPagesDeployment(cfAccountId: string, projectName: string, deploymentId: string): Promise<CfPagesDeployment> {
    return this.wrap(async () => {
      const d = await this.sdk.pages.projects.deployments.rollback(projectName, deploymentId, {
        account_id: cfAccountId,
      });
      return toPagesDeployment(d);
    });
  }

  /** Pages 项目自定义域列表（SinglePage 迭代） */
  listPagesDomains(cfAccountId: string, projectName: string): Promise<CfPagesDomain[]> {
    return this.wrap(async () => {
      const out: CfPagesDomain[] = [];
      for await (const d of this.sdk.pages.projects.domains.list(projectName, { account_id: cfAccountId })) {
        out.push(toPagesDomain(d));
      }
      return out;
    });
  }

  addPagesDomain(cfAccountId: string, projectName: string, domain: string): Promise<CfPagesDomain> {
    return this.wrap(async () => {
      const d = await this.sdk.pages.projects.domains.create(projectName, {
        account_id: cfAccountId,
        name: domain,
      });
      return toPagesDomain(d);
    });
  }

  deletePagesDomain(cfAccountId: string, projectName: string, domain: string): Promise<void> {
    return this.wrap(async () => {
      await this.sdk.pages.projects.domains.delete(projectName, domain, { account_id: cfAccountId });
    });
  }

  /** 重触发域名验证（PATCH .../domains/:domain，无额外 body） */
  retryPagesDomain(cfAccountId: string, projectName: string, domain: string): Promise<CfPagesDomain> {
    return this.wrap(async () => {
      const d = await this.sdk.pages.projects.domains.edit(projectName, domain, { account_id: cfAccountId });
      return toPagesDomain(d);
    });
  }

  /** 触发新部署（POST .../deployments，multipart form）；不传 branch 时用生产分支 */
  createPagesDeployment(cfAccountId: string, projectName: string, branch?: string): Promise<CfPagesDeployment> {
    return this.wrap(async () => {
      const d = await this.sdk.pages.projects.deployments.create(projectName, {
        account_id: cfAccountId,
        ...(branch ? { branch } : {}),
      });
      return toPagesDeployment(d);
    });
  }

  purgePagesBuildCache(cfAccountId: string, projectName: string): Promise<void> {
    return this.wrap(async () => {
      await this.sdk.pages.projects.purgeBuildCache(projectName, { account_id: cfAccountId });
    });
  }

  /**
   * Email Sending 发信（POST /accounts/:id/email/sending/send，SDK emailSending.send）。
   * cc/bcc/html/text 仅在有值时带上（端点要求 html/text 至少一个非空，由服务层 renderBody 保证）。
   * token 缺 Email Sending 权限 → CfApiError 403，由路由映射为仅该动作 403，不影响只读视图。
   */
  sendEmail(
    cfAccountId: string,
    params: {
      from: string | { address: string; name: string };
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      html?: string;
      text?: string;
    },
  ): Promise<{ messageId: string }> {
    return this.wrap(async () => {
      const r = await this.sdk.emailSending.send({
        account_id: cfAccountId,
        from: params.from,
        to: params.to,
        subject: params.subject,
        ...(params.cc?.length ? { cc: params.cc } : {}),
        ...(params.bcc?.length ? { bcc: params.bcc } : {}),
        ...(params.html ? { html: params.html } : {}),
        ...(params.text ? { text: params.text } : {}),
      });
      return { messageId: r.message_id };
    });
  }

  /** 账号级 Workers 调用统计（GraphQL workersInvocationsAdaptive，按脚本聚合；T0 探针实证形状） */
  queryWorkersInvocations(
    cfAccountId: string,
    sinceISO: string,
    untilISO: string,
  ): Promise<{ scriptName: string; requests: number; errors: number }[]> {
    return this.wrap(async () => {
      const data = await this.graphql<{
        viewer: {
          accounts: {
            workersInvocationsAdaptive: {
              dimensions: { scriptName: string };
              sum: { requests: number; errors: number };
            }[];
          }[];
        };
      }>(
        `query($account: String!, $since: Time!, $until: Time!) {
          viewer { accounts(filter: {accountTag: $account}) {
            workersInvocationsAdaptive(limit: 1000, filter: {datetime_geq: $since, datetime_leq: $until}) {
              dimensions { scriptName }
              sum { requests errors }
            }
          } }
        }`,
        { account: cfAccountId, since: sinceISO, until: untilISO },
      );
      return (data.viewer.accounts[0]?.workersInvocationsAdaptive ?? []).map((r) => ({
        scriptName: r.dimensions.scriptName,
        requests: r.sum.requests,
        errors: r.sum.errors,
      }));
    });
  }

  /** 账号级 Pages Functions 调用统计；scriptName 为 pages-worker--<ID>-<env> 原样返回，映射在路由层 */
  queryPagesFunctionsInvocations(
    cfAccountId: string,
    sinceISO: string,
    untilISO: string,
  ): Promise<{ scriptName: string; requests: number }[]> {
    return this.wrap(async () => {
      const data = await this.graphql<{
        viewer: {
          accounts: {
            pagesFunctionsInvocationsAdaptiveGroups: {
              dimensions: { scriptName: string };
              sum: { requests: number };
            }[];
          }[];
        };
      }>(
        `query($account: String!, $since: Time!, $until: Time!) {
          viewer { accounts(filter: {accountTag: $account}) {
            pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: {datetime_geq: $since, datetime_leq: $until}) {
              dimensions { scriptName }
              sum { requests }
            }
          } }
        }`,
        { account: cfAccountId, since: sinceISO, until: untilISO },
      );
      return (data.viewer.accounts[0]?.pagesFunctionsInvocationsAdaptiveGroups ?? []).map((r) => ({
        scriptName: r.dimensions.scriptName,
        requests: r.sum.requests,
      }));
    });
  }

  /** 按 UTC 自然日分组的 Workers 调用统计（快照回填用；date 为 YYYY-MM-DD） */
  queryWorkersInvocationsDaily(
    cfAccountId: string,
    sinceISO: string,
    untilISO: string,
  ): Promise<{ date: string; scriptName: string; requests: number; errors: number }[]> {
    return this.wrap(async () => {
      const data = await this.graphql<{
        viewer: {
          accounts: {
            workersInvocationsAdaptive: {
              dimensions: { date: string; scriptName: string };
              sum: { requests: number; errors: number };
            }[];
          }[];
        };
      }>(
        `query($account: String!, $since: Time!, $until: Time!) {
          viewer { accounts(filter: {accountTag: $account}) {
            workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: $since, datetime_leq: $until}) {
              dimensions { date scriptName }
              sum { requests errors }
            }
          } }
        }`,
        { account: cfAccountId, since: sinceISO, until: untilISO },
      );
      return (data.viewer.accounts[0]?.workersInvocationsAdaptive ?? []).map((r) => ({
        date: r.dimensions.date,
        scriptName: r.dimensions.scriptName,
        requests: r.sum.requests,
        errors: r.sum.errors,
      }));
    });
  }

  /** 按 UTC 自然日分组的 Pages Functions 调用统计（scriptName 原样返回，映射在 service 层） */
  queryPagesFunctionsInvocationsDaily(
    cfAccountId: string,
    sinceISO: string,
    untilISO: string,
  ): Promise<{ date: string; scriptName: string; requests: number }[]> {
    return this.wrap(async () => {
      const data = await this.graphql<{
        viewer: {
          accounts: {
            pagesFunctionsInvocationsAdaptiveGroups: {
              dimensions: { date: string; scriptName: string };
              sum: { requests: number };
            }[];
          }[];
        };
      }>(
        `query($account: String!, $since: Time!, $until: Time!) {
          viewer { accounts(filter: {accountTag: $account}) {
            pagesFunctionsInvocationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $since, datetime_leq: $until}) {
              dimensions { date scriptName }
              sum { requests }
            }
          } }
        }`,
        { account: cfAccountId, since: sinceISO, until: untilISO },
      );
      return (data.viewer.accounts[0]?.pagesFunctionsInvocationsAdaptiveGroups ?? []).map((r) => ({
        date: r.dimensions.date,
        scriptName: r.dimensions.scriptName,
        requests: r.sum.requests,
      }));
    });
  }

  /** 按 UTC 整点分组的 Workers 调用统计（bucket = datetimeHour，如 2026-07-06T08:00:00Z） */
  queryWorkersInvocationsHourly(
    cfAccountId: string,
    sinceISO: string,
    untilISO: string,
  ): Promise<{ bucket: string; scriptName: string; requests: number; errors: number }[]> {
    return this.wrap(async () => {
      const data = await this.graphql<{
        viewer: {
          accounts: {
            workersInvocationsAdaptive: {
              dimensions: { datetimeHour: string; scriptName: string };
              sum: { requests: number; errors: number };
            }[];
          }[];
        };
      }>(
        `query($account: String!, $since: Time!, $until: Time!) {
          viewer { accounts(filter: {accountTag: $account}) {
            workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: $since, datetime_leq: $until}) {
              dimensions { datetimeHour scriptName }
              sum { requests errors }
            }
          } }
        }`,
        { account: cfAccountId, since: sinceISO, until: untilISO },
      );
      return (data.viewer.accounts[0]?.workersInvocationsAdaptive ?? []).map((r) => ({
        bucket: r.dimensions.datetimeHour,
        scriptName: r.dimensions.scriptName,
        requests: r.sum.requests,
        errors: r.sum.errors,
      }));
    });
  }

  /** 按 UTC 整点分组的 Pages Functions 调用统计（scriptName 原样返回，映射在 service 层） */
  queryPagesFunctionsInvocationsHourly(
    cfAccountId: string,
    sinceISO: string,
    untilISO: string,
  ): Promise<{ bucket: string; scriptName: string; requests: number }[]> {
    return this.wrap(async () => {
      const data = await this.graphql<{
        viewer: {
          accounts: {
            pagesFunctionsInvocationsAdaptiveGroups: {
              dimensions: { datetimeHour: string; scriptName: string };
              sum: { requests: number };
            }[];
          }[];
        };
      }>(
        `query($account: String!, $since: Time!, $until: Time!) {
          viewer { accounts(filter: {accountTag: $account}) {
            pagesFunctionsInvocationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $since, datetime_leq: $until}) {
              dimensions { datetimeHour scriptName }
              sum { requests }
            }
          } }
        }`,
        { account: cfAccountId, since: sinceISO, until: untilISO },
      );
      return (data.viewer.accounts[0]?.pagesFunctionsInvocationsAdaptiveGroups ?? []).map((r) => ({
        bucket: r.dimensions.datetimeHour,
        scriptName: r.dimensions.scriptName,
        requests: r.sum.requests,
      }));
    });
  }

  /**
   * 账号下 R2 桶列表。SDK 的 BucketListResponse 只映射 buckets 字段、丢弃响应游标，
   * 无法翻页——v1 以 per_page=1000 单页拉取（个人多账号场景足够；超限桶被静默截断，
   * 若未来需要需改走 rawEnvelope 读 result_info.cursor）。只列默认 jurisdiction。
   */
  listR2Buckets(cfAccountId: string): Promise<CfR2Bucket[]> {
    return this.wrap(async () => {
      const r = await this.sdk.r2.buckets.list({ account_id: cfAccountId, per_page: 1000 });
      return (r.buckets ?? []).map((b) => ({
        name: b.name ?? '',
        creation_date: b.creation_date,
        location: b.location,
        storage_class: b.storage_class,
        raw: b,
      }));
    });
  }

  /** 创建桶。SDK 参数名注意：位置提示是 locationHint（camelCase），创建用 storageClass、编辑却用 storage_class */
  createR2Bucket(
    cfAccountId: string,
    opts: { name: string; location?: string; storageClass?: string },
  ): Promise<CfR2Bucket> {
    return this.wrap(async () => {
      const b = await this.sdk.r2.buckets.create({
        account_id: cfAccountId,
        name: opts.name,
        ...(opts.location ? { locationHint: opts.location as never } : {}),
        ...(opts.storageClass ? { storageClass: opts.storageClass as never } : {}),
      });
      return {
        name: b.name ?? opts.name,
        creation_date: b.creation_date,
        location: b.location,
        storage_class: b.storage_class,
        raw: b,
      };
    });
  }

  /** 删除桶（CF 侧要求桶为空，非空报错原样透出 CfApiError） */
  deleteR2Bucket(cfAccountId: string, name: string): Promise<void> {
    return this.wrap(async () => {
      await this.sdk.r2.buckets.delete(name, { account_id: cfAccountId });
    });
  }

  /**
   * 对象列表（REST /r2/buckets/:bucket/objects，CursorPagination）。固定 delimiter='/'：
   * 命中分隔符的键被折叠成单条"前缀"条目（key 以 / 结尾、无 size/etag），映射为 is_prefix=true。
   * 单页返回 + 游标，由前端「加载更多」翻页；不用 SDK 的 for-await 全量迭代（对象数无上界）。
   */
  listR2Objects(
    cfAccountId: string,
    bucket: string,
    opts: { prefix?: string; cursor?: string; perPage?: number } = {},
  ): Promise<{ objects: CfR2Object[]; cursor: string | null }> {
    return this.wrap(async () => {
      const page = await this.sdk.r2.buckets.objects.list(bucket, {
        account_id: cfAccountId,
        per_page: opts.perPage ?? 100,
        delimiter: '/',
        ...(opts.prefix ? { prefix: opts.prefix } : {}),
        ...(opts.cursor ? { cursor: opts.cursor } : {}),
      });
      // delimiter 命中的“文件夹”前缀不在 result 数组里，而在 result_info.delimited
      //（T14 真机实证；SDK CursorPagination 类型未声明该字段）——漏读会让全是文件夹的桶显示为空
      const info = (page as unknown as { result_info?: { delimited?: string[] } }).result_info;
      const prefixes: CfR2Object[] = (info?.delimited ?? []).map((p) => ({
        key: p,
        size: null,
        etag: null,
        last_modified: null,
        is_prefix: true,
      }));
      const prefixKeys = new Set(prefixes.map((p) => p.key));
      const objects = page
        .getPaginatedItems()
        .map((o) => {
          const key = o.key ?? '';
          // 零字节 “xx/” 目录占位对象仍会出现在 result 里，按前缀对待并与 delimited 去重
          const isPrefix = key.endsWith('/') && !o.etag;
          return {
            key,
            size: isPrefix ? null : (o.size ?? null),
            etag: isPrefix ? null : (o.etag ?? null),
            last_modified: isPrefix ? null : (o.last_modified ?? null),
            is_prefix: isPrefix,
          };
        })
        .filter((o) => !(o.is_prefix && prefixKeys.has(o.key)));
      return { objects: [...prefixes, ...objects], cursor: page.nextPageParams()?.cursor ?? null };
    });
  }

  /** 删除对象。key 编码陷阱见 encodeR2ObjectKey。 */
  deleteR2Object(cfAccountId: string, bucket: string, key: string): Promise<void> {
    return this.wrap(async () => {
      // 路由层已校验空 key；这里是纵深防御——空 key 会把 DELETE 打到桶路径上
      if (!key) throw new CfApiError(400, ['object key is required']);
      await this.sdk.r2.buckets.objects.delete(bucket, encodeR2ObjectKey(key), { account_id: cfAccountId });
    });
  }

  /**
   * 读取对象内容（服务端中转文本预览用）。SDK objects.get 返回原始 Response；
   * key 编码陷阱见 encodeR2ObjectKey。
   * 先看 Content-Length 头拒超限；无该头（chunked）时读完后按实际字节数二次校验。
   */
  getR2ObjectContent(
    cfAccountId: string,
    bucket: string,
    key: string,
    maxBytes: number,
  ): Promise<{ contentType: string | null; text: string }> {
    return this.wrap(async () => {
      const res = await this.sdk.r2.buckets.objects.get(bucket, encodeR2ObjectKey(key), { account_id: cfAccountId });
      // 注意：头缺失时 Number(null)=0（非 NaN），走不进这个分支——isFinite 过滤的是畸形非数字头；
      // 缺头（chunked）场景由下方读完后的字节数二次校验兜底
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > maxBytes) {
        void res.body?.cancel();
        throw new R2ObjectTooLargeError();
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength > maxBytes) throw new R2ObjectTooLargeError();
      return { contentType: res.headers.get('content-type'), text: new TextDecoder().decode(buf) };
    });
  }

  /** 存储快照：近 24h 每桶体积/对象数（max 聚合近似当前值），同步时写入 r2_buckets 缓存列 */
  queryR2StorageSnapshot(
    cfAccountId: string,
  ): Promise<{ bucketName: string; payloadSize: number; metadataSize: number; objectCount: number }[]> {
    return this.wrap(async () => {
      const until = new Date();
      const since = new Date(until.getTime() - 86_400_000);
      const data = await this.graphql<{
        viewer: {
          accounts: {
            r2StorageAdaptiveGroups: {
              dimensions: { bucketName: string };
              max: { payloadSize: number; metadataSize: number; objectCount: number };
            }[];
          }[];
        };
      }>(
        `query($account: String!, $since: Time!, $until: Time!) {
          viewer { accounts(filter: {accountTag: $account}) {
            r2StorageAdaptiveGroups(limit: 1000, filter: {datetime_geq: $since, datetime_leq: $until}) {
              dimensions { bucketName }
              max { payloadSize metadataSize objectCount }
            }
          } }
        }`,
        { account: cfAccountId, since: since.toISOString(), until: until.toISOString() },
      );
      return (data.viewer.accounts[0]?.r2StorageAdaptiveGroups ?? []).map((r) => ({
        bucketName: r.dimensions.bucketName,
        payloadSize: r.max.payloadSize,
        metadataSize: r.max.metadataSize,
        objectCount: r.max.objectCount,
      }));
    });
  }

  /** 单桶按 UTC 自然日的存储量趋势（详情页用量 tab） */
  queryR2StorageDaily(
    cfAccountId: string,
    bucketName: string,
    sinceISO: string,
    untilISO: string,
  ): Promise<{ date: string; payloadSize: number; objectCount: number }[]> {
    return this.wrap(async () => {
      const data = await this.graphql<{
        viewer: {
          accounts: {
            r2StorageAdaptiveGroups: {
              dimensions: { date: string };
              max: { payloadSize: number; objectCount: number };
            }[];
          }[];
        };
      }>(
        `query($account: String!, $bucket: String!, $since: Time!, $until: Time!) {
          viewer { accounts(filter: {accountTag: $account}) {
            r2StorageAdaptiveGroups(limit: 1000, filter: {bucketName: $bucket, datetime_geq: $since, datetime_leq: $until}) {
              dimensions { date }
              max { payloadSize objectCount }
            }
          } }
        }`,
        { account: cfAccountId, bucket: bucketName, since: sinceISO, until: untilISO },
      );
      return (data.viewer.accounts[0]?.r2StorageAdaptiveGroups ?? []).map((r) => ({
        date: r.dimensions.date,
        payloadSize: r.max.payloadSize,
        objectCount: r.max.objectCount,
      }));
    });
  }

  /** 单桶按 UTC 自然日、按 actionType 的操作数（Class A/B 归类在 server/r2.ts） */
  queryR2OperationsDaily(
    cfAccountId: string,
    bucketName: string,
    sinceISO: string,
    untilISO: string,
  ): Promise<{ date: string; actionType: string; requests: number }[]> {
    return this.wrap(async () => {
      const data = await this.graphql<{
        viewer: {
          accounts: {
            r2OperationsAdaptiveGroups: {
              dimensions: { date: string; actionType: string };
              sum: { requests: number };
            }[];
          }[];
        };
      }>(
        `query($account: String!, $bucket: String!, $since: Time!, $until: Time!) {
          viewer { accounts(filter: {accountTag: $account}) {
            r2OperationsAdaptiveGroups(limit: 10000, filter: {bucketName: $bucket, datetime_geq: $since, datetime_leq: $until}) {
              dimensions { date actionType }
              sum { requests }
            }
          } }
        }`,
        { account: cfAccountId, bucket: bucketName, since: sinceISO, until: untilISO },
      );
      return (data.viewer.accounts[0]?.r2OperationsAdaptiveGroups ?? []).map((r) => ({
        date: r.dimensions.date,
        actionType: r.dimensions.actionType,
        requests: r.sum.requests,
      }));
    });
  }

  /** 桶 CORS 规则；CF 对"从未配置过 CORS"的桶返回 404（10059），归一为 [] 而不是抛错 */
  getR2Cors(cfAccountId: string, bucket: string): Promise<CfR2CorsRule[]> {
    return this.wrap(async () => {
      try {
        const r = await this.sdk.r2.buckets.cors.get(bucket, { account_id: cfAccountId });
        return (r.rules ?? []).map((rule) => ({
          allowed: {
            methods: rule.allowed.methods,
            origins: rule.allowed.origins,
            ...(rule.allowed.headers ? { headers: rule.allowed.headers } : {}),
          },
          ...(rule.id !== undefined ? { id: rule.id } : {}),
          ...(rule.exposeHeaders !== undefined ? { exposeHeaders: rule.exposeHeaders } : {}),
          ...(rule.maxAgeSeconds !== undefined ? { maxAgeSeconds: rule.maxAgeSeconds } : {}),
        }));
      } catch (e) {
        if (e instanceof Cloudflare.APIError && e.status === 404) return [];
        throw e;
      }
    });
  }

  /** 整组替换 CORS 规则；空数组语义 = 清除配置（设计文档约定，PUT [] 会被 CF 拒绝） */
  putR2Cors(cfAccountId: string, bucket: string, rules: CfR2CorsRule[]): Promise<void> {
    return this.wrap(async () => {
      if (rules.length === 0) {
        await this.sdk.r2.buckets.cors.delete(bucket, { account_id: cfAccountId });
        return;
      }
      await this.sdk.r2.buckets.cors.update(bucket, { account_id: cfAccountId, rules: rules as never });
    });
  }

  listR2CustomDomains(cfAccountId: string, bucket: string): Promise<CfR2CustomDomain[]> {
    return this.wrap(async () => {
      const r = await this.sdk.r2.buckets.domains.custom.list(bucket, { account_id: cfAccountId });
      return (r.domains ?? []).map((d) => ({
        domain: d.domain,
        enabled: d.enabled,
        ownershipStatus: d.status?.ownership ?? null,
        sslStatus: d.status?.ssl ?? null,
        zoneName: d.zoneName ?? null,
      }));
    });
  }

  /** 绑定自定义域（域名必须在同 CF 账号的 zone 内，zoneId 由路由层用 findZoneForHostname 解析） */
  attachR2CustomDomain(
    cfAccountId: string,
    bucket: string,
    opts: { domain: string; zoneId: string },
  ): Promise<CfR2CustomDomain> {
    return this.wrap(async () => {
      const d = await this.sdk.r2.buckets.domains.custom.create(bucket, {
        account_id: cfAccountId,
        domain: opts.domain,
        zoneId: opts.zoneId,
        enabled: true,
      });
      return { domain: d.domain, enabled: d.enabled, ownershipStatus: null, sslStatus: null, zoneName: null };
    });
  }

  detachR2CustomDomain(cfAccountId: string, bucket: string, domain: string): Promise<void> {
    return this.wrap(async () => {
      await this.sdk.r2.buckets.domains.custom.delete(bucket, domain, { account_id: cfAccountId });
    });
  }

  /** r2.dev 托管域状态。SDK 命名陷阱：managed.list 实际是 GET 单对象（bucketId/domain/enabled），不是列表 */
  getR2ManagedDomain(cfAccountId: string, bucket: string): Promise<CfR2ManagedDomain> {
    return this.wrap(async () => {
      const r = await this.sdk.r2.buckets.domains.managed.list(bucket, { account_id: cfAccountId });
      return { domain: r.domain, enabled: r.enabled };
    });
  }

  setR2ManagedDomain(cfAccountId: string, bucket: string, enabled: boolean): Promise<CfR2ManagedDomain> {
    return this.wrap(async () => {
      const r = await this.sdk.r2.buckets.domains.managed.update(bucket, { account_id: cfAccountId, enabled });
      return { domain: r.domain, enabled: r.enabled };
    });
  }

  /**
   * 生命周期规则 → 简化形（Age 条件秒 → 天，含分段上传中止）。
   * 任一 transition 用了非 Age 条件（如固定日期）的规则标记 unsupported 并携带原始 JSON，
   * 表单只读、保存时原样透传——不能因为一条特殊规则锁死整组编辑。
   */
  getR2Lifecycle(cfAccountId: string, bucket: string): Promise<CfR2LifecycleRule[]> {
    return this.wrap(async () => {
      const r = await this.sdk.r2.buckets.lifecycle.get(bucket, { account_id: cfAccountId });
      const ageDays = (c: unknown): number | null => {
        const cond = c as { type?: string; maxAge?: number } | undefined;
        return cond?.type === 'Age' && typeof cond.maxAge === 'number' ? Math.round(cond.maxAge / 86400) : null;
      };
      const isAgeOrAbsent = (c: unknown) => c === undefined || (c as { type?: string } | null)?.type === 'Age';
      return (r.rules ?? []).map((rule) => {
        const base = { id: rule.id, enabled: rule.enabled, prefix: rule.conditions?.prefix ?? '' };
        const supported =
          isAgeOrAbsent(rule.deleteObjectsTransition?.condition) &&
          isAgeOrAbsent(rule.abortMultipartUploadsTransition?.condition) &&
          (rule.storageClassTransitions ?? []).every((t) => isAgeOrAbsent(t.condition));
        if (!supported) {
          return {
            ...base,
            deleteAfterDays: null,
            iaAfterDays: null,
            abortMultipartDays: null,
            unsupported: true,
            raw: rule,
          };
        }
        return {
          ...base,
          deleteAfterDays: ageDays(rule.deleteObjectsTransition?.condition),
          iaAfterDays: ageDays(
            rule.storageClassTransitions?.find((t) => t.storageClass === 'InfrequentAccess')?.condition,
          ),
          abortMultipartDays: ageDays(rule.abortMultipartUploadsTransition?.condition),
        };
      });
    });
  }

  /**
   * 整组替换生命周期规则（天 → Age 秒）；null 天数字段不生成对应 transition；
   * unsupported 规则用 raw 原样回传（仅允许覆盖 enabled 开关）。
   */
  putR2Lifecycle(cfAccountId: string, bucket: string, rules: CfR2LifecycleRule[]): Promise<void> {
    return this.wrap(async () => {
      await this.sdk.r2.buckets.lifecycle.update(bucket, {
        account_id: cfAccountId,
        rules: rules.map((rule) => {
          if (rule.unsupported && rule.raw) {
            return { ...(rule.raw as Record<string, unknown>), enabled: rule.enabled } as never;
          }
          return {
            id: rule.id,
            enabled: rule.enabled,
            conditions: { prefix: rule.prefix },
            ...(rule.deleteAfterDays !== null
              ? {
                  deleteObjectsTransition: {
                    condition: { type: 'Age' as const, maxAge: rule.deleteAfterDays * 86400 },
                  },
                }
              : {}),
            ...(rule.iaAfterDays !== null
              ? {
                  storageClassTransitions: [
                    {
                      storageClass: 'InfrequentAccess' as const,
                      condition: { type: 'Age' as const, maxAge: rule.iaAfterDays * 86400 },
                    },
                  ],
                }
              : {}),
            ...(typeof rule.abortMultipartDays === 'number'
              ? {
                  abortMultipartUploadsTransition: {
                    condition: { type: 'Age' as const, maxAge: rule.abortMultipartDays * 86400 },
                  },
                }
              : {}),
          };
        }),
      });
    });
  }
}
