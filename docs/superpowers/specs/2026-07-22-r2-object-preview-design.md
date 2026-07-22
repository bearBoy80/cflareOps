# R2 对象预览 + 下载/预览分离设计

日期：2026-07-22
状态：已确认（用户批准）

## 目标

R2 对象浏览器（`src/components/r2/ObjectsTab.tsx`）增加应用内文件预览，并把「下载」改为真下载（强制附件而非浏览器内联打开）。

- 预览类型（按扩展名判断）：图片、文本/代码/Markdown、PDF、视频/音频。
- 展示形式：大尺寸模态框（90vw/85vh，手机端全屏），顶栏 = 文件名 + 大小 + 下载按钮 + 关闭。
- 文本类预览大小上限 1 MB，超限返回 413 并提示“文件过大，请下载查看”。

## 架构决策（混合通道）

- **媒体类（图片/PDF/视频/音频）**：预签名 GET URL 直连 `<img>/<iframe>/<video>/<audio>` 标签——这些标签不受 CORS 限制，保持零服务器中转；R2 支持 Range，视频可拖进度。
- **文本类（含 Markdown）**：浏览器 fetch 预签名 URL 会撞桶 CORS，改走**服务端中转路由**（服务器经 CfClient REST 取内容，≤1MB）。
- 否决项：全量中转（媒体吃服务器带宽）、要求用户配桶 CORS（配置负担外移）。

## 服务端

### 1. `src/server/r2Presign.ts`

`presignR2ObjectUrl` 的 opts 增加可选 `downloadFilename?: string`：有值时在**签名前**向 URL 追加查询参数
`response-content-disposition=attachment; filename*=UTF-8''<encodeURIComponent(filename)>`
（S3 标准响应头覆盖参数，随 query 一并签名）。不传时行为不变（内联，媒体预览直接用）。

### 2. `POST .../presign` 路由

body 增加可选 `download?: boolean`。为 true 时取 key 的最后一段作为 `downloadFilename` 传入预签名。响应形状不变 `{ url, expiresAt }`。

### 3. CfClient 新方法 + 新路由 `GET .../content`

- `CfClient.getR2ObjectContent(cfAccountId, bucket, key, maxBytes): Promise<{ contentType: string | null; text: string }>`
  走 SDK `r2.buckets.objects.get`（返回原始 Response）。先看 `Content-Length` 头，超 `maxBytes` 抛带稳定标记的错误；无该头时读取后按字节数二次校验。key 逐段 encodeURIComponent（与 deleteR2Object 同规则）。
- 路由 `src/pages/api/r2/[accountId]/[bucket]/content.ts`（GET，`?key=&cfAccountId=`）：
  归属校验（`getCachedR2Bucket` → 404）→ 空 key 400 → 超限 `jsonError(..., 413, 'objectTooLarge')` → 成功 `{ contentType, text }`。上限常量 1 MB。
  CF 侧错误经 `handleCfError`（缺权限 403 只影响预览动作）。

## 前端

### 4. `src/lib/previewKind.ts`

`previewKind(key: string): 'image' | 'text' | 'markdown' | 'pdf' | 'video' | 'audio' | null`
按小写扩展名映射：
- image: jpg jpeg png gif webp svg avif ico bmp
- markdown: md markdown
- text: txt json js ts jsx tsx css html xml yaml yml toml csv log sh py go rs java sql env conf ini
- pdf: pdf
- video: mp4 webm mov m4v
- audio: mp3 wav ogg m4a flac
- 其余 → null（不可预览）

### 5. `src/components/r2/PreviewModal.tsx`

props：`{ locale, apiBase, cfAccountId, object: { key, size }, onClose }`。

- 打开即按 kind 分派：
  - image/pdf/video/audio：先 `POST presign {key, op:'get'}` 拿 URL，再渲染对应标签（图片 `max-w-full max-h-full object-contain`；PDF `<iframe>` 占满主体；视频/音频原生控件）。
  - text/markdown：`GET .../content?key=` → text 用 `<pre>` 等宽滚动展示；markdown 用仓内 `marked` 渲染后经 **EmailPreview 同款 sandbox iframe** 展示（防 XSS，项目既有模式）。
- 状态：加载 skeleton；413 → “文件过大，请下载查看” + 下载按钮兜底；403 → `r2.forbiddenHint`；其他错误 → `common.requestFailed`。
- 顶栏下载按钮 = 真下载（presign `{key, op:'get', download:true}` → `window.open`）。
- Esc/点遮罩关闭，daisyUI modal，手机端全屏（`max-w-[90vw]` + 移动断点全宽），内容区自身滚动，不撑破页面。

### 6. `ObjectsTab` 调整

- 文件名从纯文本改为可点击（`link-hover font-mono hover:text-primary`）：kind 非 null → 打开 PreviewModal；kind 为 null → 直接触发真下载。
- 操作列「下载」按钮改为真下载（`download: true`）；「删除」不变。
- 所有 fetch 继续走 `withCf()` 透传 cfAccountId。

## i18n（zh/en 双表）

新增键：`r2.preview`（预览）、`r2.previewTooLarge`（文件过大，请下载查看）、`r2.previewUnsupported`（该类型不支持预览）、`r2.previewLoading`（加载中…）、`r2.close`（关闭）。下载沿用 `r2.download`。

## 测试

- `tests/unit/preview-kind.test.ts`：各类扩展名映射 + 大小写 + 无扩展名/未知 → null。
- `tests/unit/r2-presign.test.ts` 追加：`downloadFilename` 时签名 URL 含 `response-content-disposition`（attachment + UTF-8 文件名编码），且与不带时 URL 不同。
- `tests/unit/r2-client.test.ts` 追加：`getR2ObjectContent` 命中 URL/返回 contentType+text；Content-Length 超限抛错。
- `tests/unit/r2-api.test.ts` 追加：content 路由 空 key 400、跨 owner 404。
- 前端组件按仓库惯例无单测，dev/真机验证。

## 验收

- `npm run check` / `typecheck` / `test` 全绿。
- 真机：图片/文本/MD/PDF/视频各预览一个真实对象；下载按钮触发浏览器下载（非内联打开）；>1MB 文本提示超限；500px 模态零横滚，1440px 桌面正常。
