/** SQLite 标识符引用:双引号包裹,内部双引号翻倍 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
