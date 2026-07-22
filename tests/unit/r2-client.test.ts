import { describe, expect, it } from 'vitest';
import { CfApiError, CfClient } from '@/server/cf/client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function envelope(result: unknown, result_info?: unknown) {
  return { success: true, errors: [], messages: [], result, ...(result_info ? { result_info } : {}) };
}

describe('CfClient R2 buckets', () => {
  it('listR2Buckets hits /accounts/:id/r2/buckets and maps fields', async () => {
    let seenUrl = '';
    const fetchImpl: typeof fetch = async (input) => {
      seenUrl = String(input);
      return jsonResponse(
        envelope({
          buckets: [
            { name: 'b1', creation_date: '2026-01-01T00:00:00Z', location: 'apac', storage_class: 'Standard' },
            { name: 'b2' },
          ],
        }),
      );
    };
    const buckets = await new CfClient('tok', fetchImpl).listR2Buckets('cf-1');
    expect(seenUrl).toContain('/accounts/cf-1/r2/buckets');
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({
      name: 'b1',
      creation_date: '2026-01-01T00:00:00Z',
      location: 'apac',
      storage_class: 'Standard',
    });
    expect(buckets[0].raw).toBeDefined();
    expect(buckets[1].name).toBe('b2');
  });

  it('createR2Bucket posts name/locationHint/storageClass', async () => {
    let seenBody = '';
    let seenMethod = '';
    const fetchImpl: typeof fetch = async (_input, init) => {
      seenMethod = (init?.method ?? '').toLowerCase();
      seenBody = String(init?.body ?? '');
      return jsonResponse(envelope({ name: 'nb', location: 'weur', storage_class: 'InfrequentAccess' }));
    };
    const b = await new CfClient('tok', fetchImpl).createR2Bucket('cf-1', {
      name: 'nb',
      location: 'weur',
      storageClass: 'InfrequentAccess',
    });
    expect(seenMethod).toBe('post');
    const parsed = JSON.parse(seenBody) as Record<string, unknown>;
    expect(parsed).toEqual({ name: 'nb', locationHint: 'weur', storageClass: 'InfrequentAccess' });
    expect(b.name).toBe('nb');
  });

  it('deleteR2Bucket DELETEs the bucket path and maps API errors to CfApiError', async () => {
    let seenUrl = '';
    let seenMethod = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenMethod = (init?.method ?? '').toLowerCase();
      return jsonResponse(envelope({}));
    };
    await new CfClient('tok', fetchImpl).deleteR2Bucket('cf-1', 'b1');
    expect(seenMethod).toBe('delete');
    expect(seenUrl).toContain('/accounts/cf-1/r2/buckets/b1');

    const failing: typeof fetch = async () =>
      jsonResponse({ success: false, errors: [{ code: 10006, message: 'bucket not empty' }], result: null }, 409);
    await expect(new CfClient('tok', failing).deleteR2Bucket('cf-1', 'b1')).rejects.toThrowError(CfApiError);
  });
});

describe('CfClient R2 objects', () => {
  it('listR2Objects passes prefix/delimiter/cursor and returns next cursor', async () => {
    let seenUrl = '';
    const fetchImpl: typeof fetch = async (input) => {
      seenUrl = String(input);
      return jsonResponse(
        envelope(
          [
            { key: 'docs/', size: 0 }, // delimiter 分组出的前缀条目
            { key: 'a.txt', size: 12, etag: 'e1', last_modified: '2026-07-01T00:00:00Z' },
          ],
          { cursor: 'next-1', per_page: 100 },
        ),
      );
    };
    const r = await new CfClient('tok', fetchImpl).listR2Objects('cf-1', 'b1', { prefix: 'docs/', cursor: 'c0' });
    const url = new URL(seenUrl);
    expect(url.pathname).toContain('/accounts/cf-1/r2/buckets/b1/objects');
    expect(url.searchParams.get('prefix')).toBe('docs/');
    expect(url.searchParams.get('delimiter')).toBe('/');
    expect(url.searchParams.get('cursor')).toBe('c0');
    expect(r.cursor).toBe('next-1');
    expect(r.objects).toEqual([
      { key: 'docs/', size: null, etag: null, last_modified: null, is_prefix: true },
      { key: 'a.txt', size: 12, etag: 'e1', last_modified: '2026-07-01T00:00:00Z', is_prefix: false },
    ]);
  });

  it('listR2Objects returns null cursor on the last page', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(envelope([], { per_page: 100 }));
    const r = await new CfClient('tok', fetchImpl).listR2Objects('cf-1', 'b1');
    expect(r).toEqual({ objects: [], cursor: null });
  });

  it('deleteR2Object percent-encodes each key segment but keeps slashes', async () => {
    let seenUrl = '';
    let seenMethod = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenMethod = (init?.method ?? '').toLowerCase();
      return jsonResponse(envelope({ key: 'docs/a b.txt' }));
    };
    await new CfClient('tok', fetchImpl).deleteR2Object('cf-1', 'b1', 'docs/a b.txt');
    expect(seenMethod).toBe('delete');
    expect(seenUrl).toContain('/accounts/cf-1/r2/buckets/b1/objects/docs/a%20b.txt');
  });
});

