ALTER TABLE repricing_batches
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'scenario';

ALTER TABLE repricing_drafts
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'scenario';

ALTER TABLE repricing_batches
  ADD CONSTRAINT repricing_batches_scope_allowed
  CHECK (scope IN ('scenario', 'global')) NOT VALID;

ALTER TABLE repricing_drafts
  ADD CONSTRAINT repricing_drafts_scope_allowed
  CHECK (scope IN ('scenario', 'global')) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_repricing_drafts_one_active_global
  ON repricing_drafts (scope)
  WHERE scope = 'global' AND status = 'draft';
