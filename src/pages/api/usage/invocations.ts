import type { APIRoute } from 'astro';
import { appContext, jsonError } from '../../../server/context';
import {
  ensureUsageHourlySnapshots,
  ensureUsageSnapshots,
  queryUsageDaily,
  queryUsageHourly,
  usageSeries,
} from '../../../server/usage';
import { clientForAccount } from '../../../server/workersPages';

const RANGE_DAYS: Record<string, number> = { '7d': 7, '30d': 30 };
const KINDS = { workers: 'worker', pages: 'pages' } as const;

/**
 * 用量统计（统一分页 + 图表 series 形状）。三档均走 D1：
 * 24h = 小时快照（滚动 24h，前沿滞后≤1h，摊到清理）；7d/30d = 日快照（完整自然日）。
 * series 为按桶零填充的总量时间序列，供图表使用。
 */
export const GET: APIRoute = async ({ locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const url = new URL(request.url);
  const range = url.searchParams.get('range') ?? '7d';
  const kindParam = url.searchParams.get('kind') ?? 'workers';
  if (range !== '24h' && !RANGE_DAYS[range]) {
    return jsonError('range must be 24h, 7d or 30d', 400, 'invalidRange');
  }
  if (!Object.hasOwn(KINDS, kindParam)) return jsonError('kind must be workers or pages', 400, 'invalidKind');
  const kind = KINDS[kindParam as keyof typeof KINDS];
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? '20') || 20));
  const search = (url.searchParams.get('search') ?? '').trim();
  const accountFilter = url.searchParams.get('accountId') ?? '';
  const now = new Date();
  const seriesRange = range as '24h' | '7d' | '30d';

  if (range === '24h') {
    const { failures } = await ensureUsageHourlySnapshots(
      db,
      userEmail,
      (accountId) => clientForAccount(db, key, userEmail, accountId),
      now,
    );
    const { rows, total, sinceHour, untilHour } = await queryUsageHourly(db, userEmail, {
      kind,
      search: search || undefined,
      accountId: accountFilter || undefined,
      page,
      pageSize,
      now,
      todayStart: url.searchParams.get('todayStart') || undefined,
    });
    const series = await usageSeries(db, userEmail, {
      kind,
      range: seriesRange,
      search: search || undefined,
      accountId: accountFilter || undefined,
      now,
    });
    return Response.json({
      rows,
      total,
      page,
      pageSize,
      since: sinceHour,
      until: untilHour,
      failures,
      series,
    });
  }

  const days = RANGE_DAYS[range];
  const { failures } = await ensureUsageSnapshots(
    db,
    userEmail,
    days,
    (accountId) => clientForAccount(db, key, userEmail, accountId),
    now,
  );
  const { rows, total, sinceDay, untilDay } = await queryUsageDaily(db, userEmail, {
    kind,
    days,
    search: search || undefined,
    accountId: accountFilter || undefined,
    page,
    pageSize,
    now,
  });
  const series = await usageSeries(db, userEmail, {
    kind,
    range: seriesRange,
    search: search || undefined,
    accountId: accountFilter || undefined,
    now,
  });
  return Response.json({
    rows,
    total,
    page,
    pageSize,
    since: `${sinceDay}T00:00:00Z`,
    until: `${untilDay}T23:59:59Z`,
    failures,
    series,
  });
};
