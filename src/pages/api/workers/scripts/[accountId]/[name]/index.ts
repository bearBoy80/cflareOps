import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '../../../../../../server/context';
import { clientForAccount, getCachedWorkerScript } from '../../../../../../server/workersPages';

export const GET: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  // 同名脚本可在多个 CF 账号并存，cfAccountId 查询参数用于精确定位
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const script = await getCachedWorkerScript(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!script || !script.cfAccountId) return jsonError('Script not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const [crons, allDomains] = await Promise.all([
      client.listWorkerCrons(script.cfAccountId, script.id),
      client.listWorkerDomains(script.cfAccountId),
    ]);
    const domains = allDomains.filter((d) => d.service === script.id);
    return Response.json({ script, crons, domains });
  } catch (e) {
    return handleCfError(e);
  }
};
