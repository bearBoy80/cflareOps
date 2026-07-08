import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '../../../../../../../../server/context';
import { clientForAccount, getCachedPagesProject } from '../../../../../../../../server/workersPages';

/** 重新触发域名验证（domains.edit 语义）。 */
export const POST: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const cached = await getCachedPagesProject(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!cached || !cached.cfAccountId) return jsonError('Project not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const domain = await client.retryPagesDomain(cached.cfAccountId, cached.name, params.domain!);
    return Response.json({ domain });
  } catch (e) {
    return handleCfError(e);
  }
};
