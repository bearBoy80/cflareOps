import { AlertTriangle, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { type Locale, type MessageKey, t } from '../i18n';
import { localizePath } from '../i18n/routing';
import { accountColor } from '../lib/accountColor';
import DetailTabs, { useDetailTab } from './ui/DetailTabs';
import TablePagination from './ui/TablePagination';

// ── Tab types ───────────────────────────────────────────────────────────────
type UsageTabKey = 'workers' | 'pages';
const USAGE_TABS = ['workers', 'pages'] as const;
const USAGE_TAB_LABEL_KEYS: Record<UsageTabKey, MessageKey> = {
  workers: 'usage.tabWorkers',
  pages: 'usage.tabPages',
};

// ── Range types ─────────────────────────────────────────────────────────────
type RangeKey = '24h' | '7d' | '30d';
const RANGES: readonly RangeKey[] = ['24h', '7d', '30d'];
const RANGE_LABEL_KEYS: Record<RangeKey, MessageKey> = {
  '24h': 'usage.range24h',
  '7d': 'usage.range7d',
  '30d': 'usage.range30d',
};

// 日历「今天」起点的 UTC 整点 ISO：中文按上海时区（UTC+8），其它按 UTC。
// UTC+8 为整点偏移，00:00 CST 恰落在某 UTC 整点上，与 usage_hourly.hour 对齐。
function todayStartUTC(locale: Locale, now: Date = new Date()): string {
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (locale === 'zh') {
    const cst = new Date(now.getTime() + 8 * 3600_000);
    return iso(new Date(Date.UTC(cst.getUTCFullYear(), cst.getUTCMonth(), cst.getUTCDate()) - 8 * 3600_000));
  }
  return iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
}

// ── Shared row from unified API ─────────────────────────────────────────────
interface UsageRow {
  accountId: string;
  accountName: string;
  cfAccountId: string;
  name: string;
  requests: number;
  errors: number;
  todayRequests?: number;
}

interface UsageData {
  rows: UsageRow[];
  total: number;
  page: number;
  pageSize: number;
  since: string;
  until: string;
  failures: { accountId: string; error: string }[];
  series: { bucket: string; requests: number; errors: number }[];
}

interface AccountOption {
  id: string;
  name: string;
}

// ── Sub-components ──────────────────────────────────────────────────────────
function UsageChart({
  series,
  range,
  locale,
}: {
  series: { bucket: string; requests: number; errors: number }[];
  range: RangeKey;
  locale: Locale;
}) {
  const hasData = series.some((p) => p.requests > 0 || p.errors > 0);
  // x 轴标签：24h 把 UTC 整点桶转成访问者本地时区的小时（中国 = UTC+8），7d/30d 为 UTC 自然日聚合，直接显示 UTC 日期
  const fmt = (b: string) =>
    range === '24h' ? `${String(new Date(b).getHours()).padStart(2, '0')}:00` : b.slice(5, 10);

  // 多端自适应刻度：测容器宽度，按每标签约 48px 算能放几个，等间隔从最新一格往回取——
  // 最新整点必显、窄屏自动稀疏、且绝不因“离得近”被 recharts 丢格（配 interval={0} 精确渲染这些刻度）
  const wrapRef = useRef<HTMLDivElement>(null);
  const [chartW, setChartW] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setChartW(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const maxLabels = Math.max(2, Math.floor(((chartW || 640) - 52) / 48)); // 52≈YAxis+边距
  const step = Math.max(1, Math.ceil(series.length / maxLabels));
  const ticks: string[] = [];
  for (let i = series.length - 1; i >= 0; i -= step) ticks.unshift(series[i].bucket);
  // y 轴刻度缩写大数（30000→30k / 1.2M），避免五位数被窄轴裁掉
  const compact = (v: number) =>
    v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${+(v / 1e3).toFixed(1)}k` : String(v);
  return (
    <div className="card border border-base-300 bg-base-100 p-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="min-w-0 font-semibold">{t(locale, 'usage.chartTitle')}</h2>
        {range === '24h' && <span className="whitespace-nowrap text-xs opacity-50">{t(locale, 'usage.chartTz')}</span>}
      </div>
      {hasData ? (
        <div ref={wrapRef} className="h-48 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="usageReq" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-primary, #F6821F)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--color-primary, #F6821F)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="bucket"
                tickFormatter={fmt}
                tick={{ fontSize: 11, fill: 'currentColor' }}
                className="opacity-50"
                ticks={ticks}
                interval={0}
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'currentColor' }}
                className="opacity-50"
                width={44}
                allowDecimals={false}
                tickFormatter={compact}
              />
              <Tooltip
                labelFormatter={(b) => fmt(String(b))}
                formatter={(v) => [typeof v === 'number' ? v.toLocaleString() : v, t(locale, 'usage.colRequests')]}
                contentStyle={{ fontSize: 12 }}
              />
              <Area
                type="monotone"
                dataKey="requests"
                stroke="var(--color-primary, #F6821F)"
                strokeWidth={1.75}
                fill="url(#usageReq)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="py-8 text-center text-sm opacity-60">{t(locale, 'usage.chartEmpty')}</p>
      )}
    </div>
  );
}

function AccountDot({ accountId, accountName }: { accountId: string; accountName: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: accountColor(accountId) }} />
      {accountName}
    </span>
  );
}

// ── Main component ──────────────────────────────────────────────────────────
export default function UsagePanel({ locale, initialTab }: { locale: Locale; initialTab?: string | null }) {
  const [activeTab, switchTab] = useDetailTab(USAGE_TABS, initialTab);
  const [range, setRange] = useState<RangeKey>('7d');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [accountId, setAccountId] = useState('');
  const [accountOptions, setAccountOptions] = useState<AccountOption[]>([]);
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));

  // Fetch account options for dropdown (silent fail)
  useEffect(() => {
    fetch('/api/accounts')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: unknown) => {
        const result = d as { accounts?: AccountOption[] } | null;
        if (result?.accounts) setAccountOptions(result.accounts);
      })
      .catch(() => {
        // silent degradation
      });
  }, []);

  // 300ms debounce: searchInput → search (reset page)
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setSearch(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const reload = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          range,
          kind: activeTab,
          page: String(page),
          pageSize: String(pageSize),
          search,
          accountId,
        });
        if (range === '24h') params.set('todayStart', todayStartUTC(locale));
        const res = await fetch(`/api/usage/invocations?${params.toString()}`);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(body?.error ?? t(locale, 'common.requestFailed'));
        } else {
          setData((await res.json()) as UsageData);
        }
      } catch {
        setError(t(locale, 'common.requestFailed'));
      }
      setLoading(false);
    },
    [activeTab, range, page, pageSize, search, accountId, locale],
  );

  // Auto-fetch on any dep change with a stale-response guard.
  // A rapid tab/range change leaves two fetches in flight; `cancelled` ensures
  // only the latest response commits to state (the refresh button is exempt —
  // it calls reload directly and there is no race since deps are unchanged).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      range,
      kind: activeTab,
      page: String(page),
      pageSize: String(pageSize),
      search,
      accountId,
    });
    if (range === '24h') params.set('todayStart', todayStartUTC(locale));
    void fetch(`/api/usage/invocations?${params.toString()}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(body?.error ?? t(locale, 'common.requestFailed'));
        } else {
          setData((await res.json()) as UsageData);
        }
      })
      .catch(() => {
        if (!cancelled) setError(t(locale, 'common.requestFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, range, page, pageSize, search, accountId, locale]);

  const refreshAll = async () => {
    setRefreshing(true);
    await reload(true);
    setRefreshing(false);
  };

  const rowHref = (r: UsageRow) => {
    const base =
      activeTab === 'workers'
        ? `/workers/scripts/${r.accountId}/${encodeURIComponent(r.name)}`
        : `/workers/pages/${r.accountId}/${encodeURIComponent(r.name)}`;
    return localizePath(locale, base) + `?cfAccountId=${encodeURIComponent(r.cfAccountId)}`;
  };

  // 今日请求数列仅 24h 档显示（日历今天，按 locale 时区）
  const showToday = range === '24h';
  // Column count depends on tab (workers has errors column) + optional today column
  const colSpan = (activeTab === 'workers' ? 4 : 3) + (showToday ? 1 : 0);

  const windowLabel =
    data == null
      ? ''
      : range === '24h'
        ? t(locale, 'usage.rolling24h')
        : t(locale, 'usage.statWindow', {
            since: data.since.slice(0, 10),
            until: data.until.slice(0, 10),
          });

  return (
    <div className="space-y-4">
      {/* Row 1: tabs + range join group + refresh */}
      <div className="flex flex-wrap items-center gap-2">
        <DetailTabs
          tabs={USAGE_TABS.map((k) => ({ key: k, label: t(locale, USAGE_TAB_LABEL_KEYS[k]) }))}
          active={activeTab}
          onChange={(key) => {
            switchTab(key as UsageTabKey);
            setPage(1);
          }}
        />
        <div className="join">
          {RANGES.map((r) => (
            <button
              key={r}
              className={`btn join-item btn-sm whitespace-nowrap${range === r ? ' btn-active' : ''}`}
              onClick={() => {
                setRange(r);
                setPage(1);
              }}
            >
              {t(locale, RANGE_LABEL_KEYS[r])}
            </button>
          ))}
        </div>
        {/* Narrow screen: icon-only; ≥sm: icon + label (CLAUDE.md rule 6) */}
        <button
          className="btn btn-ghost btn-sm ml-auto"
          disabled={refreshing || loading}
          onClick={() => void refreshAll()}
          title={t(locale, 'common.refresh')}
        >
          <RefreshCw size={14} strokeWidth={1.75} className={refreshing ? 'animate-spin' : ''} />
          <span className="hidden whitespace-nowrap sm:inline">{t(locale, 'common.refresh')}</span>
        </button>
      </div>

      {/* Row 2: search + account filter */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="input input-bordered input-sm flex w-64 max-w-full items-center gap-2">
          <Search size={14} strokeWidth={1.75} className="shrink-0 opacity-40" />
          <input
            type="text"
            className="grow"
            placeholder={t(locale, 'usage.searchPlaceholder')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </label>
        {accountOptions.length > 0 && (
          <select
            className="select select-bordered select-sm w-40"
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t(locale, 'zones.filterAccount')}</option>
            {accountOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Chart: rendered between filter row and table; only when data available and no error */}
      {!error && data && <UsageChart series={data.series ?? []} range={range} locale={locale} />}

      {/* Error state */}
      {error ? (
        <div className="alert alert-error text-sm">
          <AlertTriangle size={20} strokeWidth={1.75} />
          <span>{error}</span>
          <button className="btn btn-sm" onClick={() => void reload()}>
            {t(locale, 'common.retry')}
          </button>
        </div>
      ) : loading || !data ? (
        /* Skeleton */
        <div className="card border border-base-300 bg-base-100 p-4">
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>{t(locale, activeTab === 'workers' ? 'workers.colScript' : 'workers.colProject')}</th>
                  <th className="hidden md:table-cell">{t(locale, 'workers.colAccount')}</th>
                  <th>{t(locale, 'usage.colRequests')}</th>
                  {showToday && <th className="hidden sm:table-cell">{t(locale, 'usage.colToday')}</th>}
                  {activeTab === 'workers' && <th>{t(locale, 'usage.colErrors')}</th>}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    <td>
                      <div className="skeleton h-6 w-full" />
                    </td>
                    <td className="hidden md:table-cell">
                      <div className="skeleton h-6 w-full" />
                    </td>
                    <td>
                      <div className="skeleton h-6 w-full" />
                    </td>
                    {showToday && (
                      <td className="hidden sm:table-cell">
                        <div className="skeleton h-6 w-full" />
                      </td>
                    )}
                    {activeTab === 'workers' && (
                      <td>
                        <div className="skeleton h-6 w-full" />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <>
          {/* Partial failures warning */}
          {data.failures.length > 0 && (
            <div className="alert alert-warning text-sm">
              <AlertTriangle size={20} strokeWidth={1.75} />
              <span>{t(locale, 'usage.partialFailures', { m: data.failures.length })}</span>
            </div>
          )}

          {/* Single card with table */}
          <div className="card border border-base-300 bg-base-100 p-4">
            {/* Window label */}
            {windowLabel && <p className="mb-3 text-xs opacity-60">{windowLabel}</p>}

            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>{t(locale, activeTab === 'workers' ? 'workers.colScript' : 'workers.colProject')}</th>
                    <th className="hidden md:table-cell">{t(locale, 'workers.colAccount')}</th>
                    <th>{t(locale, 'usage.colRequests')}</th>
                    {showToday && <th className="hidden sm:table-cell">{t(locale, 'usage.colToday')}</th>}
                    {activeTab === 'workers' && <th>{t(locale, 'usage.colErrors')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.length === 0 ? (
                    <tr>
                      <td colSpan={colSpan} className="text-center opacity-60">
                        {t(locale, 'workers.none')}
                      </td>
                    </tr>
                  ) : (
                    data.rows.map((r) => (
                      <tr
                        key={`${r.accountId}/${r.cfAccountId}/${r.name}`}
                        className="cursor-pointer hover:bg-base-200/60"
                        onDoubleClick={() => {
                          window.location.href = rowHref(r);
                        }}
                      >
                        <td>
                          <a className="link-hover font-mono hover:text-primary" href={rowHref(r)}>
                            {r.name}
                          </a>
                        </td>
                        <td className="hidden md:table-cell">
                          <AccountDot accountId={r.accountId} accountName={r.accountName} />
                        </td>
                        <td className="font-mono">{r.requests.toLocaleString()}</td>
                        {showToday && (
                          <td className="hidden font-mono sm:table-cell">{(r.todayRequests ?? 0).toLocaleString()}</td>
                        )}
                        {activeTab === 'workers' && (
                          <td className={`font-mono${r.errors > 0 ? ' text-error' : ''}`}>
                            {r.errors.toLocaleString()}
                          </td>
                        )}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <TablePagination
              locale={locale}
              total={data.total}
              page={page}
              pageCount={pageCount}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={(ps) => {
                setPageSize(ps);
                setPage(1);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
