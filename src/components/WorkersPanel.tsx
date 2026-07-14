import { ArrowDown, ArrowUp, ArrowUpDown, RefreshCw, Search, Workflow } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { type Locale, t } from '@/i18n';
import { localizePath } from '@/i18n/routing';
import { accountColor } from '@/lib/accountColor';
import { relativeTime } from '@/lib/time';
import TablePagination from './ui/TablePagination';
import { ToastProvider, useToast } from './ui/ToastProvider';

interface WorkerScriptItem {
  id: string;
  accountId: string;
  accountName: string;
  cfAccountId: string | null;
  cfAccountName: string | null;
  createdOn: string | null;
  modifiedOn: string | null;
  usageModel: string | null;
  lastDeployedFrom: string | null;
  syncedAt: string;
}

interface PagesProjectItem {
  name: string;
  accountId: string;
  accountName: string;
  cfAccountId: string | null;
  cfAccountName: string | null;
  subdomain: string | null;
  productionBranch: string | null;
  domains: string[];
  sourceRepo: string | null;
  createdOn: string | null;
  latestDeploymentOn: string | null;
  syncedAt: string;
}

interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** 提供该函数的列可排序（当前页内客户端排序，与 Zones 表语义一致） */
  sortValue?: (row: T) => string | number | null;
  /** 应用到 th/td 的响应式类（如 hidden md:table-cell 在窄屏隐藏次要列） */
  className?: string;
}

type SortState = { key: string; dir: 'asc' | 'desc' } | null;

function SortIcon({ dir }: { dir: 'asc' | 'desc' | null }) {
  if (dir === 'asc') return <ArrowUp size={14} strokeWidth={1.75} />;
  if (dir === 'desc') return <ArrowDown size={14} strokeWidth={1.75} />;
  return <ArrowUpDown size={14} strokeWidth={1.75} className="opacity-40" />;
}

function sortRows<T>(rows: T[], columns: Column<T>[], sort: SortState): T[] {
  if (!sort) return rows;
  const col = columns.find((c) => c.key === sort.key);
  if (!col?.sortValue) return rows;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = col.sortValue!(a);
    const vb = col.sortValue!(b);
    // 空值恒排最后，不随方向翻转
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
}

const extractScripts = (data: unknown): { rows: WorkerScriptItem[]; total: number } => {
  const d = data as { scripts: WorkerScriptItem[]; total: number };
  return { rows: d.scripts, total: d.total };
};

const extractProjects = (data: unknown): { rows: PagesProjectItem[]; total: number } => {
  const d = data as { projects: PagesProjectItem[]; total: number };
  return { rows: d.projects, total: d.total };
};

function AccountDot({ accountId, accountName }: { accountId: string; accountName: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: accountColor(accountId) }} />
      {accountName}
    </span>
  );
}

function RelativeCell({ iso, locale }: { iso: string | null; locale: Locale }) {
  if (!iso) return <span>—</span>;
  return (
    <span className="font-mono text-xs opacity-60" title={iso}>
      {relativeTime(iso, locale)}
    </span>
  );
}

interface ListSectionProps<T> {
  locale: Locale;
  hidden: boolean;
  endpoint: string;
  extract: (data: unknown) => { rows: T[]; total: number };
  columns: Column<T>[];
  rowKey: (row: T) => string;
  searchPlaceholder: string;
  noMatch: string;
  refreshKey: number;
  /** 初始排序（服务端已按此序返回，这里让表头指示与当页排序一致） */
  defaultSort?: SortState;
  /** 提供时行可双击跳转详情 */
  rowHref?: (row: T) => string;
}

