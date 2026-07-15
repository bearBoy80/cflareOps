import { Eye, Mail, Pencil, Plus, Send, SquarePen, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { type Locale, type MessageKey, t } from '@/i18n';
import { relativeTime } from '@/lib/time';
import type { EmailFormat } from '@/server/email/types';
import { ConfirmDialogProvider, useConfirm } from './ui/ConfirmDialog';
import DetailTabs, { useDetailTab } from './ui/DetailTabs';
import EmailPreview from './ui/EmailPreview';
import TablePagination from './ui/TablePagination';
import { ToastProvider, useToast } from './ui/ToastProvider';

const TAB_KEYS = ['send', 'domains', 'log'] as const;
type TabKey = (typeof TAB_KEYS)[number];

const FORMAT_KEYS: Record<EmailFormat, MessageKey> = {
  markdown: 'email.formatMarkdown',
  html: 'email.formatHtml',
  text: 'email.formatText',
};

const ERROR_CODE_KEYS: Record<string, MessageKey> = {
  fieldsRequired: 'email.errFieldsRequired',
  invalidDomain: 'email.errInvalidDomain',
  duplicateDomain: 'email.errDuplicateDomain',
  domainNotFound: 'email.errDomainNotFound',
  invalidRecipient: 'email.errInvalidRecipient',
  fromDomainMismatch: 'email.errFromDomainMismatch',
  renderFailed: 'email.errRenderFailed',
  emailSendForbidden: 'email.errScopeMissing',
  logNotFound: 'email.errLogNotFound',
  accountNotFound: 'accounts.errNotFound',
};

interface DomainItem {
  id: string;
  domain: string;
  provider: 'resend' | 'cloudflare';
  apiKeyHint: string | null;
  accountId: string | null;
  cfAccountId: string | null;
  createdAt: string;
}

interface AccountItem {
  id: string;
  name: string;
}

interface LogItem {
  id: string;
  provider: string;
  fromAddress: string;
  recipients: { to: string[]; cc: string[]; bcc: string[] };
  subject: string;
  format: EmailFormat;
  status: string;
  messageId: string | null;
  error: string | null;
  createdAt: string;
}

interface LogDetail extends LogItem {
  content: string;
}

function splitEmails(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function useApiErrorText(locale: Locale) {
  return useCallback(
    (data: { error?: string; code?: string } | null): string => {
      const key = data?.code ? ERROR_CODE_KEYS[data.code] : undefined;
      if (key) return t(locale, key);
      return data?.error ?? t(locale, 'common.requestFailed');
    },
    [locale],
  );
}

/* ---------------- 发送 tab ---------------- */

function SendTab({ locale, domains }: { locale: Locale; domains: DomainItem[] }) {
  const [domainId, setDomainId] = useState('');
  const [fromLocal, setFromLocal] = useState('');
  const [fromName, setFromName] = useState('');
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState('');
  const [format, setFormat] = useState<EmailFormat>('markdown');
  const [content, setContent] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const { showToast } = useToast();
  const apiErrorText = useApiErrorText(locale);

  const selected = domains.find((d) => d.id === domainId) ?? domains[0];
  const effectiveDomainId = selected?.id ?? '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setSending(true);
    try {
      const res = await fetch('/api/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domainId: effectiveDomainId,
          from: `${fromLocal.trim()}@${selected.domain}`,
          fromName: fromName.trim() || undefined,
          to: splitEmails(to),
          cc: splitEmails(cc),
          bcc: splitEmails(bcc),
          subject,
          format,
          content,
        }),
      });
      if (res.ok) {
        showToast(t(locale, 'email.sent'), 'success');
        // 保留收件人与主题便于连发，清空正文
        setContent('');
        setPreviewing(false);
      } else {
        const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        showToast(apiErrorText(data), 'error');
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setSending(false);
    }
  }

  if (domains.length === 0) {
    return (
      <div className="card flex flex-col items-center gap-4 border border-base-300 bg-base-100 p-12">
        <Mail size={48} strokeWidth={1.75} className="opacity-40" />
        <p className="text-sm opacity-60">{t(locale, 'email.noDomains')}</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="card border border-base-300 bg-base-100 p-4">
      <fieldset className="fieldset">
        <legend className="fieldset-legend">{t(locale, 'email.sendTitle')}</legend>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
          <select
            className="select select-bordered select-sm w-full sm:w-56"
            value={effectiveDomainId}
            onChange={(e) => setDomainId(e.target.value)}
            title={t(locale, 'email.domainLabel')}
          >
            {domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.domain}（{d.provider}）
              </option>
            ))}
          </select>
          <label className="input input-bordered input-sm flex w-full items-center gap-1 sm:w-72">
            <input
              type="text"
              className="min-w-0 grow"
              placeholder={t(locale, 'email.fromLocalPlaceholder')}
              value={fromLocal}
              onChange={(e) => setFromLocal(e.target.value)}
              required
            />
            <span className="shrink-0 whitespace-nowrap font-mono text-xs opacity-60">@{selected.domain}</span>
          </label>
          <input
            className="input input-bordered input-sm w-full sm:w-48"
            placeholder={t(locale, 'email.fromNamePlaceholder')}
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
          />
        </div>
        <div className="mt-2 flex flex-col gap-2">
          <input
            className="input input-bordered input-sm w-full"
            placeholder={t(locale, 'email.toPlaceholder')}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            required
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="input input-bordered input-sm w-full sm:flex-1"
              placeholder={t(locale, 'email.ccPlaceholder')}
              value={cc}
              onChange={(e) => setCc(e.target.value)}
            />
            <input
              className="input input-bordered input-sm w-full sm:flex-1"
              placeholder={t(locale, 'email.bccPlaceholder')}
              value={bcc}
              onChange={(e) => setBcc(e.target.value)}
            />
          </div>
          <input
            className="input input-bordered input-sm w-full"
            placeholder={t(locale, 'email.subjectPlaceholder')}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            required
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="join">
            {(Object.keys(FORMAT_KEYS) as EmailFormat[]).map((f) => (
              <button
                key={f}
                type="button"
                className={`btn join-item btn-xs whitespace-nowrap${format === f ? ' btn-active' : ''}`}
                onClick={() => setFormat(f)}
              >
                {t(locale, FORMAT_KEYS[f])}
              </button>
            ))}
          </div>
          <div className="join">
            <button
              type="button"
              className={`btn join-item btn-xs whitespace-nowrap${previewing ? '' : ' btn-active'}`}
              onClick={() => setPreviewing(false)}
            >
              <SquarePen size={14} strokeWidth={1.75} />
              {t(locale, 'email.editMode')}
            </button>
            <button
              type="button"
              className={`btn join-item btn-xs whitespace-nowrap${previewing ? ' btn-active' : ''}`}
              onClick={() => setPreviewing(true)}
            >
              <Eye size={14} strokeWidth={1.75} />
              {t(locale, 'email.previewMode')}
            </button>
          </div>
        </div>
        <div className="mt-2">
          {previewing ? (
            <EmailPreview format={format} content={content} />
          ) : (
            <textarea
              className="textarea textarea-bordered h-96 w-full font-mono text-sm"
              placeholder={t(locale, 'email.contentPlaceholder')}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              required
            />
          )}
        </div>
        <div className="mt-3">
          <button className="btn btn-primary btn-sm whitespace-nowrap" disabled={sending} type="submit">
            {sending ? <span className="loading loading-spinner loading-xs" /> : <Send size={14} strokeWidth={1.75} />}
            {sending ? t(locale, 'email.sending') : t(locale, 'email.send')}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

