import type { APIRoute } from 'astro';
import type { CfR2LifecycleRule } from '@/server/cf/types';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { getCachedR2Bucket } from '@/server/r2';
import { clientForAccount } from '@/server/workersPages';

export const GET: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const bucket = await getCachedR2Bucket(db, userEmail, params.accountId!, params.bucket!, cfAccountId);
  if (!bucket) return jsonError('Bucket not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    return Response.json({ rules: await client.getR2Lifecycle(bucket.cfAccountId, bucket.name) });
  } catch (e) {
    return handleCfError(e);
  }
};

export const PUT: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const body = (await request.json().catch(() => null)) as { rules?: unknown } | null;
  if (!Array.isArray(body?.rules)) return jsonError('rules array is required', 400);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const bucket = await getCachedR2Bucket(db, userEmail, params.accountId!, params.bucket!, cfAccountId);
  if (!bucket) return jsonError('Bucket not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    await client.putR2Lifecycle(bucket.cfAccountId, bucket.name, body.rules as CfR2LifecycleRule[]);
    return Response.json({ ok: true });
  } catch (e) {
    return handleCfError(e);
  }
};
