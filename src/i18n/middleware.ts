import { defineMiddleware } from 'astro:middleware';
import { resolveLocale } from './index';
import { localeFromPath, localizePath } from './routing';

const COOKIE = 'locale';
const COOKIE_OPTS = { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' as const };

export const localeMiddleware = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;
  if (pathname.startsWith('/api/') || pathname.startsWith('/_')) return next();

  const pathLocale = localeFromPath(pathname);
  const cookie = context.cookies.get(COOKIE)?.value;

  // 首访（无 cookie）且在默认语言树：按 Accept-Language 跳转到 /en
  if (!cookie && pathLocale === 'zh' && context.request.method === 'GET') {
    const preferred = resolveLocale(undefined, context.request.headers.get('accept-language'));
    if (preferred === 'en') {
      context.cookies.set(COOKIE, 'en', COOKIE_OPTS);
      return context.redirect(localizePath('en', pathname), 302);
    }
  }

  // 记住当前所在语言树（手动切换后不再自动跳转）
  if (cookie !== pathLocale) context.cookies.set(COOKIE, pathLocale, COOKIE_OPTS);
  return next();
});
