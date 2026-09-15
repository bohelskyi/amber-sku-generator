INSERT INTO permissions (permission_key, description)
VALUES ('products.price_change', 'Directly change an existing product price in place');

WITH granted AS (
  INSERT INTO role_permissions (role_id, permission_key)
  SELECT existing.role_id, 'products.price_change'
  FROM role_permissions existing
  JOIN roles role ON role.id = existing.role_id
  WHERE existing.permission_key = 'products.recount'
    AND NOT (role.role_key = 'administrator' AND role.is_system = TRUE)
  ON CONFLICT (role_id, permission_key) DO NOTHING
  RETURNING role_id
)
UPDATE roles
SET version = version + 1, updated_at = CURRENT_TIMESTAMP
WHERE id IN (SELECT role_id FROM granted);

UPDATE permissions
SET description = CASE permission_key
  WHEN 'corrections.create' THEN 'Create recount and in-place price-change requests'
  WHEN 'corrections.price_override' THEN 'Choose protected custom pricing for correction requests'
  WHEN 'exports.view' THEN 'View product and price export status and snapshots'
  WHEN 'exports.create' THEN 'Create and confirm product and price export snapshots'
  ELSE description
END
WHERE permission_key IN (
  'corrections.create',
  'corrections.price_override',
  'exports.view',
  'exports.create'
);

ALTER TABLE correction_requests
  ADD COLUMN request_type TEXT NOT NULL DEFAULT 'recount'
    CHECK (request_type IN ('recount', 'price_change'));

ALTER TABLE correction_requests
  DROP CONSTRAINT correction_requests_pricing_decision_valid;

ALTER TABLE correction_requests
  ADD CONSTRAINT correction_requests_pricing_decision_valid CHECK (
    (pricing_mode IS NULL AND pricing_usd_per_gram IS NULL
      AND pricing_manual_uah IS NULL AND pricing_rounding_enabled IS NULL
      AND (pricing_origin IS NULL OR pricing_origin = 'automatic_unavailable_fallback'))
    OR (
      pricing_mode IS NOT NULL AND (
      (pricing_mode = 'system_auto' AND pricing_usd_per_gram IS NULL
        AND pricing_manual_uah IS NULL AND pricing_rounding_enabled IS NULL
        AND pricing_origin IS NULL)
      OR (pricing_mode = 'usd_per_gram' AND pricing_usd_per_gram IS NOT NULL
        AND pricing_usd_per_gram > 0 AND pricing_manual_uah IS NULL
        AND pricing_rounding_enabled IS NOT NULL AND pricing_rounding_enabled IN (0, 1)
        AND pricing_origin IS NULL)
      OR (pricing_mode = 'manual_uah' AND pricing_usd_per_gram IS NULL
        AND pricing_manual_uah IS NOT NULL AND pricing_manual_uah > 0
        AND pricing_origin IS NOT NULL
        AND pricing_origin IN ('authorized_override', 'automatic_unavailable_fallback')
        AND (
          (request_type = 'recount' AND pricing_rounding_enabled IS NULL)
          OR (request_type = 'price_change'
            AND pricing_rounding_enabled IS NOT NULL
            AND pricing_rounding_enabled IN (0, 1))
        ))
      )
    )
  );

ALTER TABLE correction_requests
  ADD CONSTRAINT correction_requests_price_change_shape CHECK (
    request_type <> 'price_change'
    OR (
      source_sku = proposed_sku
      AND corrected_product_id IS NULL
      AND changes = '[]'::jsonb
      AND pricing_mode IS NOT NULL
    )
  );

ALTER TABLE product_export_revisions
  DROP CONSTRAINT product_export_revisions_revision_check;

ALTER TABLE product_export_revisions
  ADD CONSTRAINT product_export_revisions_revision_check CHECK (revision >= 0),
  ADD COLUMN has_product_snapshot BOOLEAN NOT NULL DEFAULT FALSE;

DROP INDEX product_export_revisions_pending_idx;
CREATE INDEX product_export_revisions_pending_idx
  ON product_export_revisions (product_id)
  WHERE has_product_snapshot = TRUE AND confirmed_revision < revision;

COMMENT ON TABLE product_export_revisions IS
  'Coalescing per-product revisions for the dedicated price-export stream.';
COMMENT ON COLUMN product_export_revisions.has_product_snapshot IS
  'True once a normal immutable product snapshot may have exposed this SKU to Magento.';

