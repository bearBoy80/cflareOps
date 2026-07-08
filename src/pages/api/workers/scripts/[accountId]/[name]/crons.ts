import type { APIRoute } from 'astro';
import { validateCrons } from '../../../../../../lib/cronValidation';
import { appContext, handleCfError, jsonError } from '../../../../../../server/context';
import { clientForAccount, getCachedWorkerScript } from '../../../../../../server/workersPages';

/** 整组替换 cron 触发器。服务端做 5 段 cron 预检（CF 侧是权威校验）。 */
export const PUT: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const script = await getCachedWorkerScript(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!script || !script.cfAccountId) return jsonError('Script not found', 404);
  const body = (await request.json().catch(() => null)) as { crons?: unknown } | null;
  const crons = body?.crons;
  if (!Array.isArray(crons) || !crons.every((c): c is string => typeof c === 'string')) {
    return jsonError('crons must be an array of strings', 400);
  }
  const invalid = validateCrons(crons);
  if (invalid.length > 0) {
    return jsonError(`invalid cron expression at index ${invalid[0]}`, 400, 'invalidCron');
  }
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const updated = await client.updateWorkerCrons(script.cfAccountId, script.id, crons);
    return Response.json({ crons: updated });
  } catch (e) {
    return handleCfError(e);
  }
};
