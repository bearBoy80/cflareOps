const encoder = new TextEncoder();
const decoder = new TextDecoder();

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function importEncryptionKey(hex: string): Promise<CryptoKey> {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('ENCRYPTION_KEY must be 64 hex chars (256-bit)');
  return crypto.subtle.importKey('raw', hexToBytes(hex), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plain: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plain) as Uint8Array<ArrayBuffer>),
  );
  return `${toBase64(iv)}.${toBase64(ct)}`;
}

export async function decryptSecret(payload: string, key: CryptoKey): Promise<string> {
  const parts = payload.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('invalid secret payload');
  const [ivB64, ctB64] = parts;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(ivB64) }, key, fromBase64(ctB64));
    return decoder.decode(plain);
  } catch {
    throw new Error('failed to decrypt secret payload');
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(input) as Uint8Array<ArrayBuffer>),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
