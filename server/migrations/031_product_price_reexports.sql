CREATE TABLE IF NOT EXISTS product_export_revisions (
  product_id INTEGER PRIMARY KEY
    REFERENCES products(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  confirmed_revision BIGINT NOT NULL DEFAULT 0
    CHECK (confirmed_revision >= 0 AND confirmed_revision <= revision),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS product_export_revisions_pending_idx
  ON product_export_revisions (product_id)
  WHERE confirmed_revision < revision;

ALTER TABLE export_snapshots
  ADD COLUMN reexport_revisions JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT export_snapshots_reexport_revisions_array
    CHECK (jsonb_typeof(reexport_revisions) = 'array');

CREATE OR REPLACE FUNCTION protect_export_snapshot_payload()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.from_sku IS DISTINCT FROM OLD.from_sku
     OR NEW.to_sku IS DISTINCT FROM OLD.to_sku
     OR NEW.resolved_to_sku IS DISTINCT FROM OLD.resolved_to_sku
     OR NEW.exported_to_product_id IS DISTINCT FROM OLD.exported_to_product_id
     OR NEW.row_count IS DISTINCT FROM OLD.row_count
     OR NEW.file_name IS DISTINCT FROM OLD.file_name
     OR NEW.csv_content IS DISTINCT FROM OLD.csv_content
     OR NEW.generated_at IS DISTINCT FROM OLD.generated_at
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.reexport_revisions IS DISTINCT FROM OLD.reexport_revisions
     OR (
       OLD.confirmed_by_user_id IS NOT NULL
       AND NEW.confirmed_by_user_id IS DISTINCT FROM OLD.confirmed_by_user_id
     ) THEN
    RAISE EXCEPTION 'export snapshot payload is immutable';
  END IF;
  RETURN NEW;
END;
$$;
