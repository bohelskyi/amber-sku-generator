-- One immutable receipt per deterministic batch entry/phase. The receipt is
-- inserted by the business transaction, so a duplicate rolls back its mutation.
-- Existing audit events and historical correction requests are untouched.
CREATE UNIQUE INDEX correction_batch_step_identity_idx
  ON audit_events (subject_id)
  WHERE event_key = 'correction_batch.step_committed';

ALTER TABLE audit_events ADD CONSTRAINT correction_batch_step_shape CHECK (
  event_key <> 'correction_batch.step_committed'
  OR COALESCE((
    subject_type = 'correction_batch_step'
    AND subject_id ~ '^[a-f0-9]{64}:(claimed|refreshed|released|completed)$'
    AND details ?& ARRAY['entryKey', 'entryHash', 'planHash', 'selectionHash', 'requestId', 'phase', 'afterRequestHash']
    AND subject_id = (details->>'entryKey') || ':' || (details->>'phase')
    AND details->>'planHash' ~ '^[a-f0-9]{64}$'
    AND details->>'selectionHash' ~ '^[a-f0-9]{64}$'
    AND details->>'entryHash' ~ '^[a-f0-9]{64}$'
    AND details->>'afterRequestHash' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(details->'requestId') = 'number'
    AND details->>'requestId' ~ '^[1-9][0-9]*$'
  ), FALSE)
);
