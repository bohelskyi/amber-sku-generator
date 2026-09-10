CREATE TABLE IF NOT EXISTS export_snapshots (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  from_sku TEXT NOT NULL,
  to_sku TEXT,
  resolved_to_sku TEXT NOT NULL,
  exported_to_product_id INTEGER NOT NULL CHECK (exported_to_product_id >= 0),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  file_name TEXT NOT NULL,
  csv_content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated' CHECK (status IN ('generated', 'confirmed')),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS export_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  exported_to_product_id INTEGER NOT NULL DEFAULT 0 CHECK (exported_to_product_id >= 0),
  last_snapshot_id TEXT REFERENCES export_snapshots(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO export_state (singleton, exported_to_product_id)
VALUES (TRUE, COALESCE((SELECT MAX(exported_to_product_id) FROM export_events), 0))
ON CONFLICT (singleton) DO NOTHING;

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
     OR NEW.generated_at IS DISTINCT FROM OLD.generated_at THEN
    RAISE EXCEPTION 'export snapshot payload is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS export_snapshot_payload_immutable ON export_snapshots;
CREATE TRIGGER export_snapshot_payload_immutable
BEFORE UPDATE ON export_snapshots
FOR EACH ROW EXECUTE FUNCTION protect_export_snapshot_payload();
