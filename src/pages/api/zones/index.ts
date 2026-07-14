import type { APIRoute } from 'astro';
import { appContext, jsonError } from '@/server/context';
import { listCachedZones } from '@/server/zones';

export const GET: APIRoute = async ({ locals, request }) => {
  const { db, userEmail } = await appContext(locals);
  const url = new URL(request.url);
  const rawPage = parseInt(url.searchParams.get('page') ?? '1', 10);
  const rawPageSize = parseInt(url.searchParams.get('pageSize') ?? '20', 10);
  const search = url.searchParams.get('search') ?? '';
  const status = url.searchParams.get('status') ?? '';
  const accountId = url.searchParams.get('accountId') ?? '';

  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1 ? Math.min(100, rawPageSize) : 20;

  try {
    const result = await listCachedZones(db, userEmail, { page, pageSize, search, status, accountId });
    return Response.json({ zones: result.zones, total: result.total, page, pageSize });
  } catch {
    // 瞬时存储故障（如 dev 模式 D1 代理断连）返回规范 JSON，前端走错误横幅 + 重试
    return jsonError('Failed to query zones, please retry', 503);
  }
};
