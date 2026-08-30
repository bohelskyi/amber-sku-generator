CREATE TABLE IF NOT EXISTS exchange_rate_cache (
  currency_pair TEXT PRIMARY KEY,
  rate NUMERIC(18, 6) NOT NULL CHECK (rate > 0),
  rate_date DATE NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL
);
