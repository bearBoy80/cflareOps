import { useEffect, useState } from 'react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { type Locale, t } from '@/i18n';
import { formatBytes } from '@/lib/formatBytes';
import { withCf } from '@/lib/withCf';

interface UsageData {
  storage: { date: string; payloadSize: number; objectCount: number }[];
  operations: { date: string; classA: number; classB: number }[];
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-box border border-base-300 p-4">
      <h3 className="mb-3 font-semibold">{title}</h3>
      <div className="h-56 w-full">{children}</div>
    </div>
  );
}

export default function UsageTab({
  locale,
  apiBase,
  cfAccountId,
}: {
  locale: Locale;
  apiBase: string;
  cfAccountId?: string | null;
}) {
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(withCf(`${apiBase}/usage`, cfAccountId));
        if (!res.ok) {
          setError(res.status === 403 ? t(locale, 'r2.forbiddenHint') : t(locale, 'common.requestFailed'));
          return;
        }
        setData((await res.json()) as UsageData);
      } catch {
        setError(t(locale, 'common.requestFailed'));
      }
    })();
  }, [apiBase, cfAccountId, locale]);

  if (error) return <div className="alert alert-warning text-sm">{error}</div>;
  if (!data) return <div className="skeleton h-56 w-full" />;
  if (data.storage.length === 0 && data.operations.length === 0)
    return <div className="py-12 text-center text-sm opacity-60">{t(locale, 'r2.usageEmpty')}</div>;

  return (
    <div className="flex flex-col gap-4">
      <ChartCard title={t(locale, 'r2.usageStorage')}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data.storage} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="r2UsageStorage" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-primary, #F6821F)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--color-primary, #F6821F)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(d: string) => d.slice(5)} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => formatBytes(v)} width={72} />
            <Tooltip
              formatter={(value, name) =>
                name === 'payloadSize'
                  ? [formatBytes(Number(value)), t(locale, 'r2.colSize')]
                  : [value, t(locale, 'r2.usageObjects')]
              }
            />
            <Area
              type="monotone"
              dataKey="payloadSize"
              stroke="var(--color-primary, #F6821F)"
              strokeWidth={1.75}
              fill="url(#r2UsageStorage)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard title={t(locale, 'r2.usageOps')}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data.operations} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="r2UsageClassA" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-secondary, #6366F1)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--color-secondary, #6366F1)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="r2UsageClassB" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-primary, #F6821F)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--color-primary, #F6821F)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(d: string) => d.slice(5)} />
            <YAxis tick={{ fontSize: 10 }} width={56} />
            <Tooltip
              formatter={(value, name) => [
                value,
                name === 'classA' ? t(locale, 'r2.usageClassA') : t(locale, 'r2.usageClassB'),
              ]}
            />
            <Area
              type="monotone"
              dataKey="classA"
              stroke="var(--color-secondary, #6366F1)"
              strokeWidth={1.75}
              fill="url(#r2UsageClassA)"
            />
            <Area
              type="monotone"
              dataKey="classB"
              stroke="var(--color-primary, #F6821F)"
              strokeWidth={1.75}
              fill="url(#r2UsageClassB)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