describe('CfClient R2 GraphQL usage', () => {
  function graphqlCapture(data: unknown) {
    const seen: { query?: string; variables?: Record<string, unknown> } = {};
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toContain('/graphql');
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      seen.query = body.query;
      seen.variables = body.variables;
      return jsonResponse({ data });
    };
    return { seen, fetchImpl };
  }

  it('queryR2StorageSnapshot maps per-bucket max metrics', async () => {
    const { seen, fetchImpl } = graphqlCapture({
      viewer: {
        accounts: [
          {
            r2StorageAdaptiveGroups: [
              { dimensions: { bucketName: 'b1' }, max: { payloadSize: 100, metadataSize: 5, objectCount: 3 } },
            ],
          },
        ],
      },
    });
    const rows = await new CfClient('tok', fetchImpl).queryR2StorageSnapshot('cf-1');
    expect(rows).toEqual([{ bucketName: 'b1', payloadSize: 100, metadataSize: 5, objectCount: 3 }]);
    expect(seen.query).toContain('r2StorageAdaptiveGroups');
    expect(seen.variables?.account).toBe('cf-1');
  });

  it('queryR2StorageDaily filters by bucket and groups by date', async () => {
    const { seen, fetchImpl } = graphqlCapture({
      viewer: {
        accounts: [
          {
            r2StorageAdaptiveGroups: [
              { dimensions: { date: '2026-07-01' }, max: { payloadSize: 10, objectCount: 1 } },
              { dimensions: { date: '2026-07-02' }, max: { payloadSize: 20, objectCount: 2 } },
            ],
          },
        ],
      },
    });
    const rows = await new CfClient('tok', fetchImpl).queryR2StorageDaily(
      'cf-1',
      'b1',
      '2026-07-01T00:00:00Z',
      '2026-07-03T00:00:00Z',
    );
    expect(rows).toEqual([
      { date: '2026-07-01', payloadSize: 10, objectCount: 1 },
      { date: '2026-07-02', payloadSize: 20, objectCount: 2 },
    ]);
    expect(seen.variables?.bucket).toBe('b1');
  });

  it('queryR2OperationsDaily returns per-actionType daily sums', async () => {
    const { fetchImpl } = graphqlCapture({
      viewer: {
        accounts: [
          {
            r2OperationsAdaptiveGroups: [
              { dimensions: { date: '2026-07-01', actionType: 'GetObject' }, sum: { requests: 7 } },
              { dimensions: { date: '2026-07-01', actionType: 'PutObject' }, sum: { requests: 2 } },
            ],
          },
        ],
      },
    });
    const rows = await new CfClient('tok', fetchImpl).queryR2OperationsDaily(
      'cf-1',
      'b1',
      '2026-07-01T00:00:00Z',
      '2026-07-02T00:00:00Z',
    );
    expect(rows).toEqual([
      { date: '2026-07-01', actionType: 'GetObject', requests: 7 },
      { date: '2026-07-01', actionType: 'PutObject', requests: 2 },
    ]);
  });

  it('empty accounts array degrades to []', async () => {
    const { fetchImpl } = graphqlCapture({ viewer: { accounts: [] } });
    expect(await new CfClient('tok', fetchImpl).queryR2StorageSnapshot('cf-1')).toEqual([]);
  });
});

