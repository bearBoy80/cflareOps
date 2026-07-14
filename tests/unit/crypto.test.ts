import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, importEncryptionKey, sha256Hex } from '@/server/crypto';

const HEX_KEY = 'a'.repeat(64);

describe('crypto', () => {
  it('roundtrips encrypt/decrypt', async () => {
    const key = await importEncryptionKey(HEX_KEY);
    const payload = await encryptSecret('my-cf-token', key);
    expect(payload).toMatch(/^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(await decryptSecret(payload, key)).toBe('my-cf-token');
  });

  it('produces different ciphertext each time (random IV)', async () => {
    const key = await importEncryptionKey(HEX_KEY);
    expect(await encryptSecret('x', key)).not.toBe(await encryptSecret('x', key));
  });

  it('rejects invalid key format', async () => {
    await expect(importEncryptionKey('short')).rejects.toThrow('64 hex');
  });

  it('sha256Hex is deterministic', async () => {
    expect(await sha256Hex('abc')).toBe(await sha256Hex('abc'));
    expect(await sha256Hex('abc')).toHaveLength(64);
  });

  it('rejects payload with no dot separator', async () => {
    const key = await importEncryptionKey(HEX_KEY);
    await expect(decryptSecret('nodotpayload', key)).rejects.toThrow('invalid secret payload');
  });

  it('rejects payload with more than 2 segments', async () => {
    const key = await importEncryptionKey(HEX_KEY);
    await expect(decryptSecret('a.b.c', key)).rejects.toThrow('invalid secret payload');
  });

  it('rejects tampered ciphertext with failed decryption', async () => {
    const key = await importEncryptionKey(HEX_KEY);
    const payload = await encryptSecret('my-secret', key);
    const [iv, _] = payload.split('.');
    const tamperedPayload = `${iv}.dGFtcGVyZWRjaXBoZXJ0ZXh0aW5iYXNlNjQ=`;
    await expect(decryptSecret(tamperedPayload, key)).rejects.toThrow('failed to decrypt secret payload');
  });
});
