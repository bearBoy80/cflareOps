import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { listCachedR2Buckets, syncR2Buckets } from '@/server/r2';
import { clientForAccount } from '@/server/workersPages';

export const GET: APIRoute = async ({ locals, request }) => {
  const { db, userEmail } = await appContext(locals);
  const url = new URL(request.url);
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
  const search = url.searchParams.get('search') ?? '';
  return Response.json(await listCachedR2Buckets(db, userEmail, { page, pageSize, search }));
};

/** R2 桶名规则：3-63 位小写字母/数字/连字符，首尾必须为字母或数字 */
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export const POST: APIRoute = async ({ locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const body = (await request.json().catch(() => null)) as {
    accountId?: unknown;
    cfAccountId?: unknown;
    name?: unknown;
    location?: unknown;
    storageClass?: unknown;
  } | null;
  const accountId = typeof body?.accountId === 'string' ? body.accountId : '';
  const cfAccountId = typeof body?.cfAccountId === 'string' ? body.cfAccountId : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!accountId || !cfAccountId) return jsonError('accountId and cfAccountId are required', 400);
  if (!BUCKET_NAME_RE.test(name)) return jsonError('invalid bucket name', 400, 'invalidBucketName');
  try {
    const client = await clientForAccount(db, key, userEmail, accountId);
    const bucket = await client.createR2Bucket(cfAccountId, {
      name,
      ...(typeof body?.location === 'string' && body.location ? { location: body.location } : {}),
      ...(typeof body?.storageClass === 'string' && body.storageClass ? { storageClass: body.storageClass } : {}),
    });
    // 创建成功后单账号增量同步刷新缓存；失败不致命（下次手动同步会补上）
    try {
      await syncR2Buckets(db, key, userEmail, undefined, accountId);
    } catch {
      // 缓存刷新失败不影响创建结果
    }
    return Response.json({ bucket });
  } catch (e) {
    return handleCfError(e);
  }
};
