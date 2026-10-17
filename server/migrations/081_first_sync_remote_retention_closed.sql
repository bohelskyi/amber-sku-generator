-- Closes the temporary first-sync decision retain_remote (080). Historical internal
-- SKUs are opaque identifiers (catalog owner, 2026-10-14), so legacy SV
-- characteristic answers are imported missing-only instead of retained in Magento.
-- Existing remote_retained receipts stay terminal, immutable history; only new
-- rows in that state are refused. 080 and earlier checksums are unchanged.
CREATE OR REPLACE FUNCTION refuse_first_sync_remote_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FIRST_SYNC_REMOTE_RETENTION_CLOSED';
END $$;

-- Named to fire before first_sync_field_guard (BEFORE triggers run in name order).
CREATE TRIGGER first_sync_field_closed_retention BEFORE INSERT ON magento_first_sync_fields
  FOR EACH ROW WHEN (NEW.state='remote_retained') EXECUTE FUNCTION refuse_first_sync_remote_retention();
