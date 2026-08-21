-- OAuth 连接账号:在既有 cf_accounts 上增列区分凭证类型。
-- auth_type='token'(默认,现状):token_encrypted 存 API Token。
-- auth_type='oauth':token_encrypted 存 OAuth access token(短寿),用下列列自动续期。
--   oauth_client_id           续期所需的 public client id(非机密,续期自足不依赖 env)
--   oauth_refresh_encrypted   加密的 refresh token(每次续期轮换后回写)
--   oauth_expires_at          access token 过期时间(ISO),过期前 60s 惰性续期
--   oauth_scope               授权的 scope(仅记录/展示)
--   oauth_sub                 预留的 OIDC subject；当前 API 授权流不请求 openid，因此为 NULL
ALTER TABLE cf_accounts ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'token';
ALTER TABLE cf_accounts ADD COLUMN oauth_client_id TEXT;
ALTER TABLE cf_accounts ADD COLUMN oauth_refresh_encrypted TEXT;
ALTER TABLE cf_accounts ADD COLUMN oauth_expires_at TEXT;
ALTER TABLE cf_accounts ADD COLUMN oauth_scope TEXT;
ALTER TABLE cf_accounts ADD COLUMN oauth_sub TEXT;
