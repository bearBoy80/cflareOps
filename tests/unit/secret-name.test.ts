import { describe, expect, it } from 'vitest';
import { isSecretName, SECRET_NAME_RE } from '../../src/lib/secretName';

describe('isSecretName', () => {
  it('accepts letter/underscore-leading identifiers', () => {
    expect(isSecretName('API_KEY')).toBe(true);
    expect(isSecretName('_hidden')).toBe(true);
    expect(isSecretName('k1')).toBe(true);
  });

  it('rejects digit-leading, empty and non-identifier names', () => {
    expect(isSecretName('1bad')).toBe(false);
    expect(isSecretName('')).toBe(false);
    expect(isSecretName('has space')).toBe(false);
    expect(isSecretName('dash-ed')).toBe(false);
  });

  it('exports the regex for reuse', () => {
    expect(SECRET_NAME_RE.test('API_KEY')).toBe(true);
  });
});
