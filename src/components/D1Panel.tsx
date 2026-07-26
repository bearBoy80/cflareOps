import { DatabaseZap, Plus, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Locale, t } from '@/i18n';
import { localizePath } from '@/i18n/routing';
import { accountColor } from '@/lib/accountColor';
import { formatBytes } from '@/lib/formatBytes';
import { relativeTime } from '@/lib/time';
import DeleteDatabaseModal from './d1/DeleteDatabaseModal';
import TablePagination from './ui/TablePagination';
import { ToastProvider, useToast } from './ui/ToastProvider';
import { usePageshowRefresh } from './ui/usePageshowRefresh';

interface D1DatabaseItem {
  uuid: string;
  name: string;
  accountId: string;
  accountName: string;
  cfAccountId: string;
  cfAccountName: string | null;
  numTables: number | null;
  fileSize: number | null;
  createdAt: string | null;
  syncedAt: string;
}

interface AccountOption {
  id: string;
  name: string;
}

/** 列定义：className 同时用于 th/td/skeleton td 三处（移动端规则 2） */
const COLS = (locale: Locale) =>
  [
    { key: 'name', header: t(locale, 'd1.colName'), className: '' },
    { key: 'account', header: t(locale, 'd1.colAccount'), className: 'hidden md:table-cell' },
    { key: 'tables', header: t(locale, 'd1.colTables'), className: 'hidden sm:table-cell' },
    { key: 'size', header: t(locale, 'd1.colSize'), className: 'hidden sm:table-cell' },
    { key: 'created', header: t(locale, 'd1.colCreated'), className: '' },
    { key: 'actions', header: '', className: '' },
  ] as const;

