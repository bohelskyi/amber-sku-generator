-- Single reviewed remote configuration mutations. No discovery reports or seeds.
CREATE TABLE magento_configuration_actions (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind='category'),
  origin_hash TEXT NOT NULL CHECK (origin_hash ~ '^[a-f0-9]{64}$'),
  resource_key TEXT NOT NULL CHECK (resource_key ~ '^[a-f0-9]{64}$'),
  binding_revision_id TEXT NOT NULL REFERENCES magento_binding_revisions(id) ON DELETE RESTRICT,
  binding_revision BIGINT NOT NULL CHECK (binding_revision>0),
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  preview_hash TEXT NOT NULL CHECK (preview_hash ~ '^[a-f0-9]{64}$'),
  intent JSONB NOT NULL CHECK (jsonb_typeof(intent)='object' AND octet_length(intent::text)<=32768),
  state TEXT NOT NULL DEFAULT 'sealed' CHECK (state IN ('sealed','dispatched','returned','verified')),
  remote_id TEXT CHECK (remote_id ~ '^[1-9][0-9]*$'),
  verification JSONB CHECK (jsonb_typeof(verification)='object' AND octet_length(verification::text)<=32768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dispatched_at TIMESTAMPTZ,
  returned_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  UNIQUE(origin_hash,kind,resource_key),
  CHECK ((state<>'sealed')=(dispatched_at IS NOT NULL)),
  CHECK ((state IN ('returned','verified'))=(returned_at IS NOT NULL)),
  CHECK ((state IN ('returned','verified'))=(remote_id IS NOT NULL)),
  CHECK ((state='verified')=(verified_at IS NOT NULL)),
  CHECK ((state='verified')=(verification IS NOT NULL))
);
CREATE FUNCTION protect_magento_configuration_action() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'sealed' OR num_nonnulls(NEW.remote_id,NEW.verification,NEW.dispatched_at,NEW.returned_at,NEW.verified_at)<>0 THEN
      RAISE EXCEPTION 'configuration action must start sealed';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'configuration action evidence is permanent'; END IF;
  IF (to_jsonb(NEW)-ARRAY['state','remote_id','verification','dispatched_at','returned_at','verified_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['state','remote_id','verification','dispatched_at','returned_at','verified_at'])
    OR NOT ((OLD.state='sealed' AND NEW.state='dispatched') OR (OLD.state='dispatched' AND NEW.state='returned')
      OR (OLD.state='returned' AND NEW.state='verified'))
    OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
    OR (OLD.returned_at IS NOT NULL AND NEW.returned_at IS DISTINCT FROM OLD.returned_at)
    OR (OLD.remote_id IS NOT NULL AND NEW.remote_id IS DISTINCT FROM OLD.remote_id) THEN
    RAISE EXCEPTION 'configuration intent and confirmed progress are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER magento_configuration_action_guard BEFORE INSERT OR UPDATE OR DELETE ON magento_configuration_actions
  FOR EACH ROW EXECUTE FUNCTION protect_magento_configuration_action();
CREATE TRIGGER magento_configuration_action_no_truncate BEFORE TRUNCATE ON magento_configuration_actions
  FOR EACH STATEMENT EXECUTE FUNCTION protect_magento_configuration_action();
