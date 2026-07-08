import { AlertTriangle, Eraser, History, Plus, RefreshCw, Rocket, RotateCcw, ScrollText, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Locale, type MessageKey, t } from '../i18n';
import { accountColor } from '../lib/accountColor';
import { isHostname } from '../lib/dnsRecordValidation';
import { relativeTime } from '../lib/time';
import { ConfirmDialogProvider, useConfirm } from './ui/ConfirmDialog';
import DetailTabs, { useDetailTab } from './ui/DetailTabs';
import TablePagination from './ui/TablePagination';
import { ToastProvider, useToast } from './ui/ToastProvider';

interface CfPagesProject {
  name: string;
  subdomain?: string;
  production_branch?: string;
  domains?: string[];
  source_repo?: string | null;
  created_on?: string;
  latest_deployment_on?: string | null;
}

interface CfPagesDeployment {
  id: string;
  environment?: string;
  url?: string;
  created_on?: string;
  latest_stage_status?: string | null;
  latest_stage_name?: string | null;
  deployment_trigger_branch?: string | null;
  deployment_trigger_commit_hash?: string | null;
}

interface Detail {
  project: CfPagesProject;
}

interface LogLine {
  ts: string | null;
  line: string;
}

interface CfPagesDomain {
  id: string;
  name: string;
  status?: string | null;
  validation_status?: string | null;
}

function domainStatusBadgeClass(status: string | null | undefined): string {
  if (status === 'active') return 'badge-success';
  if (status === 'pending' || status === 'initializing') return 'badge-warning';
  return 'badge-ghost';
}

function TimeCell({ iso, locale }: { iso: string | null | undefined; locale: Locale }) {
  if (!iso) return <>—</>;
  return <span title={iso}>{relativeTime(iso, locale)}</span>;
}

function statusBadgeClass(status: string | null | undefined): string {
  if (status === 'success') return 'badge-success';
  if (status === 'failure' || status === 'failed') return 'badge-error';
  return 'badge-ghost';
}

const RETRYABLE_STATUSES = ['failure', 'failed', 'canceled'];

/** 域名验证进行中的 validation_data.status 值：期间展示验证中提示并轮询刷新 */
const VALIDATION_PENDING_STATUSES = ['pending', 'initializing'];

type PagesTabKey = 'overview' | 'domains' | 'deploys';
const PAGES_TABS: readonly PagesTabKey[] = ['overview', 'domains', 'deploys'];
const PAGES_TAB_LABEL_KEYS: Record<PagesTabKey, MessageKey> = {
  overview: 'pages.tabOverview',
  domains: 'pages.tabDomains',
  deploys: 'pages.tabDeploys',
};

/** subdomain 值缺少 .pages.dev 后缀时补全（CF API 一般已返回完整 *.pages.dev） */
function fullSubdomain(sub: string): string {
  return sub.endsWith('.pages.dev') ? sub : `${sub}.pages.dev`;
}

