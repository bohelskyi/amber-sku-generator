-- A new reviewed standard-REST intent. Existing 066 atomic receipts are untouched.
-- No backfill, enrollment, remote I/O, or participation change occurs on startup.
CREATE TABLE historical_standard_batches (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f-]{36}$'),
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  review_hash TEXT NOT NULL CHECK (review_hash ~ '^[0-9a-f]{64}$'),
  selected_skus JSONB NOT NULL CHECK (jsonb_typeof(selected_skus)='array'),
  selected_create_skus JSONB NOT NULL CHECK (jsonb_typeof(selected_create_skus)='array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE historical_standard_intents (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f-]{36}$'),
  batch_id TEXT NOT NULL REFERENCES historical_standard_batches(id) ON DELETE RESTRICT,
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  public_product_identity_id BIGINT NOT NULL REFERENCES public_product_identities(id) ON DELETE RESTRICT,
  public_sku TEXT NOT NULL,
  origin_hash TEXT NOT NULL CHECK (origin_hash ~ '^[0-9a-f]{64}$'),
  installation_key TEXT NOT NULL,
  binding_revision_id TEXT NOT NULL REFERENCES magento_binding_revisions(id) ON DELETE RESTRICT,
  binding_hash TEXT NOT NULL CHECK (binding_hash ~ '^[0-9a-f]{64}$'),
  local_fingerprint TEXT NOT NULL CHECK (local_fingerprint ~ '^[0-9a-f]{64}$'),
  request_generation BIGINT,
  review JSONB NOT NULL,
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('create','update')),
  remote_product_id BIGINT CHECK (remote_product_id>0),
  confirmed_remote_product_id BIGINT CHECK (confirmed_remote_product_id>0),
  remote_fingerprint TEXT,
  target_status INTEGER NOT NULL CHECK (target_status IN (1,2)),
  target_visibility INTEGER NOT NULL CHECK (target_visibility BETWEEN 1 AND 4),
  plan_hash TEXT NOT NULL CHECK (plan_hash ~ '^[0-9a-f]{64}$'),
  native_job_id TEXT REFERENCES magento_sync_jobs(id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','delivering','blocked','cancelled','completed')),
  reason_code TEXT,
  delivery_verified_at TIMESTAMPTZ,
  local_activated_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((delivery_mode='create' AND remote_product_id IS NULL AND remote_fingerprint IS NULL AND target_status=2)
    OR (delivery_mode='update' AND remote_product_id IS NOT NULL AND remote_fingerprint ~ '^[0-9a-f]{64}$')),
  CHECK ((state='completed' AND native_job_id IS NOT NULL AND confirmed_remote_product_id IS NOT NULL AND delivery_verified_at IS NOT NULL AND local_activated_at IS NOT NULL)
    OR (state<>'completed' AND confirmed_remote_product_id IS NULL AND delivery_verified_at IS NULL AND local_activated_at IS NULL)),
  CHECK ((state='cancelled') = (cancelled_at IS NOT NULL)),
  UNIQUE(batch_id,product_id)
);
CREATE UNIQUE INDEX historical_standard_one_pending ON historical_standard_intents(public_product_identity_id)
  WHERE state NOT IN ('completed','cancelled');
CREATE INDEX historical_standard_pending ON historical_standard_intents(origin_hash,last_checked_at,created_at)
  WHERE state IN ('queued','delivering');

CREATE FUNCTION protect_historical_standard_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'standard historical batch is permanent'; END $$;
CREATE TRIGGER historical_standard_batch_protected BEFORE UPDATE OR DELETE ON historical_standard_batches
  FOR EACH ROW EXECUTE FUNCTION protect_historical_standard_batch();
CREATE TRIGGER historical_standard_batch_no_truncate BEFORE TRUNCATE ON historical_standard_batches
  FOR EACH STATEMENT EXECUTE FUNCTION protect_historical_standard_batch();

