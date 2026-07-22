const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** 1024 进制字节格式化；B 档不带小数，其余 1 位小数；null（无快照数据）显示 '—' */
export function formatBytes(n: number | null): string {
  if (n === null) return '—';
  if (n < 1024) return `${n} B`;
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}
