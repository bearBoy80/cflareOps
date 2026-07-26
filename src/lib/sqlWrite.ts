/**
 * SQL 写语句检测(UX 确认层,非安全边界)。
 * 思路:先剥离字符串字面量与注释,再全文匹配写关键词——比"看首关键词"可靠,
 * 能覆盖 `WITH ... DELETE`、`SELECT 1; DROP ...` 等形态;被引号包裹的标识符
 * (如列名 "update")会被当作字符串剥掉,不会误报。
 * 未闭合引号/未闭合块注释会把后续内容(可能含 DROP/DELETE)整段吞掉,剥离结果
 * 不可信——fail closed 按写语句对待,宁可多弹一次确认也不漏掉被吞的写操作。
 * (SQLite 本身允许块注释延伸到 EOF,但 SQL 由 D1 服务端执行,其多语句切分
 * 行为不受本地假设约束,按不可信处理。)
 */
const WRITE_RE =
  /\b(insert|update|delete|replace|create|drop|alter|truncate|vacuum|attach|detach|reindex|grant|revoke|analyze)\b/i;

/** 带赋值的 PRAGMA(`PRAGMA x = y`)与 `PRAGMA optimize` 会改库(设置项/统计表),按写对待;查询型 PRAGMA(table_info 等)不算 */
const PRAGMA_WRITE_RE = /\bpragma\b[^;=]*=|\bpragma\s+optimize\b/i;

function stripLiteralsAndComments(sql: string): { text: string; unterminated: boolean } {
  let out = '';
  let unterminated = false;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      // 未闭合块注释吞掉剩余全部输入:与未闭合引号同理 fail closed(见文件头注释)
      if (end === -1) unterminated = true;
      i = end === -1 ? sql.length : end + 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      // SQLite 里 '' 转义单引号、"" 转义双引号:跳过成对引号内的所有内容
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) unterminated = true;
      i = j + 1;
      out += ' ';
    } else {
      out += ch;
      i++;
    }
  }
  return { text: out, unterminated };
}

export function isWriteSql(sql: string): boolean {
  const { text, unterminated } = stripLiteralsAndComments(sql);
  if (unterminated) return true;
  return WRITE_RE.test(text) || PRAGMA_WRITE_RE.test(text);
}