/* ---------------- 域名 tab ---------------- */

interface DomainFormValue {
  domain: string;
  provider: 'resend' | 'cloudflare';
  apiKey: string;
  accountId: string;
  cfAccountId: string;
}

function DomainFields({
  locale,
  value,
  onChange,
  accounts,
  editing,
}: {
  locale: Locale;
  value: DomainFormValue;
  onChange: (v: DomainFormValue) => void;
  accounts: AccountItem[];
  editing: boolean;
}) {
  const [cfAccounts, setCfAccounts] = useState<AccountItem[]>([]);

  // 选定本系统账号后拉取该 token 可见的 CF 侧账号
  useEffect(() => {
    if (value.provider !== 'cloudflare' || !value.accountId) {
      setCfAccounts([]);
      return;
    }
    let cancelled = false;
    void fetch(`/api/accounts/${value.accountId}/cf-accounts`)
      .then((res) => (res.ok ? res.json() : Promise.resolve({ cfAccounts: [] })))
      .then((data) => {
        if (!cancelled) setCfAccounts((data as { cfAccounts: AccountItem[] }).cfAccounts);
      })
      .catch(() => {
        if (!cancelled) setCfAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [value.provider, value.accountId]);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
      <input
        className="input input-bordered input-sm w-full sm:w-56"
        placeholder={t(locale, 'email.domainPlaceholder')}
        value={value.domain}
        onChange={(e) => onChange({ ...value, domain: e.target.value })}
        disabled={editing}
        required={!editing}
      />
      <select
        className="select select-bordered select-sm w-full sm:w-40"
        value={value.provider}
        onChange={(e) => onChange({ ...value, provider: e.target.value as 'resend' | 'cloudflare' })}
        title={t(locale, 'email.providerLabel')}
      >
        <option value="resend">Resend</option>
        <option value="cloudflare">Cloudflare</option>
      </select>
      {value.provider === 'resend' ? (
        <input
          className="input input-bordered input-sm w-full sm:flex-1"
          type="password"
          placeholder={t(locale, editing ? 'email.newApiKeyPlaceholder' : 'email.apiKeyPlaceholder')}
          value={value.apiKey}
          onChange={(e) => onChange({ ...value, apiKey: e.target.value })}
          required={!editing}
        />
      ) : (
        <>
          <select
            className="select select-bordered select-sm w-full sm:w-48"
            value={value.accountId}
            onChange={(e) => onChange({ ...value, accountId: e.target.value, cfAccountId: '' })}
            title={t(locale, 'email.accountLabel')}
            required
          >
            <option value="">{t(locale, 'email.accountLabel')}…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            className="select select-bordered select-sm w-full sm:w-56"
            value={value.cfAccountId}
            onChange={(e) => onChange({ ...value, cfAccountId: e.target.value })}
            title={t(locale, 'email.cfAccountLabel')}
            required
          >
            <option value="">{t(locale, 'email.cfAccountLabel')}…</option>
            {cfAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}

const EMPTY_FORM: DomainFormValue = { domain: '', provider: 'resend', apiKey: '', accountId: '', cfAccountId: '' };

function DomainsTab({
  locale,
  domains,
  onChanged,
}: {
  locale: Locale;
  domains: DomainItem[];
  onChanged: () => Promise<void>;
}) {
  const [form, setForm] = useState<DomainFormValue>(EMPTY_FORM);
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<DomainItem | null>(null);
  const [editForm, setEditForm] = useState<DomainFormValue>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();
  const confirm = useConfirm();
  const apiErrorText = useApiErrorText(locale);

  useEffect(() => {
    void fetch('/api/accounts?pageSize=100')
      .then((res) => (res.ok ? res.json() : Promise.resolve({ accounts: [] })))
      .then((data) => setAccounts((data as { accounts: AccountItem[] }).accounts))
      .catch(() => setAccounts([]));
  }, []);

  function domainBody(v: DomainFormValue): Record<string, unknown> {
    return v.provider === 'resend'
      ? { provider: 'resend', ...(v.apiKey.trim() ? { apiKey: v.apiKey.trim() } : {}) }
      : { provider: 'cloudflare', accountId: v.accountId, cfAccountId: v.cfAccountId };
  }

  async function addDomain(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch('/api/email/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: form.domain.trim(), ...domainBody(form) }),
      });
      if (res.ok) {
        setForm(EMPTY_FORM);
        showToast(t(locale, 'email.domainAdded'), 'success');
        await onChanged();
      } else {
        const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        showToast(apiErrorText(data), 'error');
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setBusy(false);
    }
  }

  function openEdit(d: DomainItem) {
    setEditForm({
      domain: d.domain,
      provider: d.provider,
      apiKey: '',
      accountId: d.accountId ?? '',
      cfAccountId: d.cfAccountId ?? '',
    });
    setEditing(d);
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/email/domains/${editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(domainBody(editForm)),
      });
      if (res.ok) {
        setEditing(null);
        showToast(t(locale, 'email.domainUpdated'), 'success');
        await onChanged();
      } else {
        const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        showToast(apiErrorText(data), 'error');
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function removeDomain(d: DomainItem) {
    const ok = await confirm({
      title: t(locale, 'email.confirmDeleteDomain', { domain: d.domain }),
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/email/domains/${d.id}`, { method: 'DELETE' });
      if (res.ok) {
        showToast(t(locale, 'email.domainDeleted'), 'success');
        await onChanged();
      } else {
        const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        showToast(apiErrorText(data), 'error');
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={addDomain} className="card border border-base-300 bg-base-100 p-4">
        <fieldset className="fieldset">
          <legend className="fieldset-legend">{t(locale, 'email.addDomainTitle')}</legend>
          <DomainFields locale={locale} value={form} onChange={setForm} accounts={accounts} editing={false} />
          <div className="mt-2">
            <button className="btn btn-primary btn-sm whitespace-nowrap" disabled={busy} type="submit">
              <Plus size={14} strokeWidth={1.75} />
              {t(locale, 'email.add')}
            </button>
          </div>
        </fieldset>
      </form>

      <div className="card border border-base-300 bg-base-100 p-4">
        <h2 className="mb-3 font-semibold">{t(locale, 'email.domainsTitle')}</h2>
        {domains.length === 0 ? (
          <p className="py-8 text-center text-sm opacity-60">{t(locale, 'email.emptyDomains')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>{t(locale, 'email.colDomain')}</th>
                  <th>{t(locale, 'email.colProvider')}</th>
                  <th className="hidden sm:table-cell">{t(locale, 'email.colCredential')}</th>
                  <th className="hidden md:table-cell">{t(locale, 'email.colCreated')}</th>
                  <th>{t(locale, 'email.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {domains.map((d) => (
                  <tr key={d.id}>
                    <td className="font-mono">{d.domain}</td>
                    <td>
                      <span className="badge badge-ghost badge-sm shrink-0 whitespace-nowrap">{d.provider}</span>
                    </td>
                    <td className="hidden font-mono text-xs opacity-60 sm:table-cell">
                      {d.provider === 'resend' ? `sha256:${d.apiKeyHint ?? '—'}` : (d.cfAccountId ?? '—')}
                    </td>
                    <td className="hidden font-mono text-xs md:table-cell" title={d.createdAt}>
                      {relativeTime(d.createdAt, locale) || '—'}
                    </td>
                    <td className="space-x-2 whitespace-nowrap">
                      <button className="btn btn-xs whitespace-nowrap" onClick={() => openEdit(d)} type="button">
                        <Pencil size={14} strokeWidth={1.75} />
                        {t(locale, 'email.edit')}
                      </button>
                      <button
                        className="btn btn-error btn-xs whitespace-nowrap"
                        onClick={() => void removeDomain(d)}
                        type="button"
                      >
                        <Trash2 size={14} strokeWidth={1.75} />
                        {t(locale, 'email.delete')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <dialog open className="modal modal-open">
          <div className="modal-box max-w-2xl border border-base-300">
            <h3 className="mb-1 font-semibold">{t(locale, 'email.editDomainTitle')}</h3>
            <p className="mb-4 font-mono text-xs opacity-60">{editing.domain}</p>
            <form onSubmit={saveEdit} className="flex flex-col gap-3">
              <DomainFields locale={locale} value={editForm} onChange={setEditForm} accounts={accounts} editing />
              <div className="modal-action mt-2">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>
                  {t(locale, 'common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary btn-sm whitespace-nowrap" disabled={saving}>
                  {saving && <span className="loading loading-spinner loading-xs" />}
                  {t(locale, 'email.save')}
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

/* ---------------- 记录 tab ---------------- */

function LogTab({ locale }: { locale: Locale }) {
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<LogDetail | null>(null);
  const { showToast } = useToast();
  const apiErrorText = useApiErrorText(locale);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const reload = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      const res = await fetch(`/api/email/log?${params.toString()}`);
      if (!res.ok) return;
      const data = (await res.json()) as { logs: LogItem[]; total: number };
      setLogs(data.logs);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function openDetail(id: string) {
    try {
      const res = await fetch(`/api/email/log/${id}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        showToast(apiErrorText(data), 'error');
        return;
      }
      const data = (await res.json()) as { log: LogDetail };
      setDetail(data.log);
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
  }

  return (
    <div className="card border border-base-300 bg-base-100 p-4">
      <h2 className="mb-3 font-semibold">{t(locale, 'email.logTitle')}</h2>
      {loading ? (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <tbody>
              {Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  <td>
                    <div className="skeleton h-8" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : total === 0 ? (
        <p className="py-8 text-center text-sm opacity-60">{t(locale, 'email.emptyLog')}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>{t(locale, 'email.colTime')}</th>
                  <th className="hidden sm:table-cell">{t(locale, 'email.colFrom')}</th>
                  <th className="hidden md:table-cell">{t(locale, 'email.colTo')}</th>
                  <th>{t(locale, 'email.colSubject')}</th>
                  <th>{t(locale, 'email.colStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr
                    key={log.id}
                    className="cursor-pointer hover:bg-base-200/60"
                    onClick={() => void openDetail(log.id)}
                  >
                    <td className="whitespace-nowrap font-mono text-xs" title={log.createdAt}>
                      {relativeTime(log.createdAt, locale) || '—'}
                    </td>
                    <td className="hidden font-mono text-xs sm:table-cell">{log.fromAddress}</td>
                    <td className="hidden font-mono text-xs md:table-cell">{log.recipients.to.join(', ')}</td>
                    <td>
                      <span className="block max-w-xs truncate">{log.subject}</span>
                    </td>
                    <td>
                      <span
                        className={`badge badge-sm shrink-0 whitespace-nowrap ${
                          log.status === 'sent' ? 'badge-success' : 'badge-error'
                        }`}
                      >
                        {t(locale, log.status === 'sent' ? 'email.statusSent' : 'email.statusFailed')}
                      </span>
                    </td>
                  </tr>
                ))}
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
        </>
      )}

      {detail && (
        <dialog open className="modal modal-open">
          <div className="modal-box max-w-3xl border border-base-300">
            <h3 className="mb-1 font-semibold">{t(locale, 'email.logDetailTitle')}</h3>
            <p className="mb-1 font-mono text-xs opacity-60">
              {detail.fromAddress} → {detail.recipients.to.join(', ')}
            </p>
            <p className="mb-3 min-w-0 break-all font-semibold text-sm">{detail.subject}</p>
            {detail.error && (
              <div className="alert alert-error mb-3 text-sm">
                <span className="min-w-0 break-all">
                  {t(locale, 'email.logError')}: {detail.error}
                </span>
              </div>
            )}
            <EmailPreview format={detail.format} content={detail.content} />
            {detail.messageId && <p className="mt-2 font-mono text-xs opacity-60">Message ID: {detail.messageId}</p>}
            <div className="modal-action">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDetail(null)}>
                {t(locale, 'common.cancel')}
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop" onSubmit={() => setDetail(null)}>
            <button type="submit" aria-label={t(locale, 'common.cancel')} />
          </form>
        </dialog>
      )}
    </div>
  );
}

/* ---------------- Panel ---------------- */

function EmailPanelInner({ locale, initialTab }: { locale: Locale; initialTab?: string | null }) {
  const [active, switchTab] = useDetailTab(TAB_KEYS, initialTab);
  const [domains, setDomains] = useState<DomainItem[]>([]);

  const reloadDomains = useCallback(async () => {
    try {
      const res = await fetch('/api/email/domains');
      if (!res.ok) return;
      const data = (await res.json()) as { domains: DomainItem[] };
      setDomains(data.domains);
    } catch {
      /* 列表加载失败时发送 tab 显示空态引导 */
    }
  }, []);

  useEffect(() => {
    void reloadDomains();
  }, [reloadDomains]);

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'send', label: t(locale, 'email.tabSend') },
    { key: 'domains', label: t(locale, 'email.tabDomains') },
    { key: 'log', label: t(locale, 'email.tabLog') },
  ];

  return (
    <div className="space-y-4">
      <h1 className="min-w-0 flex-1 truncate font-semibold text-xl">{t(locale, 'email.pageTitle')}</h1>
      <DetailTabs tabs={tabs} active={active} onChange={(key) => switchTab(key as TabKey)} />
      {active === 'send' && <SendTab locale={locale} domains={domains} />}
      {active === 'domains' && <DomainsTab locale={locale} domains={domains} onChanged={reloadDomains} />}
      {active === 'log' && <LogTab locale={locale} />}
    </div>
  );
}

export default function EmailPanel({ locale, initialTab }: { locale: Locale; initialTab?: string | null }) {
  return (
    <ToastProvider>
      <ConfirmDialogProvider>
        <EmailPanelInner locale={locale} initialTab={initialTab} />
      </ConfirmDialogProvider>
    </ToastProvider>
  );
}
