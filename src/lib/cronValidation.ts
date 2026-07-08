/**
 * cron 表达式 UX 预检（刻意从简）：只校验「5 个空白分隔字段 + 每字段字符集」。
 * CF 侧才是权威校验（提交后 API 会拒绝非法表达式）；这里不解析取值范围/月份日名合法性，
 * 字母字段（MON/AUG 等月/星期名）按字符集放行。@daily 之类宏写法不支持（非 5 段）。
 */
export function isCronExpression(s: string): boolean {
  const fields = s.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f) => f.length > 0 && /^[0-9A-Za-z*,/-]+$/.test(f));
}

/** 返回非法表达式的下标列表（配合多行编辑器逐行标红） */
export function validateCrons(list: string[]): number[] {
  const invalid: number[] = [];
  list.forEach((c, i) => {
    if (!isCronExpression(c)) invalid.push(i);
  });
  return invalid;
}
