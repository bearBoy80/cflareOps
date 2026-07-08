import type { APIRoute } from 'astro';
import { COMPAT_DATE_RE, parseBindingInputs, toSdkBindings } from '../../../../../../lib/workerSettingsEdit';
import { appContext, handleCfError, jsonError } from '../../../../../../server/context';
import { clientForAccount, getCachedWorkerScript } from '../../../../../../server/workersPages';

/**
 * 编辑绑定与配置（PUT 路由，透传至 CF 的 PATCH /settings，即 scriptAndVersionSettings.edit）。bindings 为整组替换语义：
 * 前端把保留的现有绑定以 {kind:'inherit', name} 传入（含 secret_text），漏传即删除。
 */
export const PUT: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const script = await getCachedWorkerScript(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!script || !script.cfAccountId) return jsonError('Script not found', 404);

  const body = (await request.json().catch(() => null)) as {
    compatibilityDate?: unknown;
    compatibilityFlags?: unknown;
    bindings?: unknown;
  } | null;
  if (!body || !Array.isArray(body.bindings)) {
    return jsonError('bindings must be an array', 400, 'invalidBody');
  }
  if (
    body.compatibilityDate !== undefined &&
    (typeof body.compatibilityDate !== 'string' || !COMPAT_DATE_RE.test(body.compatibilityDate))
  ) {
    return jsonError('compatibilityDate must be YYYY-MM-DD', 400, 'invalidCompatDate');
  }
  if (
    body.compatibilityFlags !== undefined &&
    !(
      Array.isArray(body.compatibilityFlags) && body.compatibilityFlags.every((f): f is string => typeof f === 'string')
    )
  ) {
    return jsonError('compatibilityFlags must be an array of strings', 400, 'invalidBody');
  }
  const bindings = parseBindingInputs(body.bindings);
  if (!bindings) return jsonError('invalid binding entry', 400, 'invalidBinding');

  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const settings = await client.updateWorkerScriptSettings(script.cfAccountId, script.id, {
      bindings: toSdkBindings(bindings),
      ...(body.compatibilityDate !== undefined ? { compatibility_date: body.compatibilityDate as string } : {}),
      ...(body.compatibilityFlags !== undefined ? { compatibility_flags: body.compatibilityFlags as string[] } : {}),
    });
    const { raw: _raw, ...rest } = settings;
    return Response.json({ settings: rest });
  } catch (e) {
    return handleCfError(e);
  }
};
