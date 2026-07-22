import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { getCachedR2Bucket } from '@/server/r2';
import { clientForAccount } from '@/server/workersPages';

export const GET: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const url = new URL(request.url);
  const bucket = await getCachedR2Bucket(db, userEmail, params.accountId!, params.bucket!);
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

export const DELETE: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const keyParam = new URL(request.url).searchParams.get('key') ?? '';
  if (keyParam === '') return jsonError('key is required', 400);
  const bucket = await getCachedR2Bucket(db, userEmail, params.accountId!, params.bucket!);
  if (!bucket) return jsonError('Bucket not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    await client.deleteR2Object(bucket.cfAccountId, bucket.name, keyParam);
    return Response.json({ ok: true });
  } catch (e) {
    return handleCfError(e);
  }
};
