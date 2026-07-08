import { CfApiError } from './cf/client';
import { importEncryptionKey } from './crypto';
import type { Db } from './db/types';

/** 资源在当前用户可见范围内不存在（跨用户访问或缓存缺失），API 层统一映射为 404。 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * 部署环境未配置好（缺 DB 绑定 / ENCRYPTION_KEY 缺失或非法等）导致 appContext 无法建立。
 * code 为稳定机器码，前端据此展示可操作的诊断文案，避免部署后一律看到不透明 500。
 */
export class ConfigError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** D1 表不存在（未跑迁移）时 D1 抛错的信息形态，wrangler / workerd 均含 "no such table" 子串。 */
function isMissingTableError(e: unknown): boolean {
  return e instanceof Error && /no such table/i.test(e.message);
}

/**
 * API 层未被路由自身捕获的异常 → 带稳定 code 的结构化 JSON（由中间件错误边界统一调用）。
 * 把部署配置问题（ConfigError / 未迁移）与其他内部错误区分开，让前端能给出可操作提示。
 */
export function apiErrorResponse(e: unknown): Response {
  if (e instanceof ConfigError) return jsonError(e.message, 500, `config.${e.code}`);
  if (isMissingTableError(e)) {
    return jsonError('Database tables missing — run D1 migrations', 500, 'config.dbNotMigrated');
  }
  return jsonError(e instanceof Error ? e.message : 'Internal Server Error', 500, 'internal');
}

/** DNS 等透传 Cloudflare API 的路由共用的错误映射：CF 4xx 原样、5xx 归 502、NotFound 归 404。 */
export function handleCfError(e: unknown): Response {
  if (e instanceof CfApiError) return jsonError(e.message, e.status >= 400 && e.status < 500 ? e.status : 502);
  if (e instanceof NotFoundError) return jsonError(e.message, 404);
  throw e;
}

export async function appContext(locals: App.Locals): Promise<{ db: Db; key: CryptoKey; userEmail: string }> {
  const env = locals.runtime.env;
  // 部署后常见的“配置没配全”场景：给出可定位的 code，而不是让下游抛不透明 500。
  if (!env.DB) {
    throw new ConfigError('D1 database binding "DB" is missing', 'dbBindingMissing');
  }
  if (!env.ENCRYPTION_KEY) {
    throw new ConfigError('ENCRYPTION_KEY is not set', 'encryptionKeyMissing');
  }
  let key: CryptoKey;
  try {
    key = await importEncryptionKey(env.ENCRYPTION_KEY);
  } catch {
    throw new ConfigError('ENCRYPTION_KEY must be 64 hex chars (256-bit)', 'encryptionKeyInvalid');
  }
  return {
    db: env.DB as unknown as Db,
    key,
    userEmail: locals.userEmail,
  };
}

/** code 为稳定的机器可读错误码，前端据此映射本地化文案；error 保留英文详情作回退。 */
export function jsonError(message: string, status: number, code?: string): Response {
  return Response.json(code ? { error: message, code } : { error: message }, { status });
}
