-- No historical products are enrolled and no installation is activated here.
CREATE TABLE magento_auto_sync_activation (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  installation_key TEXT,
  actor_user_id BIGINT REFERENCES application_users(id) ON DELETE RESTRICT,
  CHECK (NOT enabled OR (installation_key IS NOT NULL AND actor_user_id IS NOT NULL))
);
INSERT INTO magento_auto_sync_activation(singleton) VALUES(TRUE);

CREATE TABLE magento_product_sync_requests (
  product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE RESTRICT,
  desired_generation BIGINT NOT NULL DEFAULT 1 CHECK (desired_generation > 0),
  synced_generation BIGINT NOT NULL DEFAULT 0 CHECK (synced_generation BETWEEN 0 AND desired_generation),
  active_job_id TEXT REFERENCES magento_sync_jobs(id) ON DELETE RESTRICT,
  active_generation BIGINT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','syncing','synced','needs_attention')),
  reason_code TEXT CHECK (reason_code IN ('data_or_binding','reconciliation_required','authorization','configuration','product_retired','unexpected_failure')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((active_job_id IS NULL) = (active_generation IS NULL)),
  CHECK (active_generation IS NULL OR active_generation BETWEEN 1 AND desired_generation),
  CHECK (state <> 'synced' OR synced_generation = desired_generation)
);
CREATE INDEX magento_product_sync_pending ON magento_product_sync_requests(next_attempt_at,product_id)
  WHERE state IN ('pending','syncing');

-- Only an automatic job with no dispatch/verification evidence can be superseded.
ALTER TABLE magento_sync_jobs ADD COLUMN automatic_generation BIGINT CHECK (automatic_generation > 0);
ALTER TABLE magento_sync_jobs DROP CONSTRAINT magento_sync_jobs_state_check;
ALTER TABLE magento_sync_jobs ADD CHECK (state IN ('queued','running','retryable','blocked','uncertain','succeeded','superseded'));
DO $$ DECLARE constraint_name TEXT; BEGIN
  SELECT conname INTO STRICT constraint_name FROM pg_constraint
    WHERE conrelid='magento_sync_jobs'::regclass AND contype='u';
  EXECUTE format('ALTER TABLE magento_sync_jobs DROP CONSTRAINT %I', constraint_name);
END $$;
CREATE UNIQUE INDEX magento_sync_intent_identity ON magento_sync_jobs(origin_hash,product_id,binding_revision_id,amber_hash)
  WHERE automatic_generation IS NULL AND state <> 'superseded';
CREATE UNIQUE INDEX magento_sync_automatic_intent_identity ON magento_sync_jobs(origin_hash,product_id,binding_revision_id,automatic_generation)
  WHERE automatic_generation IS NOT NULL AND state <> 'superseded';
DROP INDEX magento_sync_one_unfinished;
CREATE UNIQUE INDEX magento_sync_one_unfinished ON magento_sync_jobs(origin_hash,sku)
  WHERE state NOT IN ('succeeded','superseded');
CREATE FUNCTION guard_magento_sync_supersession() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'superseded' OR (NEW.state = 'superseded' AND
    (OLD.automatic_generation IS NULL OR OLD.state IN ('uncertain','succeeded') OR
      EXISTS (SELECT 1 FROM magento_sync_steps WHERE job_id=OLD.id))) THEN
    RAISE EXCEPTION 'Magento dispatch evidence requires reconciliation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER magento_sync_supersession_guard BEFORE UPDATE ON magento_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION guard_magento_sync_supersession();

-- Projection of stored inputs consumed by the existing evaluator/eligibility gate.
-- Export acknowledgements, audit attribution and calculated pricing metadata are
-- deliberately absent: they do not change the desired Magento product.
CREATE FUNCTION magento_sync_product_input(p products) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_array(p.full_sku,p.category,p.weight,p.total_price_uah,p.sku_schema_version_id,
    p.details->'answers',p.magento_name_subject_ua,p.magento_name_subject_en,p.magento_name_review_required,
    p.status,p.corrected_to_product_id,p.exclude_from_export)
$$;
CREATE FUNCTION request_magento_product_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active BOOLEAN;
BEGIN
  IF TG_OP='UPDATE' AND magento_sync_product_input(NEW) IS NOT DISTINCT FROM magento_sync_product_input(OLD) THEN
    RETURN NEW;
  END IF;
  -- Serializes enable/disable with local commits, never with remote work.
  SELECT enabled INTO active FROM magento_auto_sync_activation WHERE singleton FOR SHARE;
  IF active IS NOT TRUE THEN RETURN NEW; END IF;
  -- Recount enrolls the successor, not an untouched legacy predecessor.
  IF (NEW.status <> 'active' OR NEW.corrected_to_product_id IS NOT NULL) AND
    NOT EXISTS (SELECT 1 FROM magento_product_sync_requests WHERE product_id=NEW.id) THEN RETURN NEW; END IF;
  INSERT INTO magento_product_sync_requests(product_id) VALUES(NEW.id)
  ON CONFLICT(product_id) DO UPDATE SET
    desired_generation=magento_product_sync_requests.desired_generation+1,
    state=CASE WHEN magento_product_sync_requests.reason_code='reconciliation_required'
      THEN 'needs_attention' ELSE 'pending' END,
    reason_code=CASE WHEN magento_product_sync_requests.reason_code='reconciliation_required'
      THEN 'reconciliation_required' ELSE NULL END,
    attempts=0,next_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;
CREATE TRIGGER product_magento_sync_request AFTER INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION request_magento_product_sync();
