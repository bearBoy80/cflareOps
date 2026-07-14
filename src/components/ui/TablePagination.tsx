import { type Locale, t } from '@/i18n';

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

function paginationPages(page: number, pageCount: number): (number | '…')[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const window = new Set(
    [1, pageCount, page - 2, page - 1, page, page + 1, page + 2].filter((p) => p >= 1 && p <= pageCount),
  );
  const sorted = Array.from(window).sort((a, b) => a - b);
  const pages: (number | '…')[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) pages.push('…');
    pages.push(sorted[i]);
  }
  return pages;
}

export interface TablePaginationProps {
  locale: Locale;
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

/** 列表底部通用分页条：总数 · 每页条数 · 页码 join · 第 x/y 页 */
export default function TablePagination({
  locale,
  total,
  page,
  pageCount,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: TablePaginationProps) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-base-300 pt-3">
      <span className="whitespace-nowrap text-sm opacity-60">{t(locale, 'common.totalCount', { n: total })}</span>
      <div className="flex items-center gap-2">
        <select
          className="select select-bordered select-sm w-28"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {t(locale, 'common.perPage', { n })}
            </option>
          ))}
        </select>
        <div className="join">
          <button className="join-item btn btn-sm" disabled={page === 1} onClick={() => onPageChange(1)}>
            «
          </button>
          {paginationPages(page, pageCount).map((p, i) =>
            p === '…' ? (
              <span key={`ellipsis-${i}`} className="join-item btn btn-sm btn-disabled pointer-events-none">
                …
              </span>
            ) : (
              <button
                key={p}
                className={`join-item btn btn-sm${page === p ? ' btn-active' : ''}`}
                onClick={() => onPageChange(p)}
              >
                {p}
              </button>
            ),
          )}
          <button
            className="join-item btn btn-sm"
            disabled={page === pageCount}
            onClick={() => onPageChange(pageCount)}
          >
            »
          </button>
        </div>
        <span className="whitespace-nowrap text-sm opacity-60">
          {t(locale, 'common.pageOf', { page, total: pageCount })}
        </span>
      </div>
    </div>
  );
}
