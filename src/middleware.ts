import { defineMiddleware, sequence } from 'astro:middleware';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { localeMiddleware } from './i18n/middleware';
import { shouldBypassAuth } from './server/auth';
import { apiErrorResponse } from './server/context';

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

// 最外层错误边界：把 API 路由未捕获的异常（部署未配好、DB 未迁移等）转成带 code 的
// 结构化 JSON，让前端能展示可操作的诊断信息，而不是浏览器里的不透明 500。页面路由的
// 异常仍交给 Astro 默认处理。
const errorBoundary = defineMiddleware(async (context, next) => {
  try {
    return await next();
  } catch (e) {
    if (context.url.pathname.startsWith('/api/')) {
      console.error('[api] unhandled error:', e instanceof Error ? (e.stack ?? e.message) : e);
      return apiErrorResponse(e);
    }
    throw e;
  }
});

const accessMiddleware = defineMiddleware(async (context, next) => {
  const env = context.locals.runtime.env;
  if (shouldBypassAuth(env)) {
    console.warn('[auth] DEV_MODE bypass active — do not use in production');
    context.locals.userEmail = env.DEV_USER_EMAIL ?? 'dev@localhost';
    return next();
  }

  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;
  if (!teamDomain || !aud) {
    return new Response('Cloudflare Access not configured (missing CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD)', {
      status: 500,
    });
  }

  const jwt = context.request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return new Response('Unauthorized', { status: 403 });

  try {
    let jwks = jwksCache.get(teamDomain);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
      jwksCache.set(teamDomain, jwks);
    }
    const { payload } = await jwtVerify(jwt, jwks, { audience: aud, issuer: `https://${teamDomain}` });
    if (typeof payload.email !== 'string' || payload.email.length === 0) {
      return new Response('Unauthorized', { status: 403 });
    }
    context.locals.userEmail = payload.email;
    return next();
  } catch (e) {
    console.warn('[auth] Access JWT verification failed:', e instanceof Error ? e.message : e);
    return new Response('Unauthorized', { status: 403 });
  }
});

export const onRequest = sequence(errorBoundary, accessMiddleware, localeMiddleware);
