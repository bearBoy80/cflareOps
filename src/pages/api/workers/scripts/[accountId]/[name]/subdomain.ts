import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '../../../../../../server/context';
import { clientForAccount, getCachedWorkerScript } from '../../../../../../server/workersPages';

/** workers.dev 子域名：GET 聚合账号子域名 + 脚本开关；PUT 切换开关（两布尔必填） */
export const GET: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const script = await getCachedWorkerScript(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!script || !script.cfAccountId) return jsonError('Script not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const [subdomain, flags] = await Promise.all([
      client.getWorkersSubdomain(script.cfAccountId),
      client.getWorkerScriptSubdomain(script.cfAccountId, script.id),
    ]);
    return Response.json({ subdomain, enabled: flags.enabled, previewsEnabled: flags.previews_enabled });
  } catch (e) {
    return handleCfError(e);
  }
};

export const PUT: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const script = await getCachedWorkerScript(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!script || !script.cfAccountId) return jsonError('Script not found', 404);
  const body = (await request.json().catch(() => null)) as { enabled?: unknown; previewsEnabled?: unknown } | null;
  if (typeof body?.enabled !== 'boolean' || typeof body?.previewsEnabled !== 'boolean') {
    return jsonError('enabled and previewsEnabled must be booleans', 400, 'invalidBody');
  }
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const updated = await client.setWorkerScriptSubdomain(
      script.cfAccountId,
      script.id,
      body.enabled,
      body.previewsEnabled,
    );
    return Response.json({ enabled: updated.enabled, previewsEnabled: updated.previews_enabled });
  } catch (e) {
    return handleCfError(e);
  }
};
