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
          const res = await fetch(withCf(`${apiBase}/content?key=${encodeURIComponent(object.key)}`, cfAccountId));
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
          if (kind === 'markdown')
            setState({ phase: 'markdown', html: marked.parse(text, { async: false }) as string });
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
    // biome-ignore lint/a11y/useKeyWithClickEvents: 背景点击关闭，Escape 已由上方 keydown 监听覆盖键盘可达性
    <div className="modal modal-open" role="dialog" onClick={onClose}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 阻止冒泡到背景层，非交互语义 */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: 同上，键盘可达性由 Escape 监听覆盖 */}
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
          {state.phase === 'loading' && (
            <span className="loading loading-spinner" role="status" aria-label={t(locale, 'r2.previewLoading')} />
          )}
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
