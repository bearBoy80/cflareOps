import { describe, expect, it } from 'vitest';
import { quoteIdent } from '@/lib/sqlIdent';

describe('quoteIdent', () => {
  it('普通名原样包裹双引号', () => {
    expect(quoteIdent('users')).toBe('"users"');
  });

  it('含双引号翻倍转义', () => {
    expect(quoteIdent('weird"name')).toBe('"weird""name"');
  });

  it('含单引号原样包裹(不转义单引号)', () => {
    expect(quoteIdent("o'brien")).toBe(`"o'brien"`);
  });

  it('含空格原样包裹', () => {
    expect(quoteIdent('my table')).toBe('"my table"');
  });
});
