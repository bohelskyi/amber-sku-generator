-- Durable, actor-owned original images. This migration sends no Magento request.
CREATE TABLE product_photo_assets (
  id UUID PRIMARY KEY,
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id),
  request_key UUID NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg','image/png')),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  content BYTEA NOT NULL CHECK (octet_length(content) BETWEEN 32 AND 5242880),
  product_id BIGINT REFERENCES products(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '24 hours'),
  UNIQUE(actor_user_id,request_key)
);
CREATE INDEX product_photo_assets_owner_idx ON product_photo_assets(actor_user_id) WHERE product_id IS NULL;
CREATE TABLE product_photo_sets (
  product_id BIGINT PRIMARY KEY REFERENCES products(id),
  version BIGINT NOT NULL CHECK (version > 0),
  photo_ids UUID[] NOT NULL CHECK (cardinality(photo_ids) <= 8),
  enable_when_verified BOOLEAN NOT NULL,
  CHECK (NOT enable_when_verified OR cardinality(photo_ids)>0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE product_media_jobs (
  id UUID PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id),
  public_product_identity_id BIGINT NOT NULL REFERENCES public_product_identities(id),
  version BIGINT NOT NULL CHECK (version > 0),
  photo_ids UUID[] NOT NULL CHECK (cardinality(photo_ids) <= 8),
  enable_when_verified BOOLEAN NOT NULL,
  CHECK (NOT enable_when_verified OR cardinality(photo_ids)>0),
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id),
  request_key UUID NOT NULL,
  required_permission TEXT NOT NULL CHECK (required_permission IN ('products.create','products.recount')),
  intent_hash TEXT NOT NULL CHECK (intent_hash ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','uncertain','blocked','succeeded')),
  origin_hash TEXT,
  binding_revision_id TEXT REFERENCES magento_binding_revisions(id),
  remote_product_id BIGINT,
  native_generation BIGINT,
  preservation JSONB,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  verified_at TIMESTAMPTZ,
  UNIQUE(product_id,version),
  UNIQUE(actor_user_id,request_key)
);
CREATE UNIQUE INDEX product_media_jobs_unfinished_idx ON product_media_jobs(product_id) WHERE state <> 'succeeded';
CREATE INDEX product_media_jobs_pending_idx ON product_media_jobs(created_at) WHERE state IN ('pending','running');
CREATE TABLE product_media_steps (
  job_id UUID NOT NULL REFERENCES product_media_jobs(id),
  step_key TEXT NOT NULL CHECK (length(step_key) BETWEEN 1 AND 100),
  operation_hash TEXT NOT NULL CHECK (operation_hash ~ '^[a-f0-9]{64}$'),
  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  verified_at TIMESTAMPTZ,
  remote_entry_id BIGINT,
  CHECK (verified_at IS NULL OR verified_at >= dispatched_at),
  PRIMARY KEY(job_id,step_key)
);
CREATE FUNCTION guard_product_photo_asset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'Photo original and ownership are permanent'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
    OR NEW.request_key IS DISTINCT FROM OLD.request_key OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
    OR NEW.mime_type IS DISTINCT FROM OLD.mime_type OR NEW.display_name IS DISTINCT FROM OLD.display_name
    OR NEW.content IS DISTINCT FROM OLD.content OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR (OLD.product_id IS NOT NULL AND NEW.product_id IS DISTINCT FROM OLD.product_id) THEN
    RAISE EXCEPTION 'Photo original and ownership are permanent';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER product_photo_asset_guard BEFORE UPDATE OR DELETE ON product_photo_assets
FOR EACH ROW EXECUTE FUNCTION guard_product_photo_asset();
CREATE FUNCTION guard_product_media_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'Media evidence is permanent'; END IF;
  IF TG_TABLE_NAME='product_media_jobs' THEN
    IF ROW(NEW.id,NEW.product_id,NEW.public_product_identity_id,NEW.version,NEW.photo_ids,NEW.enable_when_verified,
      NEW.actor_user_id,NEW.request_key,NEW.required_permission,NEW.intent_hash,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.product_id,OLD.public_product_identity_id,OLD.version,OLD.photo_ids,OLD.enable_when_verified,
      OLD.actor_user_id,OLD.request_key,OLD.required_permission,OLD.intent_hash,OLD.created_at)
      OR (OLD.origin_hash IS NOT NULL AND NEW.origin_hash IS DISTINCT FROM OLD.origin_hash)
      OR (OLD.binding_revision_id IS NOT NULL AND NEW.binding_revision_id IS DISTINCT FROM OLD.binding_revision_id)
      OR (OLD.remote_product_id IS NOT NULL AND NEW.remote_product_id IS DISTINCT FROM OLD.remote_product_id)
      OR (OLD.native_generation IS NOT NULL AND NEW.native_generation IS DISTINCT FROM OLD.native_generation)
      OR (OLD.preservation IS NOT NULL AND NEW.preservation IS DISTINCT FROM OLD.preservation)
      OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS DISTINCT FROM OLD.verified_at)
      OR (OLD.state='succeeded' AND NEW.state <> 'succeeded') THEN RAISE EXCEPTION 'Immutable media intent'; END IF;
  ELSE
    IF ROW(NEW.job_id,NEW.step_key,NEW.operation_hash,NEW.dispatched_at)
      IS DISTINCT FROM ROW(OLD.job_id,OLD.step_key,OLD.operation_hash,OLD.dispatched_at)
      OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS DISTINCT FROM OLD.verified_at)
      OR (OLD.remote_entry_id IS NOT NULL AND NEW.remote_entry_id IS DISTINCT FROM OLD.remote_entry_id)
      THEN RAISE EXCEPTION 'Immutable media dispatch evidence'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER product_media_jobs_guard BEFORE UPDATE OR DELETE ON product_media_jobs
FOR EACH ROW EXECUTE FUNCTION guard_product_media_evidence();
CREATE TRIGGER product_media_steps_guard BEFORE UPDATE OR DELETE ON product_media_steps
FOR EACH ROW EXECUTE FUNCTION guard_product_media_evidence();
CREATE TRIGGER product_photo_assets_no_truncate BEFORE TRUNCATE ON product_photo_assets
FOR EACH STATEMENT EXECUTE FUNCTION guard_product_photo_asset();
CREATE TRIGGER product_media_jobs_no_truncate BEFORE TRUNCATE ON product_media_jobs
FOR EACH STATEMENT EXECUTE FUNCTION guard_product_media_evidence();
CREATE TRIGGER product_media_steps_no_truncate BEFORE TRUNCATE ON product_media_steps
FOR EACH STATEMENT EXECUTE FUNCTION guard_product_media_evidence();
