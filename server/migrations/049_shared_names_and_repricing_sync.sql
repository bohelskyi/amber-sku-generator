-- Exact full names are separate from Amber's structured name subjects. No
-- historical job is reinterpreted and no remote baseline is guessed here.
ALTER TABLE products ADD COLUMN magento_name_override JSONB
  CHECK (magento_name_override IS NULL OR (jsonb_typeof(magento_name_override)='object'
    AND jsonb_typeof(magento_name_override->'generated')='object'
    AND jsonb_typeof(magento_name_override->'values')='object'));

CREATE TABLE magento_name_sync_states (
  origin_hash TEXT NOT NULL,
  public_product_identity_id BIGINT NOT NULL REFERENCES public_product_identities(id) ON DELETE RESTRICT,
  remote_product_id INTEGER NOT NULL CHECK (remote_product_id>0),
  baseline_names JSONB,
  observed_amber_names JSONB NOT NULL,
  observed_remote_names JSONB NOT NULL,
  resolution JSONB,
  state TEXT NOT NULL CHECK (state IN ('common','amber_changed','conflict','baseline_required')),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version>0),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(origin_hash,public_product_identity_id)
);
CREATE TABLE magento_name_discovery_cursors (
  origin_hash TEXT PRIMARY KEY,
  after_identity_id BIGINT NOT NULL DEFAULT 0 CHECK (after_identity_id>=0),
  next_scan_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE magento_product_sync_requests ADD COLUMN diagnostics JSONB NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(diagnostics)='array');
-- Capture the committed batch's obligation, rather than confusing it with a
-- later product mutation. Old batches have no invented synchronization proof.
ALTER TABLE repricing_items ADD COLUMN magento_sync_generation BIGINT CHECK (magento_sync_generation>0);

CREATE OR REPLACE FUNCTION magento_sync_product_input(p products) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_array(p.public_product_identity_id,p.full_sku,p.category,p.weight,p.total_price_uah,
    p.sku_schema_version_id,p.details->'answers',p.magento_name_subject_ua,p.magento_name_subject_en,
    p.magento_name_review_required,p.magento_name_override,p.status,p.corrected_to_product_id,p.exclude_from_export)
$$;
