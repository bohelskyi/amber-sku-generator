ALTER TABLE repricing_drafts
  ADD COLUMN IF NOT EXISTS reviewed_product_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
