-- 升级已有安装时，已经同时具备 Workers 与 Pages 快照的日期可直接标记为已覆盖，
-- 避免首次打开 7/30 天用量时重新抓取整段历史数据。只有单一 kind 的旧日期不回填，
-- 仍由正常回填流程修复，防止重现 Workers 数据遮蔽 Pages 数据的问题。
INSERT OR IGNORE INTO usage_daily_covered (account_id, day, synced_at)
SELECT account_id, day, MAX(synced_at)
FROM usage_daily
GROUP BY account_id, day
HAVING COUNT(DISTINCT kind) = 2;
