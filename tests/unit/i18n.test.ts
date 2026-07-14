import { describe, expect, it } from 'vitest';
import { LOCALES, resolveLocale, t } from '@/i18n';
import { localeFromPath, localizePath } from '@/i18n/routing';

describe('i18n routing', () => {
  it('derives locale from /en path prefix', () => {
    expect(localeFromPath('/')).toBe('zh');
    expect(localeFromPath('/zones')).toBe('zh');
    expect(localeFromPath('/en')).toBe('en');
    expect(localeFromPath('/en/zones/z1/dns')).toBe('en');
    expect(localeFromPath('/english')).toBe('zh');
  });

  it('localizes any path into the target locale tree', () => {
    expect(localizePath('en', '/')).toBe('/en');
    expect(localizePath('en', '/zones')).toBe('/en/zones');
    expect(localizePath('en', '/en/zones')).toBe('/en/zones');
    expect(localizePath('zh', '/en/zones')).toBe('/zones');
    expect(localizePath('zh', '/en')).toBe('/');
    expect(localizePath('zh', '/accounts')).toBe('/accounts');
  });
});

describe('i18n', () => {
  it('translates keys in both locales', () => {
    expect(t('zh', 'accounts.submit')).toBe('添加');
    expect(t('en', 'accounts.submit')).toBe('Add');
  });

  it('interpolates {n} params', () => {
    expect(t('en', 'zones.syncDone', { n: 3 })).toBe('Synced 3 zones');
    expect(t('zh', 'zones.syncDone', { n: 3 })).toContain('3');
  });

  it('zh and en dictionaries differ (en is actually translated)', () => {
    expect(t('en', 'zones.empty')).not.toBe(t('zh', 'zones.empty'));
  });

  it('resolveLocale prefers cookie, then accept-language, then zh', () => {
    expect(resolveLocale('en', null)).toBe('en');
    expect(resolveLocale('xx', 'en-US,en;q=0.9')).toBe('en');
    expect(resolveLocale(undefined, 'zh-CN,zh;q=0.9')).toBe('zh');
    expect(resolveLocale(undefined, null)).toBe('zh');
    expect(LOCALES).toEqual(['zh', 'en']);
  });
});
