import type { APIRoute } from 'astro';
import { isOAuthEnabled } from '@/server/cf/oauth';
import { runtimeEnv } from '@/server/env';

/** 前端能力探测:是否配置了「用 Cloudflare 授权」。不泄露 client_id 等细节。 */
export const GET: APIRoute = async ({ locals }) => {
  const env = runtimeEnv(locals);
  return Response.json({ enabled: isOAuthEnabled(env) });
};
