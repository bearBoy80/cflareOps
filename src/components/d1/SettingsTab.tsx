import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/ui/ToastProvider';
import { type Locale, t } from '@/i18n';
import { localizePath } from '@/i18n/routing';
import { formatBytes } from '@/lib/formatBytes';
import DeleteDatabaseModal from './DeleteDatabaseModal';

interface D1Detail {
  uuid: string;
  name: string;
  version: string | null;
  created_at: string | null;
  num_tables: number | null;
  file_size: number | null;
  read_replication_mode: 'auto' | 'disabled' | null;
}

export default function SettingsTab({ locale, apiBase }: { locale: Locale; apiBase: string }) {
  const [detail, setDetail] = useState<D1Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [savingReplication, setSavingReplication] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { showToast } = useToast();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiBase);
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      setLoadError(false);
      setDetail(((await res.json()) as { database: D1Detail }).database);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function toggleReplication(next: 'auto' | 'disabled') {
    if (savingReplication) return;
    setSavingReplication(true);
    try {
      const res = await fetch(apiBase, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(body?.error ?? t(locale, 'common.requestFailed'), 'error');
        return;
      }
      const updated = ((await res.json()) as { database: D1Detail }).database;
      // 防御性合并:CF edit 响应理论上应带全字段,但若缺字段(如 num_tables/file_size)不应整替丢显
      setDetail((prev) => (prev ? { ...prev, ...updated } : updated));
      showToast(t(locale, 'd1.replicationUpdated'), 'success');
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setSavingReplication(false);
    }
  }

  async function deleteDatabase() {
    setDeleting(true);
    try {
      const res = await fetch(apiBase, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(body?.error ?? t(locale, 'common.requestFailed'), 'error');
        setDeleting(false);
        return;
      }
      // 删除成功直接回列表页(当前详情页对应的资源已不存在)
      window.location.href = localizePath(locale, '/d1');
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
      setDeleting(false);
    }
  }

  if (loading) return <div className="skeleton h-48 w-full" />;
  if (loadError || !detail)
    return (
      <div className="alert alert-error flex items-center gap-3">
        <span className="text-sm">{t(locale, 'common.requestFailed')}</span>
        <button className="btn btn-ghost btn-sm" onClick={() => void reload()}>
          {t(locale, 'common.retry')}
        </button>
      </div>
    );

  const rows: [string, string][] = [
    [t(locale, 'd1.settingsUuid'), detail.uuid],
    [t(locale, 'd1.settingsVersion'), detail.version ?? '—'],
    [t(locale, 'd1.settingsSize'), formatBytes(detail.file_size)],
    [t(locale, 'd1.settingsTables'), detail.num_tables === null ? '—' : String(detail.num_tables)],
    [t(locale, 'd1.settingsCreated'), detail.created_at ?? '—'],
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto rounded-box border border-base-300">
        <table className="table table-sm">
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label}>
                <td className="whitespace-nowrap opacity-60">{label}</td>
                <td className="min-w-0 break-all font-mono text-xs">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3 rounded-box border border-base-300 p-3">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-sm">{t(locale, 'd1.settingsReplication')}</p>
          <p className="text-xs opacity-60">{t(locale, 'd1.replicationDesc')}</p>
        </div>
        {savingReplication && <span className="loading loading-spinner loading-xs shrink-0" />}
        <input
          type="checkbox"
          className="toggle toggle-primary shrink-0"
          checked={detail.read_replication_mode === 'auto'}
          disabled={savingReplication}
          onChange={(e) => void toggleReplication(e.target.checked ? 'auto' : 'disabled')}
        />
      </div>

      <div className="rounded-box border border-error/40 p-3">
        <p className="font-semibold text-error text-sm">{t(locale, 'd1.dangerZone')}</p>
        <p className="mt-1 text-xs opacity-60">{t(locale, 'd1.deleteDbDesc')}</p>
        <button className="btn btn-error btn-sm mt-3 whitespace-nowrap" onClick={() => setShowDelete(true)}>
          {t(locale, 'd1.delete')}
        </button>
      </div>

      {/* 输名确认必须对准 CF 实时返回的库名:URL ?name= 可被旧链接/手改带错,拿它确认等于给错误对象放行 */}
      {showDelete && (
        <DeleteDatabaseModal
          locale={locale}
          name={detail.name}
          deleting={deleting}
          onCancel={() => setShowDelete(false)}
          onConfirm={() => void deleteDatabase()}
        />
      )}
    </div>
  );
}
