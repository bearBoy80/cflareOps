-- email_domains 发送域名配置表：域名 → provider + 凭证。
-- 按域名而非发件地址建模：Resend / CF Email Sending 的验证单位是域名，
-- 域名验证通过后任意 local 部分都可发，发送时自由填写 @ 前部分。
CREATE TABLE IF NOT EXISTS email_domains (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  domain TEXT NOT NULL,                   -- 发送域名，如 mail.example.com（小写存储）
  provider TEXT NOT NULL CHECK (provider IN ('resend', 'cloudflare')),
  api_key_ciphertext TEXT,                -- 仅 resend：AES-GCM 加密的 API key（crypto.ts，同 cf_accounts.token）
  api_key_hash TEXT,                      -- 仅 resend：SHA-256，去重与 UI 识别展示用，永不解密回显
  account_id TEXT REFERENCES cf_accounts(id) ON DELETE CASCADE,  -- 仅 cloudflare：本系统账号记录 id（复用其加密 token）
  cf_account_id TEXT,                     -- 仅 cloudflare：CF 侧账号 id（emailSending.send 的 account_id 参数）
  created_at TEXT NOT NULL,
  -- 一个域名在同一用户内只绑一个 provider（发信行为确定）；不同用户可各自配置同名域名
  UNIQUE(owner_email, domain)
);

CREATE INDEX IF NOT EXISTS idx_email_domains_owner ON email_domains(owner_email);

-- email_log 发送记录：事实/审计记录而非缓存 —— domain_id 用 SET NULL（删配置不抹历史），
-- provider / from_address 为冗余快照，配置删改后记录仍独立完整可读。
CREATE TABLE IF NOT EXISTS email_log (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  domain_id TEXT REFERENCES email_domains(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,                 -- 'resend' | 'cloudflare' 发送时快照
  from_address TEXT NOT NULL,             -- 完整发件地址快照
  recipients_json TEXT NOT NULL,          -- {to: string[], cc: string[], bcc: string[]}
  subject TEXT NOT NULL,
  format TEXT NOT NULL,                   -- 'markdown' | 'html' | 'text'
  content TEXT NOT NULL,                  -- 正文原文（回看时用同一 render.ts 重新渲染）
  status TEXT NOT NULL,                   -- 'sent' | 'failed'（失败也写记录）
  message_id TEXT,                        -- provider 消息 ID，失败为 NULL
  error TEXT,                             -- 失败原因
  created_at TEXT NOT NULL
);

-- 记录页按用户倒序分页
CREATE INDEX IF NOT EXISTS idx_email_log_owner_created ON email_log(owner_email, created_at DESC);
