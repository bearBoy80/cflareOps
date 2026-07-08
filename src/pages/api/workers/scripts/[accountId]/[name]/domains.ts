import type { APIRoute } from 'astro';
import { isHostname } from '../../../../../../lib/dnsRecordValidation';
import { appContext, handleCfError, jsonError } from '../../../../../../server/context';
import { clientForAccount, findZoneForHostname, getCachedWorkerScript } from '../../../../../../server/workersPages';

/** 挂载 Worker 自定义域：hostname 必须落在脚本所属 CF 账号已聚合的某个 zone 内（跨 CF 账号 zone_id 会被 CF 拒绝）。 */
export const POST: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const script = await getCachedWorkerScript(db, userEmail, params.accountId!, params.name!, cfAccountId);
  if (!script || !script.cfAccountId) return jsonError('Script not found', 404);
  const body = (await request.json().catch(() => null)) as { hostname?: unknown } | null;
  const hostname = typeof body?.hostname === 'string' ? body.hostname : '';
  if (!isHostname(hostname)) return jsonError('invalid hostname', 400, 'invalidHostname');
  const zone = await findZoneForHostname(db, userEmail, hostname, script.cfAccountId);
  if (!zone) return jsonError('hostname is not in any aggregated zone', 400, 'zoneNotFound');
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const domain = await client.attachWorkerDomain(script.cfAccountId, {
      hostname,
      service: script.id,
      zoneId: zone.zoneId,
    });
    return Response.json({ domain });
  } catch (e) {
    return handleCfError(e);
  }
};
