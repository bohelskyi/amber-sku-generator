-- Preserve native generation and permanent media receipts during sticky work.
-- This migration creates no obligation and performs no enrollment/remote write.
ALTER TABLE product_media_jobs DROP CONSTRAINT product_media_jobs_state_check;
ALTER TABLE product_media_jobs ADD CHECK (state IN ('pending','running','uncertain','blocked','succeeded','superseded'));
ALTER TABLE product_media_jobs DROP CONSTRAINT product_media_jobs_required_permission_check;
ALTER TABLE product_media_jobs ADD CHECK (required_permission IN ('products.create','products.recount','corrections.complete'));
ALTER TABLE product_media_jobs
  ADD COLUMN inherited_from_product_id BIGINT REFERENCES products(id),
  ADD COLUMN inherited_from_job_id UUID REFERENCES product_media_jobs(id),
  ADD COLUMN superseded_by_job_id UUID REFERENCES product_media_jobs(id);
ALTER TABLE product_media_jobs ADD CHECK ((inherited_from_product_id IS NULL)=(inherited_from_job_id IS NULL));
ALTER TABLE product_media_jobs ADD CHECK ((state='superseded')=(superseded_by_job_id IS NOT NULL));
CREATE INDEX product_media_identity_active_idx ON product_media_jobs(public_product_identity_id)
  WHERE state NOT IN ('succeeded','superseded');
DROP INDEX product_media_jobs_unfinished_idx;
CREATE UNIQUE INDEX product_media_jobs_unfinished_idx ON product_media_jobs(product_id) WHERE state NOT IN ('succeeded','superseded');

CREATE FUNCTION assert_product_media_native_input(identity_id BIGINT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM product_media_jobs j WHERE j.public_product_identity_id=identity_id
    AND j.state NOT IN ('succeeded','superseded') AND (j.native_generation IS NOT NULL
      OR EXISTS(SELECT 1 FROM product_media_steps s WHERE s.job_id=j.id))) THEN
    RAISE EXCEPTION 'PHOTO_MEDIA_RECONCILIATION_REQUIRED'
      USING ERRCODE='P0651',CONSTRAINT='product_media_native_input_fence';
  END IF;
END $$;
CREATE FUNCTION guard_product_media_native_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='products' THEN
    IF TG_OP='INSERT' AND NEW.corrected_from_product_id IS NULL THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND magento_sync_product_input(NEW) IS NOT DISTINCT FROM magento_sync_product_input(OLD) THEN RETURN NEW; END IF;
    PERFORM assert_product_media_native_input(NEW.public_product_identity_id);
  ELSE
    IF ROW(NEW.desired_generation,NEW.product_id,NEW.public_product_identity_id)
      IS NOT DISTINCT FROM ROW(OLD.desired_generation,OLD.product_id,OLD.public_product_identity_id) THEN RETURN NEW; END IF;
    PERFORM assert_product_media_native_input(OLD.public_product_identity_id);
    IF NEW.public_product_identity_id IS DISTINCT FROM OLD.public_product_identity_id THEN
      PERFORM assert_product_media_native_input(NEW.public_product_identity_id);
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- AFTER ensures the server-owned identity allocator has finished for a successor.
CREATE TRIGGER product_media_native_input_fence AFTER INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION guard_product_media_native_input();
CREATE TRIGGER product_media_native_request_fence BEFORE UPDATE ON magento_product_sync_requests
  FOR EACH ROW EXECUTE FUNCTION guard_product_media_native_input();

CREATE FUNCTION guard_product_media_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_job product_media_jobs; DECLARE successor_job product_media_jobs;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.required_permission='corrections.complete' AND NEW.inherited_from_product_id IS NULL THEN
      RAISE EXCEPTION 'Correction authority can only preserve an inherited photo set';
    END IF;
    IF NEW.inherited_from_product_id IS NOT NULL THEN
      SELECT * INTO source_job FROM product_media_jobs WHERE id=NEW.inherited_from_job_id;
      IF source_job.id IS NULL OR source_job.product_id<>NEW.inherited_from_product_id
        OR source_job.public_product_identity_id<>NEW.public_product_identity_id
        OR source_job.photo_ids IS DISTINCT FROM NEW.photo_ids OR source_job.enable_when_verified IS DISTINCT FROM NEW.enable_when_verified
        OR NEW.required_permission NOT IN ('products.recount','corrections.complete') OR NEW.version<>1
        OR NOT EXISTS(SELECT 1 FROM products p JOIN products predecessor ON predecessor.id=p.corrected_from_product_id
          JOIN product_photo_sets s ON s.product_id=predecessor.id
          WHERE p.id=NEW.product_id AND predecessor.id=NEW.inherited_from_product_id
            AND p.public_product_identity_id=NEW.public_product_identity_id AND predecessor.public_product_identity_id=p.public_product_identity_id
            AND predecessor.corrected_to_product_id=p.id AND predecessor.status='corrected'
            AND s.version=source_job.version AND s.photo_ids=NEW.photo_ids AND s.enable_when_verified=NEW.enable_when_verified)
        OR (source_job.state<>'succeeded' AND (source_job.state NOT IN ('pending','blocked')
          OR num_nonnulls(source_job.origin_hash,source_job.binding_revision_id,source_job.remote_product_id,source_job.native_generation,
            source_job.preservation,source_job.verified_at)<>0 OR EXISTS(SELECT 1 FROM product_media_steps WHERE job_id=source_job.id))) THEN
        RAISE EXCEPTION 'Photo inheritance requires the exact immutable predecessor gallery';
      END IF;
    END IF;
  ELSE
    IF OLD.state='superseded' OR ROW(NEW.inherited_from_product_id,NEW.inherited_from_job_id)
      IS DISTINCT FROM ROW(OLD.inherited_from_product_id,OLD.inherited_from_job_id)
      OR (OLD.superseded_by_job_id IS NOT NULL AND NEW.superseded_by_job_id IS DISTINCT FROM OLD.superseded_by_job_id) THEN
      RAISE EXCEPTION 'Photo lineage and supersession evidence are permanent';
    END IF;
    IF NEW.state='superseded' THEN
      SELECT * INTO successor_job FROM product_media_jobs WHERE id=NEW.superseded_by_job_id;
      IF OLD.state NOT IN ('pending','blocked') OR num_nonnulls(OLD.origin_hash,OLD.binding_revision_id,OLD.remote_product_id,
        OLD.native_generation,OLD.preservation,OLD.verified_at)<>0
        OR EXISTS(SELECT 1 FROM product_media_steps WHERE job_id=OLD.id)
        OR successor_job.id IS NULL OR successor_job.inherited_from_job_id IS DISTINCT FROM OLD.id
        OR successor_job.inherited_from_product_id IS DISTINCT FROM OLD.product_id
        OR successor_job.public_product_identity_id IS DISTINCT FROM OLD.public_product_identity_id
        OR successor_job.photo_ids IS DISTINCT FROM OLD.photo_ids OR successor_job.enable_when_verified IS DISTINCT FROM OLD.enable_when_verified THEN
        RAISE EXCEPTION 'Only an undispatched obligation with its permanent successor can be superseded';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER product_media_lineage_guard BEFORE INSERT OR UPDATE ON product_media_jobs
  FOR EACH ROW EXECUTE FUNCTION guard_product_media_lineage();
