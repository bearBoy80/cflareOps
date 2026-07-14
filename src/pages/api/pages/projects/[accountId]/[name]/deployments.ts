import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { clientForAccount, getCachedPagesProject } from '@/server/workersPages';

function intParam(raw: string | null, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Pages 部署分页列表：page 默认 1，pageSize 默认 10 且 clamp 1..25。 */
export const GET: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const url = new URL(request.url);
  const cfAccountId = url.searchParams.get('cfAccountId') ?? undefined;
  const page = Math.max(1, intParam(url.searchParams.get('page'), 1));
  const pageSize = Math.min(25, Math.max(1, intParam(url.searchParams.get('pageSize'), 10)));
  const cached = await getCachedPagesProject(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!cached || !cached.cfAccountId) return jsonError('Project not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const { deployments, totalCount } = await client.listPagesDeploymentsPage(
      cached.cfAccountId,
      cached.name,
      page,
      pageSize,
    );
    return Response.json({ deployments, total: totalCount, page, pageSize });
  } catch (e) {
    return handleCfError(e);
  }
};

/** 触发新部署：可选 body { branch }，不传用项目生产分支。 */
export const POST: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const cached = await getCachedPagesProject(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!cached || !cached.cfAccountId) return jsonError('Project not found', 404);
  const body = (await request.json().catch(() => null)) as { branch?: unknown } | null;
  const branch = typeof body?.branch === 'string' && body.branch !== '' ? body.branch : undefined;
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const deployment = await client.createPagesDeployment(cached.cfAccountId, cached.name, branch);
    return Response.json({ deployment });
  } catch (e) {
    return handleCfError(e);
  }
};
