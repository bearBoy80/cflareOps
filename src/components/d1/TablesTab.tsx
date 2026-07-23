import { Table2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { type Locale, t } from '@/i18n';

interface TableInfo {
  name: string;
  rowCount: number;
  columns: { name: string; type: string; notnull: boolean; pk: boolean; dflt_value: string | null }[];
}

export default function TablesTab({
  locale,
  apiBase,
  onBrowse,
}: {
  locale: Locale;
  apiBase: string;
  onBrowse: (table: string) => void;
}) {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/tables`);
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      setLoadError(false);
      const data = (await res.json()) as { tables: TableInfo[]; truncated: boolean };
      setTables(data.tables);
      setTruncated(data.truncated);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) return <div className="skeleton h-32 w-full" />;
  if (loadError)
    return (
      <div className="alert alert-error flex items-center gap-3">
        <span className="text-sm">{t(locale, 'common.requestFailed')}</span>
        <button className="btn btn-ghost btn-sm" onClick={() => void reload()}>
          {t(locale, 'common.retry')}
        </button>
      </div>
    );
  if (tables.length === 0)
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <Table2 size={48} strokeWidth={1.75} className="opacity-40" />
        <p className="text-sm opacity-60">{t(locale, 'd1.tablesEmpty')}</p>
      </div>
    );

  return (
    <div className="flex flex-col gap-2">
      {truncated && <div className="alert alert-warning text-sm">{t(locale, 'd1.tablesTruncated')}</div>}
      {tables.map((tb) => (
        <div key={tb.name} className="rounded-box border border-base-300">
          <div className="flex flex-wrap items-center gap-2 p-3">
            <button
              className="link-hover min-w-0 break-all text-left font-mono font-semibold hover:text-primary"
              onClick={() => setExpanded((e) => (e === tb.name ? null : tb.name))}
            >
              {tb.name}
            </button>
            <span className="badge badge-ghost badge-sm shrink-0 whitespace-nowrap">
              {t(locale, 'd1.colRowCount')}: {tb.rowCount}
            </span>
            <button className="btn btn-xs ml-auto shrink-0 whitespace-nowrap" onClick={() => onBrowse(tb.name)}>
              {t(locale, 'd1.browse')}
            </button>
          </div>
          {expanded === tb.name && (
            <div className="overflow-x-auto border-base-300 border-t">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>{t(locale, 'd1.colColumn')}</th>
                    <th>{t(locale, 'd1.colType')}</th>
                    <th className="hidden sm:table-cell">{t(locale, 'd1.colNotNull')}</th>
                    <th className="hidden sm:table-cell">{t(locale, 'd1.colDefault')}</th>
                    <th>{t(locale, 'd1.colPk')}</th>
                  </tr>
                </thead>
                <tbody>
                  {tb.columns.map((c) => (
                    <tr key={c.name}>
                      <td className="font-mono">{c.name}</td>
                      <td className="font-mono text-xs opacity-70">{c.type || '—'}</td>
                      <td className="hidden sm:table-cell">{c.notnull ? '✓' : ''}</td>
                      <td className="hidden font-mono text-xs sm:table-cell">{c.dflt_value ?? '—'}</td>
                      <td>{c.pk ? '✓' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
