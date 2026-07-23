/**
 * SQL 写语句检测(UX 确认层,非安全边界)。
 * 思路:先剥离字符串字面量与注释,再全文匹配写关键词——比"看首关键词"可靠,
 * 能覆盖 `WITH ... DELETE`、`SELECT 1; DROP ...` 等形态;被引号包裹的标识符
 * (如列名 "update")会被当作字符串剥掉,不会误报。
 */
const WRITE_RE =
  /\b(insert|update|delete|replace|create|drop|alter|truncate|vacuum|attach|detach|reindex|grant|revoke)\b/i;

function stripLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      // SQLite 里 '' 转义单引号、"" 转义双引号:跳过成对引号内的所有内容
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      i = j + 1;
      out += ' ';
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

export function isWriteSql(sql: string): boolean {
  return WRITE_RE.test(stripLiteralsAndComments(sql));
}
