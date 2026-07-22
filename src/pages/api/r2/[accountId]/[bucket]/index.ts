import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { getCachedR2Bucket } from '@/server/r2';
import { clientForAccount } from '@/server/workersPages';

export const DELETE: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const bucket = await getCachedR2Bucket(db, userEmail, params.accountId!, params.bucket!, cfAccountId);
  if (!bucket) return jsonError('Bucket not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    await client.deleteR2Bucket(bucket.cfAccountId, bucket.name);
    await db
      .prepare('DELETE FROM r2_buckets WHERE account_id = ? AND cf_account_id = ? AND name = ?')
      .bind(bucket.accountId, bucket.cfAccountId, bucket.name)
      .run();
    return Response.json({ ok: true });
  } catch (e) {
    return handleCfError(e);
  }
};
