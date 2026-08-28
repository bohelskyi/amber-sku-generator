CREATE TABLE IF NOT EXISTS correction_requests (
  id SERIAL PRIMARY KEY,
  source_product_id INTEGER NOT NULL REFERENCES products(id),
  corrected_product_id INTEGER REFERENCES products(id),
  category_code TEXT NOT NULL,
  source_sku TEXT NOT NULL,
  proposed_sku TEXT NOT NULL,
  old_payload JSONB NOT NULL,
  proposed_payload JSONB NOT NULL,
  final_payload JSONB,
  changes JSONB NOT NULL DEFAULT '[]'::jsonb,
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  preview_signature TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  CHECK (status IN ('pending', 'in_progress', 'completed', 'rejected'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_correction_requests_one_active_product
  ON correction_requests (source_product_id)
  WHERE status IN ('pending', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_correction_requests_status_updated
  ON correction_requests (status, updated_at DESC);

-- A corrected product is still an active inventory item. Export exclusion is
-- controlled independently by exclude_from_export.
UPDATE products
SET status = 'active'
WHERE status = 'correction';
