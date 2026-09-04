ALTER TABLE correction_requests
  ADD COLUMN IF NOT EXISTS claim_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

ALTER TABLE correction_requests
  DROP CONSTRAINT IF EXISTS correction_requests_in_progress_has_claim;

ALTER TABLE correction_requests
  ADD CONSTRAINT correction_requests_in_progress_has_claim
  CHECK (
    status <> 'in_progress'
    OR (claim_token_hash IS NOT NULL AND claimed_at IS NOT NULL)
  ) NOT VALID;

ALTER TABLE correction_requests
  DROP CONSTRAINT IF EXISTS correction_requests_claim_only_in_progress;

ALTER TABLE correction_requests
  ADD CONSTRAINT correction_requests_claim_only_in_progress
  CHECK (status = 'in_progress' OR claim_token_hash IS NULL);
