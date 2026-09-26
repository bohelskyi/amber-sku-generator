-- Phase 1 foundation only. Do not deploy independently or run mixed writers.
ALTER TABLE products ADD COLUMN magento_name_review_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE export_snapshots ADD COLUMN full_product_lifecycle_version SMALLINT
  CHECK (full_product_lifecycle_version = 1);

CREATE TABLE product_full_export_state (
  product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE RESTRICT,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  confirmed_revision BIGINT NOT NULL DEFAULT 0
    CHECK (confirmed_revision >= 0 AND confirmed_revision <= revision),
  delivery_version BIGINT NOT NULL DEFAULT 1 CHECK (delivery_version > 0),
  route TEXT NOT NULL CHECK (route IN ('normal', 'replacement', 'hold', 'retired')),
  hold_reason TEXT CHECK (hold_reason IN
    ('historical_ambiguity', 'prior_exposure', 'intentional_exclusion', 'invalid_lineage')),
  source_correction_id INTEGER REFERENCES product_corrections(id) ON DELETE RESTRICT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  repair_manifest_hash TEXT CHECK (repair_manifest_hash ~ '^[a-f0-9]{64}$'),
  last_resolution_key TEXT CHECK (length(btrim(last_resolution_key)) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_by_user_id BIGINT REFERENCES application_users(id) ON DELETE RESTRICT,
  resolved_at TIMESTAMPTZ,
  CHECK ((route = 'hold' AND hold_reason IS NOT NULL) OR (route <> 'hold' AND hold_reason IS NULL)),
  CHECK ((resolved_by_user_id IS NULL) = (resolved_at IS NULL))
);
CREATE UNIQUE INDEX product_full_export_state_correction_idx
  ON product_full_export_state(source_correction_id) WHERE source_correction_id IS NOT NULL;
CREATE UNIQUE INDEX product_full_export_state_resolution_idx
  ON product_full_export_state(last_resolution_key) WHERE last_resolution_key IS NOT NULL;
CREATE INDEX product_full_export_state_pending_idx ON product_full_export_state(route, product_id)
  WHERE route IN ('normal', 'replacement') AND confirmed_revision < revision;
CREATE INDEX product_full_export_state_holds_idx ON product_full_export_state(hold_reason, product_id)
  WHERE route = 'hold';

-- No cursor inference, exposure repair, exclusion changes, or historical actors.
INSERT INTO product_full_export_state(product_id, route, hold_reason, evidence)
SELECT id,
  CASE WHEN status IN ('corrected', 'archived') OR corrected_to_product_id IS NOT NULL
    THEN 'retired' ELSE 'hold' END,
  CASE WHEN status IN ('corrected', 'archived') OR corrected_to_product_id IS NOT NULL
    THEN NULL ELSE 'historical_ambiguity' END,
  '{"origin":"migration_039","coverage":"unresolved_historical"}'::jsonb
FROM products ORDER BY id;

CREATE FUNCTION protect_full_product_export_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'full product export state is permanent'; END IF;
  IF NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.source_correction_id IS DISTINCT FROM OLD.source_correction_id
    OR NEW.revision < OLD.revision OR NEW.confirmed_revision < OLD.confirmed_revision
    OR NEW.delivery_version < OLD.delivery_version THEN
    RAISE EXCEPTION 'full product export identity and counters cannot regress';
  END IF;
  IF (NEW.route, NEW.hold_reason, NEW.evidence, NEW.repair_manifest_hash,
      NEW.last_resolution_key, NEW.resolved_by_user_id, NEW.resolved_at)
    IS DISTINCT FROM (OLD.route, OLD.hold_reason, OLD.evidence, OLD.repair_manifest_hash,
      OLD.last_resolution_key, OLD.resolved_by_user_id, OLD.resolved_at)
    AND NEW.delivery_version <= OLD.delivery_version THEN
    RAISE EXCEPTION 'full product delivery changes require a new version';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER product_full_export_state_protected BEFORE UPDATE OR DELETE ON product_full_export_state
  FOR EACH ROW EXECUTE FUNCTION protect_full_product_export_state();
CREATE TRIGGER product_full_export_state_no_truncate BEFORE TRUNCATE ON product_full_export_state
  FOR EACH STATEMENT EXECUTE FUNCTION protect_full_product_export_state();

CREATE FUNCTION require_product_full_export_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM product_full_export_state WHERE product_id = NEW.id) THEN
    RAISE EXCEPTION 'product requires full export state';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER product_requires_full_export_state AFTER INSERT ON products
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_product_full_export_state();

