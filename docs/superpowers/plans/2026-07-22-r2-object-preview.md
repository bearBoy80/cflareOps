# R2 对象预览 + 真下载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** R2 对象浏览器（ObjectsTab）增加应用内文件预览（图片 / 文本 / Markdown / PDF / 视频 / 音频，大尺寸模态框），并把「下载」改为真下载（强制附件而非浏览器内联打开）。

**Architecture:** 混合通道——媒体类（图片/PDF/视频/音频）用预签名 GET URL 直连 `<img>/<iframe>/<video>/<audio>` 标签（不受桶 CORS 限制，零服务器中转）；文本类（含 Markdown）走新服务端中转路由 `GET .../content`（服务器经 CfClient SDK 取内容，≤1MB，超限 413）。真下载 = 预签名前向 URL 追加 S3 标准响应头覆盖参数 `response-content-disposition=attachment`（随 query 一并签名）。

**Tech Stack:** aws4fetch SigV4 query 签名（既有 `r2Presign.ts`）、cloudflare SDK `r2.buckets.objects.get`（返回原始 `Response`）、`marked` + sandbox iframe（EmailPreview 既有防 XSS 模式）、daisyUI modal、Vitest。

**规格来源:** `docs/superpowers/specs/2026-07-22-r2-object-preview-design.md`

## Global Constraints

- 导入一律用路径别名：`@/*` → `src/*`，`@tests/*` → `tests/*`；同目录 `./` 可用；禁止 `../`。
- 所有用户数据查询按 `owner_email = ?` 过滤；对象相关路由必须先 `getCachedR2Bucket(db, userEmail, accountId, bucket, cfAccountId)` → 未命中 404，之后才允许碰 CF。
- Cloudflare API 只经 `src/server/cf/client.ts` 的 `CfClient`；`*.r2.cloudflarestorage.com` 端点只允许出现在 `src/server/r2Presign.ts`。
- 永不日志/存储解密后的 token 或派生的 S3 secret。
- 缺 R2 权限的 token：403 只影响预览/下载动作本身，不破坏列表页（前端 toast / 模态内提示 `r2.forbiddenHint`）。
- 存储的用户内容渲染为 HTML 时一律 sandbox iframe（`sandbox=""` + srcDoc），禁止 dangerouslySetInnerHTML——照抄 `src/components/ui/EmailPreview.tsx` 模式。
- 新用户可见字符串全部进 `src/i18n/index.ts` 的 zh 与 en 两张表。
- 移动端规则（CLAUDE.md）：模态框手机端全屏、内容区自身滚动、500px 视口零整页横滚；含汉字小按钮 `whitespace-nowrap`。
- 前端所有 fetch 走 `withCf()` 透传 `cfAccountId`（ObjectsTab 既有 helper，PreviewModal 需要同款）。
- 每任务收尾：`npx vitest run <该任务测试文件>`；提交前 `npm run check` + `npm run typecheck`。
- 提交信息 Conventional Commits，末行 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

## File Structure

```
src/server/r2Presign.ts                              修改  presignR2ObjectUrl opts 增加 downloadFilename
src/server/cf/client.ts                              修改  新增 R2ObjectTooLargeError + getR2ObjectContent()
src/pages/api/r2/[accountId]/[bucket]/presign.ts     修改  body 增加 download 标志
src/pages/api/r2/[accountId]/[bucket]/content.ts     新建  GET 文本内容中转路由（1MB 上限，413 objectTooLarge）
src/lib/previewKind.ts                               新建  扩展名 → 预览类型映射（纯函数）
src/components/r2/PreviewModal.tsx                   新建  预览模态框
src/components/r2/ObjectsTab.tsx                     修改  文件名可点击预览 + 真下载
src/i18n/index.ts                                    修改  新增 5 个 r2.preview* / r2.close 键（zh + en）
tests/unit/r2-presign.test.ts                        修改  downloadFilename 签名断言
tests/unit/r2-client.test.ts                         修改  getR2ObjectContent 测试
tests/unit/r2-api.test.ts                            修改  content 路由 400 / 404 测试
tests/unit/preview-kind.test.ts                      新建  映射表测试
```

---

## Task 1: `presignR2ObjectUrl` 支持 `downloadFilename`（真下载签名）

