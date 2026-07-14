import { describe, expect, it } from 'vitest';
import { pagesDevTarget } from '@/lib/pagesDevTarget';

describe('pagesDevTarget', () => {
  it('keeps a subdomain that already ends with .pages.dev', () => {
    expect(pagesDevTarget('my-proj.pages.dev', 'my-proj')).toBe('my-proj.pages.dev');
  });

  it('appends .pages.dev to a bare subdomain', () => {
    expect(pagesDevTarget('my-proj', 'my-proj')).toBe('my-proj.pages.dev');
  });

  it('falls back to <projectName>.pages.dev when subdomain is missing', () => {
    expect(pagesDevTarget(null, 'proj-a')).toBe('proj-a.pages.dev');
    expect(pagesDevTarget(undefined, 'proj-a')).toBe('proj-a.pages.dev');
    expect(pagesDevTarget('', 'proj-a')).toBe('proj-a.pages.dev');
  });
});
