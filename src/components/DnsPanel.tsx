import { ArrowDown, ArrowUp, ArrowUpDown, Check, Cloud, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Locale, t } from '../i18n';
import { DNS_VALIDATION_MESSAGES, type DnsValidationError, validateDnsRecord } from '../lib/dnsRecordValidation';
import { ConfirmDialogProvider, useConfirm } from './ui/ConfirmDialog';
import { ToastProvider, useToast } from './ui/ToastProvider';

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority?: number;
}

interface RecordForm {
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority: number;
}

function recordPayload(f: RecordForm) {
  return {
    type: f.type,
    name: f.name,
    content: f.content,
    ttl: f.ttl,
    proxied: f.proxied,
    ...(f.type === 'MX' ? { priority: f.priority } : {}),
  };
}

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS'];
type SortDir = 'asc' | 'desc' | null;

/** 错误码 → 表单里该标红的字段 */
function errorField(err: DnsValidationError): 'name' | 'content' | 'priority' | null {
  if (err === 'name') return 'name';
  if (err === 'priority') return 'priority';
  if (err === 'content' || err === 'ipv4' || err === 'ipv6' || err === 'hostname') return 'content';
  return null;
}

function SortIcon({ dir }: { dir: SortDir }) {
  if (dir === 'asc') return <ArrowUp size={14} strokeWidth={1.75} />;
  if (dir === 'desc') return <ArrowDown size={14} strokeWidth={1.75} />;
  return <ArrowUpDown size={14} strokeWidth={1.75} className="opacity-40" />;
}

