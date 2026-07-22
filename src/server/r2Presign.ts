import { AwsClient } from 'aws4fetch';
import type { CfClient } from './cf/client';
import { sha256Hex } from './crypto';

/**
 * 从现有 CF API token 推导 R2 S3 凭证（官方规则）：
 * Access Key ID = token 的 id（verifyToken() 返回），Secret = token 值的 SHA-256 hex。
 * 随请求现算、不落库不缓存不记日志；token 不带 R2 权限时 S3 请求会 403（路由按具体动作透出）。
 */
export async function deriveR2S3Credentials(
  client: Pick<CfClient, 'verifyToken'>,
  token: string,
): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  const v = await client.verifyToken();
  return { accessKeyId: v.id, secretAccessKey: await sha256Hex(token) };
}

/**
 * 生成 R2 对象预签名 URL（SigV4 query 签名，浏览器直连上传/下载）。
 * 本文件是仓库中唯一允许出现 *.r2.cloudflarestorage.com 端点的位置（CfClient 边界约定的 S3 例外）。
 * 不签 Content-Type 等额外头：query 签名只覆盖规范化 URL，浏览器可带任意类型（设计文档确认的 v1 取舍）。
 */
export async function presignR2ObjectUrl(
  creds: { accessKeyId: string; secretAccessKey: string },
  opts: {
    cfAccountId: string;
    bucket: string;
    key: string;
    method: 'GET' | 'PUT';
    expiresSeconds?: number;
    /** 有值时强制附件下载：签名前追加 response-content-disposition（S3 响应头覆盖，随 query 一并签名） */
    downloadFilename?: string;
  },
): Promise<string> {
  const aws = new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    service: 's3',
    region: 'auto',
  });
  const encodedKey = opts.key.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`https://${opts.cfAccountId}.r2.cloudflarestorage.com/${opts.bucket}/${encodedKey}`);
  url.searchParams.set('X-Amz-Expires', String(opts.expiresSeconds ?? 900));
  if (opts.downloadFilename) {
    url.searchParams.set(
      'response-content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(opts.downloadFilename)}`,
    );
  }
  const signed = await aws.sign(new Request(url, { method: opts.method }), { aws: { signQuery: true } });
  return signed.url;
}
