-- R2 桶缓存表：列 1:1 对应 SDK r2.buckets Bucket 字段（name/location/storage_class/creation_date），
-- payload_size/metadata_size/object_count 来自同步时的 GraphQL r2StorageAdaptiveGroups 快照（可为 NULL：快照失败降级）。
-- v1 只缓存默认 jurisdiction（EU/FedRAMP 为独立命名空间，需逐 jurisdiction 请求，本期不做）。
CREATE TABLE IF NOT EXISTS r2_buckets (
  account_id      TEXT NOT NULL REFERENCES cf_accounts(id) ON DELETE CASCADE,
  cf_account_id   TEXT NOT NULL,
  cf_account_name TEXT,
  name            TEXT NOT NULL,
  location        TEXT,
  storage_class   TEXT,
  creation_date   TEXT,
  payload_size    INTEGER,
  metadata_size   INTEGER,
  object_count    INTEGER,
  raw_json        TEXT NOT NULL,
  synced_at       TEXT NOT NULL,
  PRIMARY KEY (account_id, cf_account_id, name)
);
