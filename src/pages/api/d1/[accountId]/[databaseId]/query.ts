import type { APIRoute } from 'astro';
import { CfApiError } from '@/server/cf/client';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { getCachedD1Database } from '@/server/d1';
import { clientForAccount } from '@/server/workersPages';

/** 单结果集最大返回行数:超出截断并标记 truncated(防超大 SELECT 撑爆响应/前端) */
const MAX_ROWS = 1000;
/** SQL 文本长度上限(字符):防误粘贴整个 dump */
const MAX_SQL_LEN = 50_000;

export const POST: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const body = (await request.json().catch(() => null)) as { sql?: unknown; params?: unknown } | null;
  const sql = typeof body?.sql === 'string' ? body.sql.trim() : '';
  if (!sql) return jsonError('sql is required', 400);
  if (sql.length > MAX_SQL_LEN) return jsonError('sql too long', 400);
  // params 若提供必须是纯字符串数组;混入非字符串元素此前被静默 filter 掉,会让调用方误以为参数按位置传入
  let bindParams: string[] = [];
  if (body?.params !== undefined) {
    if (!Array.isArray(body.params) || !body.params.every((p): p is string => typeof p === 'string')) {
      return jsonError('params must be an array of strings', 400);
    }
    bindParams = body.params;
  }
  const cached = await getCachedD1Database(db, userEmail, params.accountId!, params.databaseId!);
  if (!cached) return jsonError('Database not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const results = await client.queryD1Raw(cached.cfAccountId, cached.uuid, sql, bindParams);
    return Response.json({
      results: results.map((r) => ({
        columns: r.columns,
        rows: r.rows.slice(0, MAX_ROWS),
        meta: r.meta,
        truncated: r.rows.length > MAX_ROWS,
      })),
    });
  } catch (e) {
    // CF 对 SQL 语法/运行时错误返回 400(7500 系列):不是异常路径,以 200 + error 字段
    // 交给前端展示在结果区;401/403(权限)等仍走 HTTP 错误由前端 toast
    if (e instanceof CfApiError && e.status === 400) {
      return Response.json({ error: { message: e.message } });
    }
    return handleCfError(e);
  }
};
