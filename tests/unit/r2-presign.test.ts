import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@/server/crypto';
import { deriveR2S3Credentials, presignR2ObjectUrl } from '@/server/r2Presign';

describe('deriveR2S3Credentials', () => {
  it('uses token id as access key and sha256(token) as secret (official derivation rule)', async () => {
    const creds = await deriveR2S3Credentials(
      { verifyToken: async () => ({ id: 'tok-id-1', status: 'active' }) },
      'raw-token',
    );
    expect(creds.accessKeyId).toBe('tok-id-1');
    expect(creds.secretAccessKey).toBe(await sha256Hex('raw-token'));
  });
});

describe('presignR2ObjectUrl', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const CREDS = { accessKeyId: 'AK', secretAccessKey: 'SK' };

  it('signs a GET url against the account S3 endpoint with query auth', async () => {
    const url = new URL(
      await presignR2ObjectUrl(CREDS, { cfAccountId: 'cf-1', bucket: 'b1', key: 'docs/a b.txt', method: 'GET' }),
    );
    expect(url.origin).toBe('https://cf-1.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/b1/docs/a%20b.txt');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Credential')).toContain('AK/20260721/auto/s3/aws4_request');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic under a fixed clock and differs by method', async () => {
    const opts = { cfAccountId: 'cf-1', bucket: 'b1', key: 'k.bin' } as const;
    const g1 = await presignR2ObjectUrl(CREDS, { ...opts, method: 'GET' });
    const g2 = await presignR2ObjectUrl(CREDS, { ...opts, method: 'GET' });
    const p = await presignR2ObjectUrl(CREDS, { ...opts, method: 'PUT' });
    expect(g1).toBe(g2);
    expect(p).not.toBe(g1);
  });

  it('honors a custom expiry', async () => {
    const url = new URL(
      await presignR2ObjectUrl(CREDS, {
        cfAccountId: 'cf-1',
        bucket: 'b1',
        key: 'k',
        method: 'PUT',
        expiresSeconds: 60,
      }),
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
  });

  it('adds a signed response-content-disposition when downloadFilename is set', async () => {
    const base = { cfAccountId: 'cf-1', bucket: 'b1', key: 'docs/报告 v2.pdf', method: 'GET' } as const;
    const plain = new URL(await presignR2ObjectUrl(CREDS, base));
    const url = new URL(await presignR2ObjectUrl(CREDS, { ...base, downloadFilename: '报告 v2.pdf' }));
    expect(url.searchParams.get('response-content-disposition')).toBe(
      "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20v2.pdf",
    );
    expect(plain.searchParams.get('response-content-disposition')).toBeNull();
    // 参数进入规范化 URL 参与签名，两个 URL 的签名必然不同
    expect(url.searchParams.get('X-Amz-Signature')).not.toBe(plain.searchParams.get('X-Amz-Signature'));
  });

  it('keeps a plain-ASCII downloadFilename readable in the disposition param', async () => {
    const url = new URL(
      await presignR2ObjectUrl(CREDS, {
        cfAccountId: 'cf-1',
        bucket: 'b1',
        key: 'report.csv',
        method: 'GET',
        downloadFilename: 'report.csv',
      }),
    );
    expect(url.searchParams.get('response-content-disposition')).toBe("attachment; filename*=UTF-8''report.csv");
  });
});