function ListSection<T>({
  locale,
  hidden,
  endpoint,
  extract,
  columns,
  rowKey,
  searchPlaceholder,
  noMatch,
  refreshKey,
  defaultSort,
  rowHref,
}: ListSectionProps<T>) {
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [sort, setSort] = useState<SortState>(defaultSort ?? null);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const displayedRows = useMemo(() => sortRows(rows, columns, sort), [rows, columns, sort]);

  function toggleSort(key: string) {
    setSort((s) => {
      if (s?.key !== key) return { key, dir: 'asc' };
      if (s.dir === 'asc') return { key, dir: 'desc' };
      return null;
    });
  }

  // Debounce searchInput → search (also resets page)
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setSearch(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is an intentional extra dep — bumping it forces a refetch
  const reload = useCallback(async () => {
    setFetching(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        search,
      });
      const res = await fetch(`${endpoint}?${params.toString()}`);
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      setLoadError(false);
      const data = extract(await res.json());
      // 页码越界（如缩小 pageSize 后）：保留旧行，回到第 1 页由下一次请求刷新
      if (data.rows.length === 0 && data.total > 0 && page > 1) {
        setPage(1);
        return;
      }
      setRows(data.rows);
      setTotal(data.total);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
      setFetching(false);
    }
    // refreshKey：同步成功后由父组件递增，强制两个 tab 重新拉取
  }, [endpoint, extract, page, pageSize, search, refreshKey]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const tableHead = (
    <thead>
      <tr>
        {columns.map((col) => (
          <th key={col.key} className={col.className}>
            {col.sortValue ? (
              <button
                className="inline-flex cursor-pointer select-none items-center gap-1"
                onClick={() => toggleSort(col.key)}
              >
                {col.header}
                <SortIcon dir={sort?.key === col.key ? sort.dir : null} />
              </button>
            ) : (
              col.header
            )}
          </th>
        ))}
      </tr>
    </thead>
  );

  return (
    <div className={hidden ? 'hidden' : ''}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="input input-bordered input-sm flex w-64 max-w-full items-center gap-2">
          <Search size={14} strokeWidth={1.75} className="shrink-0 opacity-40" />
          <input
            type="text"
            className="grow"
            placeholder={searchPlaceholder}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </label>
      </div>

      {loading ? (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            {tableHead}
            <tbody>
              {Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {columns.map((col) => (
                    <td key={col.key} className={col.className}>
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
      ) : total === 0 && search === '' ? (
        <div className="flex flex-col items-center gap-4 py-12">
          <Workflow size={48} strokeWidth={1.75} className="opacity-40" />
          <p className="text-sm opacity-60">{t(locale, 'workers.empty')}</p>
        </div>
      ) : (
        <div className={`transition-opacity${fetching ? ' pointer-events-none opacity-50' : ''}`}>
          <div className="overflow-x-auto">
            <table className="table table-sm">
              {tableHead}
              <tbody>
                {displayedRows.map((row) => (
                  <tr
                    key={rowKey(row)}
                    className={rowHref ? 'cursor-pointer hover:bg-base-200/60' : undefined}
                    onDoubleClick={
                      rowHref
                        ? () => {
                            window.location.href = rowHref(row);
                          }
                        : undefined
                    }
                  >
                    {columns.map((col) => (
                      <td key={col.key} className={col.className}>
                        {col.cell(row)}
                      </td>
                    ))}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={columns.length} className="text-center opacity-60">
                      {noMatch}
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

type TabKey = 'scripts' | 'pages';
const TAB_STORAGE_KEY = 'workersPagesTab';

function WorkersPanelInner({ locale, initialTab }: { locale: Locale; initialTab?: TabKey }) {
  const [tab, setTab] = useState<TabKey>(initialTab ?? 'scripts');
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ done: number; total: number } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const { showToast } = useToast();

  // URL ?tab= 显式指定时以其为准（并记住）；否则恢复上次离开时所在的 tab
  useEffect(() => {
    if (initialTab) {
      localStorage.setItem(TAB_STORAGE_KEY, initialTab);
      return;
    }
    const saved = localStorage.getItem(TAB_STORAGE_KEY);
    if (saved === 'scripts' || saved === 'pages') setTab(saved);
  }, [initialTab]);

  function switchTab(next: TabKey) {
    setTab(next);
    localStorage.setItem(TAB_STORAGE_KEY, next);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', next);
    window.history.replaceState(null, '', url);
  }

  const scriptHref = useCallback(
    (row: WorkerScriptItem) =>
      localizePath(locale, `/workers/scripts/${row.accountId}/${encodeURIComponent(row.id)}`) +
      (row.cfAccountId ? `?cfAccountId=${encodeURIComponent(row.cfAccountId)}` : ''),
    [locale],
  );

  const projectHref = useCallback(
    (row: PagesProjectItem) =>
      localizePath(locale, `/workers/pages/${row.accountId}/${encodeURIComponent(row.name)}`) +
      (row.cfAccountId ? `?cfAccountId=${encodeURIComponent(row.cfAccountId)}` : ''),
    [locale],
  );

  const scriptColumns = useMemo<Column<WorkerScriptItem>[]>(
    () => [
      {
        key: 'script',
        header: t(locale, 'workers.colScript'),
        cell: (row) => (
          <a className="link-hover font-mono hover:text-primary" href={scriptHref(row)}>
            {row.id}
          </a>
        ),
        sortValue: (row) => row.id,
      },
      {
        key: 'account',
        header: t(locale, 'workers.colAccount'),
        cell: (row) => <AccountDot accountId={row.accountId} accountName={row.accountName} />,
        sortValue: (row) => row.accountName,
        className: 'hidden md:table-cell',
      },
      {
        key: 'cfAccount',
        header: t(locale, 'workers.colCfAccount'),
        cell: (row) => <span className="text-xs opacity-60">{row.cfAccountName ?? '—'}</span>,
        sortValue: (row) => row.cfAccountName,
        className: 'hidden lg:table-cell',
      },
      {
        key: 'usageModel',
        header: t(locale, 'workers.colUsageModel'),
        cell: (row) =>
          row.usageModel ? <span className="badge badge-outline badge-sm">{row.usageModel}</span> : <span>—</span>,
        sortValue: (row) => row.usageModel,
        className: 'hidden sm:table-cell',
      },
      {
        key: 'modified',
        header: t(locale, 'workers.colModified'),
        cell: (row) => <RelativeCell iso={row.modifiedOn} locale={locale} />,
        sortValue: (row) => row.modifiedOn,
      },
      {
        key: 'actions',
        header: '',
        cell: (row) => (
          <a className="btn btn-xs whitespace-nowrap" href={scriptHref(row)}>
            {t(locale, 'workers.detail')}
          </a>
        ),
      },
    ],
    [locale, scriptHref],
  );

  const projectColumns = useMemo<Column<PagesProjectItem>[]>(
    () => [
      {
        key: 'project',
        header: t(locale, 'workers.colProject'),
        cell: (row) => (
          <a className="link-hover font-mono hover:text-primary" href={projectHref(row)}>
            {row.name}
          </a>
        ),
        sortValue: (row) => row.name,
      },
      {
        key: 'account',
        header: t(locale, 'workers.colAccount'),
        cell: (row) => <AccountDot accountId={row.accountId} accountName={row.accountName} />,
        sortValue: (row) => row.accountName,
        className: 'hidden md:table-cell',
      },
      {
        key: 'branch',
        header: t(locale, 'workers.colBranch'),
        cell: (row) =>
          row.productionBranch ? (
            <span className="badge badge-ghost badge-sm font-mono">{row.productionBranch}</span>
          ) : (
            <span>—</span>
          ),
        sortValue: (row) => row.productionBranch,
        className: 'hidden lg:table-cell',
      },
      {
        key: 'domains',
        header: t(locale, 'workers.colDomains'),
        cell: (row) =>
          row.domains.length === 0 ? (
            <span>—</span>
          ) : (
            <span className="inline-flex flex-wrap items-center gap-1">
              {row.domains.slice(0, 2).map((d) => (
                <span key={d} className="badge badge-outline badge-sm">
                  {d}
                </span>
              ))}
              {row.domains.length > 2 && <span className="text-xs opacity-60">+{row.domains.length - 2}</span>}
            </span>
          ),
        className: 'hidden sm:table-cell',
      },
      {
        key: 'lastDeploy',
        header: t(locale, 'workers.colLastDeploy'),
        cell: (row) => <RelativeCell iso={row.latestDeploymentOn} locale={locale} />,
        sortValue: (row) => row.latestDeploymentOn,
      },
      {
        key: 'actions',
        header: '',
        cell: (row) => (
          <a className="btn btn-xs whitespace-nowrap" href={projectHref(row)}>
            {t(locale, 'workers.detail')}
          </a>
        ),
      },
    ],
    [locale, projectHref],
  );

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

      let scripts = 0;
      let projects = 0;
      let failureCount = 0;
      let requestError = false;

      if (accounts.length <= 1) {
        const res = await fetch('/api/workers/sync', { method: 'POST' });
        if (!res.ok) {
          requestError = true;
        } else {
          const data = (await res.json()) as {
            scripts: number;
            projects: number;
            failures: unknown[];
          };
          scripts = data.scripts;
          projects = data.projects;
          failureCount = data.failures.length;
        }
      } else {
        // 分批：每账号一个请求，并发 2，实时进度
        let done = 0;
        setSyncProgress({ done: 0, total: accounts.length });
        const queue = [...accounts];
        const runOne = async () => {
          for (;;) {
            const acct = queue.shift();
            if (!acct) return;
            try {
              const res = await fetch(`/api/workers/sync?accountId=${encodeURIComponent(acct.id)}`, { method: 'POST' });
              if (!res.ok) {
                failureCount++;
              } else {
                const d = (await res.json()) as {
                  scripts: number;
                  projects: number;
                  failures: unknown[];
                };
                scripts += d.scripts;
                projects += d.projects;
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
          t(locale, 'workers.syncDone', { s: scripts, p: projects }) +
            t(locale, 'workers.syncFailures', { m: failureCount }),
          'error',
        );
      } else {
        showToast(t(locale, 'workers.syncDone', { s: scripts, p: projects }), 'success');
      }
      setRefreshKey((k) => k + 1);
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setSyncing(false);
      setSyncProgress(null);
    }
  }

  return (
    <div className="card border border-base-300 bg-base-100 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="tablist" className="tabs tabs-border">
          <button
            role="tab"
            className={`tab${tab === 'scripts' ? ' tab-active' : ''}`}
            onClick={() => switchTab('scripts')}
          >
            {t(locale, 'workers.tabScripts')}
          </button>
          <button
            role="tab"
            className={`tab${tab === 'pages' ? ' tab-active' : ''}`}
            onClick={() => switchTab('pages')}
          >
            {t(locale, 'workers.tabPages')}
          </button>
        </div>
        {/* 窄屏收成纯图标按钮与 tab 同行，≥sm 恢复图标+文字 */}
        <button
          className="btn btn-primary btn-sm ml-auto"
          disabled={syncing}
          onClick={() => void sync()}
          title={t(locale, 'workers.sync')}
        >
          <RefreshCw size={14} strokeWidth={1.75} className={syncing ? 'animate-spin' : ''} />
          <span className="hidden whitespace-nowrap sm:inline">
            {syncing
              ? syncProgress
                ? t(locale, 'common.syncProgress', {
                    done: syncProgress.done,
                    total: syncProgress.total,
                  })
                : t(locale, 'workers.syncing')
              : t(locale, 'workers.sync')}
          </span>
        </button>
      </div>

      <ListSection
        locale={locale}
        hidden={tab !== 'scripts'}
        endpoint="/api/workers/scripts"
        extract={extractScripts}
        columns={scriptColumns}
        rowKey={(row) => `${row.accountId}/${row.cfAccountId ?? ''}/${row.id}`}
        searchPlaceholder={t(locale, 'workers.searchScripts')}
        noMatch={t(locale, 'workers.noMatchScripts')}
        refreshKey={refreshKey}
        defaultSort={{ key: 'modified', dir: 'desc' }}
        rowHref={scriptHref}
      />
      <ListSection
        locale={locale}
        hidden={tab !== 'pages'}
        endpoint="/api/pages/projects"
        extract={extractProjects}
        columns={projectColumns}
        rowKey={(row) => `${row.accountId}/${row.cfAccountId ?? ''}/${row.name}`}
        searchPlaceholder={t(locale, 'workers.searchPages')}
        noMatch={t(locale, 'workers.noMatchPages')}
        refreshKey={refreshKey}
        defaultSort={{ key: 'lastDeploy', dir: 'desc' }}
        rowHref={projectHref}
      />
    </div>
  );
}

export default function WorkersPanel({ locale, initialTab }: { locale: Locale; initialTab?: TabKey }) {
  return (
    <ToastProvider>
      <WorkersPanelInner locale={locale} initialTab={initialTab} />
    </ToastProvider>
  );
}
