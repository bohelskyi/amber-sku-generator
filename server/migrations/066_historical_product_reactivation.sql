-- Explicit future Administrator decisions only; no history enrollment/backfill.
CREATE TABLE historical_reactivation_batches (
  id TEXT PRIMARY KEY CHECK(id ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  review JSONB NOT NULL CHECK(jsonb_typeof(review)='object' AND octet_length(review::text)<=1048576),
  selected_skus JSONB NOT NULL CHECK(jsonb_typeof(selected_skus)='array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE historical_reactivation_intents (
  id TEXT PRIMARY KEY CHECK(id ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
  batch_id TEXT NOT NULL REFERENCES historical_reactivation_batches(id) ON DELETE RESTRICT,
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  public_product_identity_id BIGINT NOT NULL REFERENCES public_product_identities(id) ON DELETE RESTRICT,
  public_sku TEXT NOT NULL,
  origin_hash TEXT NOT NULL CHECK(origin_hash ~ '^[a-f0-9]{64}$'),
  installation_key TEXT NOT NULL,
  binding_revision_id TEXT NOT NULL REFERENCES magento_binding_revisions(id) ON DELETE RESTRICT,
  binding_hash TEXT NOT NULL CHECK(binding_hash ~ '^[a-f0-9]{64}$'),
  local_fingerprint TEXT NOT NULL CHECK(local_fingerprint ~ '^[a-f0-9]{64}$'),
  current_facts JSONB NOT NULL CHECK(jsonb_typeof(current_facts)='object'
    AND current_facts->>'priorFacts'='unknown' AND current_facts->>'newDecision'='participate_hidden_update'
    AND current_facts->>'deliveryPlanHash' ~ '^[a-f0-9]{64}$'),
  remote_product_id BIGINT NOT NULL CHECK(remote_product_id>0),
  remote_fingerprint TEXT NOT NULL CHECK(remote_fingerprint ~ '^[a-f0-9]{64}$'),
  initial_remote_status INTEGER NOT NULL CHECK(initial_remote_status IN (1,2)),
  target_status INTEGER NOT NULL DEFAULT 2 CHECK(target_status=2),
  request_generation BIGINT,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','dispatched','blocked','awaiting_native','completed')),
  reason_code TEXT CHECK(reason_code ~ '^[A-Z][A-Z0-9_]{0,99}$'),
  dispatched_at TIMESTAMPTZ,
  hidden_verified_at TIMESTAMPTZ,
  local_activated_at TIMESTAMPTZ,
  expected_generation BIGINT CHECK(expected_generation>0),
  native_job_id TEXT REFERENCES magento_sync_jobs(id) ON DELETE RESTRICT,
  native_confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_checked_at TIMESTAMPTZ,
  UNIQUE(batch_id,product_id),
  CHECK((state IN ('awaiting_native','completed'))=(hidden_verified_at IS NOT NULL)),
  CHECK((hidden_verified_at IS NOT NULL)=(local_activated_at IS NOT NULL)),
  CHECK((hidden_verified_at IS NOT NULL)=(expected_generation IS NOT NULL)),
  CHECK((state='completed')=(native_confirmed_at IS NOT NULL)),
  CHECK(state<>'dispatched' OR dispatched_at IS NOT NULL),
  CHECK(state<>'completed' OR native_job_id IS NOT NULL)
);
CREATE UNIQUE INDEX historical_reactivation_unfinished ON historical_reactivation_intents(public_product_identity_id,origin_hash)
  WHERE state IN ('queued','dispatched','awaiting_native');
CREATE INDEX historical_reactivation_current ON historical_reactivation_intents(public_product_identity_id,origin_hash,created_at DESC,id);
CREATE FUNCTION protect_historical_reactivation_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Historical reactivation review and request evidence is permanent'; END $$;
CREATE TRIGGER historical_reactivation_batch_immutable BEFORE UPDATE OR DELETE ON historical_reactivation_batches
  FOR EACH ROW EXECUTE FUNCTION protect_historical_reactivation_batch();
CREATE TRIGGER historical_reactivation_batch_no_truncate BEFORE TRUNCATE ON historical_reactivation_batches
  FOR EACH STATEMENT EXECUTE FUNCTION protect_historical_reactivation_batch();
CREATE FUNCTION protect_historical_reactivation_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'queued' OR NEW.dispatched_at IS NOT NULL OR NEW.hidden_verified_at IS NOT NULL
      OR NEW.local_activated_at IS NOT NULL OR NEW.expected_generation IS NOT NULL OR NEW.native_job_id IS NOT NULL
      OR NEW.native_confirmed_at IS NOT NULL OR NEW.reason_code IS NOT NULL
      OR NOT EXISTS(SELECT 1 FROM historical_reactivation_batches b WHERE b.id=NEW.batch_id
        AND b.actor_user_id=NEW.actor_user_id AND b.selected_skus ? NEW.public_sku)
      OR NOT EXISTS(SELECT 1 FROM products p JOIN public_product_identities pi ON pi.id=p.public_product_identity_id
        WHERE p.id=NEW.product_id AND p.public_product_identity_id=NEW.public_product_identity_id
          AND pi.public_sku=NEW.public_sku AND p.status='archived' AND p.corrected_to_product_id IS NULL)
    THEN RAISE EXCEPTION 'Historical intent requires a new reviewed archived target'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Historical reactivation evidence is permanent'; END IF;
  IF (to_jsonb(NEW)-ARRAY['state','reason_code','dispatched_at','hidden_verified_at','local_activated_at','expected_generation','native_job_id','native_confirmed_at','last_checked_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','reason_code','dispatched_at','hidden_verified_at','local_activated_at','expected_generation','native_job_id','native_confirmed_at','last_checked_at'])
    OR OLD.state='completed'
    OR OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at
    OR OLD.hidden_verified_at IS NOT NULL AND NEW.hidden_verified_at IS DISTINCT FROM OLD.hidden_verified_at
    OR OLD.local_activated_at IS NOT NULL AND NEW.local_activated_at IS DISTINCT FROM OLD.local_activated_at
    OR OLD.expected_generation IS NOT NULL AND NEW.expected_generation IS DISTINCT FROM OLD.expected_generation
    OR OLD.native_job_id IS NOT NULL AND NEW.native_job_id IS DISTINCT FROM OLD.native_job_id
    OR OLD.state='dispatched' AND NEW.state NOT IN ('dispatched','awaiting_native')
    OR OLD.state='awaiting_native' AND NEW.state NOT IN ('awaiting_native','completed')
    OR OLD.state='blocked' AND NEW.state NOT IN ('blocked','awaiting_native')
    OR NEW.state='dispatched' AND OLD.state NOT IN ('queued','dispatched')
    OR NEW.dispatched_at IS NOT NULL AND NEW.state='blocked'
    OR NEW.state='completed' AND OLD.state<>'awaiting_native'
    OR NEW.state='queued' AND OLD.state<>'queued'
  THEN RAISE EXCEPTION 'Historical reactivation intent or dispatch proof cannot be rewritten'; END IF;
  IF NEW.state='completed' AND NOT EXISTS(SELECT 1 FROM magento_sync_jobs j WHERE j.id=NEW.native_job_id
    AND j.product_id=NEW.product_id AND j.public_product_identity_id=NEW.public_product_identity_id
    AND j.origin_hash=NEW.origin_hash AND j.binding_revision_id=NEW.binding_revision_id
    AND j.sku=NEW.public_sku AND j.remote_product_id=NEW.remote_product_id AND j.state='succeeded'
    AND j.acknowledged_at=NEW.native_confirmed_at AND j.automatic_generation=NEW.expected_generation
    AND j.intent->>'mode'='update') THEN RAISE EXCEPTION 'Exact historical UPDATE acknowledgement required'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER historical_reactivation_immutable BEFORE INSERT OR UPDATE OR DELETE ON historical_reactivation_intents
  FOR EACH ROW EXECUTE FUNCTION protect_historical_reactivation_intent();
CREATE TRIGGER historical_reactivation_no_truncate BEFORE TRUNCATE ON historical_reactivation_intents
  FOR EACH STATEMENT EXECUTE FUNCTION protect_historical_reactivation_intent();

-- A queued/dispatched new decision cannot lose its current-fact/generation proof
-- through another local writer. Installation creates no decision or reservation.
CREATE FUNCTION fence_historical_reactivation_input() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid INTEGER; i historical_reactivation_intents; own_apply BOOLEAN;
BEGIN
  IF TG_TABLE_NAME='products' THEN pid:=OLD.id; ELSE pid:=OLD.product_id; END IF;
  SELECT * INTO i FROM historical_reactivation_intents h WHERE h.product_id=pid
    AND h.state IN ('queued','dispatched','awaiting_native') ORDER BY h.created_at DESC,h.id LIMIT 1;
  IF NOT FOUND THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  own_apply:=current_setting('amber.historical_reactivation_apply',true)=i.id AND i.state='awaiting_native';
  IF TG_TABLE_NAME='magento_product_sync_requests' AND TG_OP='UPDATE' THEN
    IF NEW.product_id=OLD.product_id AND NEW.desired_generation=OLD.desired_generation THEN RETURN NEW; END IF;
    IF own_apply AND NEW.product_id=i.product_id AND NEW.desired_generation=i.expected_generation THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='products' THEN
    IF TG_OP='UPDATE' AND own_apply AND NEW.status='active' AND NEW.exclude_from_export=0 AND NEW.archived_by_user_id IS NULL
      AND (to_jsonb(NEW)-ARRAY['status','exclude_from_export','archived_by_user_id'])
        IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','exclude_from_export','archived_by_user_id']) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='product_full_export_state' THEN
    IF TG_OP='UPDATE' AND own_apply AND NEW.route='normal' AND NEW.business_exclusion_state='none' AND NEW.hold_reason IS NULL
      AND (to_jsonb(NEW)-ARRAY['route','business_exclusion_state','hold_reason','delivery_version','updated_at','evidence'])
        IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['route','business_exclusion_state','hold_reason','delivery_version','updated_at','evidence']) THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='HISTORICAL_REACTIVATION_PENDING'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER historical_reactivation_product_fence BEFORE UPDATE OR DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION fence_historical_reactivation_input();
CREATE TRIGGER historical_reactivation_lifecycle_fence BEFORE UPDATE OR DELETE ON product_full_export_state
  FOR EACH ROW EXECUTE FUNCTION fence_historical_reactivation_input();
CREATE TRIGGER historical_reactivation_request_fence BEFORE UPDATE OR DELETE ON magento_product_sync_requests
  FOR EACH ROW EXECUTE FUNCTION fence_historical_reactivation_input();

CREATE FUNCTION require_historical_update_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i historical_reactivation_intents;
BEGIN
  -- Compatible with a manual guard's outer NO KEY UPDATE while its separate
  -- ledger connection inserts. Historical enrollment takes FOR UPDATE, so
  -- this FK-strength barrier precedes the fresh historical proof query.
  PERFORM id FROM products WHERE id=NEW.product_id FOR KEY SHARE;
  SELECT * INTO i FROM historical_reactivation_intents h WHERE h.public_product_identity_id=NEW.public_product_identity_id
    AND h.origin_hash=NEW.origin_hash AND h.state IN ('queued','dispatched','awaiting_native','completed') ORDER BY h.created_at DESC,h.id DESC LIMIT 1;
  IF FOUND AND i.state IN ('queued','dispatched') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='HISTORICAL_REACTIVATION_PENDING';
  END IF;
  IF FOUND AND (NEW.intent->>'mode' IS DISTINCT FROM 'update'
    OR NEW.baseline->'raw'->>'sku' IS DISTINCT FROM i.public_sku
    OR NEW.baseline->'raw'->>'id' IS DISTINCT FROM i.remote_product_id::text
    OR i.state='awaiting_native' AND NEW.automatic_generation IS DISTINCT FROM i.expected_generation)
  THEN RAISE EXCEPTION 'Historical identity requires exact pinned UPDATE job'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER historical_reactivation_update_only BEFORE INSERT ON magento_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION require_historical_update_job();

CREATE FUNCTION fence_historical_reactivation_obligation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid INTEGER;
BEGIN
  IF TG_TABLE_NAME='product_corrections' THEN pid:=NEW.source_product_id; ELSE pid:=NEW.product_id; END IF;
  PERFORM id FROM products WHERE id=pid FOR NO KEY UPDATE;
  IF EXISTS(SELECT 1 FROM historical_reactivation_intents h JOIN products p ON p.public_product_identity_id=h.public_product_identity_id
    WHERE p.id=pid AND h.state IN ('queued','dispatched','awaiting_native'))
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='HISTORICAL_REACTIVATION_PENDING'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER historical_reactivation_media_fence BEFORE INSERT ON product_media_jobs
  FOR EACH ROW EXECUTE FUNCTION fence_historical_reactivation_obligation();
CREATE TRIGGER historical_reactivation_visibility_fence BEFORE INSERT ON product_visibility_intents
  FOR EACH ROW EXECUTE FUNCTION fence_historical_reactivation_obligation();
CREATE TRIGGER historical_reactivation_deletion_fence BEFORE INSERT ON magento_test_deletions
  FOR EACH ROW EXECUTE FUNCTION fence_historical_reactivation_obligation();
CREATE TRIGGER historical_reactivation_correction_fence BEFORE INSERT ON product_corrections
  FOR EACH ROW EXECUTE FUNCTION fence_historical_reactivation_obligation();
