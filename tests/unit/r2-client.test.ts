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
