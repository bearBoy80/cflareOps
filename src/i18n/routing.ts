import { DEFAULT_LOCALE, type Locale } from './index';

/** recipe 中的 getLangFromUrl：/en 前缀 → 'en'，否则默认语言 */
export function localeFromPath(pathname: string): Locale {
  return pathname === '/en' || pathname.startsWith('/en/') ? 'en' : DEFAULT_LOCALE;
}

/** recipe 中的 useTranslatedPath：把任意路径转换到目标语言树（默认语言隐藏前缀） */
export function localizePath(locale: Locale, pathname: string): string {
  const bare = pathname === '/en' ? '/' : pathname.startsWith('/en/') ? pathname.slice(3) : pathname;
  if (locale === 'en') return bare === '/' ? '/en' : `/en${bare}`;
  return bare;
}
