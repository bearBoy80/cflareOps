import { Activity, Check, KeyRound, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Locale, type MessageKey, t } from '@/i18n';
import { accountColor } from '@/lib/accountColor';
import { relativeTime } from '@/lib/time';
import { ConfirmDialogProvider, useConfirm } from './ui/ConfirmDialog';
import TablePagination from './ui/TablePagination';
import { ToastProvider, useToast } from './ui/ToastProvider';

interface Account {
  id: string;
  name: string;
  status: string;
  lastCheck: string | null;
  lastError: string | null;
}

const STATUS_DOT: Record<string, string> = {
  active: 'bg-success',
  error: 'bg-error',
  unchecked: 'bg-base-content/30',
};

/** API 错误码 → 本地化文案；未知码回退英文 error 详情 */
const ERROR_CODE_KEYS: Record<string, MessageKey> = {
  fieldsRequired: 'accounts.errFieldsRequired',
  nameRequired: 'accounts.errNameRequired',
  tokenNotActive: 'accounts.errTokenNotActive',
  tokenVerifyFailed: 'accounts.errTokenVerifyFailed',
  duplicateToken: 'accounts.errDuplicateToken',
  accountNotFound: 'accounts.errNotFound',
};

function AccountsPanelInner({ locale }: { locale: Locale }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [checkingIds, setCheckingIds] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Account | null>(null);
  const [editName, setEditName] = useState('');
  const [editToken, setEditToken] = useState('');
  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(true);
  const { showToast } = useToast();
  const confirm = useConfirm();

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditing(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editing]);

  // 300ms 防抖：searchInput → search，同时回到第 1 页
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setSearch(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  function apiErrorText(data: { error?: string; code?: string } | null): string {
    const key = data?.code ? ERROR_CODE_KEYS[data.code] : undefined;
    if (key) return t(locale, key);
    return data?.error ?? t(locale, 'common.requestFailed');
  }

  const reload = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), search });
      const res = await fetch(`/api/accounts?${params.toString()}`);
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      setLoadError(false);
      const data = (await res.json()) as { accounts: Account[]; total: number };
      if (data.accounts.length === 0 && data.total > 0 && page > 1) {
        setPage(1);
        return;
      }
      setAccounts(data.accounts);
      setTotal(data.total);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, search]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function addAccount(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, token }),
      });
      if (res.ok) {
        setName('');
        setToken('');
        showToast(t(locale, 'accounts.added'), 'success');
        await reload();
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

  function openEdit(a: Account) {
    setEditName(a.name);
    setEditToken('');
    setEditing(a);
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/accounts/${editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName, ...(editToken.trim() ? { token: editToken } : {}) }),
      });
      if (res.ok) {
        setEditing(null);
        showToast(t(locale, 'accounts.updated'), 'success');
        await reload();
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

  async function checkAccount(id: string) {
    setCheckingIds((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`/api/accounts/${id}/check`, { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        showToast(apiErrorText(data), 'error');
        return;
      }
      await reload();
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      if (mountedRef.current) {
        setCheckingIds((prev) => {
          const s = new Set(prev);
          s.delete(id);
          return s;
        });
      }
    }
  }

  async function removeAccount(id: string) {
    const ok = await confirm({
      title: t(locale, 'accounts.confirmDelete'),
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        showToast(apiErrorText(data), 'error');
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
        <th>{t(locale, 'accounts.colName')}</th>
        <th>{t(locale, 'accounts.colStatus')}</th>
        <th>{t(locale, 'accounts.colLastCheck')}</th>
        <th>{t(locale, 'accounts.colError')}</th>
        <th>{t(locale, 'accounts.colActions')}</th>
      </tr>
    </thead>
  );

  return (
    <div className="space-y-6">
      <form onSubmit={addAccount} className="card border border-base-300 bg-base-100 p-4">
        <fieldset className="fieldset">
          <legend className="fieldset-legend">{t(locale, 'accounts.addTitle')}</legend>
          <div className="flex flex-wrap gap-2">
            <input
              className="input input-bordered"
              placeholder={t(locale, 'accounts.namePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <input
              className="input input-bordered flex-1"
              placeholder={t(locale, 'accounts.tokenPlaceholder')}
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
            />
            <button className="btn btn-primary" disabled={busy} type="submit">
              <Plus size={14} strokeWidth={1.75} />
              {busy ? t(locale, 'accounts.verifying') : t(locale, 'accounts.submit')}
            </button>
          </div>
        </fieldset>
      </form>

      <div className="card border border-base-300 bg-base-100 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="font-semibold">{t(locale, 'accounts.listTitle')}</h2>
          <label className="input input-bordered input-sm flex w-64 max-w-full items-center gap-2">
            <Search size={14} strokeWidth={1.75} className="shrink-0 opacity-40" />
            <input
              type="text"
              className="grow"
              placeholder={t(locale, 'accounts.searchPlaceholder')}
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
                    {Array.from({ length: 5 }).map((_, j) => (
                      <td key={j}>
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
            <KeyRound size={48} strokeWidth={1.75} className="opacity-40" />
            <p className="text-sm opacity-60">{t(locale, 'accounts.empty')}</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="table table-sm">
                {tableHead}
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <span className="inline-flex items-center gap-2">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: accountColor(a.id) }} />
                          {a.name}
                        </span>
                      </td>
                      <td>
                        <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                          <span className={`h-2 w-2 rounded-full ${STATUS_DOT[a.status] ?? 'bg-base-content/30'}`} />
                          {a.status}
                        </span>
                      </td>
                      <td className="font-mono text-xs" title={a.lastCheck ?? ''}>
                        {relativeTime(a.lastCheck, locale) || '—'}
                      </td>
                      <td>
                        {a.lastError ? (
                          <div className="tooltip tooltip-left" data-tip={a.lastError}>
                            <span className="block max-w-xs truncate">{a.lastError}</span>
                          </div>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="space-x-2 whitespace-nowrap">
                        <button
                          className="btn btn-xs"
                          onClick={() => void checkAccount(a.id)}
                          disabled={checkingIds.has(a.id)}
                        >
                          {checkingIds.has(a.id) ? (
                            <span className="loading loading-spinner loading-xs" />
                          ) : (
                            <Activity size={14} strokeWidth={1.75} />
                          )}
                          {t(locale, 'accounts.check')}
                        </button>
                        <button className="btn btn-xs" onClick={() => openEdit(a)}>
                          <Pencil size={14} strokeWidth={1.75} />
                          {t(locale, 'accounts.edit')}
                        </button>
                        <button
                          className="btn btn-xs btn-error"
                          onClick={() => void removeAccount(a.id)}
                          disabled={checkingIds.has(a.id)}
                        >
                          <Trash2 size={14} strokeWidth={1.75} />
                          {t(locale, 'accounts.delete')}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {accounts.length === 0 && (
                    <tr>
                      <td colSpan={5} className="text-center opacity-60">
                        {t(locale, 'accounts.noMatch')}
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
          </>
        )}
      </div>

      {editing && (
        <dialog open className="modal modal-open">
          <div className="modal-box max-w-md border border-base-300">
            <h3 className="mb-1 font-semibold">{t(locale, 'accounts.editTitle')}</h3>
            <p className="mb-4 font-mono text-xs opacity-60">{editing.name}</p>
            <form onSubmit={saveEdit} className="flex flex-col gap-3">
              <input
                className="input input-bordered input-sm w-full"
                placeholder={t(locale, 'accounts.namePlaceholder')}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                required
              />
              <input
                className="input input-bordered input-sm w-full"
                placeholder={t(locale, 'accounts.newTokenPlaceholder')}
                type="password"
                value={editToken}
                onChange={(e) => setEditToken(e.target.value)}
              />
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
                  {t(locale, 'accounts.save')}
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

export default function AccountsPanel({ locale }: { locale: Locale }) {
  return (
    <ToastProvider>
      <ConfirmDialogProvider>
        <AccountsPanelInner locale={locale} />
      </ConfirmDialogProvider>
    </ToastProvider>
  );
}
