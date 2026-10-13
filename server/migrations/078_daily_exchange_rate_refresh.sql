-- Scheduling metadata only. A failed cold start must not fabricate a rate.
CREATE TABLE IF NOT EXISTS exchange_rate_refresh_state (
  currency_pair TEXT PRIMARY KEY CHECK (currency_pair = 'USD_UAH'),
  last_attempt_at TIMESTAMPTZ NOT NULL,
  next_attempt_at TIMESTAMPTZ,
  last_error TEXT CHECK (last_error IS NULL OR last_error ~ '^[A-Z][A-Z0-9_]{0,95}$'),
  CHECK (next_attempt_at IS NULL OR next_attempt_at >= last_attempt_at)
);
