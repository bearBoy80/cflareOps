import type { APIRoute } from 'astro';
import { CfClient, R2ObjectTooLargeError } from '@/server/cf/client';
import { appContext, handleCfError, jsonError, NotFoundError } from '@/server/context';
import { decryptSecret } from '@/server/crypto';
import { getAccount } from '@/server/db/accounts';
import { getCachedR2Bucket } from '@/server/r2';

/** 文本类预览的服务端中转上限（设计文档确认 1 MB；超限走 413 提示下载查看） */
const MAX_PREVIEW_BYTES = 1_048_576;

export const GET: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const url = new URL(request.url);
  const objectKey = url.searchParams.get('key') ?? '';
  if (objectKey === '') return jsonError('key is required', 400);
  const cfAccountId = url.searchParams.get('cfAccountId') ?? undefined;
  const bucket = await getCachedR2Bucket(db, userEmail, params.accountId!, params.bucket!, cfAccountId);
  if (!bucket) return jsonError('Bucket not found', 404);
  try {
    const account = await getAccount(db, userEmail, params.accountId!);
    if (!account) throw new NotFoundError('account not found');
    const token = await decryptSecret(account.token_encrypted, key);
    const client = new CfClient(token);
    const content = await client.getR2ObjectContent(bucket.cfAccountId, bucket.name, objectKey, MAX_PREVIEW_BYTES);
    return Response.json(content);
  } catch (e) {
    if (e instanceof R2ObjectTooLargeError) return jsonError(e.message, 413, 'objectTooLarge');
    return handleCfError(e);
  }
};
