import { describe, expect, it } from 'vitest';
import { resolveTabParam } from '@/lib/tabParam';

const KEYS = ['overview', 'config', 'deploys', 'source'] as const;

describe('resolveTabParam', () => {
  it('合法值原样返回', () => {
    expect(resolveTabParam('config', KEYS)).toBe('config');
    expect(resolveTabParam('source', KEYS)).toBe('source');
  });

  it('null / undefined 回落第一个 key', () => {
    expect(resolveTabParam(null, KEYS)).toBe('overview');
    expect(resolveTabParam(undefined, KEYS)).toBe('overview');
  });

  it('非法值回落第一个 key', () => {
    expect(resolveTabParam('nope', KEYS)).toBe('overview');
    expect(resolveTabParam('OVERVIEW', KEYS)).toBe('overview');
  });

  it('空字符串回落第一个 key', () => {
    expect(resolveTabParam('', KEYS)).toBe('overview');
  });
});
