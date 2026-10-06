-- Future deliberate archives only. No historical enrollment or remote operation.
CREATE TABLE product_visibility_intents (
  id TEXT PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  public_product_identity_id BIGINT NOT NULL REFERENCES public_product_identities(id) ON DELETE RESTRICT,
  public_sku TEXT NOT NULL,
  origin_hash TEXT NOT NULL CHECK (origin_hash ~ '^[a-f0-9]{64}$'),
  installation_key TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('hide','restore')),
  source_hide_id TEXT REFERENCES product_visibility_intents(id) ON DELETE RESTRICT,
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  previous_product JSONB NOT NULL CHECK (jsonb_typeof(previous_product)='object'),
  previous_lifecycle JSONB NOT NULL CHECK (jsonb_typeof(previous_lifecycle)='object'),
  local_fingerprint TEXT NOT NULL CHECK (local_fingerprint ~ '^[a-f0-9]{64}$'),
  remote_product_id BIGINT CHECK (remote_product_id > 0),
  target_status INTEGER CHECK (target_status IN (1,2)),
  previous_remote_status INTEGER CHECK (previous_remote_status IN (1,2)),
  expected_generation BIGINT CHECK (expected_generation > 0),
  state TEXT NOT NULL CHECK (state IN ('queued','blocked','dispatched','verified','superseded')),
  reason_code TEXT CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,99}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_checked_at TIMESTAMPTZ,
  dispatched_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  CHECK ((state='verified') = (verified_at IS NOT NULL)),
  CHECK (state NOT IN ('dispatched','verified') OR (remote_product_id IS NOT NULL AND target_status IS NOT NULL)),
  CHECK (kind<>'restore' OR (source_hide_id IS NOT NULL AND expected_generation IS NOT NULL))
);
CREATE UNIQUE INDEX product_visibility_unfinished ON product_visibility_intents(public_product_identity_id,origin_hash)
  WHERE state IN ('queued','dispatched');
CREATE INDEX product_visibility_product ON product_visibility_intents(product_id,created_at DESC,id);
CREATE FUNCTION protect_product_visibility_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Product visibility evidence is permanent'; END IF;
  IF (to_jsonb(NEW)-ARRAY['state','reason_code','previous_remote_status','dispatched_at','verified_at','last_checked_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','reason_code','previous_remote_status','dispatched_at','verified_at','last_checked_at'])
    OR OLD.state IN ('verified','superseded')
    OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
    OR (OLD.previous_remote_status IS NOT NULL AND NEW.previous_remote_status IS DISTINCT FROM OLD.previous_remote_status)
    OR (OLD.state='dispatched' AND NEW.state NOT IN ('dispatched','verified'))
    OR (NEW.state='superseded' AND (OLD.dispatched_at IS NOT NULL OR OLD.state<>'queued'))
    OR (NEW.state='dispatched' AND OLD.state NOT IN ('queued','dispatched'))
    OR (OLD.state='blocked' AND NEW.state NOT IN ('blocked','verified'))
    OR (NEW.dispatched_at IS NOT NULL AND NEW.state NOT IN ('dispatched','verified'))
    OR (NEW.state='dispatched' AND NEW.dispatched_at IS NULL)
  THEN RAISE EXCEPTION 'Product visibility intent or dispatch evidence cannot be rewritten'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER product_visibility_immutable BEFORE UPDATE OR DELETE ON product_visibility_intents
  FOR EACH ROW EXECUTE FUNCTION protect_product_visibility_intent();
CREATE TRIGGER product_visibility_no_truncate BEFORE TRUNCATE ON product_visibility_intents
  FOR EACH STATEMENT EXECUTE FUNCTION protect_product_visibility_intent();

CREATE TABLE product_restore_batches (
  id TEXT PRIMARY KEY,
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  review_hash TEXT NOT NULL CHECK (review_hash ~ '^[a-f0-9]{64}$'),
  review JSONB NOT NULL CHECK (jsonb_typeof(review)='object' AND octet_length(review::text)<=524288),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(actor_user_id,review_hash)
);
CREATE TABLE product_restore_items (
  batch_id TEXT NOT NULL REFERENCES product_restore_batches(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  public_sku TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('restored','error')),
  reason_code TEXT CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,99}$'),
  expected_generation BIGINT,
  visibility_intent_id TEXT REFERENCES product_visibility_intents(id) ON DELETE RESTRICT,
  restored_at TIMESTAMPTZ,
  PRIMARY KEY(batch_id,product_id),
  CHECK ((state='restored')=(restored_at IS NOT NULL))
);
CREATE FUNCTION protect_product_restore_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Product restore review and receipts are immutable'; END $$;
CREATE TRIGGER product_restore_batch_immutable BEFORE UPDATE OR DELETE ON product_restore_batches
  FOR EACH ROW EXECUTE FUNCTION protect_product_restore_receipt();
CREATE TRIGGER product_restore_batch_no_truncate BEFORE TRUNCATE ON product_restore_batches
  FOR EACH STATEMENT EXECUTE FUNCTION protect_product_restore_receipt();
CREATE TRIGGER product_restore_item_immutable BEFORE UPDATE OR DELETE ON product_restore_items
  FOR EACH ROW EXECUTE FUNCTION protect_product_restore_receipt();
CREATE TRIGGER product_restore_item_no_truncate BEFORE TRUNCATE ON product_restore_items
  FOR EACH STATEMENT EXECUTE FUNCTION protect_product_restore_receipt();
