import { ConfirmDialogProvider } from '@/components/ui/ConfirmDialog';
import DetailTabs, { useDetailTab } from '@/components/ui/DetailTabs';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { type Locale, t } from '@/i18n';
import ObjectsTab from './ObjectsTab';
import SettingsTab from './SettingsTab';
import UsageTab from './UsageTab';

const TAB_KEYS = ['objects', 'settings', 'usage'] as const;

export default function R2BucketDetailPanel({
  accountId,
  bucket,
  locale,
  cfAccountId,
  initialTab,
}: {
  accountId: string;
  bucket: string;
  locale: Locale;
  cfAccountId?: string | null;
  initialTab?: string | null;
}) {
  const [tab, switchTab] = useDetailTab(TAB_KEYS, initialTab);
  const apiBase = `/api/r2/${encodeURIComponent(accountId)}/${encodeURIComponent(bucket)}`;
  return (
    <ToastProvider>
      <ConfirmDialogProvider>
        <div className="card border border-base-300 bg-base-100 p-4">
          <DetailTabs
            tabs={[
              { key: 'objects', label: t(locale, 'r2.tabObjects') },
              { key: 'settings', label: t(locale, 'r2.tabSettings') },
              { key: 'usage', label: t(locale, 'r2.tabUsage') },
            ]}
            active={tab}
            onChange={(k) => switchTab(k as (typeof TAB_KEYS)[number])}
          />
          {/* tab 内容全宽垂直堆叠（移动端规则 10）；非激活 tab 卸载，切回时重新拉取保证新鲜 */}
          <div className="mt-4">
            {tab === 'objects' && <ObjectsTab locale={locale} apiBase={apiBase} cfAccountId={cfAccountId} />}
            {tab === 'settings' && <SettingsTab locale={locale} apiBase={apiBase} cfAccountId={cfAccountId} />}
            {tab === 'usage' && <UsageTab locale={locale} apiBase={apiBase} cfAccountId={cfAccountId} />}
          </div>
        </div>
      </ConfirmDialogProvider>
    </ToastProvider>
  );
}