function D1PanelInner({ locale }: { locale: Locale }) {
  const [rows, setRows] = useState<D1DatabaseItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ done: number; total: number } | null>(null);
  // 创建表单
  const [showCreate, setShowCreate] = useState(false);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [cfAccounts, setCfAccounts] = useState<AccountOption[]>([]);
  const [cfAccountsError, setCfAccountsError] = useState(false);
  const [createAccount, setCreateAccount] = useState('');
  const [createCfAccount, setCreateCfAccount] = useState('');
  const [createName, setCreateName] = useState('');
  const [createLocation, setCreateLocation] = useState('');
  const [creating, setCreating] = useState(false);
  /** 待删除的数据库行 + 删除中标志：驱动 DeleteDatabaseModal（输名确认，不用 ConfirmDialog） */
  const [deleteTarget, setDeleteTarget] = useState<D1DatabaseItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { showToast } = useToast();

  const cols = COLS(locale);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setSearch(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // 竞态守卫:翻页/搜索连发时旧请求后到会覆盖新结果——只让最新一次请求落地(同 QueryTab runSeq 模式)
  const reloadSeq = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey 是刻意的额外依赖，递增强制重拉
  const reload = useCallback(async () => {
    const seq = ++reloadSeq.current;
    setFetching(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), search });
      const res = await fetch(`/api/d1/databases?${params}`);
      if (seq !== reloadSeq.current) return;
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      const data = (await res.json()) as { databases: D1DatabaseItem[]; total: number };
      if (seq !== reloadSeq.current) return;
      setLoadError(false);
      if (data.databases.length === 0 && data.total > 0 && page > 1) {
        setPage(1);
        return;
      }
      setRows(data.databases);
      setTotal(data.total);
    } catch {
      if (seq === reloadSeq.current) setLoadError(true);
    } finally {
      if (seq === reloadSeq.current) {
        setLoading(false);
        setFetching(false);
      }
    }
  }, [page, pageSize, search, refreshKey]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 后退回本页命中 bfcache 时列表是快照旧数据——递增 refreshKey 强制重拉
  usePageshowRefresh(useCallback(() => setRefreshKey((k) => k + 1), []));

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/accounts');
        if (r.ok) setAccounts(((await r.json()) as { accounts?: AccountOption[] }).accounts ?? []);
      } catch {
        // 账号列表加载失败：创建表单降级为不可选，同步退化为单请求
      }
    })();
  }, []);

  // 选择账号后拉该 token 可见的 CF 账号列表。cancelled 守卫:快速切换账号时,
  // 旧账号的慢响应后到会覆盖新账号的列表,甚至把旧 token 的 cfAccountId 自动选进新账号的创建请求
  useEffect(() => {
    setCfAccounts([]);
    setCreateCfAccount('');
    setCfAccountsError(false);
    if (!createAccount) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/accounts/${encodeURIComponent(createAccount)}/cf-accounts`);
        if (cancelled) return;
        if (!r.ok) {
          setCfAccountsError(true);
          return;
        }
        const list = ((await r.json()) as { cfAccounts?: AccountOption[] }).cfAccounts ?? [];
        if (cancelled) return;
        setCfAccounts(list);
        if (list.length === 1) setCreateCfAccount(list[0].id);
        // 空列表意味着创建按钮永远点不亮:按加载失败提示,而不是无声死路
        if (list.length === 0) setCfAccountsError(true);
      } catch {
        if (!cancelled) setCfAccountsError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [createAccount]);

  const dbHref = useCallback(
    (row: D1DatabaseItem) =>
      localizePath(locale, `/d1/${encodeURIComponent(row.accountId)}/${encodeURIComponent(row.uuid)}`) +
      `?name=${encodeURIComponent(row.name)}`,
    [locale],
  );

  async function sync() {
    setSyncing(true);
    setSyncProgress(null);
    try {
      let databases = 0;
      let failureCount = 0;
      if (accounts.length <= 1) {
        const res = await fetch('/api/d1/sync', { method: 'POST' });
        if (!res.ok) {
          showToast(t(locale, 'common.requestFailed'), 'error');
          return;
        }
        const d = (await res.json()) as { databases: number; failures: unknown[] };
        databases = d.databases;
        failureCount = d.failures.length;
      } else {
        let done = 0;
        setSyncProgress({ done: 0, total: accounts.length });
        const queue = [...accounts];
        const runOne = async () => {
          for (;;) {
            const acct = queue.shift();
            if (!acct) return;
            try {
              const res = await fetch(`/api/d1/sync?accountId=${encodeURIComponent(acct.id)}`, { method: 'POST' });
              if (!res.ok) failureCount++;
              else {
                const d = (await res.json()) as { databases: number; failures: unknown[] };
                databases += d.databases;
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
      showToast(
        t(locale, 'd1.syncDone', { n: databases }) +
          (failureCount > 0 ? t(locale, 'd1.syncFailures', { m: failureCount }) : ''),
        failureCount > 0 ? 'error' : 'success',
      );
      setRefreshKey((k) => k + 1);
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setSyncing(false);
      setSyncProgress(null);
    }
  }

  const DB_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

  async function createDatabase() {
    if (!createAccount || !createCfAccount || creating) return;
    const name = createName.trim();
    if (!DB_NAME_RE.test(name)) {
      showToast(t(locale, 'd1.invalidName'), 'error');
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/d1/databases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: createAccount,
          cfAccountId: createCfAccount,
          name,
          ...(createLocation ? { primaryLocationHint: createLocation } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(body?.error ?? t(locale, 'common.requestFailed'), 'error');
        return;
      }
      showToast(t(locale, 'd1.created'), 'success');
      setShowCreate(false);
      setCreateName('');
      setRefreshKey((k) => k + 1);
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setCreating(false);
    }
  }

  async function deleteDatabase(row: D1DatabaseItem) {
    if (deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/d1/${encodeURIComponent(row.accountId)}/${encodeURIComponent(row.uuid)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(body?.error ?? t(locale, 'common.requestFailed'), 'error');
        return;
      }
      showToast(t(locale, 'd1.deleted'), 'success');
      setDeleteTarget(null);
      setRefreshKey((k) => k + 1);
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setDeleting(false);
    }
  }

  function cellFor(row: D1DatabaseItem, key: string) {
    switch (key) {
      case 'name':
        return (
          <a className="link-hover font-mono hover:text-primary" href={dbHref(row)}>
            {row.name}
          </a>
        );
      case 'account':
        return (
          <span className="inline-flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: accountColor(row.accountId) }}
            />
            {row.accountName}
          </span>
        );
      case 'tables':
        return <span className="font-mono text-xs">{row.numTables ?? '—'}</span>;
      case 'size':
        return <span className="font-mono text-xs">{formatBytes(row.fileSize)}</span>;
      case 'created':
        return row.createdAt ? (
          <span className="font-mono text-xs opacity-60" title={row.createdAt}>
            {relativeTime(row.createdAt, locale)}
          </span>
        ) : (
          <span>—</span>
        );
      case 'actions':
        return (
          <span className="inline-flex gap-1">
            <a className="btn btn-xs whitespace-nowrap" href={dbHref(row)}>
              {t(locale, 'd1.detail')}
            </a>
            <button
              className="btn btn-ghost btn-xs whitespace-nowrap text-error"
              disabled={deleteTarget !== null}
              onClick={() => setDeleteTarget(row)}
            >
              {t(locale, 'd1.delete')}
            </button>
          </span>
        );
      default:
        return null;
    }
  }

  const tableHead = (
    <thead>
      <tr>
        {cols.map((c) => (
          <th key={c.key} className={c.className}>
            {c.header}
          </th>
        ))}
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
            placeholder={t(locale, 'd1.searchPlaceholder')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </label>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn btn-sm" onClick={() => setShowCreate((v) => !v)} title={t(locale, 'd1.create')}>
            <Plus size={14} strokeWidth={1.75} />
            <span className="hidden whitespace-nowrap sm:inline">{t(locale, 'd1.create')}</span>
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={syncing}
            onClick={() => void sync()}
            title={t(locale, 'd1.sync')}
          >
            <RefreshCw size={14} strokeWidth={1.75} className={syncing ? 'animate-spin' : ''} />
            <span className="hidden whitespace-nowrap sm:inline">
              {syncing
                ? syncProgress
                  ? t(locale, 'common.syncProgress', { done: syncProgress.done, total: syncProgress.total })
                  : t(locale, 'd1.syncing')
                : t(locale, 'd1.sync')}
            </span>
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="mb-3 flex flex-col gap-2 rounded-box border border-base-300 p-3 sm:flex-row sm:flex-wrap sm:items-start">
          <select
            className="select select-bordered select-sm w-full sm:w-48"
            value={createAccount}
            onChange={(e) => setCreateAccount(e.target.value)}
          >
            <option value="">{t(locale, 'd1.createAccountPlaceholder')}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          {cfAccounts.length > 1 && (
            <select
              className="select select-bordered select-sm w-full sm:w-48"
              value={createCfAccount}
              onChange={(e) => setCreateCfAccount(e.target.value)}
            >
              <option value="">{t(locale, 'common.selectCfAccount')}</option>
              {cfAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          {cfAccountsError && (
            <p className="w-full text-error text-xs sm:self-center sm:w-auto">
              {t(locale, 'common.cfAccountsLoadFailed')}
            </p>
          )}
          <input
            type="text"
            className="input input-bordered input-sm w-full sm:w-56"
            placeholder={t(locale, 'd1.createNamePlaceholder')}
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
          />
          <select
            className="select select-bordered select-sm w-full sm:w-48"
            value={createLocation}
            onChange={(e) => setCreateLocation(e.target.value)}
          >
            <option value="">{t(locale, 'd1.createLocationAuto')}</option>
            {['wnam', 'enam', 'weur', 'eeur', 'apac', 'oc'].map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <button
            className="btn btn-primary btn-sm whitespace-nowrap"
            disabled={creating || !createAccount || !createCfAccount || createName.trim() === ''}
            onClick={() => void createDatabase()}
          >
            {creating && <span className="loading loading-spinner loading-xs" />}
            {t(locale, 'd1.create')}
          </button>
        </div>
      )}

      {loading ? (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            {tableHead}
            <tbody>
              {Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {cols.map((c) => (
                    <td key={c.key} className={c.className}>
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
          <button className="btn btn-ghost btn-sm" onClick={() => void reload()}>
            {t(locale, 'common.retry')}
          </button>
        </div>
      ) : total === 0 && search === '' ? (
        <div className="flex flex-col items-center gap-4 py-12">
          <DatabaseZap size={48} strokeWidth={1.75} className="opacity-40" />
          <p className="text-sm opacity-60">{t(locale, 'd1.empty')}</p>
        </div>
      ) : (
        <div className={`transition-opacity${fetching ? ' pointer-events-none opacity-50' : ''}`}>
          <div className="overflow-x-auto">
            <table className="table table-sm">
              {tableHead}
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={`${row.accountId}/${row.uuid}`}
                    className="cursor-pointer hover:bg-base-200/60"
                    onDoubleClick={() => {
                      window.location.href = dbHref(row);
                    }}
                  >
                    {cols.map((c) => (
                      <td key={c.key} className={c.className}>
                        {cellFor(row, c.key)}
                      </td>
                    ))}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={cols.length} className="text-center opacity-60">
                      {t(locale, 'd1.noMatch')}
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

      {deleteTarget && (
        <DeleteDatabaseModal
          locale={locale}
          name={deleteTarget.name}
          deleting={deleting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void deleteDatabase(deleteTarget)}
        />
      )}
    </div>
  );
}

export default function D1Panel({ locale }: { locale: Locale }) {
  return (
    <ToastProvider>
      <D1PanelInner locale={locale} />
    </ToastProvider>
  );
}
