import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/ToastProvider';
import { type Locale, t } from '@/i18n';
import { withCf } from '@/lib/withCf';

interface ManagedDomain {
  domain: string;
  enabled: boolean;
}
interface CustomDomain {
  domain: string;
  enabled: boolean;
  ownershipStatus: string | null;
  sslStatus: string | null;
  zoneName: string | null;
}
interface CorsRule {
  allowed: { methods: string[]; origins: string[]; headers?: string[] };
  id?: string;
  exposeHeaders?: string[];
  maxAgeSeconds?: number;
}
interface LifecycleRule {
  id: string;
  enabled: boolean;
  prefix: string;
  deleteAfterDays: number | null;
  iaAfterDays: number | null;
  abortMultipartDays: number | null;
  /** 含非 Age 条件（如固定日期）：表单只读，保存时后端按 raw 原样透传 */
  unsupported?: boolean;
  raw?: unknown;
}

const METHODS = ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'] as const;

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-box border border-base-300 p-4">
      <h3 className="mb-3 font-semibold">{title}</h3>
      {children}
    </div>
  );
}

export default function SettingsTab({
  locale,
  apiBase,
  cfAccountId,
}: {
  locale: Locale;
  apiBase: string;
  cfAccountId?: string | null;
}) {
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  // 公开访问
  const [managed, setManaged] = useState<ManagedDomain | null>(null);
  const [custom, setCustom] = useState<CustomDomain[]>([]);
  const [domainInput, setDomainInput] = useState('');
  const [domainBusy, setDomainBusy] = useState(false);
  const [removingDomain, setRemovingDomain] = useState<string | null>(null);
  const [r2devBusy, setR2devBusy] = useState(false);
  // CORS
  const [corsRules, setCorsRules] = useState<CorsRule[]>([]);
  const [corsBusy, setCorsBusy] = useState(false);
  // 生命周期
  const [lifecycleRules, setLifecycleRules] = useState<LifecycleRule[]>([]);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const failMsg = useCallback(
    (status: number) => (status === 403 ? t(locale, 'r2.forbiddenHint') : t(locale, 'common.requestFailed')),
    [locale],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [dRes, cRes, lRes] = await Promise.all([
        fetch(withCf(`${apiBase}/domains`, cfAccountId)),
        fetch(withCf(`${apiBase}/cors`, cfAccountId)),
        fetch(withCf(`${apiBase}/lifecycle`, cfAccountId)),
      ]);
      if (!dRes.ok && !cRes.ok && !lRes.ok) {
        setError(failMsg(dRes.status));
        return;
      }
      setError(null);
      if (dRes.ok) {
        const d = (await dRes.json()) as { managed: ManagedDomain | null; custom: CustomDomain[] };
        setManaged(d.managed);
        setCustom(d.custom);
      }
      if (cRes.ok) setCorsRules(((await cRes.json()) as { rules: CorsRule[] }).rules);
      if (lRes.ok) setLifecycleRules(((await lRes.json()) as { rules: LifecycleRule[] }).rules);
    } catch {
      setError(t(locale, 'common.requestFailed'));
    } finally {
      setLoading(false);
    }
  }, [apiBase, cfAccountId, failMsg, locale]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function toggleR2Dev(enabled: boolean) {
    setR2devBusy(true);
    try {
      const res = await fetch(withCf(`${apiBase}/domains`, cfAccountId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        showToast(failMsg(res.status), 'error');
        return;
      }
      setManaged(((await res.json()) as { managed: ManagedDomain }).managed);
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setR2devBusy(false);
    }
  }

  async function addDomain() {
    if (domainBusy || domainInput.trim() === '') return;
    setDomainBusy(true);
    try {
      const res = await fetch(withCf(`${apiBase}/domains`, cfAccountId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domainInput.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(body?.error ?? failMsg(res.status), 'error');
        return;
      }
      showToast(t(locale, 'r2.settingsDomainAdded'), 'success');
      setDomainInput('');
      void reload();
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setDomainBusy(false);
    }
  }

  async function removeDomain(domain: string) {
    if (removingDomain) return;
    const ok = await confirm({
      title: t(locale, 'r2.confirmRemoveDomain', { domain }),
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    setRemovingDomain(domain);
    try {
      const res = await fetch(withCf(`${apiBase}/domains?domain=${encodeURIComponent(domain)}`, cfAccountId), {
        method: 'DELETE',
      });
      if (!res.ok) {
        showToast(failMsg(res.status), 'error');
        return;
      }
      showToast(t(locale, 'r2.settingsDomainRemoved'), 'success');
      void reload();
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setRemovingDomain(null);
    }
  }

  async function saveCors() {
    setCorsBusy(true);
    try {
      const res = await fetch(withCf(`${apiBase}/cors`, cfAccountId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: corsRules }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(body?.error ?? failMsg(res.status), 'error');
        return;
      }
      showToast(t(locale, 'r2.corsSaved'), 'success');
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setCorsBusy(false);
    }
  }

  async function saveLifecycle() {
    setLifecycleBusy(true);
    try {
      const res = await fetch(withCf(`${apiBase}/lifecycle`, cfAccountId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: lifecycleRules }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(body?.error ?? failMsg(res.status), 'error');
        return;
      }
      showToast(t(locale, 'r2.lifecycleSaved'), 'success');
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setLifecycleBusy(false);
    }
  }

  function updateCors(i: number, patch: Partial<CorsRule> & { allowed?: CorsRule['allowed'] }) {
    setCorsRules((rules) => rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function updateLifecycle(i: number, patch: Partial<LifecycleRule>) {
    setLifecycleRules((rules) => rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  const csv = (v: string) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  if (loading) return <div className="skeleton h-40 w-full" />;
  if (error) return <div className="alert alert-warning text-sm">{error}</div>;

  return (
    <div className="flex flex-col gap-4">
      <Card title={t(locale, 'r2.settingsPublic')}>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-medium">{t(locale, 'r2.settingsR2Dev')}</div>
            <div className="text-xs opacity-60">{t(locale, 'r2.settingsR2DevDesc')}</div>
            {managed?.enabled && <div className="mt-1 min-w-0 break-all font-mono text-xs">{managed.domain}</div>}
          </div>
          <input
            type="checkbox"
            className="toggle toggle-primary shrink-0"
            checked={managed?.enabled ?? false}
            disabled={managed === null || r2devBusy}
            onChange={(e) => void toggleR2Dev(e.target.checked)}
          />
        </div>
        <div className="divider my-2" />
        <div className="mb-2 font-medium">{t(locale, 'r2.settingsCustomDomains')}</div>
        <ul className="flex flex-col gap-2">
          {custom.map((d) => (
            <li key={d.domain} className="flex items-center gap-2">
              <span className="min-w-0 break-all font-mono text-sm">{d.domain}</span>
              <span className="badge badge-outline badge-sm shrink-0 whitespace-nowrap">
                {d.ownershipStatus ?? '—'}
              </span>
              <span className="badge badge-ghost badge-sm shrink-0 whitespace-nowrap">SSL: {d.sslStatus ?? '—'}</span>
              <button
                className="btn btn-ghost btn-xs shrink-0 whitespace-nowrap text-error"
                disabled={removingDomain !== null}
                onClick={() => void removeDomain(d.domain)}
              >
                {removingDomain === d.domain ? (
                  <span className="loading loading-spinner loading-xs" />
                ) : (
                  <Trash2 size={12} strokeWidth={1.75} />
                )}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start">
          <input
            type="text"
            className="input input-bordered input-sm w-full sm:flex-1"
            placeholder={t(locale, 'r2.settingsDomainPlaceholder')}
            value={domainInput}
            onChange={(e) => setDomainInput(e.target.value)}
          />
          <button
            className="btn btn-sm whitespace-nowrap"
            disabled={domainBusy || domainInput.trim() === ''}
            onClick={() => void addDomain()}
          >
            {domainBusy && <span className="loading loading-spinner loading-xs" />}
            {t(locale, 'r2.settingsAddDomain')}
          </button>
        </div>
      </Card>

      <Card title={t(locale, 'r2.settingsCors')}>
        <div className="flex flex-col gap-3">
          {corsRules.map((rule, i) => (
            <div key={rule.id ?? i} className="flex flex-col gap-2 rounded-box border border-base-300 p-3">
              <label className="text-xs opacity-60" htmlFor={`cors-origins-${i}`}>
                {t(locale, 'r2.corsOrigins')}
              </label>
              <input
                id={`cors-origins-${i}`}
                type="text"
                className="input input-bordered input-sm w-full"
                value={rule.allowed.origins.join(', ')}
                onChange={(e) => updateCors(i, { allowed: { ...rule.allowed, origins: csv(e.target.value) } })}
              />
              <span className="text-xs opacity-60">{t(locale, 'r2.corsMethods')}</span>
              <div className="flex flex-wrap gap-2">
                {METHODS.map((m) => (
                  <label key={m} className="label cursor-pointer gap-1">
                    <input
                      type="checkbox"
                      className="checkbox checkbox-xs"
                      checked={rule.allowed.methods.includes(m)}
                      onChange={(e) =>
                        updateCors(i, {
                          allowed: {
                            ...rule.allowed,
                            methods: e.target.checked
                              ? [...rule.allowed.methods, m]
                              : rule.allowed.methods.filter((x) => x !== m),
                          },
                        })
                      }
                    />
                    <span className="font-mono text-xs">{m}</span>
                  </label>
                ))}
              </div>
              <label className="text-xs opacity-60" htmlFor={`cors-headers-${i}`}>
                {t(locale, 'r2.corsHeaders')}
              </label>
              <input
                id={`cors-headers-${i}`}
                type="text"
                className="input input-bordered input-sm w-full"
                value={(rule.allowed.headers ?? []).join(', ')}
                onChange={(e) => {
                  const headers = csv(e.target.value);
                  updateCors(i, {
                    allowed: {
                      methods: rule.allowed.methods,
                      origins: rule.allowed.origins,
                      ...(headers.length ? { headers } : {}),
                    },
                  });
                }}
              />
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <label className="text-xs opacity-60" htmlFor={`cors-maxage-${i}`}>
                  {t(locale, 'r2.corsMaxAge')}
                </label>
                <input
                  id={`cors-maxage-${i}`}
                  type="number"
                  className="input input-bordered input-sm w-full max-w-full sm:w-32"
                  value={rule.maxAgeSeconds ?? ''}
                  onChange={(e) =>
                    updateCors(
                      i,
                      e.target.value === '' ? { maxAgeSeconds: undefined } : { maxAgeSeconds: Number(e.target.value) },
                    )
                  }
                />
                <button
                  className="btn btn-ghost btn-xs whitespace-nowrap text-error sm:ml-auto"
                  onClick={() => setCorsRules((rules) => rules.filter((_, idx) => idx !== i))}
                >
                  {t(locale, 'r2.corsRemoveRule')}
                </button>
              </div>
            </div>
          ))}
          <div className="flex gap-2">
            <button
              className="btn btn-sm whitespace-nowrap"
              onClick={() => setCorsRules((rules) => [...rules, { allowed: { methods: ['GET'], origins: [] } }])}
            >
              <Plus size={14} strokeWidth={1.75} />
              {t(locale, 'r2.corsAddRule')}
            </button>
            <button
              className="btn btn-primary btn-sm whitespace-nowrap"
              disabled={corsBusy}
              onClick={() => void saveCors()}
            >
              {corsBusy && <span className="loading loading-spinner loading-xs" />}
              {t(locale, 'r2.corsSave')}
            </button>
          </div>
        </div>
      </Card>

      <Card title={t(locale, 'r2.settingsLifecycle')}>
        <div className="flex flex-col gap-3">
          {lifecycleRules.map((rule, i) => {
            const locked = rule.unsupported === true;
            return (
              <div
                key={rule.id}
                className="flex flex-col gap-2 rounded-box border border-base-300 p-3 sm:flex-row sm:flex-wrap sm:items-end"
              >
                <div className="w-full sm:flex-1">
                  <label className="text-xs opacity-60" htmlFor={`lifecycle-prefix-${rule.id}`}>
                    {t(locale, 'r2.lifecyclePrefix')}
                  </label>
                  <input
                    id={`lifecycle-prefix-${rule.id}`}
                    type="text"
                    className="input input-bordered input-sm w-full font-mono"
                    value={rule.prefix}
                    disabled={locked}
                    onChange={(e) => updateLifecycle(i, { prefix: e.target.value })}
                  />
                </div>
                <div className="w-full sm:w-40">
                  <label className="text-xs opacity-60" htmlFor={`lifecycle-delete-${rule.id}`}>
                    {t(locale, 'r2.lifecycleDeleteDays')}
                  </label>
                  <input
                    id={`lifecycle-delete-${rule.id}`}
                    type="number"
                    className="input input-bordered input-sm w-full"
                    value={rule.deleteAfterDays ?? ''}
                    disabled={locked}
                    onChange={(e) =>
                      updateLifecycle(i, { deleteAfterDays: e.target.value === '' ? null : Number(e.target.value) })
                    }
                  />
                </div>
                <div className="w-full sm:w-40">
                  <label className="text-xs opacity-60" htmlFor={`lifecycle-ia-${rule.id}`}>
                    {t(locale, 'r2.lifecycleIaDays')}
                  </label>
                  <input
                    id={`lifecycle-ia-${rule.id}`}
                    type="number"
                    className="input input-bordered input-sm w-full"
                    value={rule.iaAfterDays ?? ''}
                    disabled={locked}
                    onChange={(e) =>
                      updateLifecycle(i, { iaAfterDays: e.target.value === '' ? null : Number(e.target.value) })
                    }
                  />
                </div>
                <div className="w-full sm:w-40">
                  <label className="text-xs opacity-60" htmlFor={`lifecycle-abort-${rule.id}`}>
                    {t(locale, 'r2.lifecycleAbortDays')}
                  </label>
                  <input
                    id={`lifecycle-abort-${rule.id}`}
                    type="number"
                    className="input input-bordered input-sm w-full"
                    value={rule.abortMultipartDays ?? ''}
                    disabled={locked}
                    onChange={(e) =>
                      updateLifecycle(i, { abortMultipartDays: e.target.value === '' ? null : Number(e.target.value) })
                    }
                  />
                </div>
                <label className="label shrink-0 cursor-pointer gap-2">
                  <input
                    type="checkbox"
                    className="toggle toggle-sm"
                    checked={rule.enabled}
                    onChange={(e) => updateLifecycle(i, { enabled: e.target.checked })}
                  />
                  <span className="whitespace-nowrap text-xs">{t(locale, 'r2.lifecycleEnabled')}</span>
                </label>
                {locked && (
                  <span className="badge badge-warning badge-sm shrink-0 whitespace-nowrap">
                    {t(locale, 'r2.lifecycleDateRuleHint')}
                  </span>
                )}
                <button
                  className="btn btn-ghost btn-xs shrink-0 whitespace-nowrap text-error"
                  onClick={() => setLifecycleRules((rules) => rules.filter((_, idx) => idx !== i))}
                >
                  <Trash2 size={12} strokeWidth={1.75} />
                </button>
              </div>
            );
          })}
          <div className="flex gap-2">
            <button
              className="btn btn-sm whitespace-nowrap"
              onClick={() =>
                setLifecycleRules((rules) => [
                  ...rules,
                  {
                    id: `rule-${Date.now()}`,
                    enabled: true,
                    prefix: '',
                    deleteAfterDays: 30,
                    iaAfterDays: null,
                    abortMultipartDays: null,
                  },
                ])
              }
            >
              <Plus size={14} strokeWidth={1.75} />
              {t(locale, 'r2.lifecycleAddRule')}
            </button>
            <button
              className="btn btn-primary btn-sm whitespace-nowrap"
              disabled={lifecycleBusy}
              onClick={() => void saveLifecycle()}
            >
              {lifecycleBusy && <span className="loading loading-spinner loading-xs" />}
              {t(locale, 'r2.lifecycleSave')}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
