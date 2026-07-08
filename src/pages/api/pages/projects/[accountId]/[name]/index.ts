import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '../../../../../../server/context';
import { clientForAccount, getCachedPagesProject } from '../../../../../../server/workersPages';

export const GET: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const cached = await getCachedPagesProject(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!cached || !cached.cfAccountId) return jsonError('Project not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const [project, deployments] = await Promise.all([
      client.getPagesProject(cached.cfAccountId, cached.name),
      client.listPagesDeployments(cached.cfAccountId, cached.name),
    ]);
    return Response.json({ project, deployments });
  } catch (e) {
    return handleCfError(e);
  }
};
