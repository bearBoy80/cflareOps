import { describe, expect, it } from 'vitest';
import { formatBytes } from '@/lib/formatBytes';

describe('formatBytes', () => {
  it('formats across units with one decimal', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(formatBytes(2 * 1024 ** 4)).toBe('2.0 TB');
  });
});
