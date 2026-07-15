import type { APIRoute } from 'astro';
import { appContext } from '@/server/context';
import { listEmailLogs } from '@/server/db/emailLog';

export const GET: APIRoute = async ({ locals, request }) => {
  const { db, userEmail } = await appContext(locals);
  const url = new URL(request.url);
  const rawPage = parseInt(url.searchParams.get('page') ?? '1', 10);
  const rawPageSize = parseInt(url.searchParams.get('pageSize') ?? '20', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1 ? Math.min(100, rawPageSize) : 20;
  const { logs, total } = await listEmailLogs(db, userEmail, { page, pageSize });
  return Response.json({ logs, total, page, pageSize });
};