function DnsPanelInner({ zoneId, locale, zoneName }: { zoneId: string; locale: Locale; zoneName?: string }) {
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ type: 'A', name: '', content: '', ttl: 1, proxied: false, priority: 10 });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState('');
  const [nameSortDir, setNameSortDir] = useState<SortDir>(null);
  const [editing, setEditing] = useState<DnsRecord | null>(null);
  const [editForm, setEditForm] = useState<RecordForm>({
    type: 'A',
    name: '',
    content: '',
    ttl: 1,
    proxied: false,
    priority: 10,
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<DnsValidationError | null>(null);
  const [editError, setEditError] = useState<DnsValidationError | null>(null);
  const { showToast } = useToast();
  const confirm = useConfirm();

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditing(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editing]);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/zones/${zoneId}/dns`);
      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        setError(data.error ?? t(locale, 'common.requestFailed'));
        setLoading(false);
        return;
      }
      setError(null);
      const data = (await res.json()) as { records: DnsRecord[] };
      setRecords(data.records);
    } catch {
      setError(t(locale, 'common.requestFailed'));
    }
    setLoading(false);
  }, [zoneId, locale]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const displayedRecords = useMemo(() => {
    let list = typeFilter ? records.filter((r) => r.type === typeFilter) : records;
    if (nameSortDir) {
      list = [...list].sort((a, b) =>
        nameSortDir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name),
      );
    }
    return list;
  }, [records, typeFilter, nameSortDir]);

  function toggleNameSort() {
    setNameSortDir((d) => (d === null ? 'asc' : d === 'asc' ? 'desc' : null));
  }

  async function createRecord(e: React.FormEvent) {
    e.preventDefault();
    const invalid = validateDnsRecord(recordPayload(form));
    setFormError(invalid);
    if (invalid) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/zones/${zoneId}/dns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(recordPayload(form)),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        showToast(data.error ?? t(locale, 'common.requestFailed'), 'error');
      } else {
        setError(null);
        setForm({ type: 'A', name: '', content: '', ttl: 1, proxied: false, priority: 10 });
        await reload();
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setBusy(false);
    }
  }

  function openEdit(r: DnsRecord) {
    setEditError(null);
    setEditForm({
      type: r.type,
      name: r.name,
      content: r.content,
      ttl: r.ttl,
      proxied: r.proxied,
      priority: r.priority ?? 10,
    });
    setEditing(r);
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const invalid = validateDnsRecord(recordPayload(editForm));
    setEditError(invalid);
    if (invalid) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/zones/${zoneId}/dns/${editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(recordPayload(editForm)),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error: string } | null;
        showToast(data?.error ?? t(locale, 'common.requestFailed'), 'error');
      } else {
        setEditing(null);
        showToast(t(locale, 'dns.updated'), 'success');
        await reload();
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function removeRecord(id: string) {
    const ok = await confirm({
      title: t(locale, 'dns.confirmDelete'),
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/zones/${zoneId}/dns/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        showToast(data.error ?? t(locale, 'common.requestFailed'), 'error');
        return;
      }
      await reload();
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
  }

  const tableHead = (
    <thead>
      <tr>
        <th>{t(locale, 'dns.colType')}</th>
        <th>
          <button className="inline-flex cursor-pointer select-none items-center gap-1" onClick={toggleNameSort}>
            {t(locale, 'dns.colName')}
            <SortIcon dir={nameSortDir} />
          </button>
        </th>
        <th>{t(locale, 'dns.colContent')}</th>
        <th>{t(locale, 'dns.colTtl')}</th>
        <th>{t(locale, 'dns.colProxied')}</th>
        <th></th>
      </tr>
    </thead>
  );

  return (
    <div className="space-y-6">
      {error && <div className="alert alert-error text-sm">{error}</div>}

      <form onSubmit={createRecord} className="card border border-base-300 bg-base-100 p-4">
        <fieldset className="fieldset">
          <legend className="fieldset-legend">{t(locale, 'dns.addTitle')}</legend>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="select select-bordered select-sm w-24"
              value={form.type}
              onChange={(e) => {
                setFormError(null);
                setForm({ ...form, type: e.target.value });
              }}
            >
              {RECORD_TYPES.map((rt) => (
                <option key={rt}>{rt}</option>
              ))}
            </select>
            <input
              className={`input input-bordered input-sm${formError && errorField(formError) === 'name' ? ' input-error' : ''}`}
              placeholder={t(locale, 'dns.namePlaceholder')}
              value={form.name}
              onChange={(e) => {
                setFormError(null);
                setForm({ ...form, name: e.target.value });
              }}
              required
            />
            <input
              className={`input input-bordered input-sm flex-1${formError && errorField(formError) === 'content' ? ' input-error' : ''}`}
              placeholder={t(locale, 'dns.contentPlaceholder')}
              value={form.content}
              onChange={(e) => {
                setFormError(null);
                setForm({ ...form, content: e.target.value });
              }}
              required
            />
            {form.type === 'MX' && (
              <input
                type="number"
                className={`input input-bordered input-sm w-20${formError && errorField(formError) === 'priority' ? ' input-error' : ''}`}
                placeholder={t(locale, 'dns.priorityPlaceholder')}
                value={form.priority}
                onChange={(e) => {
                  setFormError(null);
                  setForm({ ...form, priority: Number(e.target.value) });
                }}
              />
            )}
            <label className="label cursor-pointer gap-1 text-sm">
              <input
                type="checkbox"
                className="toggle toggle-sm"
                checked={form.proxied}
                onChange={(e) => setForm({ ...form, proxied: e.target.checked })}
              />
              {t(locale, 'dns.proxied')}
            </label>
            <button className="btn btn-primary btn-sm" disabled={busy} type="submit">
              <Plus size={14} strokeWidth={1.75} />
              {t(locale, 'dns.submit')}
            </button>
          </div>
          {formError && <p className="mt-1 text-xs text-error">{t(locale, DNS_VALIDATION_MESSAGES[formError])}</p>}
        </fieldset>
      </form>

      <div className="card border border-base-300 bg-base-100 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="font-semibold">{t(locale, 'dns.listTitle')}</h2>
          <div className="join">
            <button
              className={`join-item btn btn-sm${typeFilter === '' ? ' btn-active' : ''}`}
              onClick={() => setTypeFilter('')}
            >
              {t(locale, 'dns.filterAll')}
            </button>
            {RECORD_TYPES.map((rt) => (
              <button
                key={rt}
                className={`join-item btn btn-sm${typeFilter === rt ? ' btn-active' : ''}`}
                onClick={() => setTypeFilter(rt)}
              >
                {rt}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
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
          <div className="overflow-x-auto">
            <table className="table table-sm">
              {tableHead}
              <tbody>
                {displayedRecords.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="badge badge-ghost badge-sm font-mono">{r.type}</span>
                    </td>
                    <td className="font-mono">{r.name}</td>
                    <td className="max-w-md truncate font-mono">
                      {r.type === 'MX' && r.priority != null ? `${r.priority} ${r.content}` : r.content}
                    </td>
                    <td>{r.ttl === 1 ? t(locale, 'dns.ttlAuto') : r.ttl}</td>
                    <td>
                      {r.proxied ? (
                        <div className="tooltip" data-tip={t(locale, 'dns.proxiedTip')}>
                          <Cloud size={14} strokeWidth={1.75} className="text-primary" />
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="space-x-2 whitespace-nowrap">
                      <button className="btn btn-xs" onClick={() => openEdit(r)}>
                        <Pencil size={14} strokeWidth={1.75} />
                        {t(locale, 'dns.edit')}
                      </button>
                      <button className="btn btn-xs btn-error" onClick={() => void removeRecord(r.id)}>
                        <Trash2 size={14} strokeWidth={1.75} />
                        {t(locale, 'dns.delete')}
                      </button>
                    </td>
                  </tr>
                ))}
                {displayedRecords.length === 0 && !error && (
                  <tr>
                    <td colSpan={6} className="text-center opacity-60">
                      {zoneName ? t(locale, 'dns.emptyZone', { zone: zoneName }) : t(locale, 'dns.empty')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <dialog open className="modal modal-open">
          <div className="modal-box max-w-md border border-base-300">
            <h3 className="mb-1 font-semibold">{t(locale, 'dns.editTitle')}</h3>
            <p className="mb-4 font-mono text-xs opacity-60">{editing.name}</p>
            <form onSubmit={saveEdit} className="flex flex-col gap-3">
              <select
                className="select select-bordered select-sm w-full"
                value={editForm.type}
                onChange={(e) => {
                  setEditError(null);
                  setEditForm({ ...editForm, type: e.target.value });
                }}
              >
                {RECORD_TYPES.map((rt) => (
                  <option key={rt}>{rt}</option>
                ))}
              </select>
              <input
                className={`input input-bordered input-sm w-full${editError && errorField(editError) === 'name' ? ' input-error' : ''}`}
                placeholder={t(locale, 'dns.namePlaceholder')}
                value={editForm.name}
                onChange={(e) => {
                  setEditError(null);
                  setEditForm({ ...editForm, name: e.target.value });
                }}
                required
              />
              <input
                className={`input input-bordered input-sm w-full${editError && errorField(editError) === 'content' ? ' input-error' : ''}`}
                placeholder={t(locale, 'dns.contentPlaceholder')}
                value={editForm.content}
                onChange={(e) => {
                  setEditError(null);
                  setEditForm({ ...editForm, content: e.target.value });
                }}
                required
              />
              {editForm.type === 'MX' && (
                <input
                  type="number"
                  className={`input input-bordered input-sm w-full${editError && errorField(editError) === 'priority' ? ' input-error' : ''}`}
                  placeholder={t(locale, 'dns.priorityPlaceholder')}
                  value={editForm.priority}
                  onChange={(e) => {
                    setEditError(null);
                    setEditForm({ ...editForm, priority: Number(e.target.value) });
                  }}
                />
              )}
              {editError && <p className="text-xs text-error">{t(locale, DNS_VALIDATION_MESSAGES[editError])}</p>}
              <label className="label cursor-pointer justify-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="toggle toggle-sm"
                  checked={editForm.proxied}
                  onChange={(e) => setEditForm({ ...editForm, proxied: e.target.checked })}
                />
                {t(locale, 'dns.proxied')}
              </label>
              <div className="modal-action mt-2">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>
                  {t(locale, 'common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
                  {saving ? (
                    <span className="loading loading-spinner loading-xs" />
                  ) : (
                    <Check size={14} strokeWidth={1.75} />
                  )}
                  {t(locale, 'dns.save')}
                </button>
              </div>
            </form>
          </div>
          <form method="dialog" className="modal-backdrop" onSubmit={() => setEditing(null)}>
            <button type="submit" aria-label={t(locale, 'common.cancel')} />
          </form>
        </dialog>
      )}
    </div>
  );
}

export default function DnsPanel(props: { zoneId: string; locale: Locale; zoneName?: string }) {
  return (
    <ToastProvider>
      <ConfirmDialogProvider>
        <DnsPanelInner zoneId={props.zoneId} locale={props.locale} zoneName={props.zoneName} />
      </ConfirmDialogProvider>
    </ToastProvider>
  );
}
