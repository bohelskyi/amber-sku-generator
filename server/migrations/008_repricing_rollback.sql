ALTER TABLE repricing_batches
  ADD COLUMN IF NOT EXISTS rolled_back_at TIMESTAMPTZ;

ALTER TABLE repricing_batches
  DROP CONSTRAINT IF EXISTS repricing_batches_preview_token_key;

CREATE UNIQUE INDEX IF NOT EXISTS repricing_batches_active_preview_token_idx
  ON repricing_batches (preview_token)
  WHERE status = 'completed';
