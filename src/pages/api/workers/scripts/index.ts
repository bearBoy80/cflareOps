import type { APIRoute } from 'astro';
import { appContext, jsonError } from '../../../../server/context';
import { listCachedWorkersScripts } from '../../../../server/workersPages';

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    const { db, userEmail } = await appContext(locals);
    const url = new URL(request.url);
    const rawPage = parseInt(url.searchParams.get('page') ?? '1', 10);
    const rawPageSize = parseInt(url.searchParams.get('pageSize') ?? '20', 10);
    const search = url.searchParams.get('search') ?? '';

    const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
    const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1 ? Math.min(100, rawPageSize) : 20;

    const result = await listCachedWorkersScripts(db, userEmail, { page, pageSize, search });
    return Response.json({ scripts: result.scripts, total: result.total, page, pageSize });
  } catch {
    // 瞬时存储故障（如 dev 模式 D1 代理断连）返回规范 JSON，前端走错误横幅 + 重试
    return jsonError('Failed to query workers scripts, please retry', 503);
  }
};
