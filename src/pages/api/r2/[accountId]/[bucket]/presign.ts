import type { APIRoute } from 'astro';
import { cfClientForAccount, resolveAccountToken } from '@/server/cf/account';
import { CfClient } from '@/server/cf/client';
import { appContext, handleCfError, jsonError, NotFoundError } from '@/server/context';
import { getAccount } from '@/server/db/accounts';
import { getCachedR2Bucket } from '@/server/r2';
import { deriveR2S3Credentials, presignR2ObjectUrl } from '@/server/r2Presign';

const EXPIRES_SECONDS = 900;
const MAX_PROXY_UPLOAD_BYTES = 300 * 1024 * 1024;

function proxyUrl(request: Request, objectKey: string, cfAccountId: string, download: boolean): string {
  const url = new URL(request.url);
  url.search = '';
  url.searchParams.set('key', objectKey);
  url.searchParams.set('cfAccountId', cfAccountId);
  if (download) url.searchParams.set('download', '1');
  return url.toString();
}

function downloadDisposition(objectKey: string): string {
  const filename = objectKey.split('/').pop() || objectKey;
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * 代理响应与本应用同源：对象的 Content-Type 由上传方任意设置，若原样内联渲染
 * text/html、image/svg+xml 等可执行脚本的类型，就是对整个控制台的存储型 XSS。
 * 只有不会执行脚本的媒体类型允许内联（预览 <img>/<video>/<audio>/PDF iframe 用），
 * 其余一律强制附件下载。<img> 忽略 Content-Disposition，SVG 缩略预览不受影响。
 */
function inlinePolicy(contentType: string | null): 'pdf' | 'media' | 'attachment' {
  const essence = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (essence === 'application/pdf') return 'pdf';
  if (essence.includes('svg') || essence.includes('xml')) return 'attachment';
  return /^(image|video|audio)\/[\w.+-]+$/.test(essence) ? 'media' : 'attachment';
}

export const POST: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const body = (await request.json().catch(() => null)) as {
    key?: unknown;
    op?: unknown;
    download?: unknown;
  } | null;
  const objectKey = typeof body?.key === 'string' ? body.key : '';
  const op = body?.op === 'get' || body?.op === 'put' ? body.op : null;
  const download = body?.download === true;
  if (objectKey === '' || !op) return jsonError('key and op (get|put) are required', 400);
  const cfAccountId = new URL(request.url).searchParams.get('cfAccountId') ?? undefined;
  const bucket = await getCachedR2Bucket(db, userEmail, params.accountId!, params.bucket!, cfAccountId);
  if (!bucket) return jsonError('Bucket not found', 404);
  try {
    const account = await getAccount(db, userEmail, params.accountId!);
    if (!account) throw new NotFoundError('account not found');
    // OAuth access token 不是 R2 API Token，不能按 S3 凭证规则派生 secret。
    // OAuth 账号改走本路由的同源流式代理；API Token 账号继续使用浏览器直传的预签名 URL。
    if (account.auth_type === 'oauth') {
      return Response.json({
        url: proxyUrl(request, objectKey, bucket.cfAccountId, download && op === 'get'),
        expiresAt: null,
        proxy: true,
      });
    }
    const token = await resolveAccountToken(db, key, account);
    const creds = await deriveR2S3Credentials(new CfClient(token), token);
    const url = await presignR2ObjectUrl(creds, {
      cfAccountId: bucket.cfAccountId,
      bucket: bucket.name,
      key: objectKey,
      method: op === 'get' ? 'GET' : 'PUT',
      expiresSeconds: EXPIRES_SECONDS,
      ...(download && op === 'get' ? { downloadFilename: objectKey.split('/').pop() || objectKey } : {}),
    });
    return Response.json({ url, expiresAt: new Date(Date.now() + EXPIRES_SECONDS * 1000).toISOString() });
  } catch (e) {
    return handleCfError(e);
  }
};

export const GET: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const url = new URL(request.url);
  const objectKey = url.searchParams.get('key') ?? '';
  if (!objectKey) return jsonError('key is required', 400);
  const cfAccountId = url.searchParams.get('cfAccountId') ?? undefined;
  const bucket = await getCachedR2Bucket(db, userEmail, params.accountId!, params.bucket!, cfAccountId);
  if (!bucket) return jsonError('Bucket not found', 404);

  try {
    const account = await getAccount(db, userEmail, params.accountId!);
    if (!account) throw new NotFoundError('account not found');
    const client = await cfClientForAccount(db, key, account);
    const upstream = await client.getR2ObjectStream(bucket.cfAccountId, bucket.name, objectKey);
    const headers = new Headers();
    for (const name of ['content-type', 'content-length', 'etag', 'last-modified', 'cache-control']) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    const policy = inlinePolicy(upstream.headers.get('content-type'));
    if (url.searchParams.get('download') === '1' || policy === 'attachment') {
      headers.set('content-disposition', downloadDisposition(objectKey));
    }
    // nosniff：禁止浏览器把声明为媒体的内容嗅探成 HTML。sandbox CSP 作纵深防御：即便被顶层
    // 打开也落在不透明源、无脚本；PDF 例外——Chromium 的 PDF 查看器在 sandbox 文档中无法加载。
    headers.set('x-content-type-options', 'nosniff');
    if (policy !== 'pdf') headers.set('content-security-policy', 'sandbox');
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (e) {
    return handleCfError(e);
  }
};

export const PUT: APIRoute = async ({ params, locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const url = new URL(request.url);
  const objectKey = url.searchParams.get('key') ?? '';
  if (!objectKey) return jsonError('key is required', 400);
  if (!request.body) return jsonError('request body is required', 400);
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_PROXY_UPLOAD_BYTES) {
    return jsonError('object exceeds the 300 MB REST upload limit', 413, 'objectTooLarge');
  }
  const cfAccountId = url.searchParams.get('cfAccountId') ?? undefined;
  const bucket = await getCachedR2Bucket(db, userEmail, params.accountId!, params.bucket!, cfAccountId);
  if (!bucket) return jsonError('Bucket not found', 404);

  try {
    const account = await getAccount(db, userEmail, params.accountId!);
    if (!account) throw new NotFoundError('account not found');
    const client = await cfClientForAccount(db, key, account);
    await client.uploadR2ObjectStream(
      bucket.cfAccountId,
      bucket.name,
      objectKey,
      request.body,
      request.headers.get('content-type'),
    );
    return new Response(null, { status: 204 });
  } catch (e) {
    return handleCfError(e);
  }
};
