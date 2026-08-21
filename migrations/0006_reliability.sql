-- Email send retry idempotency: a client-generated key reserves one durable send attempt.
ALTER TABLE email_log ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_log_owner_idempotency
  ON email_log(owner_email, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- OAuth refresh leases serialize refresh-token rotation across concurrent Worker requests.
ALTER TABLE cf_accounts ADD COLUMN oauth_refresh_lock_until TEXT;
