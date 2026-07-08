import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '../../../../../../server/context';
import { clientForAccount, getCachedWorkerScript } from '../../../../../../server/workersPages';

function reasonMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Worker 绑定/版本/部署历史。三个 CF 调用并行（allSettled）：单项失败降级为
 * null/[] 并把消息收进 errors[]；三项全失败才整体走 handleCfError（取第一个失败原因）。
 */
export const GET: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const script = await getCachedWorkerScript(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!script || !script.cfAccountId) return jsonError('Script not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const [settingsRes, versionsRes, deploymentsRes] = await Promise.allSettled([
      client.getWorkerScriptSettings(script.cfAccountId, script.id),
      client.listWorkerVersions(script.cfAccountId, script.id),
      client.listWorkerDeployments(script.cfAccountId, script.id),
    ]);
    if (
      settingsRes.status === 'rejected' &&
      versionsRes.status === 'rejected' &&
      deploymentsRes.status === 'rejected'
    ) {
      throw settingsRes.reason;
    }
    const errors: string[] = [];
    const settings = settingsRes.status === 'fulfilled' ? settingsRes.value : null;
    if (settingsRes.status === 'rejected') errors.push(reasonMessage(settingsRes.reason));
    const versions = versionsRes.status === 'fulfilled' ? versionsRes.value : [];
    if (versionsRes.status === 'rejected') errors.push(reasonMessage(versionsRes.reason));
    const deployments = deploymentsRes.status === 'fulfilled' ? deploymentsRes.value : [];
    if (deploymentsRes.status === 'rejected') errors.push(reasonMessage(deploymentsRes.reason));
    return Response.json({ settings, versions, deployments, errors });
  } catch (e) {
    return handleCfError(e);
  }
};
