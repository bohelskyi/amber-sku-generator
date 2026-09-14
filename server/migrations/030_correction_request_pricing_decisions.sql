ALTER TABLE correction_requests
  ADD COLUMN pricing_mode TEXT,
  ADD COLUMN pricing_usd_per_gram NUMERIC(18,4),
  ADD COLUMN pricing_manual_uah NUMERIC(18,2),
  ADD COLUMN pricing_rounding_enabled INTEGER,
  ADD COLUMN pricing_origin TEXT,
  ADD CONSTRAINT correction_requests_pricing_decision_valid CHECK (
    (pricing_mode IS NULL AND pricing_usd_per_gram IS NULL
      AND pricing_manual_uah IS NULL AND pricing_rounding_enabled IS NULL
      AND (pricing_origin IS NULL OR pricing_origin = 'automatic_unavailable_fallback'))
    OR (pricing_mode IS NOT NULL AND (
    (pricing_mode = 'system_auto' AND pricing_usd_per_gram IS NULL
      AND pricing_manual_uah IS NULL AND pricing_rounding_enabled IS NULL
      AND pricing_origin IS NULL)
    OR (pricing_mode = 'usd_per_gram' AND pricing_usd_per_gram IS NOT NULL
      AND pricing_usd_per_gram > 0 AND pricing_manual_uah IS NULL
      AND pricing_rounding_enabled IS NOT NULL AND pricing_rounding_enabled IN (0, 1)
      AND pricing_origin IS NULL)
    OR (pricing_mode = 'manual_uah' AND pricing_usd_per_gram IS NULL
      AND pricing_manual_uah IS NOT NULL AND pricing_manual_uah > 0
      AND pricing_rounding_enabled IS NULL AND pricing_origin IS NOT NULL
      AND pricing_origin IN ('authorized_override', 'automatic_unavailable_fallback'))))
  );

INSERT INTO permissions (permission_key, description)
VALUES ('corrections.price_override', 'Choose custom USD per gram or exact UAH pricing for correction requests');

WITH granted AS (
  INSERT INTO role_permissions (role_id, permission_key)
  SELECT id, 'corrections.price_override'
  FROM roles
  WHERE role_key = 'manager' AND is_system = TRUE
  ON CONFLICT (role_id, permission_key) DO NOTHING
  RETURNING role_id
)
UPDATE roles
SET version = version + 1, updated_at = CURRENT_TIMESTAMP
WHERE id IN (SELECT role_id FROM granted);
