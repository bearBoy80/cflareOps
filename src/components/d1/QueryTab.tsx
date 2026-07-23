import { Play } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Locale, t } from '@/i18n';
import { isWriteSql } from '@/lib/sqlWrite';

const BROWSE_PAGE_SIZE = 50;
const HISTORY_MAX = 20;

interface QueryResultSet {
  columns: string[];
  rows: unknown[][];
  meta: { duration: number | null; changes: number | null; changed_db: boolean };
  truncated: boolean;
}

type QueryResponse = { results: QueryResultSet[] } | { error: { message: string } };

/** SQLite 标识符引用(浏览模式拼 SELECT 用) */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function browseSql(table: string, page: number): string {
  return `SELECT * FROM ${quoteIdent(table)} LIMIT ${BROWSE_PAGE_SIZE} OFFSET ${page * BROWSE_PAGE_SIZE}`;
}

export default function QueryTab({
  locale,
  apiBase,
  browse,
}: {
  locale: Locale;
  apiBase: string;
  browse: { table: string; seq: number } | null;
}) {
  const [sql, setSql] = useState('');
  const [running, setRunning] = useState(false);
  const [resp, setResp] = useState<QueryResponse | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  // 浏览模式:由表 Tab 触发,分页按钮改写 OFFSET 重跑;手动改动 SQL 后退出浏览模式
  const [browseState, setBrowseState] = useState<{ table: string; page: number } | null>(null);
  const [confirmSql, setConfirmSql] = useState<string | null>(null);
  const historyKey = `d1-query-history:${apiBase}`;
  const lastSeq = useRef(0);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(historyKey);
      if (raw) setHistory((JSON.parse(raw) as string[]).slice(0, HISTORY_MAX));
    } catch {
      // 历史损坏就从空开始
    }
  }, [historyKey]);

  const execute = useCallback(
    async (text: string, browseCtx: { table: string; page: number } | null) => {
      setRunning(true);
      setBrowseState(browseCtx);
      try {
        const res = await fetch(`${apiBase}/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql: text }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setResp({ error: { message: body?.error ?? t(locale, 'common.requestFailed') } });
          return;
        }
        setResp((await res.json()) as QueryResponse);
        if (!browseCtx) {
          setHistory((h) => {
            const next = [text, ...h.filter((x) => x !== text)].slice(0, HISTORY_MAX);
            try {
              localStorage.setItem(historyKey, JSON.stringify(next));
            } catch {
              // 存储满/禁用时历史静默降级
            }
            return next;
          });
        }
      } catch {
        setResp({ error: { message: t(locale, 'common.requestFailed') } });
      } finally {
        setRunning(false);
      }
    },
    [apiBase, historyKey, locale],
  );

  // 表 Tab 的「浏览数据」:填入生成的 SELECT 并直接执行(只读语句,无需确认)
  useEffect(() => {
    if (!browse || browse.seq === lastSeq.current) return;
    lastSeq.current = browse.seq;
    const text = browseSql(browse.table, 0);
    setSql(text);
    void execute(text, { table: browse.table, page: 0 });
  }, [browse, execute]);

  function run() {
    const text = sql.trim();
    if (!text || running) return;
    if (isWriteSql(text)) {
      setConfirmSql(text);
      return;
    }
    void execute(text, null);
  }

  function browsePageTo(page: number) {
    if (!browseState || running || page < 0) return;
    const text = browseSql(browseState.table, page);
    setSql(text);
    void execute(text, { table: browseState.table, page });
  }

  const results = resp && 'results' in resp ? resp.results : null;
  const lastRows = results?.[results.length - 1]?.rows.length ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <textarea
        className="textarea textarea-bordered min-h-28 w-full font-mono text-sm"
        placeholder={t(locale, 'd1.queryPlaceholder')}
        value={sql}
        onChange={(e) => {
          setSql(e.target.value);
          setBrowseState(null);
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            run();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn btn-primary btn-sm whitespace-nowrap"
          disabled={running || sql.trim() === ''}
          onClick={run}
        >
          {running ? <span className="loading loading-spinner loading-xs" /> : <Play size={14} strokeWidth={1.75} />}
          {running ? t(locale, 'd1.running') : t(locale, 'd1.run')}
        </button>
        {history.length > 0 && (
          <details className="dropdown">
            <summary className="btn btn-ghost btn-sm whitespace-nowrap">{t(locale, 'd1.historyTitle')}</summary>
            <ul className="menu dropdown-content z-10 max-h-64 w-72 max-w-[90vw] flex-nowrap overflow-y-auto rounded-box border border-base-300 bg-base-100 p-2 shadow">
              {history.map((h) => (
                <li key={h}>
                  <button
                    className="block truncate font-mono text-xs"
                    title={h}
                    onClick={(e) => {
                      setSql(h);
                      setBrowseState(null);
                      (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
                    }}
                  >
                    {h}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {resp && 'error' in resp && (
        <div className="alert alert-error">
          <pre className="min-w-0 whitespace-pre-wrap break-all font-mono text-xs">{resp.error.message}</pre>
        </div>
      )}

      {results?.map((r, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs opacity-70">
            <span className="shrink-0 whitespace-nowrap">{t(locale, 'd1.rowsReturned', { n: r.rows.length })}</span>
            {r.meta.duration !== null && (
              <span className="shrink-0 whitespace-nowrap">
                {t(locale, 'd1.duration', { ms: Math.round(r.meta.duration * 100) / 100 })}
              </span>
            )}
            {r.meta.changed_db && r.meta.changes !== null && (
              <span className="badge badge-warning badge-sm shrink-0 whitespace-nowrap">
                {t(locale, 'd1.changes', { n: r.meta.changes })}
              </span>
            )}
            {r.truncated && (
              <span className="badge badge-warning badge-sm shrink-0 whitespace-nowrap">
                {t(locale, 'd1.truncated')}
              </span>
            )}
          </div>
          {r.columns.length === 0 || r.rows.length === 0 ? (
            <p className="text-sm opacity-60">{t(locale, 'd1.resultEmpty')}</p>
          ) : (
            <div className="overflow-x-auto rounded-box border border-base-300">
              <table className="table table-sm">
                <thead>
                  <tr>
                    {r.columns.map((c) => (
                      <th key={c} className="font-mono">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci} className="max-w-64 truncate font-mono text-xs" title={String(cell ?? '')}>
                          {cell === null ? <span className="opacity-40">NULL</span> : String(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}

      {browseState && results && (
        <div className="flex items-center gap-2">
          <button
            className="btn btn-sm whitespace-nowrap"
            disabled={running || browseState.page === 0}
            onClick={() => browsePageTo(browseState.page - 1)}
          >
            {t(locale, 'd1.prevPage')}
          </button>
          <span className="font-mono text-xs opacity-60">{browseState.page + 1}</span>
          <button
            className="btn btn-sm whitespace-nowrap"
            disabled={running || lastRows < BROWSE_PAGE_SIZE}
            onClick={() => browsePageTo(browseState.page + 1)}
          >
            {t(locale, 'd1.nextPage')}
          </button>
        </div>
      )}

      {confirmSql !== null && (
        <dialog open className="modal modal-open">
          <div className="modal-box">
            <h3 className="text-lg font-bold">{t(locale, 'd1.writeConfirmTitle')}</h3>
            <p className="py-2 text-sm">{t(locale, 'd1.writeConfirmDesc')}</p>
            <pre className="max-h-40 overflow-auto rounded-box bg-base-200 p-2 font-mono text-xs">{confirmSql}</pre>
            <div className="modal-action">
              <button className="btn btn-ghost" onClick={() => setConfirmSql(null)}>
                {t(locale, 'common.cancel')}
              </button>
              <button
                className="btn btn-warning"
                onClick={() => {
                  setConfirmSql(null);
                  void execute(confirmSql, null);
                }}
              >
                {t(locale, 'common.confirm')}
              </button>
            </div>
          </div>
          <form
            method="dialog"
            className="modal-backdrop"
            onSubmit={(e) => {
              e.preventDefault();
              setConfirmSql(null);
            }}
          >
            <button type="submit" aria-label={t(locale, 'common.cancel')} />
          </form>
        </dialog>
      )}
    </div>
  );
}
