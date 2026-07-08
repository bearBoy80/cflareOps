import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '../../../../../../../server/context';
import { clientForAccount, getCachedPagesProject } from '../../../../../../../server/workersPages';

export const DELETE: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const cached = await getCachedPagesProject(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!cached || !cached.cfAccountId) return jsonError('Project not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    await client.deletePagesDomain(cached.cfAccountId, cached.name, params.domain!);
    return new Response(null, { status: 204 });
  } catch (e) {
    return handleCfError(e);
  }
};