WITH snapshot_ranges AS (
  SELECT
    LEAST(from_product.id, COALESCE(to_product.id, snapshot.exported_to_product_id)) AS start_id,
    GREATEST(from_product.id, COALESCE(to_product.id, snapshot.exported_to_product_id)) AS end_id
  FROM export_snapshots snapshot
  JOIN products from_product ON from_product.full_sku = snapshot.from_sku
  LEFT JOIN products to_product ON to_product.full_sku = snapshot.to_sku
  WHERE snapshot.exported_to_product_id > 0
), represented_products AS (
  SELECT DISTINCT represented."productId" AS product_id
  FROM export_snapshots snapshot
  CROSS JOIN LATERAL jsonb_to_recordset(snapshot.reexport_revisions)
    AS represented("productId" integer, revision bigint)
), exposed_products AS (
  SELECT product.id AS product_id
  FROM products product
  CROSS JOIN export_state state
  WHERE state.singleton = TRUE
    AND product.id <= state.exported_to_product_id
  UNION
  SELECT product.id
  FROM products product
  JOIN snapshot_ranges range
    ON product.id BETWEEN range.start_id AND range.end_id
  UNION
  SELECT product_id FROM represented_products
)
INSERT INTO product_export_revisions
  (product_id, revision, confirmed_revision, changed_at, has_product_snapshot)
SELECT product_id, 0, 0, CURRENT_TIMESTAMP, TRUE
FROM exposed_products
ON CONFLICT (product_id) DO UPDATE
SET has_product_snapshot = TRUE;

WITH confirmed_evidence AS (
  SELECT represented."productId" AS product_id, MAX(represented.revision) AS revision
  FROM export_snapshots snapshot
  CROSS JOIN LATERAL jsonb_to_recordset(snapshot.reexport_revisions)
    AS represented("productId" integer, revision bigint)
  WHERE snapshot.status = 'confirmed'
  GROUP BY represented."productId"
)
UPDATE product_export_revisions revisions
SET confirmed_revision = GREATEST(revisions.confirmed_revision, evidence.revision),
    has_product_snapshot = TRUE
FROM confirmed_evidence evidence
WHERE revisions.product_id = evidence.product_id
  AND evidence.revision <= revisions.revision;

CREATE TABLE price_export_snapshots (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  row_count INTEGER NOT NULL CHECK (row_count > 0),
  file_name TEXT NOT NULL,
  csv_content TEXT NOT NULL,
  captured_revisions JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated'
    CHECK (status IN ('generated', 'confirmed')),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TIMESTAMPTZ,
  created_by_user_id BIGINT NOT NULL
    REFERENCES application_users(id) ON DELETE RESTRICT,
  confirmed_by_user_id BIGINT
    REFERENCES application_users(id) ON DELETE RESTRICT,
  CONSTRAINT price_export_snapshots_revisions_array
    CHECK (jsonb_typeof(captured_revisions) = 'array'),
  CONSTRAINT price_export_snapshots_confirmation_shape CHECK (
    (status = 'generated' AND confirmed_at IS NULL AND confirmed_by_user_id IS NULL)
    OR (status = 'confirmed' AND confirmed_at IS NOT NULL AND confirmed_by_user_id IS NOT NULL)
  )
);

CREATE INDEX price_export_snapshots_generated_idx
  ON price_export_snapshots (generated_at DESC, id DESC);

CREATE OR REPLACE FUNCTION protect_price_export_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'price export snapshots are immutable';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.row_count IS DISTINCT FROM OLD.row_count
     OR NEW.file_name IS DISTINCT FROM OLD.file_name
     OR NEW.csv_content IS DISTINCT FROM OLD.csv_content
     OR NEW.captured_revisions IS DISTINCT FROM OLD.captured_revisions
     OR NEW.generated_at IS DISTINCT FROM OLD.generated_at
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
    RAISE EXCEPTION 'price export snapshot payload is immutable';
  END IF;

  IF OLD.status = 'confirmed'
     AND (
       NEW.status IS DISTINCT FROM OLD.status
       OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       OR NEW.confirmed_by_user_id IS DISTINCT FROM OLD.confirmed_by_user_id
     ) THEN
    RAISE EXCEPTION 'confirmed price export snapshot is immutable';
  END IF;

  IF OLD.status = 'generated' AND NEW.status = 'generated'
     AND (
       NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       OR NEW.confirmed_by_user_id IS DISTINCT FROM OLD.confirmed_by_user_id
     ) THEN
    RAISE EXCEPTION 'price export confirmation fields require confirmation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER price_export_snapshot_immutable
BEFORE UPDATE OR DELETE ON price_export_snapshots
FOR EACH ROW EXECUTE FUNCTION protect_price_export_snapshot();

CREATE TRIGGER price_export_snapshots_no_truncate
BEFORE TRUNCATE ON price_export_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION protect_audit_event_immutability();
