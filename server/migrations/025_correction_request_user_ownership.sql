ALTER TABLE correction_requests
  ADD COLUMN created_by_user_id BIGINT
    REFERENCES application_users(id) ON DELETE RESTRICT,
  ADD COLUMN claimed_by_user_id BIGINT
    REFERENCES application_users(id) ON DELETE RESTRICT,
  ADD COLUMN claim_version BIGINT NOT NULL DEFAULT 0
    CHECK (claim_version >= 0);

CREATE INDEX correction_requests_created_by_user_idx
  ON correction_requests (created_by_user_id, created_at DESC, id DESC);

CREATE INDEX correction_requests_claimed_by_user_idx
  ON correction_requests (claimed_by_user_id, updated_at DESC, id DESC)
  WHERE claimed_by_user_id IS NOT NULL;

ALTER TABLE correction_requests
  DROP CONSTRAINT correction_requests_in_progress_has_claim;

ALTER TABLE correction_requests
  ADD CONSTRAINT correction_requests_in_progress_has_owner
  CHECK (
    status <> 'in_progress'
    OR (
      claimed_at IS NOT NULL
      AND (claimed_by_user_id IS NOT NULL OR claim_token_hash IS NOT NULL)
    )
  ) NOT VALID;

ALTER TABLE correction_requests
  DROP CONSTRAINT correction_requests_claim_only_in_progress;

ALTER TABLE correction_requests
  ADD CONSTRAINT correction_requests_claim_only_in_progress
  CHECK (
    status = 'in_progress'
    OR (claim_token_hash IS NULL AND claimed_by_user_id IS NULL)
  );
