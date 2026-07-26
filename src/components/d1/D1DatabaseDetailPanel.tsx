import { useState } from 'react';
import DetailTabs, { useDetailTab } from '@/components/ui/DetailTabs';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { type Locale, t } from '@/i18n';
import QueryTab from './QueryTab';
import SettingsTab from './SettingsTab';
import TablesTab from './TablesTab';

const TAB_KEYS = ['tables', 'query', 'settings'] as const;

export default function D1DatabaseDetailPanel({
  accountId,
  databaseId,
  locale,
  initialTab,
}: {
  accountId: string;
  databaseId: string;
  locale: Locale;
  initialTab?: string | null;
}) {
  const [tab, switchTab] = useDetailTab(TAB_KEYS, initialTab);
  // 表 Tab 点「浏览数据」→ 切到查询 Tab 并自动执行 SELECT;seq 递增让重复点同一张表也能触发
  const [browse, setBrowse] = useState<{ table: string; seq: number } | null>(null);
  const apiBase = `/api/d1/${encodeURIComponent(accountId)}/${encodeURIComponent(databaseId)}`;
  return (
    <ToastProvider>
      <div className="card border border-base-300 bg-base-100 p-4">
        <DetailTabs
          tabs={[
            { key: 'tables', label: t(locale, 'd1.tabTables') },
            { key: 'query', label: t(locale, 'd1.tabQuery') },
            { key: 'settings', label: t(locale, 'd1.tabSettings') },
          ]}
          active={tab}
          onChange={(k) => switchTab(k as (typeof TAB_KEYS)[number])}
        />
        {/* tab 内容全宽垂直堆叠(移动端规则 10);查询 Tab 常驻挂载保留 SQL/结果,其余按需挂载 */}
        <div className="mt-4">
          {tab === 'tables' && (
            <TablesTab
              locale={locale}
              apiBase={apiBase}
              onBrowse={(table) => {
                setBrowse((b) => ({ table, seq: (b?.seq ?? 0) + 1 }));
                switchTab('query');
              }}
            />
          )}
          <div className={tab === 'query' ? '' : 'hidden'}>
            <QueryTab locale={locale} apiBase={apiBase} browse={browse} />
          </div>
          {tab === 'settings' && <SettingsTab locale={locale} apiBase={apiBase} />}
        </div>
      </div>
    </ToastProvider>
  );
}
