import { Database, Plus, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { type Locale, t } from '@/i18n';
import { localizePath } from '@/i18n/routing';
import { accountColor } from '@/lib/accountColor';
import { formatBytes } from '@/lib/formatBytes';
import { relativeTime } from '@/lib/time';
import { ConfirmDialogProvider, useConfirm } from './ui/ConfirmDialog';
import TablePagination from './ui/TablePagination';
import { ToastProvider, useToast } from './ui/ToastProvider';
import { usePageshowRefresh } from './ui/usePageshowRefresh';

interface R2BucketItem {
  name: string;
  accountId: string;
  accountName: string;
  cfAccountId: string;
  cfAccountName: string | null;
  location: string | null;
  storageClass: string | null;
  creationDate: string | null;
  payloadSize: number | null;
  objectCount: number | null;
  syncedAt: string;
}

interface AccountOption {
  id: string;
  name: string;
}

/** 列定义：className 同时用于 th/td/skeleton td 三处（移动端规则 2） */
const COLS = (locale: Locale) =>
  [
    { key: 'name', header: t(locale, 'r2.colName'), className: '' },
    { key: 'account', header: t(locale, 'r2.colAccount'), className: 'hidden md:table-cell' },
    { key: 'location', header: t(locale, 'r2.colLocation'), className: 'hidden lg:table-cell' },
    { key: 'storageClass', header: t(locale, 'r2.colStorageClass'), className: 'hidden lg:table-cell' },
    { key: 'size', header: t(locale, 'r2.colSize'), className: 'hidden sm:table-cell' },
    { key: 'objects', header: t(locale, 'r2.colObjects'), className: 'hidden sm:table-cell' },
    { key: 'created', header: t(locale, 'r2.colCreated'), className: '' },
    { key: 'actions', header: '', className: '' },
  ] as const;

function R2PanelInner({ locale }: { locale: Locale }) {
  const [rows, setRows] = useState<R2BucketItem[]>([]);
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
  const [createAccount, setCreateAccount] = useState('');
  const [createCfAccount, setCreateCfAccount] = useState('');
  const [createName, setCreateName] = useState('');
  const [createLocation, setCreateLocation] = useState('');
  const [createClass, setCreateClass] = useState('Standard');
  const [creating, setCreating] = useState(false);
  /** 正在删除的桶（cfAccountId/name 唯一定位行），网络往返期间行内按钮转 spinner */
  const [deletingBucket, setDeletingBucket] = useState<string | null>(null);
  const { showToast } = useToast();
  const confirm = useConfirm();

  const cols = COLS(locale);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setSearch(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey 是刻意的额外依赖，递增强制重拉
  const reload = useCallback(async () => {
    setFetching(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), search });
      const res = await fetch(`/api/r2/buckets?${params}`);
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      setLoadError(false);
      const data = (await res.json()) as { buckets: R2BucketItem[]; total: number };
      if (data.buckets.length === 0 && data.total > 0 && page > 1) {
        setPage(1);
        return;
      }
      setRows(data.buckets);
      setTotal(data.total);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
      setFetching(false);
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

  // 选择账号后拉该 token 可见的 CF 账号列表
  useEffect(() => {
    setCfAccounts([]);
    setCreateCfAccount('');
    if (!createAccount) return;
    void (async () => {
      try {
        const r = await fetch(`/api/accounts/${encodeURIComponent(createAccount)}/cf-accounts`);
        if (r.ok) {
          const list = ((await r.json()) as { cfAccounts?: AccountOption[] }).cfAccounts ?? [];
          setCfAccounts(list);
          if (list.length === 1) setCreateCfAccount(list[0].id);
        }
      } catch {
        // 下拉留空，用户可换账号重试
      }
    })();
  }, [createAccount]);

  const bucketHref = useCallback(
    (row: R2BucketItem) =>
      localizePath(locale, `/r2/${row.accountId}/${encodeURIComponent(row.name)}`) +
      `?cfAccountId=${encodeURIComponent(row.cfAccountId)}`,
    [locale],
  );

  async function sync() {
    setSyncing(true);
    setSyncProgress(null);
    try {
      let buckets = 0;
      let failureCount = 0;
      if (accounts.length <= 1) {
        const res = await fetch('/api/r2/sync', { method: 'POST' });
        if (!res.ok) {
          showToast(t(locale, 'common.requestFailed'), 'error');
          return;
        }
        const d = (await res.json()) as { buckets: number; failures: unknown[] };
        buckets = d.buckets;
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
              const res = await fetch(`/api/r2/sync?accountId=${encodeURIComponent(acct.id)}`, { method: 'POST' });
              if (!res.ok) failureCount++;
              else {
                const d = (await res.json()) as { buckets: number; failures: unknown[] };
                buckets += d.buckets;
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
        t(locale, 'r2.syncDone', { n: buckets }) +
          (failureCount > 0 ? t(locale, 'r2.syncFailures', { m: failureCount }) : ''),
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

  async function createBucket() {
    if (!createAccount || !createCfAccount || creating) return;
    setCreating(true);
    try {
      const res = await fetch('/api/r2/buckets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: createAccount,
          cfAccountId: createCfAccount,
          name: createName.trim(),
          ...(createLocation ? { location: createLocation } : {}),
          storageClass: createClass,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(body?.error ?? t(locale, 'common.requestFailed'), 'error');
        return;
      }
      showToast(t(locale, 'r2.created'), 'success');
      setShowCreate(false);
      setCreateName('');
      setRefreshKey((k) => k + 1);
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setCreating(false);
    }
  }

  async function deleteBucket(row: R2BucketItem) {
    if (deletingBucket) return;
    const ok = await confirm({
      title: t(locale, 'r2.confirmDelete', { name: row.name }),
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    setDeletingBucket(`${row.cfAccountId}/${row.name}`);
    try {
      const res = await fetch(
        `/api/r2/${encodeURIComponent(row.accountId)}/${encodeURIComponent(row.name)}?cfAccountId=${encodeURIComponent(row.cfAccountId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        showToast(
          body?.code === 'bucketNotEmpty'
            ? t(locale, 'r2.bucketNotEmpty')
            : (body?.error ?? t(locale, 'common.requestFailed')),
          'error',
        );
        return;
      }
      showToast(t(locale, 'r2.deleted'), 'success');
      setRefreshKey((k) => k + 1);
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setDeletingBucket(null);
    }
  }

  function cellFor(row: R2BucketItem, key: string) {
    switch (key) {
      case 'name':
        return (
          <a className="link-hover font-mono hover:text-primary" href={bucketHref(row)}>
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
      case 'location':
        return row.location ? <span className="badge badge-ghost badge-sm">{row.location}</span> : <span>—</span>;
      case 'storageClass':
        return row.storageClass ? (
          <span className="badge badge-outline badge-sm">{row.storageClass}</span>
        ) : (
          <span>—</span>
        );
      case 'size':
        return <span className="font-mono text-xs">{formatBytes(row.payloadSize)}</span>;
      case 'objects':
        return <span className="font-mono text-xs">{row.objectCount ?? '—'}</span>;
      case 'created':
        return row.creationDate ? (
          <span className="font-mono text-xs opacity-60" title={row.creationDate}>
            {relativeTime(row.creationDate, locale)}
          </span>
        ) : (
          <span>—</span>
        );
      case 'actions':
        return (
          <span className="inline-flex gap-1">
            <a className="btn btn-xs whitespace-nowrap" href={bucketHref(row)}>
              {t(locale, 'r2.detail')}
            </a>
            <button
              className="btn btn-ghost btn-xs whitespace-nowrap text-error"
              disabled={deletingBucket !== null}
              onClick={() => void deleteBucket(row)}
            >
              {deletingBucket === `${row.cfAccountId}/${row.name}` && (
                <span className="loading loading-spinner loading-xs" />
              )}
              {t(locale, 'r2.delete')}
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
            placeholder={t(locale, 'r2.searchPlaceholder')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </label>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn btn-sm" onClick={() => setShowCreate((v) => !v)} title={t(locale, 'r2.create')}>
            <Plus size={14} strokeWidth={1.75} />
            <span className="hidden whitespace-nowrap sm:inline">{t(locale, 'r2.create')}</span>
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={syncing}
            onClick={() => void sync()}
            title={t(locale, 'r2.sync')}
          >
            <RefreshCw size={14} strokeWidth={1.75} className={syncing ? 'animate-spin' : ''} />
            <span className="hidden whitespace-nowrap sm:inline">
              {syncing
                ? syncProgress
                  ? t(locale, 'common.syncProgress', { done: syncProgress.done, total: syncProgress.total })
                  : t(locale, 'r2.syncing')
                : t(locale, 'r2.sync')}
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
            <option value="">{t(locale, 'r2.createAccountPlaceholder')}</option>
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
              <option value="">CF</option>
              {cfAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          <input
            type="text"
            className="input input-bordered input-sm w-full sm:w-56"
            placeholder={t(locale, 'r2.createNamePlaceholder')}
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
          />
          <select
            className="select select-bordered select-sm w-full sm:w-40"
            value={createLocation}
            onChange={(e) => setCreateLocation(e.target.value)}
          >
            <option value="">{t(locale, 'r2.createLocationAuto')}</option>
            {['apac', 'eeur', 'enam', 'weur', 'wnam', 'oc'].map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <select
            className="select select-bordered select-sm w-full sm:w-44"
            value={createClass}
            onChange={(e) => setCreateClass(e.target.value)}
          >
            <option value="Standard">Standard</option>
            <option value="InfrequentAccess">Infrequent Access</option>
          </select>
          <button
            className="btn btn-primary btn-sm whitespace-nowrap"
            disabled={creating || !createAccount || !createCfAccount || createName.trim() === ''}
            onClick={() => void createBucket()}
          >
            {creating && <span className="loading loading-spinner loading-xs" />}
            {t(locale, 'r2.create')}
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
          <Database size={48} strokeWidth={1.75} className="opacity-40" />
          <p className="text-sm opacity-60">{t(locale, 'r2.empty')}</p>
        </div>
      ) : (
        <div className={`transition-opacity${fetching ? ' pointer-events-none opacity-50' : ''}`}>
          <div className="overflow-x-auto">
            <table className="table table-sm">
              {tableHead}
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={`${row.accountId}/${row.cfAccountId}/${row.name}`}
                    className="cursor-pointer hover:bg-base-200/60"
                    onDoubleClick={() => {
                      window.location.href = bucketHref(row);
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
                      {t(locale, 'r2.noMatch')}
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

export default function R2Panel({ locale }: { locale: Locale }) {
  return (
    <ToastProvider>
      <ConfirmDialogProvider>
        <R2PanelInner locale={locale} />
      </ConfirmDialogProvider>
    </ToastProvider>
  );
}
