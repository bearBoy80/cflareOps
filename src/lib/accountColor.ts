export const ACCOUNT_HUES = [
  '#58a6ff',
  '#3fb950',
  '#d2a8ff',
  '#f778ba',
  '#ffa657',
  '#79c0ff',
  '#56d364',
  '#e3b341',
] as const;

/** 账号色环：按账号 id 确定性取色，在所有跨账号视图中标识归属账号。 */
export function accountColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return ACCOUNT_HUES[hash % ACCOUNT_HUES.length];
}
