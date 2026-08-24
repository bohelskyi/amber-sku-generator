CREATE TABLE IF NOT EXISTS repricing_batches (
  id SERIAL PRIMARY KEY,
  scenario_id INTEGER REFERENCES price_scenarios(id) ON DELETE SET NULL,
  category_code TEXT,
  scenario_name TEXT NOT NULL,
  scenario_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  preview_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'completed',
  candidate_count INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS repricing_items (
  id SERIAL PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES repricing_batches(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  sku TEXT NOT NULL,
  old_price_uah NUMERIC,
  new_price_uah NUMERIC NOT NULL,
  price_delta_uah NUMERIC NOT NULL,
  old_payload JSONB NOT NULL,
  new_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (batch_id, product_id)
);

CREATE INDEX IF NOT EXISTS repricing_batches_created_idx
  ON repricing_batches (created_at DESC);

CREATE INDEX IF NOT EXISTS repricing_items_batch_idx
  ON repricing_items (batch_id, id);

CREATE INDEX IF NOT EXISTS repricing_items_product_idx
  ON repricing_items (product_id, created_at DESC);
