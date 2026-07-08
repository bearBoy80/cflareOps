import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '../../../../../../../../server/context';
import { clientForAccount, getCachedPagesProject } from '../../../../../../../../server/workersPages';

/** Pages 部署构建日志。 */
export const GET: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const cached = await getCachedPagesProject(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!cached || !cached.cfAccountId) return jsonError('Project not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const { lines, total } = await client.getPagesDeploymentLogs(cached.cfAccountId, cached.name, params.deploymentId!);
    return Response.json({ lines, total });
  } catch (e) {
    return handleCfError(e);
  }
};
