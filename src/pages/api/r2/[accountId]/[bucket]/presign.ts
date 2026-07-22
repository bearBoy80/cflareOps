import type { APIRoute } from 'astro';
import { CfClient } from '@/server/cf/client';
import { appContext, handleCfError, jsonError, NotFoundError } from '@/server/context';
import { decryptSecret } from '@/server/crypto';
import { getAccount } from '@/server/db/accounts';
import { getCachedR2Bucket } from '@/server/r2';
import { deriveR2S3Credentials, presignR2ObjectUrl } from '@/server/r2Presign';

const EXPIRES_SECONDS = 900;

export const POST: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const body = (await request.json().catch(() => null)) as { key?: unknown; op?: unknown } | null;
  const objectKey = typeof body?.key === 'string' ? body.key : '';
  const op = body?.op === 'get' || body?.op === 'put' ? body.op : null;
  if (objectKey === '' || !op) return jsonError('key and op (get|put) are required', 400);
  const bucket = await getCachedR2Bucket(db, userEmail, params.accountId!, params.bucket!);
  if (!bucket) return jsonError('Bucket not found', 404);
  try {
    const account = await getAccount(db, userEmail, params.accountId!);
    if (!account) throw new NotFoundError('account not found');
    const token = await decryptSecret(account.token_encrypted, key);
    const creds = await deriveR2S3Credentials(new CfClient(token), token);
    const url = await presignR2ObjectUrl(creds, {
      cfAccountId: bucket.cfAccountId,
      bucket: bucket.name,
      key: objectKey,
      method: op === 'get' ? 'GET' : 'PUT',
      expiresSeconds: EXPIRES_SECONDS,
    });
    return Response.json({ url, expiresAt: new Date(Date.now() + EXPIRES_SECONDS * 1000).toISOString() });
  } catch (e) {
    return handleCfError(e);
  }
};
