import type { APIRoute } from 'astro';
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
    await db
      .prepare('UPDATE d1_databases SET read_replication_mode = ? WHERE account_id = ? AND uuid = ?')
      .bind(mode, cached.accountId, cached.uuid)
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
    await client.deleteD1Database(cached.cfAccountId, cached.uuid);
    await db
      .prepare('DELETE FROM d1_databases WHERE account_id = ? AND uuid = ?')
      .bind(cached.accountId, cached.uuid)
      .run();
    return Response.json({ ok: true });
  } catch (e) {
    return handleCfError(e);
  }
};
