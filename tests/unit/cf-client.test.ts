import { describe, expect, it } from 'vitest';
import { CfApiError, CfClient } from '../../src/server/cf/client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** SDK 在 Node 下以 Readable 流发送 multipart 请求体：收集为 utf8 文本以便断言 */
async function readBodyText(body: unknown): Promise<string> {
  if (typeof body === 'string') return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 用真实 FormData 构造 multipart 响应体（boundary 由平台生成，测得的行为与线上一致） */
async function multipartFixture(
  parts: { name: string; content: string; type?: string }[],
): Promise<{ body: string; contentType: string }> {
  const fd = new FormData();
  for (const p of parts) {
    fd.append(p.name, new File([p.content], p.name, { type: p.type ?? 'application/javascript+module' }));
  }
  const res = new Response(fd);
  return { body: await res.text(), contentType: res.headers.get('content-type')! };
}

async function sha256HexOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('CfClient (official SDK adapter)', () => {
  it('verifyToken sends bearer token through the SDK', async () => {
    let seenAuth = '';
    let seenUrl = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenAuth = new Headers(init?.headers).get('Authorization') ?? '';
      return jsonResponse({ success: true, errors: [], messages: [], result: { id: 't1', status: 'active' } });
    };
    const v = await new CfClient('tok-123', fetchImpl).verifyToken();
    expect(v.status).toBe('active');
    expect(seenAuth).toBe('Bearer tok-123');
    expect(seenUrl).toContain('/user/tokens/verify');
  });

  it('maps SDK errors to CfApiError', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(
        { success: false, errors: [{ code: 9109, message: 'Invalid token' }], messages: [], result: null },
        403,
      );
    const client = new CfClient('bad', fetchImpl);
    await expect(client.verifyToken()).rejects.toThrowError(CfApiError);
    await expect(client.verifyToken()).rejects.toThrow(/Invalid token/);
  });

  it('listZones auto-paginates across pages', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      calls++;
      const page = Number(new URL(String(input)).searchParams.get('page') ?? '1');
      // SDK's V4PagePaginationArray.nextPageInfo() always returns the next page number;
      // iteration only stops when a page returns 0 items. Return [] for page>=3 to terminate.
      const result =
        page === 1
          ? [{ id: 'z1', name: 'a.com', status: 'active' }]
          : page === 2
            ? [{ id: 'z2', name: 'b.com', status: 'active' }]
            : [];
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result,
        result_info: { page, per_page: 1, count: result.length, total_count: 2, total_pages: 2 },
      });
    };
    const zones = await new CfClient('tok', fetchImpl).listZones();
    expect(zones.map((z) => z.id)).toEqual(['z1', 'z2']);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('deleteDnsRecord issues DELETE via SDK', async () => {
    let method = '';
    let url = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      method = (init?.method ?? 'GET').toUpperCase();
      url = String(input);
      return jsonResponse({ success: true, errors: [], messages: [], result: { id: 'r1' } });
    };
    await new CfClient('tok', fetchImpl).deleteDnsRecord('z1', 'r1');
    expect(method).toBe('DELETE');
    expect(url).toContain('/zones/z1/dns_records/r1');
  });

  it('raw() fallback calls arbitrary endpoint with auth header', async () => {
    let seenAuth = '';
    let seenUrl = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenAuth = new Headers(init?.headers).get('Authorization') ?? '';
      return jsonResponse({ success: true, errors: [], result: { ok: true } });
    };
    const data = await new CfClient('tok-9', fetchImpl).raw<{ ok: boolean }>('/some/beta/endpoint');
    expect(data.ok).toBe(true);
    expect(seenAuth).toBe('Bearer tok-9');
    expect(seenUrl).toBe('https://api.cloudflare.com/client/v4/some/beta/endpoint');
  });

  it('listAccounts auto-paginates and maps id/name', async () => {
    let calls = 0;
    let firstUrl = '';
    const fetchImpl: typeof fetch = async (input) => {
      calls++;
      if (!firstUrl) firstUrl = String(input);
      const page = Number(new URL(String(input)).searchParams.get('page') ?? '1');
      // V4PagePaginationArray: iteration stops when a page returns 0 items (see listZones test).
      const result =
        page === 1
          ? [{ id: 'acc1', name: 'Alpha', type: 'standard' }]
          : page === 2
            ? [{ id: 'acc2', name: 'Beta', type: 'standard' }]
            : [];
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result,
        result_info: { page, per_page: 1, count: result.length, total_count: 2, total_pages: 2 },
      });
    };
    const accounts = await new CfClient('tok', fetchImpl).listAccounts();
    expect(new URL(firstUrl).pathname).toContain('/accounts');
    expect(accounts).toEqual([
      { id: 'acc1', name: 'Alpha' },
      { id: 'acc2', name: 'Beta' },
    ]);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('listWorkersScripts hits /accounts/:id/workers/scripts and maps fields', async () => {
    let url = '';
    const fetchImpl: typeof fetch = async (input) => {
      url = String(input);
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: [
          {
            id: 'my-worker',
            created_on: '2026-01-01T00:00:00Z',
            modified_on: '2026-02-01T00:00:00Z',
            usage_model: 'standard',
            last_deployed_from: 'wrangler',
            etag: 'abc',
          },
        ],
        result_info: { page: 1, per_page: 20, count: 1, total_count: 1 },
      });
    };
    const scripts = await new CfClient('tok', fetchImpl).listWorkersScripts('acc1');
    expect(url).toContain('/accounts/acc1/workers/scripts');
    expect(scripts).toHaveLength(1);
    expect(scripts[0].id).toBe('my-worker');
    expect(scripts[0].usage_model).toBe('standard');
    expect(scripts[0].last_deployed_from).toBe('wrangler');
    expect(scripts[0].modified_on).toBe('2026-02-01T00:00:00Z');
    expect((scripts[0].raw as { etag: string }).etag).toBe('abc');
  });

  it('listWorkerCrons fetches schedules for a script', async () => {
    let url = '';
    const fetchImpl: typeof fetch = async (input) => {
      url = String(input);
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: {
          schedules: [
            { cron: '*/30 * * * *', created_on: '2026-01-01T00:00:00Z', modified_on: '2026-01-02T00:00:00Z' },
          ],
        },
      });
    };
    const crons = await new CfClient('tok', fetchImpl).listWorkerCrons('acc1', 'my-worker');
    expect(url).toContain('/accounts/acc1/workers/scripts/my-worker/schedules');
    expect(crons).toEqual([
      { cron: '*/30 * * * *', created_on: '2026-01-01T00:00:00Z', modified_on: '2026-01-02T00:00:00Z' },
    ]);
  });

  it('listWorkerDomains hits /accounts/:id/workers/domains and maps fields', async () => {
    let url = '';
    const fetchImpl: typeof fetch = async (input) => {
      url = String(input);
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: [
          {
            id: 'dom1',
            cert_id: 'cert1',
            hostname: 'app.example.com',
            service: 'my-worker',
            environment: 'production',
            zone_id: 'z1',
            zone_name: 'example.com',
          },
        ],
        result_info: { page: 1, per_page: 20, count: 1, total_count: 1 },
      });
    };
    const domains = await new CfClient('tok', fetchImpl).listWorkerDomains('acc1');
    expect(url).toContain('/accounts/acc1/workers/domains');
    expect(domains).toEqual([
      {
        id: 'dom1',
        hostname: 'app.example.com',
        service: 'my-worker',
        environment: 'production',
        zone_name: 'example.com',
      },
    ]);
  });

  it('listPagesProjects auto-paginates and derives source_repo/latest_deployment_on', async () => {
    let firstUrl = '';
    const fetchImpl: typeof fetch = async (input) => {
      if (!firstUrl) firstUrl = String(input);
      const page = Number(new URL(String(input)).searchParams.get('page') ?? '1');
      const result =
        page === 1
          ? [
              {
                id: 'p1',
                name: 'site1',
                subdomain: 'site1.pages.dev',
                production_branch: 'main',
                domains: ['site1.example.com'],
                created_on: '2026-01-01T00:00:00Z',
                source: { type: 'github', config: { repo_name: 'my-repo' } },
                latest_deployment: { id: 'd1', modified_on: '2026-03-01T00:00:00Z' },
              },
              {
                id: 'p2',
                name: 'site2',
                production_branch: 'main',
                source: null,
                latest_deployment: null,
              },
            ]
          : [];
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result,
        result_info: { page, per_page: 2, count: result.length, total_count: 2, total_pages: 1 },
      });
    };
    const projects = await new CfClient('tok', fetchImpl).listPagesProjects('acc1');
    expect(firstUrl).toContain('/accounts/acc1/pages/projects');
    expect(projects).toHaveLength(2);
    expect(projects[0].name).toBe('site1');
    expect(projects[0].subdomain).toBe('site1.pages.dev');
    expect(projects[0].production_branch).toBe('main');
    expect(projects[0].domains).toEqual(['site1.example.com']);
    expect(projects[0].source_repo).toBe('my-repo');
    expect(projects[0].latest_deployment_on).toBe('2026-03-01T00:00:00Z');
    expect((projects[0].raw as { id: string }).id).toBe('p1');
    expect(projects[1].source_repo).toBeNull();
    expect(projects[1].latest_deployment_on).toBeNull();
  });

  it('getPagesProject fetches a single project by name', async () => {
    let url = '';
    const fetchImpl: typeof fetch = async (input) => {
      url = String(input);
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: {
          id: 'p1',
          name: 'site1',
          subdomain: 'site1.pages.dev',
          production_branch: 'main',
          domains: [],
          created_on: '2026-01-01T00:00:00Z',
          source: { type: 'github', config: { repo_name: 'my-repo' } },
          latest_deployment: { id: 'd1', modified_on: '2026-03-01T00:00:00Z' },
        },
      });
    };
    const project = await new CfClient('tok', fetchImpl).getPagesProject('acc1', 'site1');
    expect(url).toContain('/accounts/acc1/pages/projects/site1');
    expect(project.name).toBe('site1');
    expect(project.source_repo).toBe('my-repo');
    expect(project.latest_deployment_on).toBe('2026-03-01T00:00:00Z');
  });

  it('listPagesDeployments takes first page only, slices to 10 and flattens stage/trigger', async () => {
    let calls = 0;
    let url = '';
    const fetchImpl: typeof fetch = async (input) => {
      calls++;
      url = String(input);
      // First page deliberately over-filled (12 items) with result_info claiming more pages:
      // the client must NOT auto-paginate and must cap at 10.
      const result = Array.from({ length: 12 }, (_, i) => ({
        id: `dep${i + 1}`,
        environment: 'production',
        url: `https://dep${i + 1}.site1.pages.dev`,
        created_on: '2026-03-01T00:00:00Z',
        latest_stage: { name: 'deploy', status: 'success' },
        deployment_trigger: {
          type: 'github:push',
          metadata: { branch: 'main', commit_hash: `hash${i + 1}` },
        },
      }));
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result,
        result_info: { page: 1, per_page: 12, count: 12, total_count: 30, total_pages: 3 },
      });
    };
    const deployments = await new CfClient('tok', fetchImpl).listPagesDeployments('acc1', 'site1');
    expect(url).toContain('/accounts/acc1/pages/projects/site1/deployments');
    expect(calls).toBe(1);
    expect(deployments).toHaveLength(10);
    expect(deployments[0]).toEqual({
      id: 'dep1',
      environment: 'production',
      url: 'https://dep1.site1.pages.dev',
      created_on: '2026-03-01T00:00:00Z',
      latest_stage_status: 'success',
      latest_stage_name: 'deploy',
      deployment_trigger_branch: 'main',
      deployment_trigger_commit_hash: 'hash1',
    });
  });

  it('getWorkerScriptContent returns whole text for non-multipart responses with sha-256 fallback etag', async () => {
    let url = '';
    const code = 'export default { async fetch() { return new Response("ok"); } }';
    const fetchImpl: typeof fetch = async (input) => {
      url = String(input);
      return new Response(code, { headers: { 'Content-Type': 'application/javascript' } });
    };
    const result = await new CfClient('tok', fetchImpl).getWorkerScriptContent('acc1', 'my-worker');
    expect(url).toContain('/accounts/acc1/workers/scripts/my-worker/content/v2');
    expect(result).toEqual({
      content: code,
      mainModule: null,
      multiModule: false,
      etag: await sha256HexOf(code),
    });
  });

  it('getWorkerScriptContent parses single-module multipart and normalizes the etag header', async () => {
    // T0 真机验证：单模块 Worker 的 content.get 同样返回 multipart，入口文件名在 cf-entrypoint 头
    const code = 'export default { fetch() { return new Response("solo"); } }';
    const { body, contentType } = await multipartFixture([{ name: 'index.js', content: code }]);
    const fetchImpl: typeof fetch = async () =>
      new Response(body, {
        headers: { 'Content-Type': contentType, 'cf-entrypoint': 'index.js', etag: 'W/"abc123"' },
      });
    const result = await new CfClient('tok', fetchImpl).getWorkerScriptContent('acc1', 'my-worker');
    expect(result).toEqual({ content: code, mainModule: 'index.js', multiModule: false, etag: 'abc123' });
  });

  it('getWorkerScriptContent picks the cf-entrypoint part among multiple modules (multiModule=true)', async () => {
    // 入口 part 故意放在第二位：必须按 cf-entrypoint 匹配而不是取第一个 part
    const { body, contentType } = await multipartFixture([
      { name: 'lib.js', content: 'export const helper = 1;' },
      { name: 'worker.js', content: 'export default { fetch() { return new Response("main"); } }' },
    ]);
    const fetchImpl: typeof fetch = async () =>
      new Response(body, {
        headers: { 'Content-Type': contentType, 'cf-entrypoint': 'worker.js', etag: '"tag-multi"' },
      });
    const result = await new CfClient('tok', fetchImpl).getWorkerScriptContent('acc1', 'my-worker');
    expect(result).toEqual({
      content: 'export default { fetch() { return new Response("main"); } }',
      mainModule: 'worker.js',
      multiModule: true,
      etag: 'tag-multi',
    });
  });

  it('getWorkerScriptContent does not count sourcemap parts: single module + .map stays multiModule=false', async () => {
    // upload_source_maps 会附带 *.map part（application/source-map），不得误判为多模块
    const code = 'export default { fetch() { return new Response("mapped"); } }';
    const { body, contentType } = await multipartFixture([
      { name: 'index.js', content: code },
      { name: 'index.js.map', content: '{"version":3,"sources":["src/index.ts"]}', type: 'application/source-map' },
    ]);
    const fetchImpl: typeof fetch = async () =>
      new Response(body, {
        headers: { 'Content-Type': contentType, 'cf-entrypoint': 'index.js', etag: '"tag-map"' },
      });
    const result = await new CfClient('tok', fetchImpl).getWorkerScriptContent('acc1', 'my-worker');
    expect(result).toEqual({ content: code, mainModule: 'index.js', multiModule: false, etag: 'tag-map' });
  });

  it('getWorkerScriptContent survives source lines that look like multipart boundaries', async () => {
    // 手写 boundary 切分会把这类正文截断；平台 formData() 解析按真实 boundary 走
    const code = [
      'const sep = "--X-CF-BOUNDARY";',
      '// ------WebKitFormBoundaryFakeLine',
      'export default { fetch() { return new Response(sep); } }',
    ].join('\n');
    const { body, contentType } = await multipartFixture([{ name: 'index.js', content: code }]);
    const fetchImpl: typeof fetch = async () =>
      new Response(body, { headers: { 'Content-Type': contentType, 'cf-entrypoint': 'index.js' } });
    const result = await new CfClient('tok', fetchImpl).getWorkerScriptContent('acc1', 'my-worker');
    expect(result.content).toBe(code);
    expect(result.multiModule).toBe(false);
  });

  it('getWorkerScriptContent falls back: mainModule from the single part, etag from sha-256 of it', async () => {
    // cf-entrypoint 与 etag 头都缺失：mainModule 回退唯一模块名，etag 回退入口内容哈希
    const code = 'export default { fetch() { return new Response("fallback"); } }';
    const { body, contentType } = await multipartFixture([{ name: 'index.js', content: code }]);
    const fetchImpl: typeof fetch = async () => new Response(body, { headers: { 'Content-Type': contentType } });
    const result = await new CfClient('tok', fetchImpl).getWorkerScriptContent('acc1', 'my-worker');
    expect(result).toEqual({
      content: code,
      mainModule: 'index.js',
      multiModule: false,
      etag: await sha256HexOf(code),
    });
  });

  it('updateWorkerScriptContent PUTs multipart with metadata main_module and the file part', async () => {
    let url = '';
    let method = '';
    let contentType = '';
    let bodyText = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input);
      method = (init?.method ?? 'GET').toUpperCase();
      contentType = new Headers(init?.headers).get('Content-Type') ?? '';
      bodyText = await readBodyText(init?.body);
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: { id: 'my-worker', etag: 'W/"new-etag"' },
      });
    };
    const updated = await new CfClient('tok', fetchImpl).updateWorkerScriptContent(
      'acc1',
      'my-worker',
      'index.js',
      'export default { fetch() { return new Response("v2"); } }',
    );
    expect(method).toBe('PUT');
    expect(url).toContain('/accounts/acc1/workers/scripts/my-worker/content');
    expect(contentType).toContain('multipart/form-data');
    // metadata part：JSON 携带 main_module
    expect(bodyText).toContain('name="metadata"');
    expect(bodyText).toContain('{"main_module":"index.js"}');
    // 文件 part：filename 为入口文件名，正文为新代码
    expect(bodyText).toContain('filename="index.js"');
    expect(bodyText).toContain('export default { fetch() { return new Response("v2"); } }');
    // SDK 返回的 Script.etag 归一化后回传（乐观锁）
    expect(updated).toEqual({ etag: 'new-etag' });
  });

  it('updateWorkerCrons PUTs the full cron array to /schedules and maps the response', async () => {
    let url = '';
    let method = '';
    let body: unknown;
    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input);
      method = (init?.method ?? 'GET').toUpperCase();
      body = JSON.parse(String(init?.body));
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: {
          schedules: [
            { cron: '*/30 * * * *', created_on: '2026-07-01T00:00:00Z', modified_on: '2026-07-05T00:00:00Z' },
            { cron: '0 3 * * MON' },
          ],
        },
      });
    };
    const crons = await new CfClient('tok', fetchImpl).updateWorkerCrons('acc1', 'my-worker', [
      '*/30 * * * *',
      '0 3 * * MON',
    ]);
    expect(method).toBe('PUT');
    expect(url).toContain('/accounts/acc1/workers/scripts/my-worker/schedules');
    expect(body).toEqual([{ cron: '*/30 * * * *' }, { cron: '0 3 * * MON' }]);
    expect(crons).toEqual([
      { cron: '*/30 * * * *', created_on: '2026-07-01T00:00:00Z', modified_on: '2026-07-05T00:00:00Z' },
      { cron: '0 3 * * MON', created_on: undefined, modified_on: undefined },
    ]);
  });

  it('listWorkerSecrets iterates the SinglePage and maps name/type', async () => {
    let url = '';
    const fetchImpl: typeof fetch = async (input) => {
      url = String(input);
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: [
          { name: 'API_KEY', type: 'secret_text' },
          { name: 'SIGNING_KEY', type: 'secret_key' },
        ],
      });
    };
    const secrets = await new CfClient('tok', fetchImpl).listWorkerSecrets('acc1', 'my-worker');
    expect(url).toContain('/accounts/acc1/workers/scripts/my-worker/secrets');
    expect(secrets).toEqual([
      { name: 'API_KEY', type: 'secret_text' },
      { name: 'SIGNING_KEY', type: 'secret_key' },
    ]);
  });

  it('putWorkerSecret PUTs name/text/type=secret_text', async () => {
    let url = '';
    let method = '';
    let body: unknown;
    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input);
      method = (init?.method ?? 'GET').toUpperCase();
      body = JSON.parse(String(init?.body));
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: { name: 'API_KEY', type: 'secret_text' },
      });
    };
    await new CfClient('tok', fetchImpl).putWorkerSecret('acc1', 'my-worker', 'API_KEY', 's3cret');
    expect(method).toBe('PUT');
    expect(url).toContain('/accounts/acc1/workers/scripts/my-worker/secrets');
    expect(body).toEqual({ name: 'API_KEY', text: 's3cret', type: 'secret_text' });
  });

  it('deleteWorkerSecret issues DELETE to /secrets/:name', async () => {
    let url = '';
    let method = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input);
      method = (init?.method ?? 'GET').toUpperCase();
      return jsonResponse({ success: true, errors: [], messages: [], result: null });
    };
    await new CfClient('tok', fetchImpl).deleteWorkerSecret('acc1', 'my-worker', 'API_KEY');
    expect(method).toBe('DELETE');
    expect(url).toContain('/accounts/acc1/workers/scripts/my-worker/secrets/API_KEY');
  });

  it('listPagesDomains maps status and validation_data.status', async () => {
    let url = '';
    const fetchImpl: typeof fetch = async (input) => {
      url = String(input);
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: [
          {
            id: 'pd1',
            name: 'www.example.com',
            status: 'active',
            validation_data: { method: 'http', status: 'active' },
            verification_data: { status: 'active' },
            zone_tag: 'z1',
          },
          { id: 'pd2', name: 'beta.example.com', status: 'pending', validation_data: null },
        ],
      });
    };
    const domains = await new CfClient('tok', fetchImpl).listPagesDomains('acc1', 'site1');
    expect(url).toContain('/accounts/acc1/pages/projects/site1/domains');
    expect(domains).toEqual([
      { id: 'pd1', name: 'www.example.com', status: 'active', validation_status: 'active' },
      { id: 'pd2', name: 'beta.example.com', status: 'pending', validation_status: null },
    ]);
  });

  it('addPagesDomain POSTs {name} and maps the created domain', async () => {
    let url = '';
    let method = '';
    let body: unknown;
    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input);
      method = (init?.method ?? 'GET').toUpperCase();
      body = JSON.parse(String(init?.body));
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: {
          id: 'pd3',
          name: 'app.example.com',
          status: 'initializing',
          validation_data: { method: 'http', status: 'initializing' },
        },
      });
    };
    const domain = await new CfClient('tok', fetchImpl).addPagesDomain('acc1', 'site1', 'app.example.com');
    expect(method).toBe('POST');
    expect(url).toContain('/accounts/acc1/pages/projects/site1/domains');
    expect(body).toEqual({ name: 'app.example.com' });
    expect(domain).toEqual({
      id: 'pd3',
      name: 'app.example.com',
      status: 'initializing',
      validation_status: 'initializing',
    });
  });

  it('deletePagesDomain issues DELETE to /domains/:domain', async () => {
    let url = '';
    let method = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input);
      method = (init?.method ?? 'GET').toUpperCase();
      return jsonResponse({ success: true, errors: [], messages: [], result: null });
    };
    await new CfClient('tok', fetchImpl).deletePagesDomain('acc1', 'site1', 'app.example.com');
    expect(method).toBe('DELETE');
    expect(url).toContain('/accounts/acc1/pages/projects/site1/domains/app.example.com');
  });

  it('retryPagesDomain PATCHes /domains/:domain to re-trigger validation', async () => {
    let url = '';
    let method = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input);
      method = (init?.method ?? 'GET').toUpperCase();
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: {
          id: 'pd3',
          name: 'app.example.com',
          status: 'pending',
          validation_data: { method: 'http', status: 'pending' },
        },
      });
    };
    const domain = await new CfClient('tok', fetchImpl).retryPagesDomain('acc1', 'site1', 'app.example.com');
    expect(method).toBe('PATCH');
    expect(url).toContain('/accounts/acc1/pages/projects/site1/domains/app.example.com');
    expect(domain).toEqual({ id: 'pd3', name: 'app.example.com', status: 'pending', validation_status: 'pending' });
  });

  it('createPagesDeployment POSTs multipart with the branch field', async () => {
    let url = '';
    let method = '';
    let contentType = '';
    let bodyText = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input);
      method = (init?.method ?? 'GET').toUpperCase();
      contentType = new Headers(init?.headers).get('Content-Type') ?? '';
      bodyText = await readBodyText(init?.body);
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: {
          id: 'dep-new',
          environment: 'preview',
          url: 'https://dep-new.site1.pages.dev',
          created_on: '2026-07-05T00:00:00Z',
          latest_stage: { name: 'queued', status: 'active' },
          deployment_trigger: { type: 'ad_hoc', metadata: { branch: 'dev', commit_hash: 'h1' } },
        },
      });
    };
    const dep = await new CfClient('tok', fetchImpl).createPagesDeployment('acc1', 'site1', 'dev');
    expect(method).toBe('POST');
    expect(url).toContain('/accounts/acc1/pages/projects/site1/deployments');
    expect(contentType).toContain('multipart/form-data');
    expect(bodyText).toContain('name="branch"');
    expect(bodyText).toContain('dev');
    expect(dep.id).toBe('dep-new');
    expect(dep.deployment_trigger_branch).toBe('dev');
  });

  it('purgePagesBuildCache POSTs to /purge_build_cache', async () => {
    let url = '';
    let method = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input);
      method = (init?.method ?? 'GET').toUpperCase();
      return jsonResponse({ success: true, errors: [], messages: [], result: null });
    };
    await new CfClient('tok', fetchImpl).purgePagesBuildCache('acc1', 'site1');
    expect(method).toBe('POST');
    expect(url).toContain('/accounts/acc1/pages/projects/site1/purge_build_cache');
  });

  it('attachWorkerDomain PUTs hostname/service/environment/zone_id and maps the domain', async () => {
    let url = '';
    let method = '';
    let body: unknown;
    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input);
      method = (init?.method ?? 'GET').toUpperCase();
      body = JSON.parse(String(init?.body));
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: {
          id: 'dom9',
          cert_id: 'cert9',
          hostname: 'app.example.com',
          service: 'my-worker',
          environment: 'production',
          zone_id: 'z1',
          zone_name: 'example.com',
        },
      });
    };
    const domain = await new CfClient('tok', fetchImpl).attachWorkerDomain('acc1', {
      hostname: 'app.example.com',
      service: 'my-worker',
      zoneId: 'z1',
    });
    expect(method).toBe('PUT');
    expect(url).toContain('/accounts/acc1/workers/domains');
    expect(body).toEqual({
      hostname: 'app.example.com',
      service: 'my-worker',
      environment: 'production',
      zone_id: 'z1',
    });
    expect(domain).toEqual({
      id: 'dom9',
      hostname: 'app.example.com',
      service: 'my-worker',
      environment: 'production',
      zone_name: 'example.com',
    });
  });

  it('detachWorkerDomain issues DELETE to /workers/domains/:id', async () => {
    let url = '';
    let method = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input);
      method = (init?.method ?? 'GET').toUpperCase();
      return jsonResponse({ success: true, errors: [], messages: [] });
    };
    await new CfClient('tok', fetchImpl).detachWorkerDomain('acc1', 'dom9');
    expect(method).toBe('DELETE');
    expect(url).toContain('/accounts/acc1/workers/domains/dom9');
  });

  it('getWorkerScriptSettings hits /settings (not /script-settings) and derives binding targets', async () => {
    let url = '';
    const fetchImpl: typeof fetch = async (input) => {
      url = String(input);
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: {
          bindings: [
            { type: 'kv_namespace', name: 'KV', namespace_id: 'ns1' },
            { type: 'd1', name: 'DB', database_id: 'db1' },
            { type: 'd1', name: 'DB_OLD', id: 'db-legacy' },
            { type: 'r2_bucket', name: 'BUCKET', bucket_name: 'assets' },
            { type: 'service', name: 'API', service: 'api-worker' },
            { type: 'queue', name: 'Q', queue_name: 'jobs' },
            { type: 'durable_object_namespace', name: 'DO', class_name: 'Counter' },
            { type: 'plain_text', name: 'ENV', text: 'prod' },
          ],
          compatibility_date: '2026-01-01',
          compatibility_flags: ['nodejs_compat'],
          usage_model: 'standard',
          tail_consumers: [{ service: 'tail-worker' }],
          logpush: false,
        },
      });
    };
    const s = await new CfClient('tok', fetchImpl).getWorkerScriptSettings('acc1', 'my-worker');
    expect(new URL(url).pathname).toBe('/client/v4/accounts/acc1/workers/scripts/my-worker/settings');
    expect(s.bindings).toEqual([
      { type: 'kv_namespace', name: 'KV', target: 'ns1' },
      { type: 'd1', name: 'DB', target: 'db1' },
      { type: 'd1', name: 'DB_OLD', target: 'db-legacy' },
      { type: 'r2_bucket', name: 'BUCKET', target: 'assets' },
      { type: 'service', name: 'API', target: 'api-worker' },
      { type: 'queue', name: 'Q', target: 'jobs' },
      { type: 'durable_object_namespace', name: 'DO', target: 'Counter' },
      { type: 'plain_text', name: 'ENV', target: null },
    ]);
    expect(s.compatibility_date).toBe('2026-01-01');
    expect(s.compatibility_flags).toEqual(['nodejs_compat']);
    expect(s.usage_model).toBe('standard');
    expect(s.tail_consumers).toEqual([{ service: 'tail-worker' }]);
    expect((s.raw as { logpush: boolean }).logpush).toBe(false);
  });

  it('listWorkerVersions takes first page only (per_page=20) and maps metadata/annotations', async () => {
    let calls = 0;
    let url = '';
    const fetchImpl: typeof fetch = async (input) => {
      calls++;
      url = String(input);
      // V4PagePagination：items 嵌套在 result.items 下；result_info 声称还有更多页，客户端不得翻页
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: {
          items: [
            {
              id: 'v2',
              number: 2,
              metadata: { created_on: '2026-06-01T00:00:00Z', source: 'wrangler' },
              annotations: { 'workers/message': 'fix bug', 'workers/triggered_by': 'upload' },
            },
            {
              id: 'v1',
              number: 1,
              metadata: { created_on: '2026-05-01T00:00:00Z', source: 'api' },
            },
          ],
        },
        result_info: { page: 1, per_page: 20, count: 2, total_count: 50, total_pages: 3 },
      });
    };
    const versions = await new CfClient('tok', fetchImpl).listWorkerVersions('acc1', 'my-worker');
    const parsed = new URL(url);
    expect(parsed.pathname).toContain('/accounts/acc1/workers/scripts/my-worker/versions');
    expect(parsed.searchParams.get('per_page')).toBe('20');
    expect(calls).toBe(1);
    expect(versions).toEqual([
      { id: 'v2', number: 2, created_on: '2026-06-01T00:00:00Z', message: 'fix bug', triggered_by: 'upload' },
      // annotations 缺失时：message 为 null，triggered_by 回退到 metadata.source
      { id: 'v1', number: 1, created_on: '2026-05-01T00:00:00Z', message: null, triggered_by: 'api' },
    ]);
  });

  it('listWorkerDeployments maps strategy/versions/annotations message', async () => {
    let url = '';
    const fetchImpl: typeof fetch = async (input) => {
      url = String(input);
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: {
          deployments: [
            {
              id: 'wd1',
              strategy: 'percentage',
              created_on: '2026-06-02T00:00:00Z',
              author_email: 'dev@example.com',
              source: 'api',
              annotations: { 'workers/message': 'gradual rollout', 'workers/triggered_by': 'deployment' },
              versions: [
                { version_id: 'v2', percentage: 90 },
                { version_id: 'v1', percentage: 10 },
              ],
            },
          ],
        },
      });
    };
    const deployments = await new CfClient('tok', fetchImpl).listWorkerDeployments('acc1', 'my-worker');
    expect(url).toContain('/accounts/acc1/workers/scripts/my-worker/deployments');
    expect(deployments).toEqual([
      {
        id: 'wd1',
        strategy: 'percentage',
        created_on: '2026-06-02T00:00:00Z',
        author_email: 'dev@example.com',
        message: 'gradual rollout',
        versions: [
          { version_id: 'v2', percentage: 90 },
          { version_id: 'v1', percentage: 10 },
        ],
      },
    ]);
  });

  it('listPagesDeploymentsPage forwards page/per_page and returns totalCount from result_info', async () => {
    let url = '';
    const fetchImpl: typeof fetch = async (input) => {
      url = String(input);
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: [
          {
            id: 'dep11',
            environment: 'production',
            url: 'https://dep11.site1.pages.dev',
            created_on: '2026-03-01T00:00:00Z',
            latest_stage: { name: 'deploy', status: 'failure' },
            deployment_trigger: { type: 'github:push', metadata: { branch: 'main', commit_hash: 'hash11' } },
          },
        ],
        result_info: { page: 2, per_page: 10, count: 1, total_count: 37, total_pages: 4 },
      });
    };
    const { deployments, totalCount } = await new CfClient('tok', fetchImpl).listPagesDeploymentsPage(
      'acc1',
      'site1',
      2,
      10,
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/client/v4/accounts/acc1/pages/projects/site1/deployments');
    expect(parsed.searchParams.get('page')).toBe('2');
    expect(parsed.searchParams.get('per_page')).toBe('10');
    expect(totalCount).toBe(37);
    expect(deployments).toEqual([
      {
        id: 'dep11',
        environment: 'production',
        url: 'https://dep11.site1.pages.dev',
        created_on: '2026-03-01T00:00:00Z',
        latest_stage_status: 'failure',
        latest_stage_name: 'deploy',
        deployment_trigger_branch: 'main',
        deployment_trigger_commit_hash: 'hash11',
      },
    ]);
  });

  it('getPagesDeploymentLogs hits history/logs and maps ts/line/total', async () => {
    let url = '';
    const fetchImpl: typeof fetch = async (input) => {
      url = String(input);
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: {
          total: 2,
          includes_container_logs: false,
          data: [
            { ts: '2026-03-01T00:00:01Z', line: 'Cloning repository...' },
            { ts: '2026-03-01T00:00:09Z', line: 'Success: build completed' },
          ],
        },
      });
    };
    const logs = await new CfClient('tok', fetchImpl).getPagesDeploymentLogs('acc1', 'site1', 'dep1');
    expect(url).toContain('/accounts/acc1/pages/projects/site1/deployments/dep1/history/logs');
    expect(logs).toEqual({
      total: 2,
      lines: [
        { ts: '2026-03-01T00:00:01Z', line: 'Cloning repository...' },
        { ts: '2026-03-01T00:00:09Z', line: 'Success: build completed' },
      ],
    });
  });

  it('retryPagesDeployment POSTs to /retry and maps the updated deployment', async () => {
    let url = '';
    let method = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input);
      method = (init?.method ?? 'GET').toUpperCase();
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: {
          id: 'dep1',
          environment: 'production',
          url: 'https://dep1.site1.pages.dev',
          created_on: '2026-03-02T00:00:00Z',
          latest_stage: { name: 'queued', status: 'active' },
          deployment_trigger: { type: 'retry', metadata: { branch: 'main', commit_hash: 'hash1' } },
        },
      });
    };
    const dep = await new CfClient('tok', fetchImpl).retryPagesDeployment('acc1', 'site1', 'dep1');
    expect(method).toBe('POST');
    expect(url).toContain('/accounts/acc1/pages/projects/site1/deployments/dep1/retry');
    expect(dep.id).toBe('dep1');
    expect(dep.latest_stage_status).toBe('active');
    expect(dep.latest_stage_name).toBe('queued');
  });

  it('rollbackPagesDeployment POSTs to /rollback and maps the updated deployment', async () => {
    let url = '';
    let method = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input);
      method = (init?.method ?? 'GET').toUpperCase();
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: {
          id: 'dep0',
          environment: 'production',
          url: 'https://dep0.site1.pages.dev',
          created_on: '2026-02-01T00:00:00Z',
          latest_stage: { name: 'deploy', status: 'success' },
          deployment_trigger: { type: 'rollback', metadata: { branch: 'main', commit_hash: 'hash0' } },
        },
      });
    };
    const dep = await new CfClient('tok', fetchImpl).rollbackPagesDeployment('acc1', 'site1', 'dep0');
    expect(method).toBe('POST');
    expect(url).toContain('/accounts/acc1/pages/projects/site1/deployments/dep0/rollback');
    expect(dep.id).toBe('dep0');
    expect(dep.latest_stage_status).toBe('success');
  });

  it('getWorkersSubdomain returns the account-level subdomain', async () => {
    let seenUrl = '';
    const fetchImpl: typeof fetch = async (input) => {
      seenUrl = String(input);
      return jsonResponse({ success: true, errors: [], messages: [], result: { subdomain: 'aiall' } });
    };
    expect(await new CfClient('tok', fetchImpl).getWorkersSubdomain('acc1')).toBe('aiall');
    expect(seenUrl).toContain('/accounts/acc1/workers/subdomain');
  });

  it('getWorkersSubdomain returns null when the account has no subdomain (CF error swallowed)', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(
        {
          success: false,
          errors: [{ code: 10007, message: 'workers.api.error.not_found' }],
          messages: [],
          result: null,
        },
        404,
      );
    expect(await new CfClient('tok', fetchImpl).getWorkersSubdomain('acc1')).toBeNull();
  });

  it('getWorkerScriptSubdomain reads enabled/previews_enabled', async () => {
    let seenUrl = '';
    const fetchImpl: typeof fetch = async (input) => {
      seenUrl = String(input);
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: { enabled: true, previews_enabled: false },
      });
    };
    const s = await new CfClient('tok', fetchImpl).getWorkerScriptSubdomain('acc1', 'my-worker');
    expect(s).toEqual({ enabled: true, previews_enabled: false });
    expect(seenUrl).toContain('/accounts/acc1/workers/scripts/my-worker/subdomain');
  });

  it('setWorkerScriptSubdomain POSTs both flags and maps the response', async () => {
    let seenMethod = '';
    let seenBody = '';
    const fetchImpl: typeof fetch = async (_input, init) => {
      seenMethod = init?.method ?? '';
      seenBody = await readBodyText(init?.body);
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: { enabled: false, previews_enabled: true },
      });
    };
    const s = await new CfClient('tok', fetchImpl).setWorkerScriptSubdomain('acc1', 'my-worker', false, true);
    expect(s).toEqual({ enabled: false, previews_enabled: true });
    expect(seenMethod).toBe('POST');
    expect(JSON.parse(seenBody)).toEqual({ enabled: false, previews_enabled: true });
  });

  it('updateWorkerScriptSettings PATCHes /settings with the given settings and maps the response', async () => {
    let seenUrl = '';
    let seenMethod = '';
    let seenBody = '';
    let seenContentType = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenMethod = init?.method ?? '';
      seenContentType = new Headers(init?.headers).get('Content-Type') ?? '';
      seenBody = await readBodyText(init?.body);
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: {
          bindings: [
            { type: 'plain_text', name: 'MODE', text: 'prod' },
            { type: 'secret_text', name: 'TOKEN' },
          ],
          compatibility_date: '2026-07-06',
          compatibility_flags: ['nodejs_compat'],
          usage_model: 'standard',
        },
      });
    };
    const s = await new CfClient('tok', fetchImpl).updateWorkerScriptSettings('acc1', 'my-worker', {
      bindings: [
        { type: 'inherit', name: 'TOKEN' },
        { type: 'plain_text', name: 'MODE', text: 'prod' },
      ],
      compatibility_date: '2026-07-06',
    });
    expect(seenUrl).toContain('/accounts/acc1/workers/scripts/my-worker/settings');
    expect(seenUrl).not.toContain('script-settings');
    expect(seenMethod).toBe('PATCH');
    // /settings PATCH 是 multipart：settings 以表单字段承载 JSON（SDK __multipartSyntax: 'json'）
    const fd = await new Response(seenBody, {
      headers: { 'content-type': seenContentType },
    }).formData();
    const settingsPart = fd.get('settings');
    const settingsJson = settingsPart instanceof File ? await settingsPart.text() : String(settingsPart);
    expect(JSON.parse(settingsJson)).toEqual({
      bindings: [
        { type: 'inherit', name: 'TOKEN' },
        { type: 'plain_text', name: 'MODE', text: 'prod' },
      ],
      compatibility_date: '2026-07-06',
    });
    expect(s.compatibility_date).toBe('2026-07-06');
    expect(s.bindings.map((b) => b.type)).toEqual(['plain_text', 'secret_text']);
  });

  it('raw() keeps caller headers when passed as a Headers instance', async () => {
    let seen: Headers | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen = new Headers(init?.headers);
      return jsonResponse({ success: true, errors: [], result: { ok: true } });
    };
    await new CfClient('tok-9', fetchImpl).raw('/x', {
      headers: new Headers({ 'X-Custom': 'abc', 'Content-Type': 'text/plain' }),
    });
    expect(seen!.get('X-Custom')).toBe('abc');
    expect(seen!.get('Content-Type')).toBe('text/plain');
    expect(seen!.get('Authorization')).toBe('Bearer tok-9');
  });

  it('queryWorkersInvocations POSTs /graphql with the dataset query and maps rows', async () => {
    let seenUrl = '';
    let seenMethod = '';
    let seenBody: { query?: string; variables?: Record<string, unknown> } = {};
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenMethod = init?.method ?? '';
      seenBody = JSON.parse(String(init?.body));
      return jsonResponse({
        data: {
          viewer: {
            accounts: [
              {
                workersInvocationsAdaptive: [
                  { dimensions: { scriptName: 'hono-sever' }, sum: { requests: 1093, errors: 2 } },
                  { dimensions: { scriptName: 'coloring-pages' }, sum: { requests: 1453, errors: 0 } },
                ],
              },
            ],
          },
        },
        errors: null,
      });
    };
    const rows = await new CfClient('tok', fetchImpl).queryWorkersInvocations(
      'acc1',
      '2026-06-30T00:00:00Z',
      '2026-07-07T00:00:00Z',
    );
    expect(seenUrl).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect(seenMethod).toBe('POST');
    expect(seenBody.query).toContain('workersInvocationsAdaptive');
    expect(seenBody.variables).toEqual({
      account: 'acc1',
      since: '2026-06-30T00:00:00Z',
      until: '2026-07-07T00:00:00Z',
    });
    expect(rows).toEqual([
      { scriptName: 'hono-sever', requests: 1093, errors: 2 },
      { scriptName: 'coloring-pages', requests: 1453, errors: 0 },
    ]);
  });

  it('queryPagesFunctionsInvocations maps pages-worker scriptNames verbatim', async () => {
    let seenBody: { query?: string } = {};
    const fetchImpl: typeof fetch = async (_input, init) => {
      seenBody = JSON.parse(String(init?.body));
      return jsonResponse({
        data: {
          viewer: {
            accounts: [
              {
                pagesFunctionsInvocationsAdaptiveGroups: [
                  { dimensions: { scriptName: 'pages-worker--12090723-production' }, sum: { requests: 110334 } },
                ],
              },
            ],
          },
        },
        errors: null,
      });
    };
    const rows = await new CfClient('tok', fetchImpl).queryPagesFunctionsInvocations(
      'acc1',
      '2026-06-30T00:00:00Z',
      '2026-07-07T00:00:00Z',
    );
    expect(seenBody.query).toContain('pagesFunctionsInvocationsAdaptiveGroups');
    expect(rows).toEqual([{ scriptName: 'pages-worker--12090723-production', requests: 110334 }]);
  });

  it('queryWorkersInvocationsDaily groups by date and maps rows', async () => {
    let seenBody: { query?: string; variables?: Record<string, unknown> } = {};
    const fetchImpl: typeof fetch = async (_input, init) => {
      seenBody = JSON.parse(String(init?.body));
      return jsonResponse({
        data: {
          viewer: {
            accounts: [
              {
                workersInvocationsAdaptive: [
                  {
                    dimensions: { date: '2026-07-05', scriptName: 'hono-sever' },
                    sum: { requests: 196, errors: 1 },
                  },
                  {
                    dimensions: { date: '2026-07-06', scriptName: 'hono-sever' },
                    sum: { requests: 18, errors: 0 },
                  },
                ],
              },
            ],
          },
        },
        errors: null,
      });
    };
    const rows = await new CfClient('tok', fetchImpl).queryWorkersInvocationsDaily(
      'acc1',
      '2026-07-05T00:00:00Z',
      '2026-07-07T00:00:00Z',
    );
    expect(seenBody.query).toContain('workersInvocationsAdaptive');
    expect(seenBody.query).toContain('date scriptName');
    expect(seenBody.query).toContain('limit: 10000');
    expect(rows).toEqual([
      { date: '2026-07-05', scriptName: 'hono-sever', requests: 196, errors: 1 },
      { date: '2026-07-06', scriptName: 'hono-sever', requests: 18, errors: 0 },
    ]);
  });

  it('queryPagesFunctionsInvocationsDaily groups by date and maps rows', async () => {
    let seenBody: { query?: string } = {};
    const fetchImpl: typeof fetch = async (_input, init) => {
      seenBody = JSON.parse(String(init?.body));
      return jsonResponse({
        data: {
          viewer: {
            accounts: [
              {
                pagesFunctionsInvocationsAdaptiveGroups: [
                  {
                    dimensions: { date: '2026-07-05', scriptName: 'pages-worker--12090723-production' },
                    sum: { requests: 12963 },
                  },
                ],
              },
            ],
          },
        },
        errors: null,
      });
    };
    const rows = await new CfClient('tok', fetchImpl).queryPagesFunctionsInvocationsDaily(
      'acc1',
      '2026-07-05T00:00:00Z',
      '2026-07-07T00:00:00Z',
    );
    expect(seenBody.query).toContain('pagesFunctionsInvocationsAdaptiveGroups');
    expect(seenBody.query).toContain('date scriptName');
    expect(rows).toEqual([{ date: '2026-07-05', scriptName: 'pages-worker--12090723-production', requests: 12963 }]);
  });

  it('queryWorkersInvocationsHourly groups by datetimeHour and maps to bucket', async () => {
    let seenBody: { query?: string; variables?: Record<string, unknown> } = {};
    const fetchImpl: typeof fetch = async (_input, init) => {
      seenBody = JSON.parse(String(init?.body));
      return jsonResponse({
        data: {
          viewer: {
            accounts: [
              {
                workersInvocationsAdaptive: [
                  {
                    dimensions: { datetimeHour: '2026-07-06T08:00:00Z', scriptName: 'hono-sever' },
                    sum: { requests: 4, errors: 1 },
                  },
                  {
                    dimensions: { datetimeHour: '2026-07-06T09:00:00Z', scriptName: 'hono-sever' },
                    sum: { requests: 2, errors: 0 },
                  },
                ],
              },
            ],
          },
        },
        errors: null,
      });
    };
    const rows = await new CfClient('tok', fetchImpl).queryWorkersInvocationsHourly(
      'acc1',
      '2026-07-06T08:00:00Z',
      '2026-07-06T10:00:00Z',
    );
    expect(seenBody.query).toContain('workersInvocationsAdaptive');
    expect(seenBody.query).toContain('datetimeHour scriptName');
    expect(seenBody.query).toContain('limit: 10000');
    expect(rows).toEqual([
      { bucket: '2026-07-06T08:00:00Z', scriptName: 'hono-sever', requests: 4, errors: 1 },
      { bucket: '2026-07-06T09:00:00Z', scriptName: 'hono-sever', requests: 2, errors: 0 },
    ]);
  });

  it('queryPagesFunctionsInvocationsHourly groups by datetimeHour and maps to bucket', async () => {
    let seenBody: { query?: string } = {};
    const fetchImpl: typeof fetch = async (_input, init) => {
      seenBody = JSON.parse(String(init?.body));
      return jsonResponse({
        data: {
          viewer: {
            accounts: [
              {
                pagesFunctionsInvocationsAdaptiveGroups: [
                  {
                    dimensions: { datetimeHour: '2026-07-06T08:00:00Z', scriptName: 'pages-worker--111-production' },
                    sum: { requests: 42 },
                  },
                ],
              },
            ],
          },
        },
        errors: null,
      });
    };
    const rows = await new CfClient('tok', fetchImpl).queryPagesFunctionsInvocationsHourly(
      'acc1',
      '2026-07-06T08:00:00Z',
      '2026-07-06T10:00:00Z',
    );
    expect(seenBody.query).toContain('pagesFunctionsInvocationsAdaptiveGroups');
    expect(seenBody.query).toContain('datetimeHour scriptName');
    expect(rows).toEqual([
      { bucket: '2026-07-06T08:00:00Z', scriptName: 'pages-worker--111-production', requests: 42 },
    ]);
  });

  it('graphql errors array maps to CfApiError with the message', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ data: null, errors: [{ message: 'not authorized to access account' }] });
    const client = new CfClient('tok', fetchImpl);
    await expect(
      client.queryWorkersInvocations('acc1', '2026-06-30T00:00:00Z', '2026-07-07T00:00:00Z'),
    ).rejects.toThrow(/not authorized/);
  });
});
