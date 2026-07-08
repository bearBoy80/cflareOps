import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as getContent, PUT as putContent } from '../../src/pages/api/workers/scripts/[accountId]/[name]/content';
import type { CfAccount, CfPagesProject, CfWorkerScript } from '../../src/server/cf/types';
import { encryptSecret, importEncryptionKey } from '../../src/server/crypto';
import { insertAccount } from '../../src/server/db/accounts';
import { syncWorkersPages } from '../../src/server/workersPages';
import { createTestDb } from '../helpers/d1';

const HEX_KEY = 'b'.repeat(64);
const ALICE = 'alice@ops.dev';

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

/** 种子：ALICE 的账号 a1，缓存脚本 worker-a（cf-1） */
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
    fakeClient([{ id: 'cf-1', name: 'CF One' }], { 'cf-1': [{ id: 'worker-a' }] }),
  );
}

function makeContext(
  db: unknown,
  url: string,
  params: Record<string, string>,
  opts: { method?: string; body?: unknown } = {},
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
      userEmail: ALICE,
      runtime: { env: { DB: db, ENCRYPTION_KEY: HEX_KEY } },
    },
    request: new Request(url, init),
    params,
  } as unknown as Parameters<typeof putContent>[0];
}

/** 用真实 FormData 构造 content/v2 的 multipart 响应体 */
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

async function readBodyText(body: unknown): Promise<string> {
  if (typeof body === 'string') return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 按 URL/method 分发的全局 fetch 替身：路由内部 clientForAccount 用默认 fetch 构造 CfClient */
function stubCfFetch(handlers: {
  getContent: () => Promise<Response> | Response;
  putContent?: (init?: RequestInit) => Promise<Response> | Response;
}) {
  const putCalls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/content/v2') && method === 'GET') return handlers.getContent();
    if (url.includes('/content') && method === 'PUT') {
      putCalls.push({ url, init });
      if (!handlers.putContent) throw new Error('unexpected PUT to CF');
      return handlers.putContent(init);
    }
    throw new Error(`unexpected CF call: ${method} ${url}`);
  }) as typeof fetch);
  return putCalls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const URL_BASE = 'http://localhost/api/workers/scripts/a1/worker-a/content';
const PARAMS = { accountId: 'a1', name: 'worker-a' };

describe('GET /api/workers/scripts/[accountId]/[name]/content', () => {
  it('includes the etag in the JSON response', async () => {
    const db = createTestDb();
    await seedCache(db);
    const { body, contentType } = await multipartFixture([{ name: 'index.js', content: 'export default {};' }]);
    stubCfFetch({
      getContent: () =>
        new Response(body, {
          headers: { 'Content-Type': contentType, 'cf-entrypoint': 'index.js', etag: '"tag-1"' },
        }),
    });
    const res = await getContent(makeContext(db, URL_BASE, PARAMS));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      content: 'export default {};',
      mainModule: 'index.js',
      multiModule: false,
      etag: 'tag-1',
    });
  });
});

describe('PUT /api/workers/scripts/[accountId]/[name]/content', () => {
  it('rejects multi-module workers with 400 multiModule (server-side guard)', async () => {
    const db = createTestDb();
    await seedCache(db);
    const { body, contentType } = await multipartFixture([
      { name: 'lib.js', content: 'export const x = 1;' },
      { name: 'index.js', content: 'export default {};' },
    ]);
    const putCalls = stubCfFetch({
      getContent: () =>
        new Response(body, {
          headers: { 'Content-Type': contentType, 'cf-entrypoint': 'index.js', etag: '"tag-1"' },
        }),
    });
    const res = await putContent(makeContext(db, URL_BASE, PARAMS, { method: 'PUT', body: { content: 'new code' } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('multiModule');
    expect(putCalls).toHaveLength(0);
  });

  it('rejects a stale etag with 409 editConflict without touching CF', async () => {
    const db = createTestDb();
    await seedCache(db);
    const { body, contentType } = await multipartFixture([{ name: 'index.js', content: 'export default {};' }]);
    const putCalls = stubCfFetch({
      getContent: () =>
        new Response(body, {
          headers: { 'Content-Type': contentType, 'cf-entrypoint': 'index.js', etag: '"fresh-tag"' },
        }),
    });
    const res = await putContent(
      makeContext(db, URL_BASE, PARAMS, { method: 'PUT', body: { content: 'new code', etag: 'stale-tag' } }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('editConflict');
    expect(putCalls).toHaveLength(0);
  });

  it('happy path: uploads with the SERVER-derived main module and returns the new etag', async () => {
    const db = createTestDb();
    await seedCache(db);
    const { body, contentType } = await multipartFixture([{ name: 'index.js', content: 'export default {};' }]);
    const putCalls = stubCfFetch({
      getContent: () =>
        new Response(body, {
          headers: { 'Content-Type': contentType, 'cf-entrypoint': 'index.js', etag: '"tag-1"' },
        }),
      putContent: () =>
        new Response(
          JSON.stringify({
            success: true,
            errors: [],
            messages: [],
            result: { id: 'worker-a', etag: '"tag-2"' },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    });
    const res = await putContent(
      makeContext(db, URL_BASE, PARAMS, {
        method: 'PUT',
        // mainModule 由客户端提供也会被忽略，以服务端最新值为准
        body: { content: 'export default { fetch() {} };', etag: 'tag-1', mainModule: 'evil.js' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, etag: 'tag-2' });
    expect(putCalls).toHaveLength(1);
    const uploadBody = await readBodyText(putCalls[0].init?.body);
    expect(uploadBody).toContain('{"main_module":"index.js"}');
    expect(uploadBody).toContain('filename="index.js"');
    expect(uploadBody).not.toContain('evil.js');
    expect(uploadBody).toContain('export default { fetch() {} };');
  });

  it('rejects an empty content body with 400', async () => {
    const db = createTestDb();
    await seedCache(db);
    stubCfFetch({
      getContent: () => {
        throw new Error('should not reach CF');
      },
    });
    const res = await putContent(makeContext(db, URL_BASE, PARAMS, { method: 'PUT', body: { etag: 't' } }));
    expect(res.status).toBe(400);
  });
});
