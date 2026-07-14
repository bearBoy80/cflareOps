import { describe, expect, it } from 'vitest';
import { relativeTime } from '@/lib/time';

describe('relativeTime', () => {
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago

  it('returns empty string for null input', () => {
    expect(relativeTime(null, 'zh')).toBe('');
    expect(relativeTime(null, 'en')).toBe('');
  });

  it('formats Chinese relative time (contains 前)', () => {
    expect(relativeTime(past, 'zh')).toContain('前');
  });

  it('formats English relative time (contains ago)', () => {
    expect(relativeTime(past, 'en')).toContain('ago');
  });
});
