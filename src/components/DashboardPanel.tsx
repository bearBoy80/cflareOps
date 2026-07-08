import { AlertTriangle, Globe, PanelsTopLeft, RefreshCw, Users, Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type Locale, type MessageKey, t } from '../i18n';
import { localizePath } from '../i18n/routing';
import { relativeTime } from '../lib/time';

interface Stats {
  accounts: { total: number; errors: number };
  zones: { total: number; lastSyncedAt: string | null };
  workers: { scripts: number; projects: number };
}

// 部署配置类错误码（后端 apiErrorResponse 返回）→ 可操作的本地化提示；其余走通用“请求失败”。
const CONFIG_CODES: MessageKey[] = [
  'config.encryptionKeyMissing',
  'config.encryptionKeyInvalid',
  'config.dbBindingMissing',
  'config.dbNotMigrated',
];

function isConfigCode(code: string | undefined): code is MessageKey {
  return !!code && (CONFIG_CODES as string[]).includes(code);
}

export default function DashboardPanel({ locale }: { locale: Locale }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [failed, setFailed] = useState(false);
  // 配置类错误的具体提示（含对应修复动作）；null 时回退到通用“请求失败”。
  const [configHint, setConfigHint] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/stats');
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
          if (!cancelled) {
            const code = body?.code;
            if (isConfigCode(code)) setConfigHint(t(locale, code));
            setFailed(true);
          }
          return;
        }
        const data = (await res.json()) as Stats;
        if (!cancelled) setStats(data);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [locale]);

  if (failed) {
    return (
      <div className="alert alert-error">
        <AlertTriangle size={20} strokeWidth={1.75} />
        <div>
          {configHint ? (
            <>
              <div className="font-semibold">{t(locale, 'config.title')}</div>
              <div className="text-sm opacity-90">{configHint}</div>
            </>
          ) : (
            <span>{t(locale, 'common.requestFailed')}</span>
          )}
        </div>
      </div>
    );
  }

  if (!stats) {
    return <div className="skeleton h-32 w-full" />;
  }

  const hasErrors = stats.accounts.errors > 0;

  return (
    <div className="stats stats-vertical w-full overflow-x-auto border border-base-300 bg-base-100 sm:stats-horizontal">
      <div className="stat">
        <div className="stat-figure text-base-content/60">
          <Users size={20} strokeWidth={1.75} />
        </div>
        <div className="stat-title">{t(locale, 'dashboard.accounts')}</div>
        <div className="stat-value font-mono text-3xl">{stats.accounts.total}</div>
      </div>

      <div className="stat">
        <div className={`stat-figure ${hasErrors ? 'text-error' : 'text-base-content/60'}`}>
          <AlertTriangle size={20} strokeWidth={1.75} />
        </div>
        <div className="stat-title">{t(locale, 'dashboard.accountErrors')}</div>
        <div className={`stat-value font-mono text-3xl ${hasErrors ? 'text-error' : ''}`}>{stats.accounts.errors}</div>
        {hasErrors && (
          <div className="stat-desc">
            <a className="link link-error" href={localizePath(locale, '/accounts')}>
              {t(locale, 'dashboard.goFix')}
            </a>
          </div>
        )}
      </div>

      <div className="stat">
        <div className="stat-figure text-base-content/60">
          <Globe size={20} strokeWidth={1.75} />
        </div>
        <div className="stat-title">{t(locale, 'dashboard.zones')}</div>
        <div className="stat-value font-mono text-3xl">{stats.zones.total}</div>
      </div>

      <div className="stat">
        <div className="stat-figure text-base-content/60">
          <Workflow size={20} strokeWidth={1.75} />
        </div>
        <div className="stat-title">{t(locale, 'dashboard.workers')}</div>
        <div className="stat-value font-mono text-3xl">{stats.workers.scripts}</div>
      </div>

      <div className="stat">
        <div className="stat-figure text-base-content/60">
          <PanelsTopLeft size={20} strokeWidth={1.75} />
        </div>
        <div className="stat-title">{t(locale, 'dashboard.pages')}</div>
        <div className="stat-value font-mono text-3xl">{stats.workers.projects}</div>
      </div>

      <div className="stat">
        <div className="stat-figure text-base-content/60">
          <RefreshCw size={20} strokeWidth={1.75} />
        </div>
        <div className="stat-title">{t(locale, 'dashboard.lastSync')}</div>
        <div className="stat-value text-lg">
          {stats.zones.lastSyncedAt ? relativeTime(stats.zones.lastSyncedAt, locale) : t(locale, 'dashboard.never')}
        </div>
      </div>
    </div>
  );
}