CREATE FUNCTION protect_historical_standard_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j magento_sync_jobs;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'standard historical intent is permanent'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'queued' OR NEW.native_job_id IS NOT NULL OR NEW.reason_code IS NOT NULL
      OR NEW.delivery_verified_at IS NOT NULL OR NEW.local_activated_at IS NOT NULL
      OR NOT EXISTS(SELECT 1 FROM historical_standard_batches b WHERE b.id=NEW.batch_id AND b.actor_user_id=NEW.actor_user_id
        AND b.selected_skus ? NEW.public_sku AND (NEW.delivery_mode<>'create' OR b.selected_create_skus ? NEW.public_sku))
      OR NOT EXISTS(SELECT 1 FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
        WHERE p.id=NEW.product_id AND p.public_product_identity_id=NEW.public_product_identity_id AND i.public_sku=NEW.public_sku
        AND p.status='archived' AND p.corrected_to_product_id IS NULL AND p.corrected_from_product_id IS NULL)
      OR EXISTS(SELECT 1 FROM historical_reactivation_intents h WHERE h.public_product_identity_id=NEW.public_product_identity_id
        AND h.state IN ('queued','dispatched','awaiting_native'))
    THEN RAISE EXCEPTION 'standard historical enrollment proof required'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['state','reason_code','native_job_id','confirmed_remote_product_id','delivery_verified_at','local_activated_at','last_checked_at','cancelled_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','reason_code','native_job_id','confirmed_remote_product_id','delivery_verified_at','local_activated_at','last_checked_at','cancelled_at'])
    OR OLD.state IN ('completed','cancelled') AND NEW IS DISTINCT FROM OLD
    OR OLD.state='blocked' AND NEW.state NOT IN ('blocked','cancelled')
    OR OLD.state='delivering' AND NEW.state='queued'
    OR OLD.native_job_id IS NOT NULL AND NEW.native_job_id IS DISTINCT FROM OLD.native_job_id
  THEN RAISE EXCEPTION 'standard historical proof cannot be rewritten'; END IF;
  IF NEW.state='cancelled' THEN
    IF current_setting('amber.historical_standard_cancel',true) IS DISTINCT FROM NEW.id
      OR NEW.native_job_id IS NOT NULL AND EXISTS(SELECT 1 FROM magento_sync_steps WHERE job_id=NEW.native_job_id)
    THEN RAISE EXCEPTION 'Started historical delivery requires reconciliation'; END IF;
  END IF;
  IF NEW.native_job_id IS NOT NULL THEN
    SELECT * INTO j FROM magento_sync_jobs WHERE id=NEW.native_job_id;
    IF NOT FOUND OR j.product_id<>NEW.product_id OR j.public_product_identity_id<>NEW.public_product_identity_id
      OR j.sku<>NEW.public_sku OR j.origin_hash<>NEW.origin_hash OR j.binding_revision_id<>NEW.binding_revision_id
      OR j.plan_hash<>NEW.plan_hash OR j.intent->>'mode'<>NEW.delivery_mode OR j.created_by_user_id<>NEW.actor_user_id
    THEN RAISE EXCEPTION 'standard historical exact original job required'; END IF;
    IF NEW.state='cancelled' AND j.state IN ('uncertain','succeeded','superseded')
    THEN RAISE EXCEPTION 'Started historical delivery requires reconciliation'; END IF;
    IF NEW.state='completed' AND (j.state<>'succeeded' OR j.acknowledged_at IS NULL
      OR NEW.delivery_verified_at IS DISTINCT FROM j.acknowledged_at OR j.remote_product_id IS NULL
      OR NEW.confirmed_remote_product_id IS DISTINCT FROM j.remote_product_id
      OR NEW.delivery_mode='update' AND j.remote_product_id<>NEW.remote_product_id)
    THEN RAISE EXCEPTION 'standard historical acknowledgement required'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER historical_standard_intent_protected BEFORE INSERT OR UPDATE OR DELETE ON historical_standard_intents
  FOR EACH ROW EXECUTE FUNCTION protect_historical_standard_intent();
CREATE TRIGGER historical_standard_intent_no_truncate BEFORE TRUNCATE ON historical_standard_intents
  FOR EACH STATEMENT EXECUTE FUNCTION protect_historical_standard_intent();

CREATE FUNCTION fence_historical_standard_input() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid INTEGER; h historical_standard_intents;
BEGIN
  IF TG_TABLE_NAME='products' THEN pid:=OLD.id; ELSE pid:=OLD.product_id; END IF;
  SELECT * INTO h FROM historical_standard_intents WHERE product_id=pid AND state NOT IN ('completed','cancelled') LIMIT 1;
  IF NOT FOUND THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
  -- Completion is the sole deliberate local participation change after receipt.
  IF TG_OP='UPDATE' AND current_setting('amber.historical_standard_apply',true)=h.id THEN
    IF TG_TABLE_NAME='products' THEN
      IF NEW.status='active' AND NEW.exclude_from_export=0 AND NEW.archived_by_user_id IS NULL
        AND (to_jsonb(NEW)-ARRAY['status','exclude_from_export','archived_by_user_id'])
          IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','exclude_from_export','archived_by_user_id']) THEN RETURN NEW; END IF;
    ELSIF TG_TABLE_NAME='product_full_export_state' THEN
      IF NEW.route='normal' AND NEW.business_exclusion_state='none' AND NEW.hold_reason IS NULL
        AND (to_jsonb(NEW)-ARRAY['route','business_exclusion_state','hold_reason','delivery_version','updated_at','evidence'])
          IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['route','business_exclusion_state','hold_reason','delivery_version','updated_at','evidence']) THEN RETURN NEW; END IF;
    ELSIF TG_TABLE_NAME='magento_product_sync_requests' THEN
      IF NEW.product_id=h.product_id AND NEW.desired_generation=COALESCE(h.request_generation,0)+1 THEN RETURN NEW; END IF;
    END IF;
  END IF;
  IF TG_TABLE_NAME='magento_product_sync_requests' AND TG_OP='UPDATE' THEN
    IF NEW.product_id=OLD.product_id AND NEW.desired_generation=OLD.desired_generation THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='HISTORICAL_STANDARD_PENDING'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER historical_standard_product_fence BEFORE UPDATE OR DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION fence_historical_standard_input();