**Files:**
- Modify: `src/server/r2Presign.ts`
- Modify: `tests/unit/r2-presign.test.ts`

**Step 1: 写测试（先跑红）**

在 `tests/unit/r2-presign.test.ts` 的 `describe('presignR2ObjectUrl')` 末尾追加：

```ts
  it('adds a signed response-content-disposition when downloadFilename is set', async () => {
    const base = { cfAccountId: 'cf-1', bucket: 'b1', key: 'docs/报告 v2.pdf', method: 'GET' } as const;
    const plain = new URL(await presignR2ObjectUrl(CREDS, base));
    const url = new URL(await presignR2ObjectUrl(CREDS, { ...base, downloadFilename: '报告 v2.pdf' }));
    expect(url.searchParams.get('response-content-disposition')).toBe(
      "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20v2.pdf",
    );
    expect(plain.searchParams.get('response-content-disposition')).toBeNull();
    // 参数进入规范化 URL 参与签名，两个 URL 的签名必然不同
    expect(url.searchParams.get('X-Amz-Signature')).not.toBe(plain.searchParams.get('X-Amz-Signature'));
  });
```

运行 `npx vitest run tests/unit/r2-presign.test.ts` — 新用例必须失败（TS 报未知属性或断言 null）。

**Step 2: 实现**

`src/server/r2Presign.ts` 中 `presignR2ObjectUrl`：

1. opts 类型追加可选项：

```ts
  opts: {
    cfAccountId: string;
    bucket: string;
    key: string;
    method: 'GET' | 'PUT';
    expiresSeconds?: number;
    /** 有值时强制附件下载：签名前追加 response-content-disposition（S3 响应头覆盖，随 query 一并签名） */
    downloadFilename?: string;
  },
```

2. 在 `url.searchParams.set('X-Amz-Expires', ...)` 之后、`aws.sign(...)` 之前插入：

```ts
  if (opts.downloadFilename) {
    url.searchParams.set(
      'response-content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(opts.downloadFilename)}`,
    );
  }
```

**Step 3: 验证 + 提交**

- [ ] `npx vitest run tests/unit/r2-presign.test.ts` 全绿
- [ ] `npm run check && npm run typecheck`
- [ ] commit: `feat(r2): presign supports attachment content-disposition for true download`

---

## Task 2: presign 路由 `download` 标志

**Files:**
- Modify: `src/pages/api/r2/[accountId]/[bucket]/presign.ts`

（路由内 CF 调用在 Node 测试里无法免网络执行，既有 400/404 用例已覆盖前置校验路径；本任务不加新测试，行为由 Task 1 单测 + 验收真机覆盖。）

**Step 1: 实现**

`src/pages/api/r2/[accountId]/[bucket]/presign.ts` 修改两处：

1. body 解析行增加 `download`：

```ts
  const body = (await request.json().catch(() => null)) as {
    key?: unknown;
    op?: unknown;
    download?: unknown;
  } | null;
  const objectKey = typeof body?.key === 'string' ? body.key : '';
  const op = body?.op === 'get' || body?.op === 'put' ? body.op : null;
  const download = body?.download === true;
```

2. `presignR2ObjectUrl` 调用增加参数（仅 GET 生效；文件名取 key 最后一段）：

```ts
    const url = await presignR2ObjectUrl(creds, {
      cfAccountId: bucket.cfAccountId,
      bucket: bucket.name,
      key: objectKey,
      method: op === 'get' ? 'GET' : 'PUT',
      expiresSeconds: EXPIRES_SECONDS,
      ...(download && op === 'get' ? { downloadFilename: objectKey.split('/').pop() || objectKey } : {}),
    });
