-- Reviewed disposition of a retained legacy export file for first-sync history
-- admission. A row records, permanently, that every product of one retained
-- export file was found in the named Magento origin, created there inside the
-- file's import window (magento_readback_v1). It binds the exact stored CSV
-- bytes and the audit event that recorded it. It changes no snapshot, product,
-- membership or delivery data and never acknowledges an export.
CREATE TABLE retained_export_dispositions (
  snapshot_id TEXT PRIMARY KEY REFERENCES export_snapshots(id) ON DELETE RESTRICT,
  disposition TEXT NOT NULL CHECK (disposition = 'consumed_and_reconciled'),
  basis TEXT NOT NULL CHECK (basis = 'magento_readback_v1'),
  csv_sha256 TEXT NOT NULL CHECK (csv_sha256 ~ '^[a-f0-9]{64}$'),
  origin_hash TEXT NOT NULL CHECK (origin_hash ~ '^[a-f0-9]{64}$'),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 1000),
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  audit_event_id BIGINT NOT NULL UNIQUE REFERENCES audit_events(id) ON DELETE RESTRICT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE FUNCTION guard_retained_export_disposition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot export_snapshots; event audit_events;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'retained export dispositions are permanent'; END IF;
  SELECT * INTO snapshot FROM export_snapshots WHERE id = NEW.snapshot_id FOR KEY SHARE;
  SELECT * INTO event FROM audit_events WHERE id = NEW.audit_event_id;
  IF snapshot.id IS NULL OR snapshot.full_product_lifecycle_version IS NOT NULL
    OR encode(sha256(convert_to(snapshot.csv_content, 'UTF8')), 'hex') IS DISTINCT FROM NEW.csv_sha256
    OR event.id IS NULL OR event.event_key IS DISTINCT FROM 'export.retained_disposition_recorded'
    OR event.subject_type IS DISTINCT FROM 'export_snapshot' OR event.subject_id IS DISTINCT FROM NEW.snapshot_id
    OR event.actor_user_id IS DISTINCT FROM NEW.actor_user_id
    OR event.details->>'evidenceHash' IS DISTINCT FROM NEW.evidence_hash
    OR event.details->>'csvSha256' IS DISTINCT FROM NEW.csv_sha256
    OR event.details->>'originHash' IS DISTINCT FROM NEW.origin_hash
    OR event.details->>'disposition' IS DISTINCT FROM NEW.disposition
    OR NEW.evidence->>'snapshotId' IS DISTINCT FROM NEW.snapshot_id
    OR NEW.evidence->>'csvSha256' IS DISTINCT FROM NEW.csv_sha256
    OR NEW.evidence->>'originHash' IS DISTINCT FROM NEW.origin_hash THEN
    RAISE EXCEPTION 'retained export disposition evidence is invalid';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER retained_export_disposition_guard BEFORE INSERT OR UPDATE OR DELETE ON retained_export_dispositions
  FOR EACH ROW EXECUTE FUNCTION guard_retained_export_disposition();
CREATE FUNCTION reject_retained_export_disposition_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'retained export dispositions are permanent'; END $$;
CREATE TRIGGER retained_export_disposition_no_truncate BEFORE TRUNCATE ON retained_export_dispositions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_retained_export_disposition_truncate();
