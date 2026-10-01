-- Durable intent and dispatch ledger only. No jobs, publication or remote writes seeded.
CREATE TABLE magento_sync_jobs (
  id TEXT PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  sku TEXT NOT NULL,
  installation_key TEXT NOT NULL,
  origin_hash TEXT NOT NULL CHECK (origin_hash ~ '^[a-f0-9]{64}$'),
  binding_revision_id TEXT NOT NULL REFERENCES magento_binding_revisions(id) ON DELETE RESTRICT,
  binding_hash TEXT NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
  amber_hash TEXT NOT NULL CHECK (amber_hash ~ '^[a-f0-9]{64}$'),
  plan_hash TEXT NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  intent JSONB NOT NULL CHECK (jsonb_typeof(intent)='object' AND octet_length(intent::text) <= 1048576),
  baseline JSONB NOT NULL CHECK (jsonb_typeof(baseline)='object' AND octet_length(baseline::text) <= 1048576),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','retryable','blocked','uncertain','succeeded')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  remote_product_id BIGINT CHECK (remote_product_id > 0),
  failure JSONB,
  created_by_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  acknowledged_at TIMESTAMPTZ,
  UNIQUE (origin_hash, product_id, binding_revision_id, amber_hash),
  CHECK ((state='succeeded') = (acknowledged_at IS NOT NULL))
);
CREATE UNIQUE INDEX magento_sync_one_unfinished ON magento_sync_jobs(origin_hash, sku) WHERE state <> 'succeeded';
CREATE TABLE magento_sync_steps (
  job_id TEXT NOT NULL REFERENCES magento_sync_jobs(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  state TEXT NOT NULL CHECK (state IN ('dispatched','verified')),
  dispatched_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  PRIMARY KEY(job_id, ordinal),
  CHECK ((state='verified') = (verified_at IS NOT NULL))
);
CREATE FUNCTION guard_magento_sync_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'Magento sync evidence is permanent'; END IF;
  IF (to_jsonb(NEW) - ARRAY['state','attempts','remote_product_id','failure','updated_at','acknowledged_at'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','attempts','remote_product_id','failure','updated_at','acknowledged_at'])
    OR OLD.state='succeeded' OR NEW.attempts < OLD.attempts
    OR (OLD.remote_product_id IS NOT NULL AND NEW.remote_product_id IS DISTINCT FROM OLD.remote_product_id)
  THEN RAISE EXCEPTION 'Magento sync intent is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER magento_sync_job_guard BEFORE UPDATE OR DELETE ON magento_sync_jobs FOR EACH ROW EXECUTE FUNCTION guard_magento_sync_job();
CREATE TRIGGER magento_sync_job_no_truncate BEFORE TRUNCATE ON magento_sync_jobs FOR EACH STATEMENT EXECUTE FUNCTION guard_magento_sync_job();
CREATE FUNCTION guard_magento_sync_step() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'Magento sync dispatch evidence is permanent'; END IF;
  IF NEW.job_id <> OLD.job_id OR NEW.ordinal <> OLD.ordinal OR OLD.state='verified'
    OR NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at OR NEW.state <> 'verified'
  THEN RAISE EXCEPTION 'Magento sync dispatch cannot be reset'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER magento_sync_step_guard BEFORE UPDATE OR DELETE ON magento_sync_steps FOR EACH ROW EXECUTE FUNCTION guard_magento_sync_step();
CREATE TRIGGER magento_sync_step_no_truncate BEFORE TRUNCATE ON magento_sync_steps FOR EACH STATEMENT EXECUTE FUNCTION guard_magento_sync_step();
