import { describe, expect, it } from 'vitest';
import { GET } from '../../src/pages/api/zones/index';

const HEX_KEY = 'a'.repeat(64);

function makeContext(db: unknown) {
  return {
    locals: {
      userEmail: 'alice@ops.dev',
      runtime: { env: { DB: db, ENCRYPTION_KEY: HEX_KEY } },
    },
    request: new Request('http://localhost/api/zones?status=moved'),
  } as unknown as Parameters<typeof GET>[0];
}

describe('GET /api/zones error handling', () => {
  it('returns json 503 instead of throwing when the db transport fails', async () => {
    const brokenDb = {
      prepare() {
        throw new TypeError('fetch failed');
      },
    };
    const res = await GET(makeContext(brokenDb));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('zones');
  });
});