CREATE TABLE export_snapshot_products (
  snapshot_id TEXT NOT NULL REFERENCES export_snapshots(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  sku_at_capture TEXT NOT NULL CHECK (length(btrim(sku_at_capture)) > 0),
  full_revision BIGINT CHECK (full_revision > 0),
  delivery_version BIGINT CHECK (delivery_version > 0),
  capture_kind TEXT NOT NULL CHECK (capture_kind IN ('full_product', 'legacy_compatibility')),
  evidence_origin TEXT NOT NULL CHECK (evidence_origin IN ('live_capture', 'verified_stored_csv')),
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(snapshot_id, product_id),
  CHECK ((capture_kind = 'full_product' AND full_revision IS NOT NULL AND delivery_version IS NOT NULL
      AND evidence_origin = 'live_capture')
    OR (capture_kind = 'legacy_compatibility' AND full_revision IS NULL AND delivery_version IS NULL))
);
CREATE INDEX export_snapshot_products_product_idx ON export_snapshot_products(product_id, snapshot_id);
CREATE FUNCTION protect_export_snapshot_products() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'export snapshot products are immutable';
END;
$$;
CREATE TRIGGER export_snapshot_products_immutable BEFORE UPDATE OR DELETE ON export_snapshot_products
  FOR EACH ROW EXECUTE FUNCTION protect_export_snapshot_products();
CREATE TRIGGER export_snapshot_products_no_truncate BEFORE TRUNCATE ON export_snapshot_products
  FOR EACH STATEMENT EXECUTE FUNCTION protect_export_snapshot_products();

CREATE FUNCTION protect_snapshot_lifecycle_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.full_product_lifecycle_version IS DISTINCT FROM OLD.full_product_lifecycle_version THEN
    RAISE EXCEPTION 'snapshot lifecycle provenance is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER snapshot_lifecycle_version_immutable BEFORE UPDATE ON export_snapshots
  FOR EACH ROW EXECUTE FUNCTION protect_snapshot_lifecycle_version();

CREATE FUNCTION require_snapshot_product_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_id TEXT;
  snapshot export_snapshots%ROWTYPE;
  members BIGINT;
  full_members BIGINT;
  artifact_products BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'export_snapshots' THEN target_id := NEW.id;
  ELSE target_id := NEW.snapshot_id; END IF;
  SELECT * INTO STRICT snapshot FROM export_snapshots WHERE id = target_id;
  IF snapshot.full_product_lifecycle_version IS NULL THEN
    IF TG_TABLE_NAME = 'export_snapshot_products' THEN
      IF NEW.capture_kind <> 'legacy_compatibility' OR NEW.evidence_origin <> 'verified_stored_csv' THEN
        RAISE EXCEPTION 'historical snapshots require verified compatibility evidence';
      END IF;
    END IF;
    RETURN NULL;
  END IF;
  SELECT count(*), count(*) FILTER (WHERE capture_kind = 'full_product')
    INTO members, full_members FROM export_snapshot_products WHERE snapshot_id = target_id;
  SELECT COALESCE(sum(product_count), 0) INTO artifact_products
    FROM magento_export_artifacts WHERE snapshot_id = target_id;
  IF members <> snapshot.row_count
    OR (artifact_products > 0 AND (artifact_products <> members OR full_members <> members))
    OR (artifact_products = 0 AND full_members <> 0)
    OR EXISTS (SELECT 1 FROM export_snapshot_products WHERE snapshot_id = target_id AND evidence_origin <> 'live_capture') THEN
    RAISE EXCEPTION 'lifecycle snapshot requires complete exact product membership';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER snapshot_requires_product_membership AFTER INSERT ON export_snapshots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_snapshot_product_membership();
CREATE CONSTRAINT TRIGGER snapshot_product_membership_complete AFTER INSERT ON export_snapshot_products
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_snapshot_product_membership();
CREATE CONSTRAINT TRIGGER snapshot_artifact_membership_complete AFTER INSERT ON magento_export_artifacts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_snapshot_product_membership();

-- The existing permission trigger grants Administrator; normal role editing may delegate it.
INSERT INTO permissions(permission_key, description)
VALUES ('exports.reconcile', 'Reconcile held full-product export delivery');