```

**Step 2: 验证 + 提交**

- [ ] `npx vitest run tests/unit/r2-api.test.ts` 全绿（既有用例不回归）
- [ ] `npm run check && npm run typecheck`
- [ ] commit: `feat(r2): presign route accepts download flag`

---

## Task 3: `CfClient.getR2ObjectContent` + `R2ObjectTooLargeError`

**Files:**
- Modify: `src/server/cf/client.ts`
- Modify: `tests/unit/r2-client.test.ts`

**Step 1: 写测试（先跑红）**

`tests/unit/r2-client.test.ts` 顶部 import 追加 `R2ObjectTooLargeError`（与 `CfApiError, CfClient` 同行）。在 `describe('CfClient R2 objects')` 末尾追加：

```ts
  it('getR2ObjectContent GETs the encoded object path and returns contentType + text', async () => {
    let seenUrl = '';
    const fetchImpl: typeof fetch = async (input) => {
      seenUrl = String(input);
      return new Response('hello world', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': '11' },
      });
    };
    const r = await new CfClient('tok', fetchImpl).getR2ObjectContent('cf-1', 'b1', 'docs/a b.txt', 1024);
    expect(seenUrl).toContain('/accounts/cf-1/r2/buckets/b1/objects/docs/a%20b.txt');
    expect(r.contentType).toBe('text/plain; charset=utf-8');
    expect(r.text).toBe('hello world');
  });

  it('getR2ObjectContent throws R2ObjectTooLargeError when Content-Length exceeds maxBytes', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('x'.repeat(20), { status: 200, headers: { 'Content-Length': '20' } });
    await expect(new CfClient('tok', fetchImpl).getR2ObjectContent('cf-1', 'b1', 'big.txt', 10)).rejects.toBeInstanceOf(
      R2ObjectTooLargeError,
    );
  });

  it('getR2ObjectContent re-checks byte size after reading when Content-Length is absent', async () => {
    const fetchImpl: typeof fetch = async () => new Response('x'.repeat(20), { status: 200 });
    await expect(new CfClient('tok', fetchImpl).getR2ObjectContent('cf-1', 'b1', 'big.txt', 10)).rejects.toBeInstanceOf(
      R2ObjectTooLargeError,
    );
  });
```

> 注意：`new Response(body)` 在 Node 下可能自动带 `Content-Length`——第三个用例若因此变成走头部路径提前抛错，断言结果相同，仍然有效；但为了确实覆盖"无头二次校验"分支，用 `new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('x'.repeat(20))); c.close(); } }), { status: 200 })` 构造无 Content-Length 的响应（流式 body 不会自动生成该头）。实现者跑一次确认覆盖到实现里的第二个分支。

运行 `npx vitest run tests/unit/r2-client.test.ts` — 新用例失败（方法不存在）。

**Step 2: 实现**

`src/server/cf/client.ts`：

1. 在 `CfApiError` 类附近（文件顶部错误定义区）新增导出：

```ts
/** 对象超出服务端中转预览上限时的稳定标记错误（content 路由映射为 413 objectTooLarge） */
export class R2ObjectTooLargeError extends Error {
  constructor() {
    super('object exceeds preview size limit');
    this.name = 'R2ObjectTooLargeError';
  }
}
```

2. 在 `deleteR2Object` 之后新增方法：

```ts
  /**
   * 读取对象内容（服务端中转文本预览用）。SDK objects.get 返回原始 Response；
   * key 与 deleteR2Object 同规则逐段 encodeURIComponent（SDK 不做路径编码）。
   * 先看 Content-Length 头拒超限；无该头（chunked）时读完后按实际字节数二次校验。
   */
  getR2ObjectContent(
    cfAccountId: string,
    bucket: string,
    key: string,
    maxBytes: number,
  ): Promise<{ contentType: string | null; text: string }> {
    return this.wrap(async () => {
      const encoded = key.split('/').map(encodeURIComponent).join('/');
      const res = await this.sdk.r2.buckets.objects.get(bucket, encoded, { account_id: cfAccountId });
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > maxBytes) throw new R2ObjectTooLargeError();
      const buf = await res.arrayBuffer();
      if (buf.byteLength > maxBytes) throw new R2ObjectTooLargeError();
      return { contentType: res.headers.get('content-type'), text: new TextDecoder().decode(buf) };
    });
  }
