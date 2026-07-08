/** Pages 项目的 *.pages.dev 目标域：subdomain 可能带或不带 .pages.dev 后缀，缺失时回退 <项目名>.pages.dev */
export function pagesDevTarget(subdomain: string | null | undefined, projectName: string): string {
  if (!subdomain) return `${projectName}.pages.dev`;
  return subdomain.endsWith('.pages.dev') ? subdomain : `${subdomain}.pages.dev`;
}
