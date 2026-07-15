import { describe, expect, it } from 'vitest';
import { renderBody } from '@/server/email/render';

describe('renderBody', () => {
  it('markdown renders html and keeps raw markdown as the text fallback', () => {
    const src = '# Hi\n\n- a\n- b';
    const r = renderBody('markdown', src);
    expect(r.html).toContain('<h1');
    expect(r.html).toContain('<li>a</li>');
    expect(r.text).toBe(src);
  });

  it('markdown supports GFM tables', () => {
    const r = renderBody('markdown', '| a | b |\n| - | - |\n| 1 | 2 |');
    expect(r.html).toContain('<table>');
    expect(r.html).toContain('<td>1</td>');
  });

  it('html passes through unchanged with no text part', () => {
    const r = renderBody('html', '<p>hi</p>');
    expect(r.html).toBe('<p>hi</p>');
    expect(r.text).toBeUndefined();
  });

  it('text passes through unchanged with no html part', () => {
    const r = renderBody('text', 'plain body');
    expect(r.text).toBe('plain body');
    expect(r.html).toBeUndefined();
  });
});