CREATE TRIGGER historical_standard_lifecycle_fence BEFORE UPDATE OR DELETE ON product_full_export_state
  FOR EACH ROW EXECUTE FUNCTION fence_historical_standard_input();
CREATE TRIGGER historical_standard_request_fence BEFORE UPDATE OR DELETE ON magento_product_sync_requests
  FOR EACH ROW EXECUTE FUNCTION fence_historical_standard_input();

CREATE FUNCTION require_historical_standard_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h historical_standard_intents;
BEGIN
  PERFORM id FROM products WHERE id=NEW.product_id FOR KEY SHARE;
  SELECT * INTO h FROM historical_standard_intents WHERE public_product_identity_id=NEW.public_product_identity_id
    AND state NOT IN ('completed','cancelled') ORDER BY created_at DESC LIMIT 1;
  IF FOUND AND (NEW.product_id<>h.product_id OR NEW.sku<>h.public_sku OR NEW.origin_hash<>h.origin_hash
    OR NEW.binding_revision_id<>h.binding_revision_id OR NEW.plan_hash<>h.plan_hash OR NEW.intent->>'mode'<>h.delivery_mode
    OR NEW.created_by_user_id<>h.actor_user_id OR NEW.automatic_generation IS NOT NULL
    OR h.native_job_id IS NOT NULL AND NEW.id<>h.native_job_id
    OR (NEW.baseline->'raw'->>'id') IS DISTINCT FROM h.remote_product_id::text)
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='HISTORICAL_STANDARD_ORIGINAL_JOB_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER historical_standard_job_fence BEFORE INSERT ON magento_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION require_historical_standard_job();

CREATE FUNCTION fence_historical_standard_obligation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid INTEGER;
BEGIN
  IF TG_TABLE_NAME='product_corrections' THEN pid:=NEW.source_product_id; ELSE pid:=NEW.product_id; END IF;
  PERFORM id FROM products WHERE id=pid FOR KEY SHARE;
  IF EXISTS(SELECT 1 FROM historical_standard_intents WHERE product_id=pid AND state NOT IN ('completed','cancelled'))
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='HISTORICAL_STANDARD_PENDING'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER historical_standard_media_fence BEFORE INSERT ON product_media_jobs
  FOR EACH ROW EXECUTE FUNCTION fence_historical_standard_obligation();
CREATE TRIGGER historical_standard_visibility_fence BEFORE INSERT ON product_visibility_intents
  FOR EACH ROW EXECUTE FUNCTION fence_historical_standard_obligation();
CREATE TRIGGER historical_standard_deletion_fence BEFORE INSERT ON magento_test_deletions
  FOR EACH ROW EXECUTE FUNCTION fence_historical_standard_obligation();
CREATE TRIGGER historical_standard_correction_fence BEFORE INSERT ON product_corrections
  FOR EACH ROW EXECUTE FUNCTION fence_historical_standard_obligation();

-- Only this new protocol can deliberately retire its untouched manual job.
-- Prior ordinary jobs and every dispatched/verified/uncertain receipt retain
-- migration 044's exact supersession protection.
CREATE OR REPLACE FUNCTION guard_magento_sync_supersession() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state='superseded' OR (NEW.state='superseded' AND
    (OLD.automatic_generation IS NULL OR OLD.state IN ('uncertain','succeeded') OR
      EXISTS(SELECT 1 FROM magento_sync_steps WHERE job_id=OLD.id))) THEN
    IF OLD.state IN ('queued','running','retryable','blocked') AND NEW.state='superseded'
      AND OLD.automatic_generation IS NULL AND NOT EXISTS(SELECT 1 FROM magento_sync_steps WHERE job_id=OLD.id)
      AND EXISTS(SELECT 1 FROM historical_standard_intents h WHERE h.native_job_id=OLD.id AND h.state='cancelled'
        AND current_setting('amber.historical_standard_cancel',true)=h.id)
    THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Magento dispatch evidence requires reconciliation';
  END IF;
  RETURN NEW;
END $$;