```

（`wrap` 只转换 `Cloudflare.APIError`，自定义错误原样穿透——无需改 `wrap`。）

**Step 3: 验证 + 提交**

- [ ] `npx vitest run tests/unit/r2-client.test.ts` 全绿
- [ ] `npm run check && npm run typecheck`
- [ ] commit: `feat(r2): CfClient.getR2ObjectContent with size guard`

---

## Task 4: `GET .../content` 中转路由

**Files:**
- Create: `src/pages/api/r2/[accountId]/[bucket]/content.ts`
- Modify: `tests/unit/r2-api.test.ts`

**Step 1: 写测试（先跑红）**

`tests/unit/r2-api.test.ts` 顶部 import 追加：

```ts
import { GET as contentGet } from '@/pages/api/r2/[accountId]/[bucket]/content';
```

新增 describe：

```ts
describe('GET /api/r2/:accountId/:bucket/content', () => {
  it('400s on an empty key before touching CF', async () => {
    const db = createTestDb();
    await seed(db);
    const res = await contentGet(
      ctx(db, 'http://localhost/api/r2/a1/b1/content', undefined, { accountId: 'a1', bucket: 'b1' }),
    );
    expect(res.status).toBe(400);
  });

  it('404s for a bucket outside the owner scope', async () => {
    const db = createTestDb();
    await seed(db);
    const res = await contentGet(
      ctx(db, 'http://localhost/api/r2/a1/nope/content?key=a.txt', undefined, { accountId: 'a1', bucket: 'nope' }),
    );
    expect(res.status).toBe(404);
  });
});
```

运行 `npx vitest run tests/unit/r2-api.test.ts` — 失败（模块不存在）。

**Step 2: 实现**

新建 `src/pages/api/r2/[accountId]/[bucket]/content.ts`：

```ts
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
```

**Step 3: 验证 + 提交**

- [ ] `npx vitest run tests/unit/r2-api.test.ts` 全绿
- [ ] `npm run check && npm run typecheck`
- [ ] commit: `feat(r2): server relay route for text object preview`

---

## Task 5: `previewKind` 映射（纯函数）

**Files:**
- Create: `src/lib/previewKind.ts`
- Create: `tests/unit/preview-kind.test.ts`

**Step 1: 写测试（先跑红）**

新建 `tests/unit/preview-kind.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { previewKind } from '@/lib/previewKind';

describe('previewKind', () => {
  it.each([
    ['photo.jpg', 'image'],
    ['a/b/pic.WEBP', 'image'],
    ['icon.svg', 'image'],
    ['README.md', 'markdown'],
    ['notes.markdown', 'markdown'],
    ['app.ts', 'text'],
    ['config.YAML', 'text'],
    ['.env', 'text'],
    ['data.csv', 'text'],
    ['doc.pdf', 'pdf'],
    ['clip.mp4', 'video'],
    ['song.mp3', 'audio'],
    ['voice.M4A', 'audio'],
  ] as const)('%s → %s', (key, kind) => {
    expect(previewKind(key)).toBe(kind);
  });

  it.each(['archive.zip', 'binary.bin', 'noext', 'weird.', 'dir/noext'])('%s → null', (key) => {
    expect(previewKind(key)).toBeNull();
  });
});
```

> `.env` 的期望：最后一个 `.` 之后是 `env`，在 text 列表里 → `'text'`。`'weird.'` 扩展名为空 → null。

**Step 2: 实现**

新建 `src/lib/previewKind.ts`：

```ts
export type PreviewKind = 'image' | 'text' | 'markdown' | 'pdf' | 'video' | 'audio';

const KIND_BY_EXT: Record<string, PreviewKind> = Object.fromEntries([
  ...['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif', 'ico', 'bmp'].map((e) => [e, 'image'] as const),
  ...['md', 'markdown'].map((e) => [e, 'markdown'] as const),
  ...[
    'txt', 'json', 'js', 'ts', 'jsx', 'tsx', 'css', 'html', 'xml', 'yaml', 'yml', 'toml',
    'csv', 'log', 'sh', 'py', 'go', 'rs', 'java', 'sql', 'env', 'conf', 'ini',
  ].map((e) => [e, 'text'] as const),
  ['pdf', 'pdf'] as const,
  ...['mp4', 'webm', 'mov', 'm4v'].map((e) => [e, 'video'] as const),
  ...['mp3', 'wav', 'ogg', 'm4a', 'flac'].map((e) => [e, 'audio'] as const),
]);

