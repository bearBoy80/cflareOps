import type { APIRoute } from 'astro';
import { isHostname } from '@/lib/dnsRecordValidation';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { getCachedR2Bucket } from '@/server/r2';
import { clientForAccount, findZoneForHostname } from '@/server/workersPages';

export const GET: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const bucket = await getCachedR2Bucket(db, userEmail, params.accountId!, params.bucket!, cfAccountId);
  if (!bucket) return jsonError('Bucket not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    // r2.dev 状态与自定义域一次带回；managed 接口在个别账号态可能报错 → 降级 null 不破坏整卡
    const custom = await client.listR2CustomDomains(bucket.cfAccountId, bucket.name);
    let managed = null;
    try {
      managed = await client.getR2ManagedDomain(bucket.cfAccountId, bucket.name);
    } catch {
      managed = null;
    }
    return Response.json({ managed, custom });
  } catch (e) {
    return handleCfError(e);
  }
};

/** 绑定自定义域：域名必须落在该桶所属 CF 账号已聚合的 zone 内（与 Worker 域挂载同规则） */
export const POST: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const body = (await request.json().catch(() => null)) as { domain?: unknown } | null;
  const domain = typeof body?.domain === 'string' ? body.domain.trim().toLowerCase() : '';
  if (!isHostname(domain)) return jsonError('invalid hostname', 400, 'invalidHostname');
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const bucket = await getCachedR2Bucket(db, userEmail, params.accountId!, params.bucket!, cfAccountId);
  if (!bucket) return jsonError('Bucket not found', 404);
  const zone = await findZoneForHostname(db, userEmail, domain, bucket.cfAccountId);
  if (!zone) return jsonError('hostname is not in any aggregated zone', 400, 'zoneNotFound');
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const created = await client.attachR2CustomDomain(bucket.cfAccountId, bucket.name, {
      domain,
      zoneId: zone.zoneId,
    });
    return Response.json({ domain: created });
  } catch (e) {
    return handleCfError(e);
  }
};

export const DELETE: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const searchParams = new URL(request.url).searchParams;
  const domain = searchParams.get('domain') ?? '';
  if (domain === '') return jsonError('domain is required', 400);
  const cfAccountId = searchParams.get('cfAccountId') ?? undefined;
  const bucket = await getCachedR2Bucket(db, userEmail, params.accountId!, params.bucket!, cfAccountId);
  if (!bucket) return jsonError('Bucket not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    await client.detachR2CustomDomain(bucket.cfAccountId, bucket.name, domain);
    return Response.json({ ok: true });
  } catch (e) {
    return handleCfError(e);
  }
};

/** r2.dev 公开访问开关 */
export const PUT: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== 'boolean') return jsonError('enabled boolean is required', 400);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const bucket = await getCachedR2Bucket(db, userEmail, params.accountId!, params.bucket!, cfAccountId);
  if (!bucket) return jsonError('Bucket not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    return Response.json({ managed: await client.setR2ManagedDomain(bucket.cfAccountId, bucket.name, body.enabled) });
  } catch (e) {
    return handleCfError(e);
  }
};
