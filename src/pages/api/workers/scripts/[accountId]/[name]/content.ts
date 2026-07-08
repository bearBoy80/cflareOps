import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '../../../../../../server/context';
import { clientForAccount, getCachedWorkerScript } from '../../../../../../server/workersPages';

/** Worker 源码（懒加载，JSON：{ content, mainModule, multiModule, etag }）。owner 校验同详情路由：先查缓存行拿 cf_account_id。 */
export const GET: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const script = await getCachedWorkerScript(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!script || !script.cfAccountId) return jsonError('Script not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const content = await client.getWorkerScriptContent(script.cfAccountId, script.id);
    return Response.json(content);
  } catch (e) {
    return handleCfError(e);
  }
};

/**
 * 在线编辑保存：只更新代码（bindings/secrets 由 CF /content 端点保留），立即部署生产并产生新版本。
 * 服务端守卫：保存前重新拉取源码——多模块拒绝编辑；body.etag 与最新 etag 不符时 409（乐观锁）；
 * 入口文件名以服务端最新值为准，不信任客户端。
 */
export const PUT: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const script = await getCachedWorkerScript(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!script || !script.cfAccountId) return jsonError('Script not found', 404);
  const body = (await request.json().catch(() => null)) as { content?: unknown; etag?: unknown } | null;
  const content = typeof body?.content === 'string' ? body.content : '';
  const clientEtag = typeof body?.etag === 'string' ? body.etag : '';
  if (content === '') return jsonError('content is required', 400);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const fresh = await client.getWorkerScriptContent(script.cfAccountId, script.id);
    if (fresh.multiModule) return jsonError('multi-module workers are read-only', 400, 'multiModule');
    if (clientEtag !== '' && clientEtag !== fresh.etag) {
      return jsonError('script was updated elsewhere', 409, 'editConflict');
    }
    if (!fresh.mainModule) return jsonError('main module could not be determined', 400);
    const updated = await client.updateWorkerScriptContent(script.cfAccountId, script.id, fresh.mainModule, content);
    const etag = updated.etag ?? (await client.getWorkerScriptContent(script.cfAccountId, script.id)).etag;
    return Response.json({ ok: true, etag });
  } catch (e) {
    return handleCfError(e);
  }
};