/** 对象 key → 预览类型；按小写扩展名判断，无扩展名或未知类型返回 null（不可预览，点击直接下载） */
export function previewKind(key: string): PreviewKind | null {
  const base = key.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return KIND_BY_EXT[ext] ?? null;
}
```

> 注意 `.env`：`lastIndexOf('.') === 0` 也算有扩展名（`dot < 0` 才排除），`base.slice(1)` = `env` → text，与测试一致。Biome 可能会重排上面数组的换行——以 `npm run check` 的结果为准。

**Step 3: 验证 + 提交**

- [ ] `npx vitest run tests/unit/preview-kind.test.ts` 全绿
- [ ] `npm run check && npm run typecheck`
- [ ] commit: `feat(r2): preview kind mapping by file extension`

---

## Task 6: i18n 新键（zh + en）

**Files:**
- Modify: `src/i18n/index.ts`

**Step 1: 实现**

zh 表中 `'r2.forbiddenHint'` 行之后插入：

```ts
  'r2.preview': '预览',
  'r2.previewTooLarge': '文件过大，请下载查看',
  'r2.previewUnsupported': '该类型不支持预览',
  'r2.previewLoading': '加载中…',
  'r2.close': '关闭',
```

en 表中 `'r2.forbiddenHint'` 行之后插入：

```ts
  'r2.preview': 'Preview',
  'r2.previewTooLarge': 'File too large — download to view',
  'r2.previewUnsupported': 'Preview is not supported for this type',
  'r2.previewLoading': 'Loading…',
  'r2.close': 'Close',
```

**Step 2: 验证 + 提交**

- [ ] `npm run check && npm run typecheck`（键名 TS 字面量联合会校验两表一致）
- [ ] commit: `feat(r2): i18n strings for object preview`

---

## Task 7: `PreviewModal` 组件

**Files:**
- Create: `src/components/r2/PreviewModal.tsx`

依赖：Task 5 的 `previewKind`、Task 6 的 i18n 键、Task 2/4 的路由行为。前端组件按仓库惯例无单测（dev/真机验证）。

**Step 1: 实现**

新建 `src/components/r2/PreviewModal.tsx`：

```tsx
import { marked } from 'marked';
import { useEffect, useState } from 'react';
import { type Locale, t } from '@/i18n';
import { formatBytes } from '@/lib/formatBytes';
import { previewKind } from '@/lib/previewKind';

/** 追加 cfAccountId 查询参数（与 ObjectsTab 同款；同一 token 下多 CF 账号同名桶消歧） */
function withCf(url: string, cfAccountId?: string | null): string {
  if (!cfAccountId) return url;
  return `${url}${url.includes('?') ? '&' : '?'}cfAccountId=${encodeURIComponent(cfAccountId)}`;
}

type State =
  | { phase: 'loading' }
  | { phase: 'media'; url: string }
  | { phase: 'text'; text: string }
  | { phase: 'markdown'; html: string }
  | { phase: 'error'; message: string; tooLarge?: boolean };

/**
 * R2 对象预览模态框。混合通道：媒体类（图片/PDF/视频/音频）预签名 URL 直连标签
 * （标签加载不受桶 CORS 限制）；文本/Markdown 走服务端中转 content 路由（≤1MB，超限 413）。
 * Markdown 渲染产物装 sandbox iframe（EmailPreview 同款防 XSS 模式）。
 */
