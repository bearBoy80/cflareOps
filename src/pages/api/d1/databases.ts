import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { listCachedD1Databases, syncD1Databases } from '@/server/d1';
import { clientForAccount } from '@/server/workersPages';

export const GET: APIRoute = async ({ locals, request }) => {
  const { db, userEmail } = await appContext(locals);
  const url = new URL(request.url);
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
  const search = url.searchParams.get('search') ?? '';
  return Response.json(await listCachedD1Databases(db, userEmail, { page, pageSize, search }));
};

/** D1 库名规则:1-63 位小写字母/数字/连字符/下划线,首字符为字母或数字 */
const DB_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const LOCATION_HINTS = new Set(['wnam', 'enam', 'weur', 'eeur', 'apac', 'oc']);

export const POST: APIRoute = async ({ locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const body = (await request.json().catch(() => null)) as {
    accountId?: unknown;
    cfAccountId?: unknown;
    name?: unknown;
    primaryLocationHint?: unknown;
  } | null;
  const accountId = typeof body?.accountId === 'string' ? body.accountId : '';
  const cfAccountId = typeof body?.cfAccountId === 'string' ? body.cfAccountId : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const hint = typeof body?.primaryLocationHint === 'string' ? body.primaryLocationHint : '';
  if (!accountId || !cfAccountId) return jsonError('accountId and cfAccountId are required', 400);
  if (!DB_NAME_RE.test(name)) return jsonError('invalid database name', 400, 'invalidDatabaseName');
  if (hint && !LOCATION_HINTS.has(hint)) return jsonError('invalid location hint', 400);
  try {
    const client = await clientForAccount(db, key, userEmail, accountId);
    const database = await client.createD1Database(cfAccountId, {
      name,
      ...(hint ? { primaryLocationHint: hint } : {}),
    });
    // 创建成功后单账号增量同步刷新缓存;失败不致命(下次手动同步会补上)
    try {
      await syncD1Databases(db, key, userEmail, undefined, accountId);
    } catch {
      // 缓存刷新失败不影响创建结果
    }
    return Response.json({ database });
  } catch (e) {
    return handleCfError(e);
  }
};
