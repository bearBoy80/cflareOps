CREATE TABLE IF NOT EXISTS cf_accounts (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  name TEXT NOT NULL,
  token_encrypted TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unchecked',
  last_check TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_email, token_hash)
);

CREATE INDEX IF NOT EXISTS idx_accounts_owner ON cf_accounts(owner_email);

-- zones 为 CF API 缓存表：列名与 SDK Zone 对象字段 1:1 对应（见全局约束），
-- account_id / synced_at 为本系统字段，raw_json 存 SDK 返回的完整 Zone 对象
CREATE TABLE IF NOT EXISTS zones (
  id TEXT NOT NULL,                       -- Zone.id
  account_id TEXT NOT NULL REFERENCES cf_accounts(id) ON DELETE CASCADE,  -- 本系统账号记录 id
  name TEXT NOT NULL,                     -- Zone.name（域名）
  status TEXT,                            -- Zone.status: initializing/pending/active/moved
  paused INTEGER NOT NULL DEFAULT 0,      -- Zone.paused（仅 DNS 服务）
  type TEXT,                              -- Zone.type: full/partial/secondary
  development_mode INTEGER,               -- Zone.development_mode（剩余秒数）
  name_servers TEXT,                      -- Zone.name_servers（JSON 数组）
  original_name_servers TEXT,             -- Zone.original_name_servers（JSON 数组）
  original_registrar TEXT,                -- Zone.original_registrar
  cf_account_id TEXT,                     -- Zone.account.id（CF 侧账号）
  cf_account_name TEXT,                   -- Zone.account.name
  plan_id TEXT,                           -- Zone.plan.id
  plan_name TEXT,                         -- Zone.plan.name
  created_on TEXT,                        -- Zone.created_on
  modified_on TEXT,                       -- Zone.modified_on
  activated_on TEXT,                      -- Zone.activated_on
  raw_json TEXT NOT NULL,                 -- SDK 返回的完整 Zone 对象
  synced_at TEXT NOT NULL,               -- 本系统同步时间
  PRIMARY KEY (id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_zones_account ON zones(account_id);
CREATE INDEX IF NOT EXISTS idx_zones_name ON zones(name);

-- workers_scripts 为 CF API 缓存表：列名与 SDK Script 对象字段 1:1 对应（见全局约束），
-- account_id / synced_at 为本系统字段，raw_json 存 SDK 返回的完整 Script 对象
CREATE TABLE IF NOT EXISTS workers_scripts (
  id TEXT NOT NULL,                       -- Script.id（脚本名）
  account_id TEXT NOT NULL REFERENCES cf_accounts(id) ON DELETE CASCADE,  -- 本系统账号记录 id
  cf_account_id TEXT NOT NULL,            -- CF 侧账号 id（accounts.list）
  cf_account_name TEXT,                   -- CF 侧账号名
  created_on TEXT,                        -- Script.created_on
  modified_on TEXT,                       -- Script.modified_on
  usage_model TEXT,                       -- Script.usage_model
  last_deployed_from TEXT,                -- Script.last_deployed_from
  raw_json TEXT NOT NULL,                 -- SDK 返回的完整 Script 对象
  synced_at TEXT NOT NULL,                -- 本系统同步时间
  -- 一个 token 可见多个 CF 账号，同名脚本可在不同 CF 账号并存，主键必须含 cf_account_id
  PRIMARY KEY (id, account_id, cf_account_id)
);

CREATE INDEX IF NOT EXISTS idx_ws_account ON workers_scripts(account_id);

-- pages_projects 为 CF API 缓存表：列名与 SDK Project 对象字段 1:1 对应（见全局约束），
-- account_id / synced_at 为本系统字段，raw_json 存 SDK 返回的完整 Project 对象
CREATE TABLE IF NOT EXISTS pages_projects (
  name TEXT NOT NULL,                     -- Project.name
  account_id TEXT NOT NULL REFERENCES cf_accounts(id) ON DELETE CASCADE,  -- 本系统账号记录 id
  cf_account_id TEXT NOT NULL,            -- CF 侧账号 id（accounts.list）
  cf_account_name TEXT,                   -- CF 侧账号名
  subdomain TEXT,                         -- Project.subdomain
  production_branch TEXT,                 -- Project.production_branch
  domains TEXT,                           -- Project.domains（JSON 数组）
  source_repo TEXT,                       -- Project.source.config.repo_name 或 null
  created_on TEXT,                        -- Project.created_on
  latest_deployment_on TEXT,              -- Project.latest_deployment.modified_on
  raw_json TEXT NOT NULL,                 -- SDK 返回的完整 Project 对象
  synced_at TEXT NOT NULL,                -- 本系统同步时间
  -- 同名 Pages 项目可在同一 token 的不同 CF 账号并存，主键必须含 cf_account_id
  PRIMARY KEY (name, account_id, cf_account_id)
);

CREATE INDEX IF NOT EXISTS idx_pp_account ON pages_projects(account_id);

-- 用量日快照：UTC 自然日 × 脚本/项目 聚合（惰性回填，永不清理）
CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES cf_accounts(id) ON DELETE CASCADE,
  cf_account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  requests INTEGER NOT NULL,
  errors INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (day, kind, account_id, cf_account_id, name)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_lookup ON usage_daily(account_id, kind, day);

-- 用量小时快照：滚动最近 24 个已完成 UTC 整点（回填时摊入清理 >25h 的行）
CREATE TABLE IF NOT EXISTS usage_hourly (
  hour TEXT NOT NULL,               -- YYYY-MM-DDTHH:00:00Z 整点 UTC
  kind TEXT NOT NULL,               -- 'worker' | 'pages'
  account_id TEXT NOT NULL REFERENCES cf_accounts(id) ON DELETE CASCADE,
  cf_account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  requests INTEGER NOT NULL,
  errors INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (hour, kind, account_id, cf_account_id, name)
);
CREATE INDEX IF NOT EXISTS idx_usage_hourly_lookup ON usage_hourly(account_id, kind, hour);

-- 小时回填覆盖标记：记录「已抓取过」的整点（含零流量整点，usage_hourly 无行也算已覆盖），
-- 使 24h 回填对已覆盖整点不再重复 fan-out CF。随 usage_hourly 同步滚动清理 >25h。
CREATE TABLE IF NOT EXISTS usage_hourly_covered (
  account_id TEXT NOT NULL REFERENCES cf_accounts(id) ON DELETE CASCADE,
  hour TEXT NOT NULL,               -- YYYY-MM-DDTHH:00:00Z 整点 UTC
  synced_at TEXT NOT NULL,
  PRIMARY KEY (account_id, hour)
);
