ALTER TABLE price_scenarios
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;

ALTER TABLE price_scenarios
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE price_scenarios
  ADD COLUMN IF NOT EXISTS price_mode TEXT NOT NULL DEFAULT 'category_default';

ALTER TABLE price_scenarios
  ADD COLUMN IF NOT EXISTS apply_modifiers BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE price_scenarios
SET status = 'active'
WHERE status IS NULL OR status NOT IN ('draft', 'active', 'archived');

UPDATE price_scenarios
SET price_mode = 'category_default'
WHERE price_mode IS NULL
   OR price_mode NOT IN ('category_default', 'per_gram_usd', 'fixed_uah');

CREATE TABLE IF NOT EXISTS price_weight_bands (
  id SERIAL PRIMARY KEY,
  scenario_id INTEGER NOT NULL REFERENCES price_scenarios(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  min_weight NUMERIC NOT NULL,
  max_weight NUMERIC,
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK (min_weight >= 0),
  CHECK (max_weight IS NULL OR max_weight > min_weight)
);

CREATE INDEX IF NOT EXISTS price_scenarios_active_priority_idx
  ON price_scenarios (category_code, status, priority DESC);

CREATE INDEX IF NOT EXISTS price_weight_bands_scenario_idx
  ON price_weight_bands (scenario_id, sort_order, min_weight);
