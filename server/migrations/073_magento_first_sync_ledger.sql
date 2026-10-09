-- Durable first-sync evidence only. No enrollment, product changes, remote I/O,
-- confirmed/synced stamps, history backfill or outward-gate activation.
CREATE TABLE magento_first_sync_sessions (
  id UUID PRIMARY KEY,
  origin_hash TEXT NOT NULL CHECK (origin_hash ~ '^[a-f0-9]{64}$'),
  public_product_identity_id BIGINT NOT NULL REFERENCES public_product_identities(id) ON DELETE RESTRICT,
  installation_key TEXT NOT NULL CHECK (installation_key ~ '^[a-z][a-z0-9_-]{0,79}$'),
  public_sku TEXT NOT NULL CHECK (length(public_sku) BETWEEN 1 AND 255 AND public_sku=btrim(public_sku)),
  remote_product_id BIGINT NOT NULL CHECK (remote_product_id>0),
  initial_product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  initial_binding_revision_id TEXT NOT NULL REFERENCES magento_binding_revisions(id) ON DELETE RESTRICT,
  initial_contract_version TEXT NOT NULL CHECK (length(initial_contract_version) BETWEEN 1 AND 160),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision>=0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  UNIQUE(origin_hash,public_product_identity_id),
  UNIQUE(origin_hash,remote_product_id)
);
CREATE TABLE magento_first_sync_progress (
  session_id UUID NOT NULL REFERENCES magento_first_sync_sessions(id) ON DELETE RESTRICT,
  revision BIGINT NOT NULL CHECK (revision>0),
  preview_hash TEXT NOT NULL CHECK (preview_hash ~ '^[a-f0-9]{64}$'),
  command_hash TEXT NOT NULL CHECK (command_hash ~ '^[a-f0-9]{64}$'),
  command JSONB NOT NULL CHECK (jsonb_typeof(command)='object' AND octet_length(command::text)<=1048576),
  result JSONB NOT NULL CHECK (jsonb_typeof(result)='object' AND octet_length(result::text)<=1048576),
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  audit_event_id BIGINT NOT NULL UNIQUE REFERENCES audit_events(id) ON DELETE RESTRICT,
  completed BOOLEAN NOT NULL,
  transaction_id BIGINT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(session_id,revision),
  UNIQUE(session_id,preview_hash)
);
ALTER TABLE magento_first_sync_sessions ADD CONSTRAINT first_sync_current_receipt
  FOREIGN KEY(id,revision) REFERENCES magento_first_sync_progress(session_id,revision)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE magento_first_sync_fields (
  session_id UUID NOT NULL,
  revision BIGINT NOT NULL,
  target TEXT NOT NULL CHECK (target ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
  scope TEXT NOT NULL CHECK (scope ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
  state TEXT NOT NULL CHECK (state IN ('imported','equal','optional_empty','outward_verified','name_received',
    'conflict','unknown','pending_outward_confirmation','review_required')),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=1048576),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(session_id,revision,target,scope),
  FOREIGN KEY(session_id,revision) REFERENCES magento_first_sync_progress(session_id,revision) ON DELETE RESTRICT
);
CREATE INDEX first_sync_latest_fields ON magento_first_sync_fields(session_id,target,scope,revision DESC);

CREATE FUNCTION guard_first_sync_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p products; i public_product_identities; b magento_binding_revisions;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'FIRST_SYNC_SESSION_PERMANENT'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT * INTO p FROM products WHERE id=NEW.initial_product_id;
    SELECT * INTO i FROM public_product_identities WHERE id=NEW.public_product_identity_id;
    SELECT * INTO b FROM magento_binding_revisions WHERE id=NEW.initial_binding_revision_id;
    IF NEW.revision<>0 OR NEW.completed_at IS NOT NULL
      OR p.public_product_identity_id IS DISTINCT FROM NEW.public_product_identity_id
      OR i.public_sku IS DISTINCT FROM NEW.public_sku
      OR b.origin_hash IS DISTINCT FROM NEW.origin_hash
      OR b.installation_key IS DISTINCT FROM NEW.installation_key OR b.state IS DISTINCT FROM 'published' THEN
      RAISE EXCEPTION 'FIRST_SYNC_IDENTITY_INVALID';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['revision','completed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','completed_at'])
      OR OLD.completed_at IS NOT NULL OR NEW.revision<>OLD.revision+1 THEN
      RAISE EXCEPTION 'FIRST_SYNC_SESSION_IMMUTABLE';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER first_sync_session_guard BEFORE INSERT OR UPDATE OR DELETE ON magento_first_sync_sessions
  FOR EACH ROW EXECUTE FUNCTION guard_first_sync_session();
CREATE TRIGGER first_sync_session_no_truncate BEFORE TRUNCATE ON magento_first_sync_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION guard_first_sync_session();

