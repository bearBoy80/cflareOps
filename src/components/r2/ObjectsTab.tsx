import { File, Folder, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import PreviewModal from '@/components/r2/PreviewModal';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/ToastProvider';
import { type Locale, t } from '@/i18n';
import { formatBytes } from '@/lib/formatBytes';
import { previewKind } from '@/lib/previewKind';
import { relativeTime } from '@/lib/time';

interface R2Object {
  key: string;
  size: number | null;
  etag: string | null;
  last_modified: string | null;
  is_prefix: boolean;
}

/** 追加 cfAccountId 查询参数（同一 token 下多 CF 账号同名桶消歧），缺省时透传原 url 不变 */
function withCf(url: string, cfAccountId?: string | null): string {
  if (!cfAccountId) return url;
  return `${url}${url.includes('?') ? '&' : '?'}cfAccountId=${encodeURIComponent(cfAccountId)}`;
}

export default function ObjectsTab({
  locale,
  apiBase,
  cfAccountId,
}: {
  locale: Locale;
  apiBase: string;
  cfAccountId?: string | null;
}) {
  const [prefix, setPrefix] = useState('');
  const [objects, setObjects] = useState<R2Object[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ key: string; size: number | null } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { showToast } = useToast();
  const confirm = useConfirm();

  const load = useCallback(
    async (p: string, cur: string | null, append: boolean) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const params = new URLSearchParams();
        if (p) params.set('prefix', p);
        if (cur) params.set('cursor', cur);
        const res = await fetch(withCf(`${apiBase}/objects?${params}`, cfAccountId));
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          // 403 = token 缺 R2 权限：只影响本 tab，给本地化提示（不破坏整页）
          setLoadError(
            res.status === 403 ? t(locale, 'r2.forbiddenHint') : (body?.error ?? t(locale, 'common.requestFailed')),
          );
          return;
        }
        setLoadError(null);
        const data = (await res.json()) as { objects: R2Object[]; cursor: string | null };
        setObjects((prev) => (append ? [...prev, ...data.objects] : data.objects));
        setCursor(data.cursor);
      } catch {
        setLoadError(t(locale, 'common.requestFailed'));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [apiBase, cfAccountId, locale],
  );

  useEffect(() => {
    void load(prefix, null, false);
  }, [prefix, load]);

  /** 面包屑：'' → ['根']；'a/b/' → ['根', 'a', 'b'] */
  const crumbs = prefix === '' ? [] : prefix.replace(/\/$/, '').split('/');

  function enterPrefix(p: string) {
    setObjects([]);
    setCursor(null);
    setPrefix(p);
  }

  async function download(obj: R2Object) {
    try {
      const res = await fetch(withCf(`${apiBase}/presign`, cfAccountId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: obj.key, op: 'get', download: true }),
      });
      if (!res.ok) {
        showToast(res.status === 403 ? t(locale, 'r2.forbiddenHint') : t(locale, 'common.requestFailed'), 'error');
        return;
      }
      const { url } = (await res.json()) as { url: string };
      window.open(url, '_blank', 'noopener');
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
  }

  async function removeObject(obj: R2Object) {
    const ok = await confirm({
      title: t(locale, 'r2.confirmDeleteObject', { key: obj.key }),
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    try {
      const res = await fetch(withCf(`${apiBase}/objects?key=${encodeURIComponent(obj.key)}`, cfAccountId), {
        method: 'DELETE',
      });
      if (!res.ok) {
        showToast(res.status === 403 ? t(locale, 'r2.forbiddenHint') : t(locale, 'common.requestFailed'), 'error');
        return;
      }
      showToast(t(locale, 'r2.objectDeleted'), 'success');
      void load(prefix, null, false);
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
  }

  async function upload(file: globalThis.File) {
    const key = prefix + file.name;
    try {
      const res = await fetch(withCf(`${apiBase}/presign`, cfAccountId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, op: 'put' }),
      });
      if (!res.ok) {
        showToast(res.status === 403 ? t(locale, 'r2.forbiddenHint') : t(locale, 'r2.uploadFailed'), 'error');
        return;
      }
      const { url } = (await res.json()) as { url: string };
      // XHR 直传 R2（预签名 PUT）：fetch 不提供上传进度，用 XHR 的 upload.onprogress
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', url);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setUploadPct(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`));
        xhr.onerror = () => reject(new Error('network error'));
        xhr.send(file);
      });
      showToast(t(locale, 'r2.uploadDone', { name: file.name }), 'success');
      void load(prefix, null, false);
    } catch {
      showToast(t(locale, 'r2.uploadFailed'), 'error');
    } finally {
      setUploadPct(null);
    }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <nav className="breadcrumbs min-w-0 flex-1 text-sm">
          <ul>
            <li>
              <button type="button" className="link-hover" onClick={() => enterPrefix('')}>
                {t(locale, 'r2.objectsRoot')}
              </button>
            </li>
            {crumbs.map((seg, i) => (
              <li key={`${i}-${seg}`}>
                <button
                  type="button"
                  className="link-hover font-mono"
                  onClick={() => enterPrefix(`${crumbs.slice(0, i + 1).join('/')}/`)}
                >
                  {seg}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <input
          ref={fileInput}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = '';
          }}
        />
        <button
          className="btn btn-primary btn-sm shrink-0"
          disabled={uploadPct !== null}
          onClick={() => fileInput.current?.click()}
          title={t(locale, 'r2.upload')}
        >
          <Upload size={14} strokeWidth={1.75} />
          <span className="hidden whitespace-nowrap sm:inline">
            {uploadPct !== null ? t(locale, 'r2.uploading', { pct: uploadPct }) : t(locale, 'r2.upload')}
          </span>
        </button>
      </div>

      {uploadPct !== null && <progress className="progress progress-primary mb-3 w-full" value={uploadPct} max={100} />}

      {loading ? (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <tbody>
              {Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  <td>
                    <div className="skeleton h-8" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : loadError ? (
        <div className="alert alert-warning text-sm">{loadError}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>{t(locale, 'r2.colObjectKey')}</th>
                <th className="hidden sm:table-cell">{t(locale, 'r2.colObjectSize')}</th>
                <th>{t(locale, 'r2.colObjectModified')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {objects.map((obj) =>
                obj.is_prefix ? (
                  <tr
                    key={obj.key}
                    className="cursor-pointer hover:bg-base-200/60"
                    onDoubleClick={() => enterPrefix(obj.key)}
                  >
                    <td>
                      <button
                        type="button"
                        className="link-hover inline-flex items-center gap-2 font-mono"
                        onClick={() => enterPrefix(obj.key)}
                      >
                        <Folder size={14} strokeWidth={1.75} className="shrink-0 opacity-60" />
                        {obj.key.slice(prefix.length)}
                      </button>
                    </td>
                    <td className="hidden sm:table-cell">—</td>
                    <td>—</td>
                    <td />
                  </tr>
                ) : (
                  <tr key={obj.key}>
                    <td>
                      <button
                        type="button"
                        className="link-hover inline-flex min-w-0 items-center gap-2 text-left font-mono hover:text-primary"
                        title={previewKind(obj.key) ? t(locale, 'r2.preview') : t(locale, 'r2.download')}
                        onClick={() => {
                          if (previewKind(obj.key)) setPreview({ key: obj.key, size: obj.size });
                          else void download(obj);
                        }}
                      >
                        <File size={14} strokeWidth={1.75} className="shrink-0 opacity-40" />
                        <span className="min-w-0 break-all">{obj.key.slice(prefix.length)}</span>
                      </button>
                    </td>
                    <td className="hidden sm:table-cell">
                      <span className="font-mono text-xs">{formatBytes(obj.size)}</span>
                    </td>
                    <td>
                      {obj.last_modified ? (
                        <span className="font-mono text-xs opacity-60" title={obj.last_modified}>
                          {relativeTime(obj.last_modified, locale)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <span className="inline-flex gap-1">
                        <button className="btn btn-xs whitespace-nowrap" onClick={() => void download(obj)}>
                          {t(locale, 'r2.download')}
                        </button>
                        <button
                          className="btn btn-ghost btn-xs whitespace-nowrap text-error"
                          onClick={() => void removeObject(obj)}
                        >
                          {t(locale, 'r2.deleteObject')}
                        </button>
                      </span>
                    </td>
                  </tr>
                ),
              )}
              {objects.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-center opacity-60">
                    {t(locale, 'r2.objectsEmpty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {cursor && !loading && !loadError && (
        <div className="mt-3 text-center">
          <button className="btn btn-sm" disabled={loadingMore} onClick={() => void load(prefix, cursor, true)}>
            {t(locale, 'r2.loadMore')}
          </button>
        </div>
      )}

      {preview && (
        <PreviewModal
          key={preview.key}
          locale={locale}
          apiBase={apiBase}
          cfAccountId={cfAccountId}
          object={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
