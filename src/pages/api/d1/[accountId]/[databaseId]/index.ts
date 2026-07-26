import type { APIRoute } from 'astro';
import { CfApiError } from '@/server/cf/client';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { getCachedD1Database } from '@/server/d1';
import { clientForAccount } from '@/server/workersPages';

/** 实时详情:cfAccountId 从缓存行取(uuid 全局唯一,无需 query 参数);缓存缺失(未同步过)→ 404 */
export const GET: APIRoute = async ({ params, locals }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cached = await getCachedD1Database(db, userEmail, params.accountId!, params.databaseId!);
  if (!cached) return jsonError('Database not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const database = await client.getD1Database(cached.cfAccountId, cached.uuid);
    return Response.json({ database });
  } catch (e) {
    return handleCfError(e);
  }
};

export const PATCH: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const body = (await request.json().catch(() => null)) as { mode?: unknown } | null;
  const mode = body?.mode;
  if (mode !== 'auto' && mode !== 'disabled') return jsonError('mode must be "auto" or "disabled"', 400);
  const cached = await getCachedD1Database(db, userEmail, params.accountId!, params.databaseId!);
  if (!cached) return jsonError('Database not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const database = await client.editD1DatabaseReplication(cached.cfAccountId, cached.uuid, mode);
    // raw_json/synced_at 一并更新,避免缓存行的平铺列与 raw_json 内容互相矛盾
    await db
      .prepare(
        `UPDATE d1_databases SET read_replication_mode = ?, raw_json = json_patch(raw_json, ?), synced_at = ?
         WHERE account_id = ? AND uuid = ?`,
      )
      .bind(
        mode,
        JSON.stringify({ read_replication: { mode } }),
        new Date().toISOString(),
        cached.accountId,
        cached.uuid,
      )
      .run();
    return Response.json({ database });
  } catch (e) {
    return handleCfError(e);
  }
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cached = await getCachedD1Database(db, userEmail, params.accountId!, params.databaseId!);
  if (!cached) return jsonError('Database not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    try {
      await client.deleteD1Database(cached.cfAccountId, cached.uuid);
    } catch (e) {
      // 远端已不存在(别处删过):按删除成功处理,仍清缓存行——否则该行只能靠全量同步才能消掉,重试永远 404
      if (!(e instanceof CfApiError && e.status === 404)) throw e;
    }
    await db
      .prepare('DELETE FROM d1_databases WHERE account_id = ? AND uuid = ?')
      .bind(cached.accountId, cached.uuid)
      .run();
    return Response.json({ ok: true });
  } catch (e) {
    return handleCfError(e);
  }
};
