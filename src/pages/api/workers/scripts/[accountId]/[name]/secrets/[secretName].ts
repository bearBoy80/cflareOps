import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '../../../../../../../server/context';
import { clientForAccount, getCachedWorkerScript } from '../../../../../../../server/workersPages';

export const DELETE: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const script = await getCachedWorkerScript(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!script || !script.cfAccountId) return jsonError('Script not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    await client.deleteWorkerSecret(script.cfAccountId, script.id, params.secretName!);
    return new Response(null, { status: 204 });
  } catch (e) {
    return handleCfError(e);
  }
};
