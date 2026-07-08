import { describe, expect, it } from 'vitest';
import { GET as getPagesProjects } from '../../src/pages/api/pages/projects/index';
import { GET as getWorkersScripts } from '../../src/pages/api/workers/scripts/index';

const HEX_KEY = 'a'.repeat(64);

function makeContext(db: unknown, url: string) {
  return {
    locals: {
      userEmail: 'alice@ops.dev',
      runtime: { env: { DB: db, ENCRYPTION_KEY: HEX_KEY } },
    },
    request: new Request(url),
  } as unknown as Parameters<typeof getWorkersScripts>[0];
}

const brokenDb = {
  prepare() {
    throw new TypeError('fetch failed');
  },
};

describe('GET /api/workers/scripts error handling', () => {
  it('returns json 503 instead of throwing when the db transport fails', async () => {
    const res = await getWorkersScripts(makeContext(brokenDb, 'http://localhost/api/workers/scripts'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('workers scripts');
  });
});

describe('GET /api/pages/projects error handling', () => {
  it('returns json 503 instead of throwing when the db transport fails', async () => {
    const res = await getPagesProjects(makeContext(brokenDb, 'http://localhost/api/pages/projects'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('pages projects');
  });
});
