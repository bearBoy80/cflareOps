import { describe, expect, it } from 'vitest';
import { ACCOUNT_HUES, accountColor } from '@/lib/accountColor';

describe('accountColor', () => {
  it('is deterministic for the same id', () => {
    expect(accountColor('acct-1')).toBe(accountColor('acct-1'));
  });

  it('always returns a palette color', () => {
    for (const id of ['a', 'b', 'c', crypto.randomUUID()]) {
      expect(ACCOUNT_HUES).toContain(accountColor(id));
    }
  });
});