export default function PreviewModal({
  locale,
  apiBase,
  cfAccountId,
  object,
  onClose,
}: {
  locale: Locale;
  apiBase: string;
  cfAccountId?: string | null;
  object: { key: string; size: number | null };
  onClose: () => void;
}) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const kind = previewKind(object.key);
  const filename = object.key.split('/').pop() ?? object.key;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!kind) {
        setState({ phase: 'error', message: t(locale, 'r2.previewUnsupported') });
        return;
      }
      try {
        if (kind === 'text' || kind === 'markdown') {
          const res = await fetch(
            withCf(`${apiBase}/content?key=${encodeURIComponent(object.key)}`, cfAccountId),
          );
          if (!res.ok) {
            if (cancelled) return;
            const message =
              res.status === 413
                ? t(locale, 'r2.previewTooLarge')
                : res.status === 403
                  ? t(locale, 'r2.forbiddenHint')
                  : t(locale, 'common.requestFailed');
            setState({ phase: 'error', message, tooLarge: res.status === 413 });
            return;
          }
          const { text } = (await res.json()) as { contentType: string | null; text: string };
          if (cancelled) return;
          if (kind === 'markdown') setState({ phase: 'markdown', html: marked.parse(text, { async: false }) as string });
          else setState({ phase: 'text', text });
        } else {
          const res = await fetch(withCf(`${apiBase}/presign`, cfAccountId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: object.key, op: 'get' }),
          });
          if (!res.ok) {
            if (cancelled) return;
            setState({
              phase: 'error',
              message: res.status === 403 ? t(locale, 'r2.forbiddenHint') : t(locale, 'common.requestFailed'),
            });
            return;
          }
          const { url } = (await res.json()) as { url: string };
          if (!cancelled) setState({ phase: 'media', url });
        }
      } catch {
        if (!cancelled) setState({ phase: 'error', message: t(locale, 'common.requestFailed') });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // object.key 变化即整体重挂载（父组件按对象渲染），依赖只列稳定输入
  }, [kind, locale, apiBase, cfAccountId, object.key]);

  async function download() {
    try {
      const res = await fetch(withCf(`${apiBase}/presign`, cfAccountId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: object.key, op: 'get', download: true }),
      });
      if (!res.ok) return;
      const { url } = (await res.json()) as { url: string };
      window.open(url, '_blank', 'noopener');
    } catch {
      /* 顶栏下载失败静默：主体错误态已有兜底提示 */
    }
  }

  return (
    <div className="modal modal-open" role="dialog" onClick={onClose}>
      <div
        className="modal-box flex h-full max-h-full w-full max-w-full flex-col rounded-none p-0 sm:h-[85vh] sm:max-h-[85vh] sm:w-[90vw] sm:max-w-[90vw] sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-base-300 border-b px-4 py-3">
          <span className="min-w-0 flex-1 truncate font-mono text-sm" title={object.key}>
            {filename}
          </span>
          <span className="shrink-0 whitespace-nowrap font-mono text-xs opacity-60">{formatBytes(object.size)}</span>
          <button className="btn btn-xs whitespace-nowrap" onClick={() => void download()}>
            {t(locale, 'r2.download')}
          </button>
          <button className="btn btn-ghost btn-xs whitespace-nowrap" onClick={onClose}>
            {t(locale, 'r2.close')}
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
          {state.phase === 'loading' && <span className="loading loading-spinner" aria-label={t(locale, 'r2.previewLoading')} />}
          {state.phase === 'error' && (
            <div className="flex flex-col items-center gap-3 text-sm opacity-70">
              <span>{state.message}</span>
              {state.tooLarge && (
                <button className="btn btn-sm whitespace-nowrap" onClick={() => void download()}>
                  {t(locale, 'r2.download')}
                </button>
              )}
            </div>
          )}
          {state.phase === 'media' && kind === 'image' && (
            <img src={state.url} alt={filename} className="max-h-full max-w-full object-contain" />
          )}
          {state.phase === 'media' && kind === 'pdf' && (
            <iframe src={state.url} title={filename} className="h-full w-full" />
          )}
          {state.phase === 'media' && kind === 'video' && (
            // biome-ignore lint/a11y/useMediaCaption: 用户任意对象存储内容，无字幕轨可用
            <video src={state.url} controls className="max-h-full max-w-full" />
          )}
          {state.phase === 'media' && kind === 'audio' && (
            // biome-ignore lint/a11y/useMediaCaption: 用户任意对象存储内容，无字幕轨可用
            <audio src={state.url} controls className="w-full max-w-xl" />
          )}
          {state.phase === 'text' && (
            <pre className="h-full w-full self-start overflow-auto whitespace-pre-wrap rounded border border-base-300 bg-base-200/40 p-3 font-mono text-sm">
              {state.text}
            </pre>
          )}
          {state.phase === 'markdown' && (
            <iframe
              title={filename}
              sandbox=""
              srcDoc={`<!doctype html><meta charset="utf-8"><body style="margin:16px;font-family:system-ui,sans-serif;line-height:1.6;word-break:break-word">${state.html}</body>`}
              className="h-full w-full rounded border border-base-300 bg-white"
            />
          )}
        </div>
      </div>
    </div>
  );
}
```

要点（实现者自查）：
- sandbox iframe 的 `sandbox=""`（禁脚本禁同源）与 srcDoc 骨架必须与 EmailPreview 逐字一致的模式。
- 手机端（<sm）模态全屏：`h-full w-full max-w-full rounded-none`；≥sm 恢复 `90vw/85vh` 圆角。内容区 `min-h-0 flex-1 overflow-auto` 自身滚动。
- biome-ignore 注释如 `npm run check` 不要求可去掉；若 lint 报 `useMediaCaption` 之外的规则按仓库配置处理（`useButtonType` 已关闭）。

**Step 2: 验证 + 提交**

- [ ] `npm run check && npm run typecheck`
- [ ] commit: `feat(r2): object preview modal (media direct, text via relay)`

---

## Task 8: `ObjectsTab` 集成（可点击文件名 + 真下载）

**Files:**
- Modify: `src/components/r2/ObjectsTab.tsx`

**Step 1: 实现**

1. import 追加：

```ts
import PreviewModal from '@/components/r2/PreviewModal';
import { previewKind } from '@/lib/previewKind';
```

2. state 追加（`uploadPct` 之后）：

```ts
  const [preview, setPreview] = useState<{ key: string; size: number | null } | null>(null);
