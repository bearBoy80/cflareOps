import type { APIRoute } from 'astro';
import { isHostname } from '../../../../../../lib/dnsRecordValidation';
import { pagesDevTarget } from '../../../../../../lib/pagesDevTarget';
import { appContext, handleCfError, jsonError } from '../../../../../../server/context';
import { clientForAccount, createPagesDnsRecord, getCachedPagesProject } from '../../../../../../server/workersPages';

export const GET: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const cached = await getCachedPagesProject(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!cached || !cached.cfAccountId) return jsonError('Project not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const domains = await client.listPagesDomains(cached.cfAccountId, cached.name);
    return Response.json({ domains });
  } catch (e) {
    return handleCfError(e);
  }
};

/**
 * 添加自定义域，可选联动创建 CNAME → <subdomain>.pages.dev。
 * DNS 创建失败不回滚域名添加（createPagesDnsRecord 以返回值分字段报告），响应 { domain, dns }。
 */
export const POST: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const cached = await getCachedPagesProject(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!cached || !cached.cfAccountId) return jsonError('Project not found', 404);
  const body = (await request.json().catch(() => null)) as { domain?: unknown; createDns?: unknown } | null;
  const domain = typeof body?.domain === 'string' ? body.domain : '';
  if (!isHostname(domain)) return jsonError('invalid hostname', 400, 'invalidHostname');
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const added = await client.addPagesDomain(cached.cfAccountId, cached.name, domain);
    let dns: Awaited<ReturnType<typeof createPagesDnsRecord>> | null = null;
    if (body?.createDns) {
      const target = pagesDevTarget(cached.subdomain, cached.name);
      dns = await createPagesDnsRecord(db, key, userEmail, { hostname: domain, target });
    }
    return Response.json({ domain: added, dns });
  } catch (e) {
    return handleCfError(e);
  }
};
