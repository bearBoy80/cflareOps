import { AlertTriangle, Pencil, Plus, RefreshCw, Rocket, Trash2 } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { type Locale, type MessageKey, t } from '../i18n';
import { accountColor } from '../lib/accountColor';
import { validateCrons } from '../lib/cronValidation';
import { isHostname } from '../lib/dnsRecordValidation';
import { isSecretName } from '../lib/secretName';
import { relativeTime } from '../lib/time';
import { COMPAT_DATE_RE } from '../lib/workerSettingsEdit';
import { ConfirmDialogProvider, useConfirm } from './ui/ConfirmDialog';
import DetailTabs, { useDetailTab } from './ui/DetailTabs';
import { ToastProvider, useToast } from './ui/ToastProvider';

// CodeMirror 懒加载：仅 CodeEditor.tsx import codemirror 相关包
const CodeEditor = lazy(() => import('./ui/CodeEditor'));

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

interface CfWorkerCron {
  cron: string;
  created_on?: string;
  modified_on?: string;
}

interface CfWorkerDomain {
  id: string;
  hostname: string;
  service: string;
  environment?: string;
  zone_name?: string;
}

interface Detail {
  script: WorkerScriptItem;
  crons: CfWorkerCron[];
  domains: CfWorkerDomain[];
}

interface WorkerBinding {
  type: string;
  name: string;
  target?: string | null;
}

interface WorkerSettings {
  bindings: WorkerBinding[];
  compatibility_date?: string | null;
  compatibility_flags?: string[];
  usage_model?: string | null;
}

interface WorkerVersion {
  id: string;
  number?: number | null;
  created_on?: string | null;
  message?: string | null;
  triggered_by?: string | null;
}

interface WorkerDeployment {
  id: string;
  strategy?: string | null;
  created_on?: string | null;
  author_email?: string | null;
  message?: string | null;
  versions: { version_id: string; percentage: number }[];
}

interface History {
  settings: WorkerSettings | null;
  versions: WorkerVersion[];
  deployments: WorkerDeployment[];
  errors: string[];
}

interface WorkerSecret {
  name: string;
  type: string;
}

/** 源码保存 API 错误码 → 本地化文案 */
const SAVE_ERROR_CODE_KEYS: Record<string, MessageKey> = {
  editConflict: 'workers.editConflict',
  multiModule: 'workers.multiModuleReadOnly',
};

type WorkerTabKey = 'overview' | 'config' | 'deploys' | 'source';
const WORKER_TABS: readonly WorkerTabKey[] = ['overview', 'config', 'deploys', 'source'];
const WORKER_TAB_LABEL_KEYS: Record<WorkerTabKey, MessageKey> = {
  overview: 'workers.tabOverview',
  config: 'workers.tabConfig',
  deploys: 'workers.tabDeploys',
  source: 'workers.tabSource',
};

/** 可新增绑定类型 → 目标字段 i18n key（service 额外有 environment 输入） */
const NEW_BINDING_KINDS = ['kv_namespace', 'd1', 'r2_bucket', 'plain_text', 'json', 'service'] as const;
type NewBindingKind = (typeof NEW_BINDING_KINDS)[number];
const BINDING_TARGET_LABEL_KEYS: Record<NewBindingKind, MessageKey> = {
  kv_namespace: 'workers.bindingTargetKv',
  d1: 'workers.bindingTargetD1',
  r2_bucket: 'workers.bindingTargetR2',
  plain_text: 'workers.bindingTargetText',
  json: 'workers.bindingTargetJson',
  service: 'workers.bindingTargetService',
};
interface NewBindingRow {
  kind: NewBindingKind;
  name: string;
  target: string;
  environment: string;
}

function TimeCell({ iso, locale }: { iso: string | null | undefined; locale: Locale }) {
  if (!iso) return <>—</>;
  return <span title={iso}>{relativeTime(iso, locale)}</span>;
}

function EditorSkeleton() {
  return (
    <div className="space-y-2">
      <div className="skeleton h-4 w-full" />
      <div className="skeleton h-4 w-5/6" />
      <div className="skeleton h-4 w-2/3" />
    </div>
  );
}

