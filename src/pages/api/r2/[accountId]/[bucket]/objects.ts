import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { getCachedR2Bucket } from '@/server/r2';
import { clientForAccount } from '@/server/workersPages';

export const GET: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const url = new URL(request.url);
  const cfAccountId = url.searchParams.get('cfAccountId') ?? undefined;
  const bucket = await getCachedR2Bucket(db, userEmail, params.accountId!, params.bucket!, cfAccountId);
  if (!bucket) return jsonError('Bucket not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const prefix = url.searchParams.get('prefix') ?? undefined;
    const cursor = url.searchParams.get('cursor') ?? undefined;
    return Response.json(
      await client.listR2Objects(bucket.cfAccountId, bucket.name, {
        ...(prefix ? { prefix } : {}),
        ...(cursor ? { cursor } : {}),
      }),
    );
  } catch (e) {
    return handleCfError(e);
  }
};

/** 目录递归删除单次调用限量：workerd 子请求有上限（免费档 50），删不完由前端按 done=false 续跑 */
const MAX_PREFIX_DELETES = 40;

export const DELETE: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const searchParams = new URL(request.url).searchParams;
  const keyParam = searchParams.get('key') ?? '';
  const prefixParam = searchParams.get('prefix') ?? '';
  if (keyParam === '' && prefixParam === '') return jsonError('key or prefix is required', 400);
  const cfAccountId = searchParams.get('cfAccountId') ?? undefined;
  const bucket = await getCachedR2Bucket(db, userEmail, params.accountId!, params.bucket!, cfAccountId);
  if (!bucket) return jsonError('Bucket not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    if (prefixParam !== '') {
      return Response.json(
        await client.deleteR2Prefix(bucket.cfAccountId, bucket.name, prefixParam, MAX_PREFIX_DELETES),
      );
    }
    await client.deleteR2Object(bucket.cfAccountId, bucket.name, keyParam);
    return Response.json({ ok: true });
  } catch (e) {
    return handleCfError(e);
  }
};
