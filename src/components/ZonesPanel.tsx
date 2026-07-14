import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, Globe, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Locale, t } from '@/i18n';
import { localizePath } from '@/i18n/routing';
import { accountColor } from '@/lib/accountColor';
import { relativeTime } from '@/lib/time';
import TablePagination from './ui/TablePagination';
import { ToastProvider, useToast } from './ui/ToastProvider';

interface ZoneItem {
  id: string;
  accountId: string;
  accountName: string;
  name: string;
  status: string | null;
  paused: boolean;
  planName: string | null;
  syncedAt: string;
}

interface AccountOption {
  id: string;
  name: string;
}

const columnHelper = createColumnHelper<ZoneItem>();

const STATUS_OPTIONS = ['active', 'pending', 'initializing', 'moved', 'paused'] as const;

/** 列响应式类：columnDef.meta.className 应用到 th/td/skeleton td（窄屏隐藏次要列约定） */
function colClass(col: { columnDef: { meta?: unknown } }): string | undefined {
  return (col.columnDef.meta as { className?: string } | undefined)?.className;
}

function SortIcon({ sorted }: { sorted: false | 'asc' | 'desc' }) {
  if (sorted === 'asc') return <ArrowUp size={14} strokeWidth={1.75} />;
  if (sorted === 'desc') return <ArrowDown size={14} strokeWidth={1.75} />;
  return <ArrowUpDown size={14} strokeWidth={1.75} className="opacity-40" />;
}