```

3. `download(obj)` 的 presign body 改为真下载：

```ts
        body: JSON.stringify({ key: obj.key, op: 'get', download: true }),
```

4. 文件行名称列：把现有 `<span className="inline-flex min-w-0 items-center gap-2 font-mono">…</span>` 替换为可点击按钮（保留 File 图标与 break-all）：

```tsx
                    <td>
                      <button
                        type="button"
                        className="link-hover inline-flex min-w-0 items-center gap-2 text-left font-mono hover:text-primary"
                        title={t(locale, 'r2.preview')}
                        onClick={() => {
                          if (previewKind(obj.key)) setPreview({ key: obj.key, size: obj.size });
                          else void download(obj);
                        }}
                      >
                        <File size={14} strokeWidth={1.75} className="shrink-0 opacity-40" />
                        <span className="min-w-0 break-all">{obj.key.slice(prefix.length)}</span>
                      </button>
                    </td>
```

5. 组件返回 JSX 最外层 `</div>` 前渲染模态：

```tsx
      {preview && (
        <PreviewModal
          locale={locale}
          apiBase={apiBase}
          cfAccountId={cfAccountId}
          object={preview}
          onClose={() => setPreview(null)}
        />
      )}
```

**Step 2: 验证 + 提交**

- [ ] `npx vitest run`（全量不回归）
- [ ] `npm run check && npm run typecheck`
- [ ] commit: `feat(r2): clickable object preview and true attachment download`

---

## Task 9: 门禁 + 真机验收

**Step 1: 全量门禁**

- [ ] `npm run check:ci`（或 `npm run check` 后无 diff）
- [ ] `npm run typecheck`
- [ ] `npm run test` 全绿

**Step 2: 真机验收（dev 服务器 :4321，DEV_MODE 免登录）**

进入任一 R2 桶详情 → 对象 tab（带真实对象的桶，如 `better-auth-doc`）：

- [ ] 图片对象点击文件名 → 模态内展示（`object-contain` 不变形）
- [ ] `.md` 对象 → sandbox iframe 渲染（含中文正常；含 `<script>` 的 md 不执行）
- [ ] `.txt`/`.json` 等 → `<pre>` 等宽展示
- [ ] PDF → iframe 内嵌浏览器阅读器
- [ ] mp4 → 原生控件可播放、可拖进度（Range 生效）
- [ ] >1MB 文本对象 → 模态提示「文件过大，请下载查看」+ 下载按钮可用（没有现成对象就临时上传一个 >1MB 的 .log）
- [ ] 未知扩展名对象点击文件名 → 直接触发下载（不开模态）
- [ ] 操作列「下载」与模态顶栏「下载」→ 浏览器下载文件（Content-Disposition attachment，非内联打开；中文文件名正确）
- [ ] 缺 R2 权限 token 的账号（如有）→ 预览模态内显示 `r2.forbiddenHint`，列表页不受影响
- [ ] Esc 与点遮罩关闭模态
- [ ] 500px 视口：模态全屏、`document.scrollingElement.scrollWidth === window.innerWidth`（零整页横滚）
- [ ] 1440px 桌面：模态 90vw/85vh，无回归
- [ ] `/en/...` 英文页同样入口文案正确

**Step 3: 收尾**

- [ ] 若有验收修复，逐项小步提交
- [ ] 更新 `.superpowers/sdd/progress.md` 账本
