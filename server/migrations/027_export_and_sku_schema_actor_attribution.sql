ALTER TABLE export_snapshots
  ADD COLUMN created_by_user_id BIGINT
    REFERENCES application_users(id) ON DELETE RESTRICT,
  ADD COLUMN confirmed_by_user_id BIGINT
    REFERENCES application_users(id) ON DELETE RESTRICT;

ALTER TABLE sku_schema_versions
  ADD COLUMN published_by_user_id BIGINT
    REFERENCES application_users(id) ON DELETE RESTRICT;

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
     OR (
       OLD.confirmed_by_user_id IS NOT NULL
       AND NEW.confirmed_by_user_id IS DISTINCT FROM OLD.confirmed_by_user_id
     ) THEN
    RAISE EXCEPTION 'export snapshot payload is immutable';
  END IF;
  RETURN NEW;
END;
$$;
