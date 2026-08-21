-- 日用量回填覆盖标记：记录「已成功抓取过」的 UTC 日期（含零流量日期）。
-- 数据行不能充当覆盖标记：只有 Workers 行时，无法判断 Pages 是零流量还是尚未抓取。
CREATE TABLE IF NOT EXISTS usage_daily_covered (
  account_id TEXT NOT NULL REFERENCES cf_accounts(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (account_id, day)
);
