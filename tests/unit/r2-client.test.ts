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
