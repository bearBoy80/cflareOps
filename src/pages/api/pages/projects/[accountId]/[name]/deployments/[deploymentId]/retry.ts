import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { clientForAccount, getCachedPagesProject } from '@/server/workersPages';

/** 重试部署（需要 token 具备 Pages:Edit，403 由 handleCfError 透出可读错误）。 */
export const POST: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const cached = await getCachedPagesProject(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!cached || !cached.cfAccountId) return jsonError('Project not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const deployment = await client.retryPagesDeployment(cached.cfAccountId, cached.name, params.deploymentId!);
    return Response.json({ deployment });
  } catch (e) {
    return handleCfError(e);
  }
};