function ZonesPanelInner({ locale }: { locale: Locale }) {
  const [zones, setZones] = useState<ZoneItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [accountId, setAccountId] = useState('');
  const [accountOptions, setAccountOptions] = useState<AccountOption[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ done: number; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([]);
  const { showToast } = useToast();

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const hasFilters = search !== '' || status !== '' || accountId !== '';

  // Fetch account options for the dropdown (silent fail)
  useEffect(() => {
    fetch('/api/accounts')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        const d = data as { accounts?: AccountOption[] } | null;
        if (d?.accounts) setAccountOptions(d.accounts);
      })
      .catch(() => {
        // silent degradation
      });
  }, []);

  // Debounce searchInput → search (also resets page)
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setSearch(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const reload = useCallback(async () => {
    setFetching(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        search,
        status,
        accountId,
      });
      const res = await fetch(`/api/zones?${params.toString()}`);
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      setLoadError(false);
      const data = (await res.json()) as { zones: ZoneItem[]; total: number };
      // 页码越界（如缩小 pageSize 后）：保留旧行，回到第 1 页由下一次请求刷新
      if (data.zones.length === 0 && data.total > 0 && page > 1) {
        setPage(1);
        return;
      }
      setZones(data.zones);
      setTotal(data.total);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
      setFetching(false);
    }
  }, [page, pageSize, search, status, accountId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const columns = useMemo(
    () => [
      columnHelper.accessor('name', {
        header: t(locale, 'zones.colDomain'),
        cell: (info) => (
          <a
            className="link-hover font-mono hover:text-primary"
            href={localizePath(locale, `/zones/${info.row.original.id}/dns`)}
          >
            {info.getValue()}
          </a>
        ),
      }),
      columnHelper.accessor('accountName', {
        header: t(locale, 'zones.colAccount'),
        meta: { className: 'hidden md:table-cell' },
        cell: (info) => (
          <span className="inline-flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: accountColor(info.row.original.accountId) }}
            />
            {info.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor((row) => (row.paused ? 'paused' : (row.status ?? '')), {
        id: 'status',
        header: t(locale, 'zones.colStatus'),
        meta: { className: 'hidden sm:table-cell' },
        cell: (info) => {
          const row = info.row.original;
          return (
            <span className="font-mono text-xs">
              {row.paused ? <span className="text-warning">paused</span> : (row.status ?? '—')}
            </span>
          );
        },
      }),
      columnHelper.accessor('planName', {
        header: t(locale, 'zones.colPlan'),
        meta: { className: 'hidden lg:table-cell' },
        cell: (info) => {
          const val = info.getValue();
          return val ? <span className="badge badge-outline badge-sm whitespace-nowrap">{val}</span> : <span>—</span>;
        },
      }),
      columnHelper.accessor('syncedAt', {
        header: t(locale, 'zones.colSynced'),
        cell: (info) => {
          const iso = info.getValue();
          return (
            <span className="font-mono text-xs opacity-60" title={iso}>
              {relativeTime(iso, locale)}
            </span>
          );
        },
      }),
      columnHelper.display({
        id: 'actions',
        cell: (info) => (
          <a className="btn btn-xs" href={localizePath(locale, `/zones/${info.row.original.id}/dns`)}>
            {t(locale, 'zones.dns')}
          </a>
        ),
      }),
    ],
    [locale],
  );

  const table = useReactTable({
    data: zones,
    columns,
    state: { sorting },
    manualPagination: true,
    manualFiltering: true,
    pageCount,
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  async function sync() {
    setSyncing(true);
    setSyncProgress(null);
    try {
      // 拿账号列表分批同步（每账号一个请求，子请求限额独立）；失败则退回单请求全量
      let accounts: { id: string }[] = [];
      try {
        const r = await fetch('/api/accounts');
        if (r.ok) accounts = ((await r.json()) as { accounts?: { id: string }[] }).accounts ?? [];
      } catch {
        // 静默降级到全量单请求
      }

      let synced = 0;
      let failureCount = 0;
      let requestError = false;

      if (accounts.length <= 1) {
        const res = await fetch('/api/zones/sync', { method: 'POST' });
        if (!res.ok) {
          requestError = true;
        } else {
          const data = (await res.json()) as { synced: number; failures: unknown[] };
          synced = data.synced;
          failureCount = data.failures.length;
        }
      } else {
        let done = 0;
        setSyncProgress({ done: 0, total: accounts.length });
        const queue = [...accounts];
        const runOne = async () => {
          for (;;) {
            const acct = queue.shift();
            if (!acct) return;
            try {
              const res = await fetch(`/api/zones/sync?accountId=${encodeURIComponent(acct.id)}`, {
                method: 'POST',
              });
              if (!res.ok) {
                failureCount++;
              } else {
                const d = (await res.json()) as { synced: number; failures: unknown[] };
                synced += d.synced;
                failureCount += d.failures.length;
              }
            } catch {
              failureCount++;
            }
            done++;
            setSyncProgress({ done, total: accounts.length });
          }
        };
        await Promise.all([runOne(), runOne()]);
      }

      if (requestError) {
        showToast(t(locale, 'common.requestFailed'), 'error');
        return;
      }
      if (failureCount > 0) {
        showToast(
          t(locale, 'zones.syncDone', { n: synced }) + t(locale, 'zones.syncFailures', { m: failureCount }),
          'error',
        );
      } else {
        showToast(t(locale, 'zones.syncDone', { n: synced }), 'success');
      }
      await reload();
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setSyncing(false);
      setSyncProgress(null);
    }
  }

  const tableHead = (
    <thead>
      <tr>
        {table.getHeaderGroups().flatMap((hg) =>
          hg.headers.map((header) => (
            <th key={header.id} className={colClass(header.column)}>
              {header.column.getCanSort() ? (
                <button
                  className="inline-flex cursor-pointer select-none items-center gap-1"
                  onClick={header.column.getToggleSortingHandler()}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                  <SortIcon sorted={header.column.getIsSorted()} />
                </button>
              ) : (
                flexRender(header.column.columnDef.header, header.getContext())
              )}
            </th>
          )),
        )}
      </tr>
    </thead>
  );

  return (
    <div className="card border border-base-300 bg-base-100 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="input input-bordered input-sm flex w-64 max-w-full items-center gap-2">
          <Search size={14} strokeWidth={1.75} className="shrink-0 opacity-40" />
          <input
            type="text"
            className="grow"
            placeholder={t(locale, 'zones.filterPlaceholder')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </label>
        <select
          className="select select-bordered select-sm w-36"
          value={status}
          onChange={(e) => {
            setPage(1);
            setStatus(e.target.value);
          }}
        >
          <option value="">{t(locale, 'zones.filterStatus')}</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          className="select select-bordered select-sm w-40"
          value={accountId}
          onChange={(e) => {
            setPage(1);
            setAccountId(e.target.value);
          }}
        >
          <option value="">{t(locale, 'zones.filterAccount')}</option>
          {accountOptions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {/* 窄屏收成纯图标按钮，≥sm 恢复图标+文字（同 WorkersPanel 约定） */}
        <button
          className="btn btn-primary btn-sm ml-auto"
          disabled={syncing}
          onClick={() => void sync()}
          title={t(locale, 'zones.sync')}
        >
          <RefreshCw size={14} strokeWidth={1.75} className={syncing ? 'animate-spin' : ''} />
          <span className="hidden whitespace-nowrap sm:inline">
            {syncing
              ? syncProgress
                ? t(locale, 'common.syncProgress', {
                    done: syncProgress.done,
                    total: syncProgress.total,
                  })
                : t(locale, 'zones.syncing')
              : t(locale, 'zones.sync')}
          </span>
        </button>
      </div>

      {loading ? (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            {tableHead}
            <tbody>
              {Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {table.getAllLeafColumns().map((col) => (
                    <td key={col.id} className={colClass(col)}>
                      <div className="skeleton h-8" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : loadError ? (
        <div className="alert alert-error flex items-center gap-3">
          <span className="text-sm">{t(locale, 'common.requestFailed')}</span>
          <button className="btn btn-sm btn-ghost" onClick={() => void reload()}>
            {t(locale, 'common.retry')}
          </button>
        </div>
      ) : total === 0 && !hasFilters ? (
        <div className="flex flex-col items-center gap-4 py-12">
          <Globe size={48} strokeWidth={1.75} className="opacity-40" />
          <p className="text-sm opacity-60">{t(locale, 'zones.empty')}</p>
          <a className="btn btn-sm btn-ghost" href={localizePath(locale, '/accounts')}>
            {t(locale, 'nav.accounts')}
          </a>
        </div>
      ) : (
        <div className={`transition-opacity${fetching ? ' pointer-events-none opacity-50' : ''}`}>
          <div className="overflow-x-auto">
            <table className="table table-sm">
              {tableHead}
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className="cursor-pointer hover:bg-base-200/60"
                    onDoubleClick={() => {
                      window.location.href = localizePath(locale, `/zones/${row.original.id}/dns`);
                    }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className={colClass(cell.column)}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
                {zones.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center opacity-60">
                      {t(locale, 'zones.noMatch')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <TablePagination
            locale={locale}
            total={total}
            page={page}
            pageCount={pageCount}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(n) => {
              setPage(1);
              setPageSize(n);
            }}
          />
        </div>
      )}
    </div>
  );
}

export default function ZonesPanel({ locale }: { locale: Locale }) {
  return (
    <ToastProvider>
      <ZonesPanelInner locale={locale} />
    </ToastProvider>
  );
}
