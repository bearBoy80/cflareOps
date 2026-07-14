import type { APIRoute } from 'astro';
import { isSecretName } from '@/lib/secretName';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { clientForAccount, getCachedWorkerScript } from '@/server/workersPages';

/** Secrets 列表（只有 name/type，值不可读取）。 */
export const GET: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const script = await getCachedWorkerScript(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!script || !script.cfAccountId) return jsonError('Script not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const secrets = await client.listWorkerSecrets(script.cfAccountId, script.id);
    return Response.json({ secrets });
  } catch (e) {
    return handleCfError(e);
  }
};

/** 新增或覆盖 secret（type 固定 secret_text，值只写不回显）。 */
export const PUT: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const script = await getCachedWorkerScript(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!script || !script.cfAccountId) return jsonError('Script not found', 404);
  const body = (await request.json().catch(() => null)) as { name?: unknown; text?: unknown } | null;
  const name = typeof body?.name === 'string' ? body.name : '';
  const text = typeof body?.text === 'string' ? body.text : '';
  if (!isSecretName(name)) return jsonError('invalid secret name', 400, 'invalidSecretName');
  if (text === '') return jsonError('text is required', 400);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    await client.putWorkerSecret(script.cfAccountId, script.id, name, text);
    return Response.json({ ok: true });
  } catch (e) {
    return handleCfError(e);
  }
};
