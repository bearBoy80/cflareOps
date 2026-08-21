import { env as cloudflareEnv } from 'cloudflare:workers';

/**
 * Astro 7 / Cloudflare adapter 14 移除了 locals.runtime.env，生产环境使用官方
 * cloudflare:workers 全局绑定。单元测试仍可在 locals 上注入自有 runtime.env。
 * 读取属性描述符是为了避开新版 adapter 为旧 API 安装的“访问即抛错”兼容 getter。
 */
export function runtimeEnv(locals: App.Locals): Env {
  const runtime = Object.getOwnPropertyDescriptor(locals, 'runtime')?.value as { env?: Env } | undefined;
  const injected = runtime ? Object.getOwnPropertyDescriptor(runtime, 'env')?.value : undefined;
  return injected ?? (cloudflareEnv as Env);
}