CREATE FUNCTION guard_first_sync_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session magento_first_sync_sessions; progress magento_first_sync_progress;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'FIRST_SYNC_EVIDENCE_IMMUTABLE'; END IF;
  SELECT * INTO session FROM magento_first_sync_sessions WHERE id=NEW.session_id FOR UPDATE;
  IF session.id IS NULL OR session.completed_at IS NOT NULL OR NEW.revision<>session.revision+1 THEN
    RAISE EXCEPTION 'FIRST_SYNC_REVISION_CONFLICT';
  END IF;
  IF TG_TABLE_NAME='magento_first_sync_progress' THEN
    IF NEW.transaction_id<>txid_current() THEN RAISE EXCEPTION 'FIRST_SYNC_TRANSACTION_REQUIRED'; END IF;
  ELSE
    SELECT * INTO progress FROM magento_first_sync_progress WHERE session_id=NEW.session_id AND revision=NEW.revision;
    IF progress.transaction_id IS DISTINCT FROM txid_current()
      OR NEW.evidence->>'target' IS DISTINCT FROM NEW.target OR NEW.evidence->>'scope' IS DISTINCT FROM NEW.scope
      OR NEW.evidence->>'state' IS DISTINCT FROM NEW.state
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(progress.command->'fields') field WHERE field=NEW.evidence) THEN
      RAISE EXCEPTION 'FIRST_SYNC_FIELD_EVIDENCE_INVALID';
    END IF;
    IF EXISTS(SELECT 1 FROM magento_first_sync_fields f WHERE f.session_id=NEW.session_id
      AND f.target=NEW.target AND f.scope=NEW.scope
      AND f.state IN ('imported','equal','optional_empty','outward_verified','name_received')) THEN
      RAISE EXCEPTION 'FIRST_SYNC_TERMINAL_PERMANENT';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER first_sync_progress_guard BEFORE INSERT OR UPDATE OR DELETE ON magento_first_sync_progress
  FOR EACH ROW EXECUTE FUNCTION guard_first_sync_evidence();
CREATE TRIGGER first_sync_progress_no_truncate BEFORE TRUNCATE ON magento_first_sync_progress
  FOR EACH STATEMENT EXECUTE FUNCTION guard_first_sync_evidence();
CREATE TRIGGER first_sync_field_guard BEFORE INSERT OR UPDATE OR DELETE ON magento_first_sync_fields
  FOR EACH ROW EXECUTE FUNCTION guard_first_sync_evidence();
CREATE TRIGGER first_sync_field_no_truncate BEFORE TRUNCATE ON magento_first_sync_fields
  FOR EACH STATEMENT EXECUTE FUNCTION guard_first_sync_evidence();

CREATE FUNCTION require_first_sync_progress() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session magento_first_sync_sessions; event audit_events;
BEGIN
  SELECT * INTO session FROM magento_first_sync_sessions WHERE id=NEW.session_id;
  SELECT * INTO event FROM audit_events WHERE id=NEW.audit_event_id;
  IF session.revision<NEW.revision OR NEW.transaction_id<>txid_current()
    OR event.actor_user_id IS DISTINCT FROM NEW.actor_user_id
    OR event.event_key IS DISTINCT FROM 'magento.first_sync_progress_recorded'
    OR event.subject_type IS DISTINCT FROM 'magento_first_sync'
    OR event.subject_id IS DISTINCT FROM NEW.session_id::text
    OR event.details->>'revision' IS DISTINCT FROM NEW.revision::text
    OR event.details->>'previewHash' IS DISTINCT FROM NEW.preview_hash
    OR event.details->>'commandHash' IS DISTINCT FROM NEW.command_hash
    OR event.details->'result' IS DISTINCT FROM NEW.result
    OR NEW.result->>'revision' IS DISTINCT FROM NEW.revision::text
    OR NEW.result->>'sessionId' IS DISTINCT FROM NEW.session_id::text
    OR (NEW.result->>'completed')::boolean IS DISTINCT FROM NEW.completed
    OR (NEW.command->>'complete')::boolean IS DISTINCT FROM NEW.completed
    OR jsonb_array_length(NEW.command->'fields')>500
    OR jsonb_array_length(NEW.result->'changedFields') IS DISTINCT FROM
      (SELECT count(*)::integer FROM magento_first_sync_fields WHERE session_id=NEW.session_id AND revision=NEW.revision)
    OR (SELECT count(*) FROM (SELECT DISTINCT target,scope FROM magento_first_sync_fields WHERE session_id=NEW.session_id) fields)>500 THEN
    RAISE EXCEPTION 'FIRST_SYNC_PROGRESS_INCOMPLETE';
  END IF;
  IF NEW.completed THEN
    IF session.completed_at IS DISTINCT FROM NEW.recorded_at OR session.revision<>NEW.revision
      OR jsonb_array_length(NEW.command->'requiredScopes') IS NULL OR jsonb_array_length(NEW.command->'requiredScopes')=0
      OR EXISTS(SELECT 1 FROM (
        SELECT DISTINCT ON(target,scope) state FROM magento_first_sync_fields
        WHERE session_id=NEW.session_id AND revision<=NEW.revision ORDER BY target,scope,revision DESC
      ) fields WHERE state NOT IN ('imported','equal','optional_empty','outward_verified','name_received'))
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.command->'requiredScopes') needed WHERE NOT EXISTS(
        SELECT 1 FROM magento_first_sync_fields f WHERE f.session_id=NEW.session_id AND f.revision<=NEW.revision
          AND f.target=needed->>'target' AND f.scope=needed->>'scope'
          AND f.state IN ('imported','equal','optional_empty','outward_verified','name_received'))) THEN
      RAISE EXCEPTION 'FIRST_SYNC_COMPLETION_UNPROVEN';
    END IF;
  ELSIF session.revision=NEW.revision AND session.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'FIRST_SYNC_COMPLETION_UNPROVEN';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER first_sync_progress_complete AFTER INSERT ON magento_first_sync_progress
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_first_sync_progress();
