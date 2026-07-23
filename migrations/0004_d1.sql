-- D1 数据库缓存表:列 1:1 对应 SDK d1.database D1 对象字段(uuid/name/version/created_at 等)。
-- num_tables/file_size/read_replication_mode 在 list 响应的 SDK typings 中未声明但运行时通常返回,
-- best-effort 写入(缺失为 NULL);详情页展示以实时 get 为准。
CREATE TABLE IF NOT EXISTS d1_databases (
  account_id            TEXT NOT NULL REFERENCES cf_accounts(id) ON DELETE CASCADE,
  cf_account_id         TEXT NOT NULL,
  cf_account_name       TEXT,
  uuid                  TEXT NOT NULL,
  name                  TEXT NOT NULL,
  version               TEXT,
  num_tables            INTEGER,
  file_size             INTEGER,
  created_at            TEXT,
  read_replication_mode TEXT,
  raw_json              TEXT NOT NULL,
  synced_at             TEXT NOT NULL,
  PRIMARY KEY (account_id, cf_account_id, uuid)
);

CREATE INDEX IF NOT EXISTS idx_d1_databases_account ON d1_databases(account_id);