describe('CfClient R2 settings', () => {
  it('getR2Cors maps rules and putR2Cors([]) issues a delete', async () => {
    const getImpl: typeof fetch = async (input) => {
      expect(String(input)).toContain('/accounts/cf-1/r2/buckets/b1/cors');
      return jsonResponse(
        envelope({
          rules: [{ allowed: { methods: ['GET'], origins: ['https://a.dev'] }, maxAgeSeconds: 300 }],
        }),
      );
    };
    const rules = await new CfClient('tok', getImpl).getR2Cors('cf-1', 'b1');
    expect(rules).toEqual([{ allowed: { methods: ['GET'], origins: ['https://a.dev'] }, maxAgeSeconds: 300 }]);

    let seenMethod = '';
    const delImpl: typeof fetch = async (_i, init) => {
      seenMethod = (init?.method ?? '').toLowerCase();
      return jsonResponse(envelope({}));
    };
    await new CfClient('tok', delImpl).putR2Cors('cf-1', 'b1', []);
    expect(seenMethod).toBe('delete');
  });

  it('putR2Cors with rules PUTs the whole rule set', async () => {
    let seenMethod = '';
    let seenBody = '';
    const fetchImpl: typeof fetch = async (_i, init) => {
      seenMethod = (init?.method ?? '').toLowerCase();
      seenBody = String(init?.body ?? '');
      return jsonResponse(envelope({}));
    };
    await new CfClient('tok', fetchImpl).putR2Cors('cf-1', 'b1', [
      { allowed: { methods: ['GET', 'PUT'], origins: ['*'] } },
    ]);
    expect(seenMethod).toBe('put');
    expect(JSON.parse(seenBody)).toEqual({ rules: [{ allowed: { methods: ['GET', 'PUT'], origins: ['*'] } }] });
  });

  it('custom domains: list maps status, attach posts domain/zoneId/enabled', async () => {
    const listImpl: typeof fetch = async () =>
      jsonResponse(
        envelope({
          domains: [
            {
              domain: 'cdn.a.dev',
              enabled: true,
              status: { ownership: 'active', ssl: 'active' },
              zoneName: 'a.dev',
            },
          ],
        }),
      );
    const domains = await new CfClient('tok', listImpl).listR2CustomDomains('cf-1', 'b1');
    expect(domains).toEqual([
      { domain: 'cdn.a.dev', enabled: true, ownershipStatus: 'active', sslStatus: 'active', zoneName: 'a.dev' },
    ]);

    let seenBody = '';
    const createImpl: typeof fetch = async (_i, init) => {
      seenBody = String(init?.body ?? '');
      return jsonResponse(envelope({ domain: 'cdn.a.dev', enabled: true, zoneId: 'z1' }));
    };
    const d = await new CfClient('tok', createImpl).attachR2CustomDomain('cf-1', 'b1', {
      domain: 'cdn.a.dev',
      zoneId: 'z1',
    });
    expect(JSON.parse(seenBody)).toEqual({ domain: 'cdn.a.dev', enabled: true, zoneId: 'z1' });
    expect(d.domain).toBe('cdn.a.dev');
  });

  it('managed domain get/set round-trips enabled', async () => {
    const getImpl: typeof fetch = async () =>
      jsonResponse(envelope({ bucketId: 'bid', domain: 'pub-x.r2.dev', enabled: false }));
    expect(await new CfClient('tok', getImpl).getR2ManagedDomain('cf-1', 'b1')).toEqual({
      domain: 'pub-x.r2.dev',
      enabled: false,
    });

    let seenBody = '';
    const setImpl: typeof fetch = async (_i, init) => {
      seenBody = String(init?.body ?? '');
      return jsonResponse(envelope({ bucketId: 'bid', domain: 'pub-x.r2.dev', enabled: true }));
    };
    const r = await new CfClient('tok', setImpl).setR2ManagedDomain('cf-1', 'b1', true);
    expect(JSON.parse(seenBody)).toEqual({ enabled: true });
    expect(r.enabled).toBe(true);
  });

  it('lifecycle: GET maps Age conditions to days, PUT builds SDK rules from days', async () => {
    const getImpl: typeof fetch = async () =>
      jsonResponse(
        envelope({
          rules: [
            {
              id: 'r1',
              enabled: true,
              conditions: { prefix: 'tmp/' },
              deleteObjectsTransition: { condition: { type: 'Age', maxAge: 604800 } },
              storageClassTransitions: [
                { storageClass: 'InfrequentAccess', condition: { type: 'Age', maxAge: 86400 } },
              ],
            },
            {
              id: 'r2',
              enabled: false,
              conditions: { prefix: '' },
              deleteObjectsTransition: { condition: { type: 'Date', date: '2027-01-01' } },
            },
          ],
        }),
      );
    const rules = await new CfClient('tok', getImpl).getR2Lifecycle('cf-1', 'b1');
    expect(rules).toEqual([
      { id: 'r1', enabled: true, prefix: 'tmp/', deleteAfterDays: 7, iaAfterDays: 1 },
      { id: 'r2', enabled: false, prefix: '', deleteAfterDays: null, iaAfterDays: null },
    ]);

    let seenBody = '';
    const putImpl: typeof fetch = async (_i, init) => {
      seenBody = String(init?.body ?? '');
      return jsonResponse(envelope({}));
    };
    await new CfClient('tok', putImpl).putR2Lifecycle('cf-1', 'b1', [
      { id: 'r1', enabled: true, prefix: 'tmp/', deleteAfterDays: 7, iaAfterDays: null },
    ]);
    expect(JSON.parse(seenBody)).toEqual({
      rules: [
        {
          id: 'r1',
          enabled: true,
          conditions: { prefix: 'tmp/' },
          deleteObjectsTransition: { condition: { type: 'Age', maxAge: 604800 } },
        },
      ],
    });
  });
});
