/** 追加 cfAccountId 查询参数（同一 token 下多 CF 账号同名桶消歧），缺省时透传原 url 不变 */
export function withCf(url: string, cfAccountId?: string | null): string {
  if (!cfAccountId) return url;
  return `${url}${url.includes('?') ? '&' : '?'}cfAccountId=${encodeURIComponent(cfAccountId)}`;
}