function WorkerDetailPanelInner({
  accountId,
  name,
  locale,
  cfAccountId,
  initialTab,
}: {
  accountId: string;
  name: string;
  locale: Locale;
  cfAccountId?: string | null;
  initialTab?: string | null;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<History | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [mainModule, setMainModule] = useState<string | null>(null);
  const [multiModule, setMultiModule] = useState(false);
  // 乐观锁：GET/PUT 返回的 etag
  const [sourceEtag, setSourceEtag] = useState<string | null>(null);

  // F3 在线编辑
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [deploying, setDeploying] = useState(false);

  // F1 cron 编辑弹窗
  const [cronModalOpen, setCronModalOpen] = useState(false);
  const [cronRows, setCronRows] = useState<string[]>([]);
  const [cronInvalid, setCronInvalid] = useState<number[]>([]);
  const [cronSaving, setCronSaving] = useState(false);

  // F2 secrets
  const [secrets, setSecrets] = useState<WorkerSecret[]>([]);
  const [secretsLoading, setSecretsLoading] = useState(true);
  const [secretsError, setSecretsError] = useState<string | null>(null);
  const [secretBusy, setSecretBusy] = useState<string | null>(null);
  const [secretAdding, setSecretAdding] = useState(false);
  const [newSecretName, setNewSecretName] = useState('');
  const [newSecretValue, setNewSecretValue] = useState('');
  const [secretNameInvalid, setSecretNameInvalid] = useState(false);

  // F6 自定义域
  const [domainModalOpen, setDomainModalOpen] = useState(false);
  const [domainHostname, setDomainHostname] = useState('');
  const [domainInlineError, setDomainInlineError] = useState<string | null>(null);
  const [domainSubmitting, setDomainSubmitting] = useState(false);
  const [domainBusyId, setDomainBusyId] = useState<string | null>(null);
  // undefined = 未预检；null = 未命中 zone
  const [zoneMatch, setZoneMatch] = useState<{ zoneName: string } | null | undefined>(undefined);

  const [activeTab, switchTab] = useDetailTab(WORKER_TABS, initialTab);
  const [refreshing, setRefreshing] = useState(false);

  // Worker URL（workers.dev 子域名开关）
  const [subInfo, setSubInfo] = useState<{
    subdomain: string | null;
    enabled: boolean;
    previewsEnabled: boolean;
  } | null>(null);
  const [subLoading, setSubLoading] = useState(true);
  const [subError, setSubError] = useState<string | null>(null);
  const [subBusy, setSubBusy] = useState(false);

  // 绑定与配置编辑 modal
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [editCompatDate, setEditCompatDate] = useState('');
  const [editCompatFlags, setEditCompatFlags] = useState('');
  const [keptBindings, setKeptBindings] = useState<WorkerBinding[]>([]);
  const [newBindings, setNewBindings] = useState<NewBindingRow[]>([]);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsInlineError, setSettingsInlineError] = useState<string | null>(null);

  const { showToast } = useToast();
  const confirm = useConfirm();

  const base = useMemo(() => `/api/workers/scripts/${accountId}/${encodeURIComponent(name)}`, [accountId, name]);
  const qs = useMemo(() => (cfAccountId ? `?cfAccountId=${encodeURIComponent(cfAccountId)}` : ''), [cfAccountId]);

  const reload = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${base}${qs}`);
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
    [base, qs, locale],
  );

  const reloadHistory = useCallback(
    async (quiet = false) => {
      if (!quiet) setHistoryLoading(true);
      setHistoryError(null);
      try {
        const res = await fetch(`${base}/history${qs}`);
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          setHistoryError(data?.error ?? t(locale, 'common.requestFailed'));
        } else {
          setHistory((await res.json()) as History);
        }
      } catch {
        setHistoryError(t(locale, 'common.requestFailed'));
      }
      setHistoryLoading(false);
    },
    [base, qs, locale],
  );

  const loadSource = useCallback(
    async (quiet = false) => {
      if (!quiet) setSourceLoading(true);
      setSourceError(null);
      try {
        const res = await fetch(`${base}/content${qs}`);
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          setSourceError(data?.error ?? t(locale, 'common.requestFailed'));
        } else {
          // /content 路由返回 JSON { content, mainModule, multiModule, etag }（Phase 2.6 T1）
          const data = (await res.json()) as {
            content: string;
            mainModule: string | null;
            multiModule: boolean;
            etag: string;
          };
          setSource(data.content);
          setMainModule(data.mainModule);
          setMultiModule(data.multiModule);
          setSourceEtag(data.etag);
        }
      } catch {
        setSourceError(t(locale, 'common.requestFailed'));
      }
      setSourceLoading(false);
    },
    [base, qs, locale],
  );

  const reloadSecrets = useCallback(
    async (quiet = false) => {
      if (!quiet) setSecretsLoading(true);
      setSecretsError(null);
      try {
        const res = await fetch(`${base}/secrets${qs}`);
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          setSecretsError(data?.error ?? t(locale, 'common.requestFailed'));
        } else {
          const data = (await res.json()) as { secrets: WorkerSecret[] };
          setSecrets(data.secrets);
        }
      } catch {
        setSecretsError(t(locale, 'common.requestFailed'));
      }
      setSecretsLoading(false);
    },
    [base, qs, locale],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void reloadHistory();
  }, [reloadHistory]);

  const reloadSubdomain = useCallback(
    async (quiet = false) => {
      if (!quiet) setSubLoading(true);
      setSubError(null);
      try {
        const res = await fetch(`${base}/subdomain${qs}`);
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          setSubError(data?.error ?? t(locale, 'common.requestFailed'));
        } else {
          setSubInfo((await res.json()) as { subdomain: string | null; enabled: boolean; previewsEnabled: boolean });
        }
      } catch {
        setSubError(t(locale, 'common.requestFailed'));
      }
      setSubLoading(false);
    },
    [base, qs, locale],
  );

  useEffect(() => {
    void reloadSecrets();
  }, [reloadSecrets]);

  useEffect(() => {
    void reloadSubdomain();
  }, [reloadSubdomain]);

  // 源码 tab 首次激活自动加载；已加载/加载中/出错（等用户点重试）都不重复请求
  useEffect(() => {
    if (activeTab !== 'source') return;
    if (source !== null || sourceLoading || sourceError !== null) return;
    void loadSource();
  }, [activeTab, source, sourceLoading, sourceError, loadSource]);

  // Esc 关闭 cron / 域名 / 设置弹窗
  useEffect(() => {
    if (!cronModalOpen && !domainModalOpen && !settingsModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCronModalOpen(false);
        setDomainModalOpen(false);
        setSettingsModalOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cronModalOpen, domainModalOpen, settingsModalOpen]);

  const startEdit = () => {
    if (source === null) return;
    setDraft(source);
    setEditing(true);
  };

  const saveDeploy = async () => {
    if (!mainModule) return;
    const ok = await confirm({
      title: t(locale, 'workers.confirmDeploy', { name }),
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    setDeploying(true);
    try {
      const res = await fetch(`${base}/content${qs}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: draft, etag: sourceEtag ?? undefined }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
          code?: string;
        } | null;
        // editConflict 时保留编辑器中的草稿，由用户自行重载
        const key = data?.code ? SAVE_ERROR_CODE_KEYS[data.code] : undefined;
        showToast(key ? t(locale, key) : (data?.error ?? t(locale, 'common.requestFailed')), 'error');
      } else {
        const data = (await res.json()) as { etag: string };
        setSourceEtag(data.etag);
        showToast(t(locale, 'workers.deployed'), 'success');
        setSource(draft);
        setEditing(false);
        void reloadHistory();
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
    setDeploying(false);
  };

  const openCronModal = () => {
    setCronRows((detail?.crons ?? []).map((c) => c.cron));
    setCronInvalid([]);
    setCronModalOpen(true);
  };

  const saveCrons = async () => {
    const entries = cronRows.map((v, i) => ({ v: v.trim(), i })).filter((e) => e.v !== '');
    const invalid = validateCrons(entries.map((e) => e.v)).map((k) => entries[k].i);
    setCronInvalid(invalid);
    if (invalid.length > 0) return;
    const ok = await confirm({
      title: t(locale, 'workers.confirmSaveCrons'),
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    setCronSaving(true);
    try {
      const res = await fetch(`${base}/crons${qs}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crons: entries.map((e) => e.v) }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(data?.error ?? t(locale, 'common.requestFailed'), 'error');
      } else {
        const data = (await res.json()) as { crons: CfWorkerCron[] };
        setDetail((prev) => (prev ? { ...prev, crons: data.crons } : prev));
        showToast(t(locale, 'workers.cronsSaved'), 'success');
        setCronModalOpen(false);
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
    setCronSaving(false);
  };

  const addSecret = async () => {
    const secretName = newSecretName.trim();
    if (!isSecretName(secretName)) {
      setSecretNameInvalid(true);
      return;
    }
    setSecretNameInvalid(false);
    const ok = await confirm({
      title: `${t(locale, 'workers.addSecret')}: ${secretName}`,
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    setSecretAdding(true);
    try {
      const res = await fetch(`${base}/secrets${qs}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: secretName, text: newSecretValue }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(data?.error ?? t(locale, 'common.requestFailed'), 'error');
      } else {
        showToast(t(locale, 'workers.secretSaved'), 'success');
        setNewSecretName('');
        setNewSecretValue('');
        void reloadSecrets();
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
    setSecretAdding(false);
  };

  const deleteSecret = async (secretName: string) => {
    const ok = await confirm({
      title: t(locale, 'workers.confirmDeleteSecret', { name: secretName }),
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    setSecretBusy(secretName);
    try {
      const res = await fetch(`${base}/secrets/${encodeURIComponent(secretName)}${qs}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(data?.error ?? t(locale, 'common.requestFailed'), 'error');
      } else {
        showToast(t(locale, 'workers.secretDeleted'), 'success');
        void reloadSecrets();
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
    setSecretBusy(null);
  };

  const openDomainModal = () => {
    setDomainHostname('');
    setDomainInlineError(null);
    setZoneMatch(undefined);
    setDomainModalOpen(true);
  };

  // 添加域名弹窗内：hostname 输入 400ms 防抖 → zone 预检（仅提示，不阻断提交，服务端为准）
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

  const submitDomain = async () => {
    const hostname = domainHostname.trim();
    if (!isHostname(hostname)) {
      setDomainInlineError(t(locale, 'common.invalidHostname'));
      return;
    }
    const ok = await confirm({
      title: t(locale, 'workers.confirmAttachDomain', { hostname }),
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    setDomainInlineError(null);
    setDomainSubmitting(true);
    try {
      const res = await fetch(`${base}/domains${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostname }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
          code?: string;
        } | null;
        if (data?.code === 'zoneNotFound') {
          // 域名不在已聚合 zone 内：留在弹窗内提示，便于改输入重试
          setDomainInlineError(t(locale, 'workers.zoneNotFound'));
        } else {
          showToast(data?.error ?? t(locale, 'common.requestFailed'), 'error');
        }
      } else {
        showToast(t(locale, 'workers.domainAttached'), 'success');
        setDomainModalOpen(false);
        void reload();
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
    setDomainSubmitting(false);
  };

  const detachDomain = async (d: CfWorkerDomain) => {
    const ok = await confirm({
      title: t(locale, 'workers.confirmDetachDomain', { hostname: d.hostname }),
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    setDomainBusyId(d.id);
    try {
      const res = await fetch(`${base}/domains/${encodeURIComponent(d.id)}${qs}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(data?.error ?? t(locale, 'common.requestFailed'), 'error');
      } else {
        showToast(t(locale, 'workers.domainDetached'), 'success');
        void reload();
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
    setDomainBusyId(null);
  };

  // 切换 workers.dev 开关：另一开关取当前值原样带上（CF POST 要求 enabled 必填）
  const toggleSubdomain = async (which: 'enabled' | 'previews') => {
    if (!subInfo || subInfo.subdomain === null) return;
    const next = {
      enabled: which === 'enabled' ? !subInfo.enabled : subInfo.enabled,
      previewsEnabled: which === 'previews' ? !subInfo.previewsEnabled : subInfo.previewsEnabled,
    };
    const url =
      which === 'enabled' ? `${name}.${subInfo.subdomain}.workers.dev` : `*-${name}.${subInfo.subdomain}.workers.dev`;
    const turningOn = which === 'enabled' ? next.enabled : next.previewsEnabled;
    const ok = await confirm({
      title: t(locale, turningOn ? 'workers.confirmEnableUrl' : 'workers.confirmDisableUrl', { url }),
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    setSubBusy(true);
    try {
      const res = await fetch(`${base}/subdomain${qs}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(data?.error ?? t(locale, 'common.requestFailed'), 'error');
      } else {
        const data = (await res.json()) as { enabled: boolean; previewsEnabled: boolean };
        setSubInfo((prev) => (prev ? { ...prev, ...data } : prev));
        showToast(t(locale, 'workers.urlUpdated'), 'success');
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
    setSubBusy(false);
  };

  const openSettingsModal = () => {
    // 防御：settings 降级为 null 时不开 modal（避免空绑定数组覆盖现有绑定）
    if (!history?.settings) return;
    const s = history.settings;
    setEditCompatDate(s.compatibility_date ?? '');
    setEditCompatFlags((s.compatibility_flags ?? []).join('\n'));
    setKeptBindings(s.bindings ?? []);
    setNewBindings([]);
    setSettingsInlineError(null);
    setSettingsModalOpen(true);
  };

  const saveSettings = async () => {
    const compatDate = editCompatDate.trim();
    if (compatDate !== '' && !COMPAT_DATE_RE.test(compatDate)) {
      setSettingsInlineError(t(locale, 'workers.invalidCompatDate'));
      return;
    }
    for (const nb of newBindings) {
      if (!isSecretName(nb.name.trim())) {
        setSettingsInlineError(t(locale, 'workers.invalidSecretName'));
        return;
      }
      if (nb.kind === 'json') {
        try {
          JSON.parse(nb.target.trim());
        } catch {
          setSettingsInlineError(t(locale, 'workers.invalidJsonValue'));
          return;
        }
      }
    }
    const ok = await confirm({
      title: t(locale, 'workers.confirmSaveSettings'),
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    setSettingsInlineError(null);
    setSettingsSaving(true);
    try {
      const flags = editCompatFlags
        .split('\n')
        .map((f) => f.trim())
        .filter((f) => f !== '');
      const body = {
        bindings: [
          // 保留的现有绑定（含 secret_text）一律 inherit —— 整组替换语义下的防删保护
          ...keptBindings.map((b) => ({ kind: 'inherit' as const, name: b.name })),
          // biome-ignore lint/suspicious/useIterableCallbackReturn: exhaustive switch over the binding-kind union — every case returns
          ...newBindings.map((nb) => {
            const name = nb.name.trim();
            const target = nb.target.trim();
            switch (nb.kind) {
              case 'kv_namespace':
                return { kind: nb.kind, name, namespaceId: target };
              case 'd1':
                return { kind: nb.kind, name, databaseId: target };
              case 'r2_bucket':
                return { kind: nb.kind, name, bucketName: target };
              case 'plain_text':
                return { kind: nb.kind, name, text: target };
              case 'json':
                return { kind: nb.kind, name, json: target };
              case 'service':
                return {
                  kind: nb.kind,
                  name,
                  service: target,
                  ...(nb.environment.trim() !== '' ? { environment: nb.environment.trim() } : {}),
                };
            }
          }),
        ],
        ...(compatDate !== '' ? { compatibilityDate: compatDate } : {}),
        compatibilityFlags: flags,
      };
      const res = await fetch(`${base}/settings${qs}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(data?.error ?? t(locale, 'common.requestFailed'), 'error');
      } else {
        const data = (await res.json()) as { settings: WorkerSettings };
        setHistory((prev) => (prev ? { ...prev, settings: data.settings } : prev));
        showToast(t(locale, 'workers.settingsSaved'), 'success');
        setSettingsModalOpen(false);
        void reloadHistory(true); // 版本历史里出现新版本
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
    setSettingsSaving(false);
  };

  // 一键刷新整页数据：静默并行重拉；源码仅在已加载且未编辑时重拉（保护草稿）
  const refreshAll = async () => {
    setRefreshing(true);
    const jobs = [reload(true), reloadHistory(true), reloadSecrets(true), reloadSubdomain(true)];
    if (source !== null && !editing) jobs.push(loadSource(true));
    await Promise.all(jobs);
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

  const { script, crons, domains } = detail;
  const canEditSource = source !== null && !multiModule && mainModule !== null;

  // 依赖 history 数据的卡片统一门：错误 → alert+重试；加载中 → n 张骨架卡；就绪 → render(history)
  const historyGate = (skeletons: number, render: (h: History) => ReactNode) => {
    if (historyError) {
      return (
        <div className="alert alert-error text-sm">
          <AlertTriangle size={20} strokeWidth={1.75} />
          <span>{historyError}</span>
          <button className="btn btn-sm" onClick={() => void reloadHistory()}>
            {t(locale, 'common.retry')}
          </button>
        </div>
      );
    }
    if (historyLoading || !history) {
      return (
        <>
          {Array.from({ length: skeletons }).map((_, i) => (
            <div key={i} className="card border border-base-300 bg-base-100 p-4">
              <div className="skeleton h-32 w-full" />
            </div>
          ))}
        </>
      );
    }
    return render(history);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <DetailTabs
          tabs={WORKER_TABS.map((k) => ({ key: k, label: t(locale, WORKER_TAB_LABEL_KEYS[k]) }))}
          active={activeTab}
          onChange={(k) => switchTab(k as WorkerTabKey)}
        />
        <button className="btn btn-ghost btn-sm ml-auto" disabled={refreshing} onClick={() => void refreshAll()}>
          <RefreshCw size={14} strokeWidth={1.75} className={refreshing ? 'animate-spin' : ''} />
          {t(locale, 'common.refresh')}
        </button>
      </div>

      {/* 概览：基本信息 | 绑定与配置 */}
      <div className={activeTab === 'overview' ? 'space-y-6' : 'hidden'}>
        <div className="card border border-base-300 bg-base-100 p-4">
          <h2 className="mb-3 font-semibold">{t(locale, 'workers.scriptDetailTitle')}</h2>
          <div className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex items-center gap-2">
              <span className="opacity-60">{t(locale, 'workers.colAccount')}</span>
              <span className="inline-flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: accountColor(script.accountId) }}
                />
                {script.accountName}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="opacity-60">{t(locale, 'workers.colCfAccount')}</span>
              <span>{script.cfAccountName ?? '—'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="opacity-60">{t(locale, 'workers.colUsageModel')}</span>
              {script.usageModel ? (
                <span className="badge badge-ghost badge-sm font-mono">{script.usageModel}</span>
              ) : (
                <span>—</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="opacity-60">{t(locale, 'workers.colCreated')}</span>
              <span>
                <TimeCell iso={script.createdOn} locale={locale} />
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="opacity-60">{t(locale, 'workers.colModified')}</span>
              <span>
                <TimeCell iso={script.modifiedOn} locale={locale} />
              </span>
            </div>
          </div>
        </div>
        <div className="card border border-base-300 bg-base-100 p-4">
          <h2 className="mb-3 font-semibold">{t(locale, 'workers.urlTitle')}</h2>
          {subError ? (
            <div className="flex items-center gap-3 text-sm text-error">
              <span>{subError}</span>
              <button className="btn btn-sm" onClick={() => void reloadSubdomain()}>
                {t(locale, 'common.retry')}
              </button>
            </div>
          ) : subLoading || !subInfo ? (
            <div className="skeleton h-16 w-full" />
          ) : subInfo.subdomain === null ? (
            <p className="text-sm opacity-60">{t(locale, 'workers.noSubdomain')}</p>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-3">
                <span className="badge badge-ghost badge-sm shrink-0 whitespace-nowrap">
                  {t(locale, 'workers.urlProduction')}
                </span>
                {subInfo.enabled ? (
                  <a
                    className="link-hover min-w-0 break-all font-mono hover:text-primary"
                    href={`https://${name}.${subInfo.subdomain}.workers.dev`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {name}.{subInfo.subdomain}.workers.dev
                  </a>
                ) : (
                  <span className="min-w-0 break-all font-mono opacity-50">
                    {name}.{subInfo.subdomain}.workers.dev
                  </span>
                )}
                <input
                  type="checkbox"
                  className="toggle toggle-sm ml-auto shrink-0"
                  checked={subInfo.enabled}
                  disabled={subBusy}
                  onChange={() => void toggleSubdomain('enabled')}
                />
              </div>
              <div className="flex items-center gap-3">
                <span className="badge badge-ghost badge-sm shrink-0 whitespace-nowrap">
                  {t(locale, 'workers.urlPreview')}
                </span>
                <span className={`min-w-0 break-all font-mono${subInfo.previewsEnabled ? '' : ' opacity-50'}`}>
                  *-{name}.{subInfo.subdomain}.workers.dev
                </span>
                <input
                  type="checkbox"
                  className="toggle toggle-sm ml-auto shrink-0"
                  checked={subInfo.previewsEnabled}
                  disabled={subBusy}
                  onChange={() => void toggleSubdomain('previews')}
                />
              </div>
            </div>
          )}
        </div>
        {historyGate(1, (h) => (
          <div className="card border border-base-300 bg-base-100 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">{t(locale, 'workers.bindingsTitle')}</h2>
              {h.settings && (
                <button className="btn btn-xs" onClick={openSettingsModal}>
                  <Pencil size={14} strokeWidth={1.75} />
                  {t(locale, 'workers.editSettings')}
                </button>
              )}
            </div>
            {h.errors.length > 0 && (
              <div className="alert alert-warning mb-3 text-xs">
                {t(locale, 'workers.historyLoadFailed')}: {h.errors.join('; ')}
              </div>
            )}
            {h.settings && (
              <div className="mb-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
                <div className="flex items-center gap-2">
                  <span className="opacity-60">{t(locale, 'workers.compatDate')}</span>
                  <span className="font-mono">{h.settings.compatibility_date ?? '—'}</span>
                </div>
                {(h.settings.compatibility_flags?.length ?? 0) > 0 && (
                  <div className="flex items-start gap-2">
                    <span className="opacity-60">{t(locale, 'workers.compatFlags')}</span>
                    <span className="flex flex-wrap gap-1">
                      {h.settings.compatibility_flags?.map((f) => (
                        <span key={f} className="badge badge-ghost badge-sm font-mono">
                          {f}
                        </span>
                      ))}
                    </span>
                  </div>
                )}
                {h.settings.usage_model && (
                  <div className="flex items-center gap-2">
                    <span className="opacity-60">{t(locale, 'workers.colUsageModel')}</span>
                    <span className="badge badge-ghost badge-sm font-mono">{h.settings.usage_model}</span>
                  </div>
                )}
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>{t(locale, 'workers.colBindingType')}</th>
                    <th>{t(locale, 'workers.colBindingName')}</th>
                    <th>{t(locale, 'workers.colBindingTarget')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(h.settings?.bindings ?? []).map((b, i) => (
                    <tr key={`${b.type}-${b.name}-${i}`}>
                      <td>
                        <span className="badge badge-ghost badge-sm font-mono">{b.type}</span>
                      </td>
                      <td className="font-mono">{b.name}</td>
                      <td className="font-mono text-xs opacity-60">{b.target ?? '—'}</td>
                    </tr>
                  ))}
                  {(h.settings?.bindings ?? []).length === 0 && (
                    <tr>
                      <td colSpan={3} className="text-center opacity-60">
                        {t(locale, 'workers.none')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      {/* 配置：Cron | 自定义域，Secrets 全宽 */}
      <div className={activeTab === 'config' ? 'space-y-6' : 'hidden'}>
        <div className="card border border-base-300 bg-base-100 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">{t(locale, 'workers.crons')}</h2>
            <button className="btn btn-xs" onClick={openCronModal}>
              <Pencil size={14} strokeWidth={1.75} />
              {t(locale, 'workers.editCrons')}
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>{t(locale, 'workers.colCron')}</th>
                  <th>{t(locale, 'workers.colCreated')}</th>
                  <th>{t(locale, 'workers.colModified')}</th>
                </tr>
              </thead>
              <tbody>
                {crons.map((c) => (
                  <tr key={c.cron}>
                    <td className="font-mono">{c.cron}</td>
                    <td>
                      <TimeCell iso={c.created_on} locale={locale} />
                    </td>
                    <td>
                      <TimeCell iso={c.modified_on} locale={locale} />
                    </td>
                  </tr>
                ))}
                {crons.length === 0 && (
                  <tr>
                    <td colSpan={3} className="text-center opacity-60">
                      {t(locale, 'workers.none')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card border border-base-300 bg-base-100 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">{t(locale, 'workers.customDomains')}</h2>
            <button className="btn btn-xs" onClick={openDomainModal}>
              <Plus size={14} strokeWidth={1.75} />
              {t(locale, 'workers.addDomain')}
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>{t(locale, 'workers.colHostname')}</th>
                  <th>{t(locale, 'workers.colZone')}</th>
                  <th>{t(locale, 'workers.colEnvironment')}</th>
                  <th>{t(locale, 'accounts.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {domains.map((d) => (
                  <tr key={d.id}>
                    <td className="font-mono">{d.hostname}</td>
                    <td className="font-mono">{d.zone_name ?? '—'}</td>
                    <td>{d.environment ? <span className="badge badge-ghost badge-sm">{d.environment}</span> : '—'}</td>
                    <td>
                      <button
                        className="btn btn-xs btn-error"
                        disabled={domainBusyId !== null}
                        onClick={() => void detachDomain(d)}
                      >
                        {domainBusyId === d.id ? (
                          <span className="loading loading-spinner loading-xs" />
                        ) : (
                          <Trash2 size={14} strokeWidth={1.75} />
                        )}
                      </button>
                    </td>
                  </tr>
                ))}
                {domains.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-center opacity-60">
                      {t(locale, 'workers.none')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card border border-base-300 bg-base-100 p-4">
          <h2 className="mb-3 font-semibold">{t(locale, 'workers.secretsTitle')}</h2>
          {secretsError ? (
            <div className="flex items-center gap-3 text-sm text-error">
              <span>{secretsError}</span>
              <button className="btn btn-sm" onClick={() => void reloadSecrets()}>
                {t(locale, 'common.retry')}
              </button>
            </div>
          ) : secretsLoading ? (
            <div className="skeleton h-24 w-full" />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="table table-sm">
                  <thead>
                    <tr>
                      <th>{t(locale, 'workers.secretName')}</th>
                      <th>{t(locale, 'workers.colBindingType')}</th>
                      <th>{t(locale, 'accounts.colActions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {secrets.map((s) => (
                      <tr key={s.name}>
                        <td className="font-mono">{s.name}</td>
                        <td>
                          <span className="badge badge-ghost badge-sm">{s.type}</span>
                        </td>
                        <td>
                          <button
                            className="btn btn-xs btn-error"
                            disabled={secretBusy !== null || secretAdding}
                            onClick={() => void deleteSecret(s.name)}
                          >
                            {secretBusy === s.name ? (
                              <span className="loading loading-spinner loading-xs" />
                            ) : (
                              <Trash2 size={14} strokeWidth={1.75} />
                            )}
                          </button>
                        </td>
                      </tr>
                    ))}
                    {secrets.length === 0 && (
                      <tr>
                        <td colSpan={3} className="text-center opacity-60">
                          {t(locale, 'workers.none')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
                <div className="flex flex-col">
                  <input
                    className="input input-sm w-full font-mono sm:w-48"
                    placeholder={t(locale, 'workers.secretName')}
                    value={newSecretName}
                    onChange={(e) => {
                      setNewSecretName(e.target.value);
                      setSecretNameInvalid(false);
                    }}
                  />
                  {secretNameInvalid && (
                    <span className="mt-1 text-xs text-error">{t(locale, 'workers.invalidSecretName')}</span>
                  )}
                </div>
                <input
                  type="password"
                  className="input input-sm w-full sm:min-w-48 sm:w-auto sm:flex-1"
                  placeholder={t(locale, 'workers.secretValue')}
                  value={newSecretValue}
                  onChange={(e) => setNewSecretValue(e.target.value)}
                />
                <button
                  className="btn btn-outline btn-primary btn-sm"
                  disabled={secretAdding || secretBusy !== null || newSecretName.trim() === '' || newSecretValue === ''}
                  onClick={() => void addSecret()}
                >
                  {secretAdding ? (
                    <span className="loading loading-spinner loading-xs" />
                  ) : (
                    <Plus size={14} strokeWidth={1.75} />
                  )}
                  {t(locale, 'workers.addSecret')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 部署：版本历史 + 部署历史 */}
      <div className={activeTab === 'deploys' ? 'space-y-6' : 'hidden'}>
        {historyGate(2, (h) => (
          <>
            <div className="card border border-base-300 bg-base-100 p-4">
              <h2 className="mb-3 font-semibold">{t(locale, 'workers.versionsTitle')}</h2>
              <div className="overflow-x-auto">
                <table className="table table-sm">
                  <thead>
                    <tr>
                      <th>{t(locale, 'workers.colVersion')}</th>
                      <th>{t(locale, 'workers.colNumber')}</th>
                      <th>{t(locale, 'workers.colMessage')}</th>
                      <th>{t(locale, 'workers.colTriggeredBy')}</th>
                      <th>{t(locale, 'workers.colCreated')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {h.versions.map((v) => (
                      <tr key={v.id}>
                        <td>
                          <span className="font-mono" title={v.id}>
                            {v.id.slice(0, 8)}
                          </span>
                        </td>
                        <td>{v.number ?? '—'}</td>
                        <td>{v.message ?? '—'}</td>
                        <td>
                          {v.triggered_by ? <span className="badge badge-ghost badge-sm">{v.triggered_by}</span> : '—'}
                        </td>
                        <td>
                          <TimeCell iso={v.created_on} locale={locale} />
                        </td>
                      </tr>
                    ))}
                    {h.versions.length === 0 && (
                      <tr>
                        <td colSpan={5} className="text-center opacity-60">
                          {t(locale, 'workers.none')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card border border-base-300 bg-base-100 p-4">
              <h2 className="mb-3 font-semibold">{t(locale, 'workers.deploymentsTitle')}</h2>
              <div className="overflow-x-auto">
                <table className="table table-sm">
                  <thead>
                    <tr>
                      <th>{t(locale, 'workers.colStrategy')}</th>
                      <th>{t(locale, 'workers.colVersions')}</th>
                      <th>{t(locale, 'workers.colAuthor')}</th>
                      <th>{t(locale, 'workers.colMessage')}</th>
                      <th>{t(locale, 'workers.colCreated')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {h.deployments.map((d) => (
                      <tr key={d.id}>
                        <td>{d.strategy ? <span className="badge badge-ghost badge-sm">{d.strategy}</span> : '—'}</td>
                        <td>
                          <div className="flex flex-col gap-0.5">
                            {d.versions.map((v) => (
                              <span key={v.version_id} className="font-mono text-xs" title={v.version_id}>
                                {v.version_id.slice(0, 8)} · {v.percentage}%
                              </span>
                            ))}
                            {d.versions.length === 0 && '—'}
                          </div>
                        </td>
                        <td>{d.author_email ?? '—'}</td>
                        <td>{d.message ?? '—'}</td>
                        <td>
                          <TimeCell iso={d.created_on} locale={locale} />
                        </td>
                      </tr>
                    ))}
                    {h.deployments.length === 0 && (
                      <tr>
                        <td colSpan={5} className="text-center opacity-60">
                          {t(locale, 'workers.none')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ))}
      </div>

      {/* 源码：CM6 全高 */}
      <div className={activeTab === 'source' ? '' : 'hidden'}>
        <div className="card border border-base-300 bg-base-100 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">{t(locale, 'workers.sourceTitle')}</h2>
            <div className="flex items-center gap-2">
              {source !== null && multiModule && (
                <span className="badge badge-ghost badge-sm">{t(locale, 'workers.multiModuleReadOnly')}</span>
              )}
              {canEditSource && !editing && (
                <button className="btn btn-sm" onClick={startEdit}>
                  <Pencil size={14} strokeWidth={1.75} />
                  {t(locale, 'workers.editSource')}
                </button>
              )}
            </div>
          </div>
          {sourceLoading && (
            <div className="mt-3">
              <EditorSkeleton />
            </div>
          )}
          {sourceError && !sourceLoading && (
            <div className="mt-3 flex items-center gap-3 text-sm text-error">
              <span>{sourceError}</span>
              <button className="btn btn-sm" onClick={() => void loadSource()}>
                {t(locale, 'common.retry')}
              </button>
            </div>
          )}
          {source !== null && (
            <div className="mt-3">
              <Suspense fallback={<EditorSkeleton />}>
                <CodeEditor
                  value={editing ? draft : source}
                  onChange={editing ? setDraft : undefined}
                  readOnly={!editing}
                  height="max(24rem, calc(100vh - 22rem))"
                />
              </Suspense>
              {editing && (
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    className="btn btn-sm"
                    disabled={deploying}
                    onClick={() => {
                      setEditing(false);
                      setDraft('');
                    }}
                  >
                    {t(locale, 'workers.cancelEdit')}
                  </button>
                  <button className="btn btn-primary btn-sm" disabled={deploying} onClick={() => void saveDeploy()}>
                    {deploying ? (
                      <span className="loading loading-spinner loading-xs" />
                    ) : (
                      <Rocket size={14} strokeWidth={1.75} />
                    )}
                    {t(locale, 'workers.saveDeploy')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 原 cronModalOpen / domainModalOpen 两个 dialog 原样保留在根部 */}
      {cronModalOpen && (
        <dialog open className="modal modal-open">
          <div className="modal-box max-w-lg border border-base-300">
            <h3 className="mb-4 font-semibold">{t(locale, 'workers.cronsTitle')}</h3>
            <div className="space-y-2">
              {cronRows.map((row, i) => (
                <div key={i}>
                  <div className="flex items-center gap-2">
                    <input
                      className="input input-sm flex-1 font-mono"
                      value={row}
                      onChange={(e) => setCronRows((prev) => prev.map((r, j) => (j === i ? e.target.value : r)))}
                    />
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => {
                        setCronRows((prev) => prev.filter((_, j) => j !== i));
                        setCronInvalid([]);
                      }}
                    >
                      <Trash2 size={14} strokeWidth={1.75} />
                    </button>
                  </div>
                  {cronInvalid.includes(i) && (
                    <p className="mt-1 text-xs text-error">{t(locale, 'workers.invalidCron', { n: i + 1 })}</p>
                  )}
                </div>
              ))}
              <button className="btn btn-ghost btn-sm" onClick={() => setCronRows((prev) => [...prev, ''])}>
                <Plus size={14} strokeWidth={1.75} />
                {t(locale, 'workers.addCron')}
              </button>
            </div>
            <div className="modal-action">
              <button className="btn btn-ghost" disabled={cronSaving} onClick={() => setCronModalOpen(false)}>
                {t(locale, 'common.cancel')}
              </button>
              <button className="btn btn-primary" disabled={cronSaving} onClick={() => void saveCrons()}>
                {cronSaving && <span className="loading loading-spinner loading-xs" />}
                {t(locale, 'common.confirm')}
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop" onSubmit={() => setCronModalOpen(false)}>
            <button type="submit" aria-label={t(locale, 'common.cancel')} />
          </form>
        </dialog>
      )}

      {domainModalOpen && (
        <dialog open className="modal modal-open">
          <div className="modal-box max-w-md border border-base-300">
            <h3 className="mb-4 font-semibold">{t(locale, 'workers.addDomain')}</h3>
            <input
              className="input input-sm w-full font-mono"
              placeholder={t(locale, 'workers.domainHostname')}
              value={domainHostname}
              onChange={(e) => {
                setDomainHostname(e.target.value);
                setDomainInlineError(null);
              }}
            />
            {domainInlineError && <p className="mt-2 text-xs text-error">{domainInlineError}</p>}
            {zoneMatch ? (
              <p className="mt-2 text-xs opacity-60">
                {t(locale, 'workers.zoneMatched', { zone: zoneMatch.zoneName })}
              </p>
            ) : zoneMatch === null ? (
              <p className="mt-2 text-xs opacity-60">{t(locale, 'workers.zoneNotFound')}</p>
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

      {settingsModalOpen && (
        <dialog open className="modal modal-open">
          <div className="modal-box max-w-2xl border border-base-300">
            <h3 className="mb-4 font-semibold">{t(locale, 'workers.editSettings')}</h3>
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="opacity-60">{t(locale, 'workers.compatDate')}</span>
                  <input
                    className="input input-sm font-mono"
                    placeholder="YYYY-MM-DD"
                    value={editCompatDate}
                    onChange={(e) => {
                      setEditCompatDate(e.target.value);
                      setSettingsInlineError(null);
                    }}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="opacity-60">
                    {t(locale, 'workers.compatFlags')} · {t(locale, 'workers.compatFlagsHint')}
                  </span>
                  <textarea
                    className="textarea textarea-sm h-16 font-mono"
                    value={editCompatFlags}
                    onChange={(e) => setEditCompatFlags(e.target.value)}
                  />
                </label>
              </div>

              <div className="space-y-1">
                {keptBindings.map((b) => (
                  <div key={`${b.type}-${b.name}`} className="flex items-center gap-2 text-sm">
                    <span className="badge badge-ghost badge-sm font-mono">{b.type}</span>
                    <span className="font-mono">{b.name}</span>
                    <span className="truncate font-mono text-xs opacity-50">{b.target ?? ''}</span>
                    {b.type === 'secret_text' ? (
                      <span className="ml-auto text-xs opacity-50">{t(locale, 'workers.bindingManagedInSecrets')}</span>
                    ) : (
                      <button
                        className="btn btn-ghost btn-xs ml-auto"
                        onClick={() => setKeptBindings((prev) => prev.filter((x) => x !== b))}
                      >
                        <Trash2 size={14} strokeWidth={1.75} />
                      </button>
                    )}
                  </div>
                ))}
                {newBindings.map((nb, i) => (
                  <div key={`new-${i}`} className="flex flex-wrap items-center gap-2 text-sm">
                    <select
                      className="select select-sm w-36 font-mono"
                      value={nb.kind}
                      onChange={(e) =>
                        setNewBindings((prev) =>
                          prev.map((x, j) =>
                            j === i ? { ...x, kind: e.target.value as NewBindingKind, target: '', environment: '' } : x,
                          ),
                        )
                      }
                    >
                      {NEW_BINDING_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                    <input
                      className="input input-sm w-36 font-mono"
                      placeholder={t(locale, 'workers.bindingName')}
                      value={nb.name}
                      onChange={(e) =>
                        setNewBindings((prev) => prev.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                      }
                    />
                    <input
                      className="input input-sm min-w-36 flex-1 font-mono"
                      placeholder={t(locale, BINDING_TARGET_LABEL_KEYS[nb.kind])}
                      value={nb.target}
                      onChange={(e) =>
                        setNewBindings((prev) => prev.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))
                      }
                    />
                    {nb.kind === 'service' && (
                      <input
                        className="input input-sm w-32 font-mono"
                        placeholder={t(locale, 'workers.bindingEnvironment')}
                        value={nb.environment}
                        onChange={(e) =>
                          setNewBindings((prev) =>
                            prev.map((x, j) => (j === i ? { ...x, environment: e.target.value } : x)),
                          )
                        }
                      />
                    )}
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => setNewBindings((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <Trash2 size={14} strokeWidth={1.75} />
                    </button>
                  </div>
                ))}
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    setNewBindings((prev) => [...prev, { kind: 'kv_namespace', name: '', target: '', environment: '' }])
                  }
                >
                  <Plus size={14} strokeWidth={1.75} />
                  {t(locale, 'workers.addBinding')}
                </button>
              </div>

              {settingsInlineError && <p className="text-xs text-error">{settingsInlineError}</p>}
            </div>
            <div className="modal-action">
              <button className="btn btn-ghost" disabled={settingsSaving} onClick={() => setSettingsModalOpen(false)}>
                {t(locale, 'common.cancel')}
              </button>
              <button
                className="btn btn-primary"
                disabled={settingsSaving || newBindings.some((nb) => nb.name.trim() === '' || nb.target.trim() === '')}
                onClick={() => void saveSettings()}
              >
                {settingsSaving && <span className="loading loading-spinner loading-xs" />}
                {t(locale, 'common.confirm')}
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop" onSubmit={() => setSettingsModalOpen(false)}>
            <button type="submit" aria-label={t(locale, 'common.cancel')} />
          </form>
        </dialog>
      )}
    </div>
  );
}

export default function WorkerDetailPanel(props: {
  accountId: string;
  name: string;
  locale: Locale;
  cfAccountId?: string | null;
  initialTab?: string | null;
}) {
  return (
    <ToastProvider>
      <ConfirmDialogProvider>
        <WorkerDetailPanelInner {...props} />
      </ConfirmDialogProvider>
    </ToastProvider>
  );
}
