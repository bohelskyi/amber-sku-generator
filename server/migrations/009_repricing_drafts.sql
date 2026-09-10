CREATE TABLE IF NOT EXISTS repricing_drafts (
  id SERIAL PRIMARY KEY,
  scenario_id INTEGER REFERENCES price_scenarios(id) ON DELETE SET NULL,
  category_code TEXT NOT NULL,
  scenario_name TEXT NOT NULL,
  scenario_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  preview_fingerprint TEXT NOT NULL,
  preview_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  manual_overrides JSONB NOT NULL DEFAULT '[]'::jsonb,
  ui_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft',
  applied_batch_id INTEGER REFERENCES repricing_batches(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_at TIMESTAMPTZ,
  discarded_at TIMESTAMPTZ,
  CHECK (status IN ('draft', 'applied', 'discarded'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_repricing_drafts_one_active_scenario
  ON repricing_drafts (scenario_id)
  WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS idx_repricing_drafts_status_updated
  ON repricing_drafts (status, updated_at DESC);
