-- Separate destructive retirement; no remote calls or historical state changes.
ALTER TABLE products DROP CONSTRAINT products_status_allowed;
ALTER TABLE products ADD CONSTRAINT products_status_allowed
  CHECK (status IN ('active','archived','corrected','voided')) NOT VALID;

INSERT INTO permissions(permission_key,description) VALUES
  ('products.delete_test','Permanently delete an unused test product from Magento');
CREATE FUNCTION reserve_test_delete_permission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.permission_key='products.delete_test' AND NOT EXISTS
    (SELECT 1 FROM roles WHERE id=NEW.role_id AND role_key='administrator' AND is_system) THEN
    RAISE EXCEPTION 'products.delete_test is reserved for Administrator';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER test_delete_permission_reserved BEFORE INSERT OR UPDATE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION reserve_test_delete_permission();

CREATE TABLE magento_test_deletions (
  id UUID PRIMARY KEY,
  product_id INTEGER NOT NULL UNIQUE REFERENCES products(id) ON DELETE RESTRICT,
  public_product_identity_id BIGINT NOT NULL UNIQUE REFERENCES public_product_identities(id) ON DELETE RESTRICT,
  public_sku TEXT NOT NULL CHECK (public_sku ~ '^AG-[0-9]{6,}$'),
  internal_sku TEXT NOT NULL REFERENCES sku_registry(full_sku) ON DELETE RESTRICT,
  origin_hash TEXT NOT NULL CHECK (origin_hash ~ '^[a-f0-9]{64}$'),
  remote_product_id BIGINT NOT NULL CHECK (remote_product_id>0),
  create_job_id TEXT NOT NULL REFERENCES magento_sync_jobs(id) ON DELETE RESTRICT,
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  local_hash TEXT NOT NULL CHECK (local_hash ~ '^[a-f0-9]{64}$'),
  remote_hash TEXT NOT NULL CHECK (remote_hash ~ '^[a-f0-9]{64}$'),
  preview_hash TEXT NOT NULL CHECK (preview_hash ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL DEFAULT 'sealed' CHECK (state IN ('sealed','dispatched','verified','finalized')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dispatched_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  CHECK ((state IN ('verified','finalized')) = (verified_at IS NOT NULL)),
  CHECK ((state='finalized') = (finalized_at IS NOT NULL)),
  CHECK (state <> 'dispatched' OR dispatched_at IS NOT NULL)
);
CREATE FUNCTION validate_test_deletion_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state<>'sealed' OR num_nonnulls(NEW.dispatched_at,NEW.verified_at,NEW.finalized_at)<>0
    OR NOT EXISTS(SELECT 1 FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
      JOIN sku_registry r ON r.full_sku=p.full_sku AND r.first_product_id=p.id
      JOIN magento_sync_jobs j ON j.id=NEW.create_job_id
      WHERE p.id=NEW.product_id AND p.status='active' AND p.public_product_identity_id=NEW.public_product_identity_id
        AND i.origin='allocated' AND i.public_sku=NEW.public_sku AND p.full_sku=NEW.internal_sku
        AND j.product_id=p.id AND j.public_product_identity_id=i.id AND j.sku=i.public_sku
        AND j.origin_hash=NEW.origin_hash AND j.remote_product_id=NEW.remote_product_id
        AND j.state='succeeded' AND j.intent->>'mode'='create') THEN
    RAISE EXCEPTION 'test deletion requires exact allocated product and succeeded CREATE identity';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER test_deletion_identity BEFORE INSERT ON magento_test_deletions
  FOR EACH ROW EXECUTE FUNCTION validate_test_deletion_identity();
CREATE FUNCTION protect_test_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'test deletion evidence is permanent'; END IF;
  IF (to_jsonb(NEW)-ARRAY['state','dispatched_at','verified_at','finalized_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['state','dispatched_at','verified_at','finalized_at'])
    OR OLD.state='finalized'
    OR NOT ((OLD.state='sealed' AND NEW.state IN ('dispatched','verified'))
      OR (OLD.state='dispatched' AND NEW.state='verified')
      OR (OLD.state='verified' AND NEW.state='finalized'))
    OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
    OR (NEW.state<>'dispatched' AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
    OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS DISTINCT FROM OLD.verified_at) THEN
    RAISE EXCEPTION 'test deletion intent and progress are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER test_deletion_permanent BEFORE UPDATE OR DELETE ON magento_test_deletions
  FOR EACH ROW EXECUTE FUNCTION protect_test_deletion();
CREATE TRIGGER test_deletion_no_truncate BEFORE TRUNCATE ON magento_test_deletions
  FOR EACH STATEMENT EXECUTE FUNCTION protect_test_deletion();

-- Fence existing business writers for this identity; no transaction spans HTTP.
CREATE FUNCTION fence_test_deletion_product() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE deletion magento_test_deletions;
BEGIN
  SELECT * INTO deletion FROM magento_test_deletions WHERE public_product_identity_id=NEW.public_product_identity_id;
  IF FOUND THEN
    IF TG_OP='UPDATE' AND deletion.product_id=NEW.id AND deletion.state='verified'
      AND NEW.status='voided' AND NEW.exclude_from_export=1
      AND (to_jsonb(NEW)-ARRAY['status','exclude_from_export'])=(to_jsonb(OLD)-ARRAY['status','exclude_from_export']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'test deletion in progress or finalized; product is frozen' USING ERRCODE='P0050';
  END IF;
  IF NEW.status='voided' THEN RAISE EXCEPTION 'verified test deletion required'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zzz_test_deletion_product_fence BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION fence_test_deletion_product();

CREATE FUNCTION fence_test_deletion_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE deletion magento_test_deletions;
BEGIN
  SELECT * INTO deletion FROM magento_test_deletions WHERE product_id=NEW.product_id;
  IF FOUND AND NOT (deletion.state='verified' AND NEW.route='retired' AND NEW.hold_reason IS NULL
    AND NEW.delivery_version=OLD.delivery_version+1
    AND (to_jsonb(NEW)-ARRAY['route','hold_reason','delivery_version','updated_at'])=
        (to_jsonb(OLD)-ARRAY['route','hold_reason','delivery_version','updated_at'])) THEN
    RAISE EXCEPTION 'test deletion lifecycle is frozen' USING ERRCODE='P0050';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER test_deletion_lifecycle_fence BEFORE UPDATE ON product_full_export_state
  FOR EACH ROW EXECUTE FUNCTION fence_test_deletion_lifecycle();

CREATE FUNCTION fence_test_deletion_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id INTEGER; field_name TEXT;
BEGIN
  FOREACH field_name IN ARRAY TG_ARGV LOOP
    target_id := (to_jsonb(NEW)->>field_name)::integer;
    IF target_id IS NOT NULL THEN
      -- AFTER INSERT runs after the existing immediate FK's key-share lock.
      -- A sealing FOR UPDATE either waits for this insert, or this check sees
      -- the committed seal after the FK wait. No new product-after-state lock.
      IF EXISTS(SELECT 1 FROM magento_test_deletions WHERE product_id=target_id) THEN
        RAISE EXCEPTION 'test deletion product cannot acquire business evidence' USING ERRCODE='P0050';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER test_deletion_correction_fence AFTER INSERT ON correction_requests
  FOR EACH ROW EXECUTE FUNCTION fence_test_deletion_reference('source_product_id','corrected_product_id');
CREATE TRIGGER test_deletion_lineage_fence AFTER INSERT ON product_corrections
  FOR EACH ROW EXECUTE FUNCTION fence_test_deletion_reference('source_product_id','corrected_product_id');
CREATE TRIGGER test_deletion_export_fence AFTER INSERT ON export_snapshot_products
  FOR EACH ROW EXECUTE FUNCTION fence_test_deletion_reference('product_id');
CREATE TRIGGER test_deletion_price_fence AFTER INSERT ON product_export_revisions
  FOR EACH ROW EXECUTE FUNCTION fence_test_deletion_reference('product_id');
CREATE TRIGGER test_deletion_repricing_fence AFTER INSERT ON repricing_items
  FOR EACH ROW EXECUTE FUNCTION fence_test_deletion_reference('product_id');
-- Job enqueue already holds the shared origin/SKU session lock. Do not take a
-- second product lock here: manual jobs commit their ledger on another connection.
CREATE FUNCTION fence_test_deletion_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM magento_test_deletions WHERE public_product_identity_id=NEW.public_product_identity_id) THEN
    RAISE EXCEPTION 'test deletion blocks normal sync jobs' USING ERRCODE='P0050';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER test_deletion_job_fence BEFORE INSERT ON magento_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION fence_test_deletion_job();

ALTER TABLE magento_product_sync_requests DROP CONSTRAINT magento_product_sync_requests_state_check;
ALTER TABLE magento_product_sync_requests ADD CHECK
  (state IN ('pending','syncing','synced','needs_attention','voided'));
-- A distinct terminal state consumes no normal sync generation or fabricated job.
CREATE FUNCTION terminalize_test_deletion_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='voided' THEN
    UPDATE magento_product_sync_requests SET state='voided',reason_code=NULL,
      active_job_id=NULL,active_generation=NULL,diagnostics='[]'::jsonb,updated_at=CURRENT_TIMESTAMP
      WHERE public_product_identity_id=NEW.public_product_identity_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_test_deletion_request_terminal AFTER UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION terminalize_test_deletion_request();

CREATE FUNCTION validate_test_deletion_final_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id INTEGER;
BEGIN
  target_id:=NEW.product_id;
  IF (TG_TABLE_NAME='magento_test_deletions' AND NEW.state='finalized')
    OR (TG_TABLE_NAME='magento_product_sync_requests' AND NEW.state='voided') THEN
    IF NOT EXISTS(SELECT 1 FROM magento_test_deletions d JOIN products p ON p.id=d.product_id
      JOIN product_full_export_state f ON f.product_id=p.id
      WHERE p.id=target_id AND d.state='finalized' AND p.status='voided' AND p.exclude_from_export=1 AND f.route='retired')
      OR EXISTS(SELECT 1 FROM magento_product_sync_requests WHERE product_id=target_id AND state<>'voided') THEN
      RAISE EXCEPTION 'test deletion finalization must be atomic';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER test_deletion_final_state AFTER UPDATE ON magento_test_deletions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_test_deletion_final_state();
CREATE CONSTRAINT TRIGGER test_deletion_request_state AFTER INSERT OR UPDATE ON magento_product_sync_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_test_deletion_final_state();