function PagesDetailPanelInner({
  accountId,
  name,
  locale,
  accountName,
  cfAccountName,
  cfAccountId,
  initialTab,
}: {
  accountId: string;
  name: string;
  locale: Locale;
  accountName?: string | null;
  cfAccountName?: string | null;
  cfAccountId?: string | null;
  initialTab?: string | null;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [deployments, setDeployments] = useState<CfPagesDeployment[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [depLoading, setDepLoading] = useState(true);
  const [depError, setDepError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [logsFor, setLogsFor] = useState<CfPagesDeployment | null>(null);
  const [logLines, setLogLines] = useState<LogLine[] | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);

  // F4 自定义域
  const [customDomains, setCustomDomains] = useState<CfPagesDomain[]>([]);
  const [domainsLoading, setDomainsLoading] = useState(true);
  const [domainsError, setDomainsError] = useState<string | null>(null);
  const [domainBusyId, setDomainBusyId] = useState<string | null>(null);
  const [domainModalOpen, setDomainModalOpen] = useState(false);
  const [domainHostname, setDomainHostname] = useState('');
  const [domainInlineError, setDomainInlineError] = useState<string | null>(null);
  const [domainSubmitting, setDomainSubmitting] = useState(false);
  // undefined = 未预检；null = 未命中 zone
  const [zoneMatch, setZoneMatch] = useState<{ zoneName: string } | null | undefined>(undefined);
  const [createDnsChecked, setCreateDnsChecked] = useState(true);

  // F5 触发部署 / 清构建缓存
  const [deployTriggering, setDeployTriggering] = useState(false);
  const [purging, setPurging] = useState(false);

  const [activeTab, switchTab] = useDetailTab(PAGES_TABS, initialTab);
  const [refreshing, setRefreshing] = useState(false);

  const { showToast } = useToast();
  const confirm = useConfirm();

  const base = useMemo(() => `/api/pages/projects/${accountId}/${encodeURIComponent(name)}`, [accountId, name]);
  const qs = useMemo(() => (cfAccountId ? `?cfAccountId=${encodeURIComponent(cfAccountId)}` : ''), [cfAccountId]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const reload = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      setError(null);
      try {
        const qs = cfAccountId ? `?cfAccountId=${encodeURIComponent(cfAccountId)}` : '';
        const res = await fetch(`/api/pages/projects/${accountId}/${encodeURIComponent(name)}${qs}`);
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(data?.error ?? t(locale, 'common.requestFailed'));
        } else {
          setDetail((await res.json()) as Detail);
        }
      } catch {
        setError(t(locale, 'common.requestFailed'));
      }
      setLoading(false);
    },
    [accountId, name, locale, cfAccountId],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  const reloadDeployments = useCallback(async () => {
    setFetching(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (cfAccountId) params.set('cfAccountId', cfAccountId);
      const res = await fetch(
        `/api/pages/projects/${accountId}/${encodeURIComponent(name)}/deployments?${params.toString()}`,
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setDepError(data?.error ?? t(locale, 'common.requestFailed'));
      } else {
        const data = (await res.json()) as { deployments: CfPagesDeployment[]; total: number };
        setDepError(null);
        setDeployments(data.deployments);
        setTotal(data.total);
      }
    } catch {
      setDepError(t(locale, 'common.requestFailed'));
    }
    setDepLoading(false);
    setFetching(false);
  }, [accountId, name, locale, cfAccountId, page, pageSize]);

  useEffect(() => {
    void reloadDeployments();
  }, [reloadDeployments]);

  // quiet = 后台静默刷新（验证轮询用），不闪 skeleton
  const reloadDomains = useCallback(
    async (quiet = false) => {
      if (!quiet) setDomainsLoading(true);
      setDomainsError(null);
      try {
        const res = await fetch(`${base}/domains${qs}`);
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          setDomainsError(data?.error ?? t(locale, 'common.requestFailed'));
        } else {
          const data = (await res.json()) as { domains: CfPagesDomain[] };
          setCustomDomains(data.domains);
        }
      } catch {
        setDomainsError(t(locale, 'common.requestFailed'));
      }
      setDomainsLoading(false);
    },
    [base, qs, locale],
  );

  useEffect(() => {
    void reloadDomains();
  }, [reloadDomains]);

  // 有域名验证进行中时每 10s 静默刷新，状态落定（或刷新出错）自动停止
  useEffect(() => {
    const validating = customDomains.some((d) => VALIDATION_PENDING_STATUSES.includes(d.validation_status ?? ''));
    if (!validating) return;
    const timer = setTimeout(() => void reloadDomains(true), 10_000);
    return () => clearTimeout(timer);
  }, [customDomains, reloadDomains]);

  // Esc 关闭日志弹窗 / 添加域名弹窗
  useEffect(() => {
    if (!logsFor && !domainModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setLogsFor(null);
        setDomainModalOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [logsFor, domainModalOpen]);

  // 添加域名弹窗内：hostname 输入 400ms 防抖 → zone 预检（仅提示；checkbox 状态由用户掌控）
  useEffect(() => {
    if (!domainModalOpen) return;
    const hostname = domainHostname.trim();
    setZoneMatch(undefined);
    if (!isHostname(hostname)) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ hostname });
        if (cfAccountId) params.set('cfAccountId', cfAccountId);
        const res = await fetch(`/api/zones/lookup?${params.toString()}`);
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as { zone: { zoneName: string } | null };
          setZoneMatch(data.zone ? { zoneName: data.zone.zoneName } : null);
        } else {
          setZoneMatch(null);
        }
      } catch {
        if (!cancelled) setZoneMatch(null);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [domainModalOpen, domainHostname, cfAccountId]);

  const loadLogs = useCallback(
    async (deploymentId: string) => {
      setLogsLoading(true);
      setLogsError(null);
      setLogLines(null);
      try {
        const qs = cfAccountId ? `?cfAccountId=${encodeURIComponent(cfAccountId)}` : '';
        const res = await fetch(
          `/api/pages/projects/${accountId}/${encodeURIComponent(name)}/deployments/${deploymentId}/logs${qs}`,
        );
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          setLogsError(data?.error ?? t(locale, 'common.requestFailed'));
        } else {
          const data = (await res.json()) as { lines: LogLine[] };
          setLogLines(data.lines);
        }
      } catch {
        setLogsError(t(locale, 'common.requestFailed'));
      }
      setLogsLoading(false);
    },
    [accountId, name, locale, cfAccountId],
  );

  const openLogs = (d: CfPagesDeployment) => {
    setLogsFor(d);
    void loadLogs(d.id);
  };

  const runAction = async (d: CfPagesDeployment, action: 'retry' | 'rollback') => {
    const ok = await confirm({
      title: t(locale, action === 'retry' ? 'pages.confirmRetry' : 'pages.confirmRollback'),
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    setBusyId(d.id);
    try {
      const qs = cfAccountId ? `?cfAccountId=${encodeURIComponent(cfAccountId)}` : '';
      const res = await fetch(
        `/api/pages/projects/${accountId}/${encodeURIComponent(name)}/deployments/${d.id}/${action}${qs}`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(data?.error ?? t(locale, 'common.requestFailed'), 'error');
      } else {
        showToast(t(locale, action === 'retry' ? 'pages.retried' : 'pages.rolledBack'), 'success');
        await reloadDeployments();
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
    setBusyId(null);
  };

  const openDomainModal = () => {
    setDomainHostname('');
    setDomainInlineError(null);
    setZoneMatch(undefined);
    setCreateDnsChecked(true);
    setDomainModalOpen(true);
  };

  const submitDomain = async () => {
    const hostname = domainHostname.trim();
    if (!isHostname(hostname)) {
      setDomainInlineError(t(locale, 'common.invalidHostname'));
      return;
    }
    const ok = await confirm({
      title: t(locale, 'pages.confirmAddDomain', { domain: hostname }),
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    setDomainInlineError(null);
    setDomainSubmitting(true);
    try {
      // zoneMatch 仅展示用；createDns 直接取 checkbox，服务端对无 zone 情况兜底
      const res = await fetch(`${base}/domains${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: hostname, createDns: createDnsChecked }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(data?.error ?? t(locale, 'common.requestFailed'), 'error');
      } else {
        const data = (await res.json()) as {
          dns: { created: boolean; zoneName?: string; error?: string } | null;
        };
        showToast(t(locale, 'pages.domainAdded'), 'success');
        if (data.dns) {
          if (data.dns.created) {
            showToast(t(locale, 'pages.dnsCreated', { zone: data.dns.zoneName ?? '' }), 'success');
          } else if (data.dns.error) {
            showToast(t(locale, 'pages.dnsFailed', { error: data.dns.error }), 'error');
          }
        }
        setDomainModalOpen(false);
        void reloadDomains();
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
    setDomainSubmitting(false);
  };

  const retryDomainValidation = async (d: CfPagesDomain) => {
    const ok = await confirm({
      title: t(locale, 'pages.confirmRetryValidation', { domain: d.name }),
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    setDomainBusyId(`retry:${d.name}`);
    try {
      const res = await fetch(`${base}/domains/${encodeURIComponent(d.name)}/retry${qs}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(data?.error ?? t(locale, 'common.requestFailed'), 'error');
      } else {
        showToast(t(locale, 'pages.validationRetried'), 'success');
        void reloadDomains();
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
    setDomainBusyId(null);
  };

  const deleteDomain = async (d: CfPagesDomain) => {
    const ok = await confirm({
      title: t(locale, 'pages.confirmDeleteDomain', { domain: d.name }),
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    setDomainBusyId(`del:${d.name}`);
    try {
      const res = await fetch(`${base}/domains/${encodeURIComponent(d.name)}${qs}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(data?.error ?? t(locale, 'common.requestFailed'), 'error');
      } else {
        showToast(t(locale, 'pages.domainDeleted'), 'success');
        void reloadDomains();
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
    setDomainBusyId(null);
  };

  const triggerDeploy = async () => {
    const ok = await confirm({
      title: t(locale, 'pages.confirmTriggerDeploy', {
        branch: detail?.project.production_branch ?? 'production',
      }),
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    setDeployTriggering(true);
    try {
      const res = await fetch(`${base}/deployments${qs}`, { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(data?.error ?? t(locale, 'common.requestFailed'), 'error');
      } else {
        showToast(t(locale, 'pages.deployTriggered'), 'success');
        await reloadDeployments();
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
    setDeployTriggering(false);
  };

  const purgeBuildCache = async () => {
    const ok = await confirm({
      title: t(locale, 'pages.confirmPurgeCache'),
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    setPurging(true);
    try {
      const res = await fetch(`${base}/purge-build-cache${qs}`, { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(data?.error ?? t(locale, 'common.requestFailed'), 'error');
      } else {
        showToast(t(locale, 'pages.cachePurged'), 'success');
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
    setPurging(false);
  };

  // 一键刷新整页数据：静默并行重拉（deployments 走自身 fetching 变暗态）
  const refreshAll = async () => {
    setRefreshing(true);
    await Promise.all([reload(true), reloadDeployments(), reloadDomains(true)]);
    setRefreshing(false);
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="card border border-base-300 bg-base-100 p-4">
          <div className="skeleton h-24 w-full" />
        </div>
        <div className="card border border-base-300 bg-base-100 p-4">
          <div className="skeleton h-32 w-full" />
        </div>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="alert alert-error text-sm">
        <AlertTriangle size={20} strokeWidth={1.75} />
        <span>{error ?? t(locale, 'common.requestFailed')}</span>
        <button className="btn btn-sm" onClick={() => void reload()}>
          {t(locale, 'common.retry')}
        </button>
      </div>
    );
  }

  const { project } = detail;
  const domains = project.domains ?? [];

  const tableHead = (
    <thead>
      <tr>
        <th>{t(locale, 'workers.colStatus')}</th>
        <th>{t(locale, 'workers.colEnvironment')}</th>
        <th>{t(locale, 'workers.colBranch')}</th>
        <th>{t(locale, 'workers.colCommit')}</th>
        <th>{t(locale, 'workers.colCreated')}</th>
        <th>{t(locale, 'accounts.colActions')}</th>
      </tr>
    </thead>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <DetailTabs
          tabs={PAGES_TABS.map((k) => ({ key: k, label: t(locale, PAGES_TAB_LABEL_KEYS[k]) }))}
          active={activeTab}
          onChange={(k) => switchTab(k as PagesTabKey)}
        />
        <button className="btn btn-ghost btn-sm ml-auto" disabled={refreshing} onClick={() => void refreshAll()}>
          <RefreshCw size={14} strokeWidth={1.75} className={refreshing ? 'animate-spin' : ''} />
          {t(locale, 'common.refresh')}
        </button>
      </div>

      {/* 概览：项目信息 + 清缓存 */}
      <div className={activeTab === 'overview' ? '' : 'hidden'}>
        <div className="card border border-base-300 bg-base-100 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">{t(locale, 'workers.projectDetailTitle')}</h2>
            <button className="btn btn-ghost btn-xs" disabled={purging} onClick={() => void purgeBuildCache()}>
              {purging ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                <Eraser size={14} strokeWidth={1.75} />
              )}
              {t(locale, 'pages.purgeCache')}
            </button>
          </div>
          <div className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex items-center gap-2">
              <span className="opacity-60">{t(locale, 'workers.colAccount')}</span>
              {accountName ? (
                <span className="inline-flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: accountColor(accountId) }} />
                  {accountName}
                </span>
              ) : (
                <span>—</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="opacity-60">{t(locale, 'workers.colCfAccount')}</span>
              <span>{cfAccountName ?? '—'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="opacity-60">{t(locale, 'workers.colBranch')}</span>
              {project.production_branch ? (
                <span className="badge badge-ghost badge-sm font-mono">{project.production_branch}</span>
              ) : (
                <span>—</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="opacity-60">{t(locale, 'workers.colCreated')}</span>
              <span>
                <TimeCell iso={project.created_on} locale={locale} />
              </span>
            </div>
            <div className="flex items-start gap-2 sm:col-span-2">
              <span className="opacity-60">{t(locale, 'workers.colDomains')}</span>
              {domains.length > 0 ? (
                <span className="flex flex-wrap gap-1">
                  {domains.map((d) => (
                    <span key={d} className="badge badge-outline badge-sm font-mono">
                      {d}
                    </span>
                  ))}
                </span>
              ) : (
                <span>—</span>
              )}
            </div>
            {project.subdomain && (
              <div className="font-mono text-xs opacity-80 sm:col-span-2">{fullSubdomain(project.subdomain)}</div>
            )}
          </div>
        </div>
      </div>

      {/* 域名 */}
      <div className={activeTab === 'domains' ? '' : 'hidden'}>
        <div className="card border border-base-300 bg-base-100 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">{t(locale, 'pages.domainsTitle')}</h2>
            <button className="btn btn-sm" onClick={openDomainModal}>
              <Plus size={14} strokeWidth={1.75} />
              {t(locale, 'pages.addDomain')}
            </button>
          </div>
          {domainsError ? (
            <div className="alert alert-error text-sm">
              <AlertTriangle size={20} strokeWidth={1.75} />
              <span>{domainsError}</span>
              <button className="btn btn-sm" onClick={() => void reloadDomains()}>
                {t(locale, 'common.retry')}
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>{t(locale, 'workers.colHostname')}</th>
                    <th>{t(locale, 'pages.domainStatus')}</th>
                    <th>{t(locale, 'accounts.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {domainsLoading ? (
                    Array.from({ length: 3 }).map((_, i) => (
                      <tr key={i}>
                        {Array.from({ length: 3 }).map((_, j) => (
                          <td key={j}>
                            <div className="skeleton h-8" />
                          </td>
                        ))}
                      </tr>
                    ))
                  ) : (
                    <>
                      {customDomains.map((d) => (
                        <tr key={d.id}>
                          <td className="font-mono">{d.name}</td>
                          <td>
                            <span className="inline-flex items-center gap-2">
                              <span
                                className={`badge ${domainStatusBadgeClass(d.status)} badge-sm`}
                                title={d.status === 'error' ? t(locale, 'pages.validationErrorHint') : undefined}
                              >
                                {d.status ?? '—'}
                              </span>
                              {VALIDATION_PENDING_STATUSES.includes(d.validation_status ?? '') ? (
                                <span className="inline-flex items-center gap-1.5 text-xs opacity-60">
                                  <span className="loading loading-spinner loading-xs" />
                                  {t(locale, 'pages.validationPending')}
                                </span>
                              ) : (
                                d.validation_status &&
                                d.validation_status !== d.status && (
                                  <span className="text-xs opacity-60">{d.validation_status}</span>
                                )
                              )}
                            </span>
                          </td>
                          <td>
                            <div className="flex items-center gap-1">
                              <button
                                className="btn btn-xs"
                                disabled={domainBusyId !== null}
                                onClick={() => void retryDomainValidation(d)}
                              >
                                {domainBusyId === `retry:${d.name}` ? (
                                  <span className="loading loading-spinner loading-xs" />
                                ) : (
                                  <RefreshCw size={14} strokeWidth={1.75} />
                                )}
                                {t(locale, 'pages.retryValidation')}
                              </button>
                              <button
                                className="btn btn-xs btn-error"
                                disabled={domainBusyId !== null}
                                onClick={() => void deleteDomain(d)}
                              >
                                {domainBusyId === `del:${d.name}` ? (
                                  <span className="loading loading-spinner loading-xs" />
                                ) : (
                                  <Trash2 size={14} strokeWidth={1.75} />
                                )}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {customDomains.length === 0 && (
                        <tr>
                          <td colSpan={3} className="text-center opacity-60">
                            {t(locale, 'workers.none')}
                          </td>
                        </tr>
                      )}
                    </>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* 部署 */}
      <div className={activeTab === 'deploys' ? '' : 'hidden'}>
        <div className="card border border-base-300 bg-base-100 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">{t(locale, 'pages.deploymentsTitle')}</h2>
            <button className="btn btn-sm btn-primary" disabled={deployTriggering} onClick={() => void triggerDeploy()}>
              {deployTriggering ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                <Rocket size={14} strokeWidth={1.75} />
              )}
              {t(locale, 'pages.triggerDeploy')}
            </button>
          </div>
          {depError ? (
            <div className="alert alert-error text-sm">
              <AlertTriangle size={20} strokeWidth={1.75} />
              <span>{depError}</span>
              <button className="btn btn-sm" onClick={() => void reloadDeployments()}>
                {t(locale, 'common.retry')}
              </button>
            </div>
          ) : depLoading ? (
            <div className="overflow-x-auto">
              <table className="table table-sm">
                {tableHead}
                <tbody>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 6 }).map((_, j) => (
                        <td key={j}>
                          <div className="skeleton h-8" />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={`transition-opacity${fetching ? ' pointer-events-none opacity-50' : ''}`}>
              <div className="overflow-x-auto">
                <table className="table table-sm">
                  {tableHead}
                  <tbody>
                    {deployments.map((d, index) => {
                      const canRetry = RETRYABLE_STATUSES.includes(d.latest_stage_status ?? '');
                      const canRollback =
                        d.environment === 'production' &&
                        d.latest_stage_status === 'success' &&
                        !(page === 1 && index === 0);
                      const busy = busyId === d.id;
                      return (
                        <tr key={d.id}>
                          <td>
                            <span className="inline-flex items-center gap-2">
                              <span className={`badge ${statusBadgeClass(d.latest_stage_status)} badge-sm`}>
                                {d.latest_stage_status ?? '—'}
                              </span>
                              {d.latest_stage_name && <span className="text-xs opacity-60">{d.latest_stage_name}</span>}
                            </span>
                          </td>
                          <td>{d.environment ?? '—'}</td>
                          <td className="font-mono">{d.deployment_trigger_branch ?? '—'}</td>
                          <td className="font-mono">
                            {d.deployment_trigger_commit_hash ? d.deployment_trigger_commit_hash.slice(0, 7) : '—'}
                          </td>
                          <td>
                            <TimeCell iso={d.created_on} locale={locale} />
                          </td>
                          <td>
                            <div className="flex items-center gap-1">
                              <button className="btn btn-xs" onClick={() => openLogs(d)}>
                                <ScrollText size={14} strokeWidth={1.75} />
                                {t(locale, 'pages.logs')}
                              </button>
                              {canRetry && (
                                <button
                                  className="btn btn-xs"
                                  disabled={busyId !== null}
                                  onClick={() => void runAction(d, 'retry')}
                                >
                                  {busy ? (
                                    <span className="loading loading-spinner loading-xs" />
                                  ) : (
                                    <RotateCcw size={14} strokeWidth={1.75} />
                                  )}
                                  {t(locale, 'pages.retry')}
                                </button>
                              )}
                              {canRollback && (
                                <button
                                  className="btn btn-xs btn-outline btn-error"
                                  disabled={busyId !== null}
                                  onClick={() => void runAction(d, 'rollback')}
                                >
                                  {busy ? (
                                    <span className="loading loading-spinner loading-xs" />
                                  ) : (
                                    <History size={14} strokeWidth={1.75} />
                                  )}
                                  {t(locale, 'pages.rollback')}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {deployments.length === 0 && (
                      <tr>
                        <td colSpan={6} className="text-center opacity-60">
                          {t(locale, 'workers.none')}
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
                  setPageSize(n);
                  setPage(1);
                }}
              />
            </div>
          )}
        </div>
      </div>

      {logsFor && (
        <dialog open className="modal modal-open">
          <div className="modal-box max-w-2xl border border-base-300">
            <h3 className="mb-1 font-semibold">{t(locale, 'pages.logsTitle')}</h3>
            <p className="mb-4 font-mono text-xs opacity-60" title={logsFor.id}>
              {logsFor.id.slice(0, 8)}
            </p>
            {logsLoading ? (
              <div className="space-y-2">
                <div className="skeleton h-4 w-full" />
                <div className="skeleton h-4 w-5/6" />
                <div className="skeleton h-4 w-2/3" />
              </div>
            ) : logsError ? (
              <div className="flex items-center gap-3 text-sm text-error">
                <span>{logsError}</span>
                <button className="btn btn-sm" onClick={() => void loadLogs(logsFor.id)}>
                  {t(locale, 'common.retry')}
                </button>
              </div>
            ) : logLines && logLines.length > 0 ? (
              <pre className="max-h-96 overflow-auto rounded-md bg-base-200 p-3 font-mono text-xs">
                {logLines.map((l, i) => (
                  <div key={i}>{l.ts ? `[${l.ts}] ${l.line}` : l.line}</div>
                ))}
              </pre>
            ) : (
              <p className="text-sm opacity-60">{t(locale, 'pages.noLogs')}</p>
            )}
          </div>
          <form method="dialog" className="modal-backdrop" onSubmit={() => setLogsFor(null)}>
            <button type="submit" aria-label={t(locale, 'common.cancel')} />
          </form>
        </dialog>
      )}

      {domainModalOpen && (
        <dialog open className="modal modal-open">
          <div className="modal-box max-w-md border border-base-300">
            <h3 className="mb-4 font-semibold">{t(locale, 'pages.addDomain')}</h3>
            <input
              className="input input-sm w-full font-mono"
              placeholder={t(locale, 'workers.colHostname')}
              value={domainHostname}
              onChange={(e) => {
                setDomainHostname(e.target.value);
                setDomainInlineError(null);
              }}
            />
            {domainInlineError && <p className="mt-2 text-xs text-error">{domainInlineError}</p>}
            {zoneMatch ? (
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm"
                  checked={createDnsChecked}
                  onChange={(e) => setCreateDnsChecked(e.target.checked)}
                />
                {t(locale, 'pages.createDnsToo', { zone: zoneMatch.zoneName })}
              </label>
            ) : zoneMatch === null ? (
              <p className="mt-3 text-xs opacity-60">{t(locale, 'pages.noZoneForDns')}</p>
            ) : null}
            <div className="modal-action">
              <button className="btn btn-ghost" disabled={domainSubmitting} onClick={() => setDomainModalOpen(false)}>
                {t(locale, 'common.cancel')}
              </button>
              <button
                className="btn btn-primary"
                disabled={domainSubmitting || domainHostname.trim() === ''}
                onClick={() => void submitDomain()}
              >
                {domainSubmitting && <span className="loading loading-spinner loading-xs" />}
                {t(locale, 'common.confirm')}
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop" onSubmit={() => setDomainModalOpen(false)}>
            <button type="submit" aria-label={t(locale, 'common.cancel')} />
          </form>
        </dialog>
      )}
    </div>
  );
}

export default function PagesDetailPanel(props: {
  accountId: string;
  name: string;
  locale: Locale;
  accountName?: string | null;
  cfAccountName?: string | null;
  cfAccountId?: string | null;
  initialTab?: string | null;
}) {
  return (
    <ToastProvider>
      <ConfirmDialogProvider>
        <PagesDetailPanelInner {...props} />
      </ConfirmDialogProvider>
    </ToastProvider>
  );
}
