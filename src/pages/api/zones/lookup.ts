import type { APIRoute } from 'astro';
import { isHostname } from '@/lib/dnsRecordValidation';
import { appContext, jsonError } from '@/server/context';
import { findZoneForHostname } from '@/server/workersPages';

/** 域名添加 modal 的轻量预检：hostname 命中当前用户哪个已聚合 zone（null 表示无命中）。
 *  cfAccountId 给定时只在该 CF 账号的 zone 内匹配。不打 CF API。 */
export const GET: APIRoute = async ({ locals, request }) => {
  const { db, userEmail } = await appContext(locals);
  const url = new URL(request.url);
  const hostname = url.searchParams.get('hostname') ?? '';
  if (!isHostname(hostname)) return jsonError('invalid hostname', 400, 'invalidHostname');
  const cfAccountId = url.searchParams.get('cfAccountId') ?? undefined;
  return Response.json({ zone: await findZoneForHostname(db, userEmail, hostname, cfAccountId) });
};
