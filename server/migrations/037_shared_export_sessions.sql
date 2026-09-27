-- Durable workspaces for explicitly controlled product exports. No historical backfill.
CREATE TABLE export_sessions (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-f0-9-]{36}$'),
  owner_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  creation_key TEXT NOT NULL CHECK (length(creation_key) BETWEEN 1 AND 200),
  creation_intent JSONB NOT NULL,
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  settings JSONB NOT NULL CHECK (jsonb_typeof(settings) = 'object' AND settings->>'requestContract' = 'template-v1' AND octet_length(settings::text) <= 8192),
  configuration_revision BIGINT NOT NULL DEFAULT 1 CHECK (configuration_revision > 0),
  current_attempt_id TEXT,
  snapshot_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_user_id, creation_key)
);
CREATE TABLE export_session_members (
  session_id TEXT NOT NULL REFERENCES export_sessions(id) ON DELETE RESTRICT,
  user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('pending','accepted','declined','revoked','left')),
  epoch BIGINT NOT NULL DEFAULT 1 CHECK (epoch > 0),
  invited_by_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  invited_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  ended_by_user_id BIGINT REFERENCES application_users(id) ON DELETE RESTRICT,
  PRIMARY KEY(session_id,user_id)
);
CREATE INDEX export_session_members_user ON export_session_members(user_id,state,session_id);
CREATE INDEX export_sessions_owner ON export_sessions(owner_user_id,created_at DESC,id);
CREATE TABLE export_session_attempts (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-f0-9-]{36}$'),
  session_id TEXT NOT NULL REFERENCES export_sessions(id) ON DELETE RESTRICT,
  configuration_revision BIGINT NOT NULL CHECK (configuration_revision > 0),
  prepared_by_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  request_intent JSONB NOT NULL,
  binding_evidence JSONB NOT NULL CHECK (jsonb_typeof(binding_evidence) = 'object'),
  preview_proof TEXT NOT NULL CHECK (octet_length(preview_proof) <= 8192),
  preview_summary JSONB NOT NULL CHECK (octet_length(preview_summary::text) <= 32768),
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','executing','failed','superseded','succeeded')),
  last_error_code TEXT,
  started_at TIMESTAMPTZ,
  initiated_by_user_id BIGINT REFERENCES application_users(id) ON DELETE RESTRICT,
  finished_at TIMESTAMPTZ,
  snapshot_id TEXT UNIQUE,
  CHECK ((state = 'succeeded') = (snapshot_id IS NOT NULL)),
  UNIQUE(id,session_id),
  UNIQUE(id,session_id,configuration_revision)
);
ALTER TABLE export_sessions ADD CONSTRAINT export_session_current_attempt
  FOREIGN KEY(current_attempt_id,id,configuration_revision) REFERENCES export_session_attempts(id,session_id,configuration_revision) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE export_snapshots
  ADD COLUMN export_session_id TEXT REFERENCES export_sessions(id) ON DELETE RESTRICT,
  ADD COLUMN export_attempt_id TEXT,
  ADD CONSTRAINT export_snapshot_session_shape CHECK ((export_session_id IS NULL AND export_attempt_id IS NULL) OR (export_session_id IS NOT NULL AND export_attempt_id IS NOT NULL AND request_contract = 'template-v1')),
  ADD CONSTRAINT export_snapshot_session_attempt FOREIGN KEY(export_attempt_id,export_session_id) REFERENCES export_session_attempts(id,session_id),
  ADD CONSTRAINT export_snapshot_one_per_session UNIQUE(export_session_id),
  ADD CONSTRAINT export_snapshot_session_identity UNIQUE(id,export_session_id),
  ADD CONSTRAINT export_snapshot_attempt_identity UNIQUE(id,export_attempt_id);
ALTER TABLE export_sessions ADD CONSTRAINT export_session_result FOREIGN KEY(snapshot_id,id)
  REFERENCES export_snapshots(id,export_session_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE export_session_attempts ADD CONSTRAINT export_attempt_result FOREIGN KEY(snapshot_id,id)
  REFERENCES export_snapshots(id,export_attempt_id) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION protect_export_session_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'export session evidence is permanent'; END IF;
  IF TG_TABLE_NAME = 'export_sessions' THEN
    IF (NEW.id,NEW.owner_user_id,NEW.creation_key,NEW.creation_intent,NEW.created_at) IS DISTINCT FROM
       (OLD.id,OLD.owner_user_id,OLD.creation_key,OLD.creation_intent,OLD.created_at)
       OR NEW.configuration_revision < OLD.configuration_revision
       OR NEW.configuration_revision > OLD.configuration_revision + 1
       OR ((NEW.settings,NEW.title) IS DISTINCT FROM (OLD.settings,OLD.title) AND NEW.configuration_revision <> OLD.configuration_revision + 1)
       OR (OLD.snapshot_id IS NOT NULL AND (NEW.settings,NEW.title,NEW.configuration_revision,NEW.current_attempt_id,NEW.snapshot_id) IS DISTINCT FROM (OLD.settings,OLD.title,OLD.configuration_revision,OLD.current_attempt_id,OLD.snapshot_id))
    THEN RAISE EXCEPTION 'export session identity/result is immutable'; END IF;
  ELSIF TG_TABLE_NAME = 'export_session_attempts' THEN
    IF (NEW.id,NEW.session_id,NEW.configuration_revision,NEW.prepared_by_user_id,NEW.prepared_at,NEW.request_intent,NEW.binding_evidence,NEW.preview_proof,NEW.preview_summary,NEW.idempotency_key) IS DISTINCT FROM
       (OLD.id,OLD.session_id,OLD.configuration_revision,OLD.prepared_by_user_id,OLD.prepared_at,OLD.request_intent,OLD.binding_evidence,OLD.preview_proof,OLD.preview_summary,OLD.idempotency_key)
       OR (OLD.state IN ('succeeded','superseded') AND NEW IS DISTINCT FROM OLD)
       OR (OLD.initiated_by_user_id IS NOT NULL AND NEW.initiated_by_user_id IS DISTINCT FROM OLD.initiated_by_user_id)
       OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
       OR (NEW.state = 'succeeded' AND OLD.state <> 'executing')
    THEN RAISE EXCEPTION 'export attempt identity/result is immutable'; END IF;
  ELSE
    IF (NEW.session_id,NEW.user_id) IS DISTINCT FROM (OLD.session_id,OLD.user_id)
       OR NEW.epoch <> OLD.epoch + 1 THEN RAISE EXCEPTION 'export membership epoch must advance'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER export_session_protected BEFORE UPDATE OR DELETE ON export_sessions FOR EACH ROW EXECUTE FUNCTION protect_export_session_evidence();
CREATE TRIGGER export_session_no_truncate BEFORE TRUNCATE ON export_sessions FOR EACH STATEMENT EXECUTE FUNCTION protect_export_session_evidence();
CREATE TRIGGER export_attempt_protected BEFORE UPDATE OR DELETE ON export_session_attempts FOR EACH ROW EXECUTE FUNCTION protect_export_session_evidence();
CREATE TRIGGER export_attempt_no_truncate BEFORE TRUNCATE ON export_session_attempts FOR EACH STATEMENT EXECUTE FUNCTION protect_export_session_evidence();
CREATE TRIGGER export_member_protected BEFORE UPDATE OR DELETE ON export_session_members FOR EACH ROW EXECUTE FUNCTION protect_export_session_evidence();
CREATE TRIGGER export_member_no_truncate BEFORE TRUNCATE ON export_session_members FOR EACH STATEMENT EXECUTE FUNCTION protect_export_session_evidence();

CREATE FUNCTION protect_export_snapshot_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.export_session_id,NEW.export_attempt_id) IS DISTINCT FROM (OLD.export_session_id,OLD.export_attempt_id) THEN RAISE EXCEPTION 'snapshot session linkage is immutable'; END IF;
  ELSIF NEW.export_session_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM export_sessions s JOIN export_session_attempts a ON a.id = s.current_attempt_id
      WHERE s.id = NEW.export_session_id AND a.id = NEW.export_attempt_id AND a.state = 'executing'
      AND a.configuration_revision = s.configuration_revision AND s.snapshot_id IS NULL
      AND a.idempotency_key = NEW.idempotency_key AND a.request_intent = NEW.request_intent
      AND a.binding_evidence = NEW.binding_evidence AND s.settings = NEW.request_intent)
    THEN RAISE EXCEPTION 'snapshot must match the current prepared attempt'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER export_snapshot_session_protected BEFORE INSERT OR UPDATE ON export_snapshots FOR EACH ROW EXECUTE FUNCTION protect_export_snapshot_session();
CREATE FUNCTION require_export_session_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.export_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM export_sessions s JOIN export_session_attempts a ON a.id=s.current_attempt_id
    WHERE s.id=NEW.export_session_id AND s.snapshot_id=NEW.id AND a.id=NEW.export_attempt_id AND a.snapshot_id=NEW.id AND a.state='succeeded')
  THEN RAISE EXCEPTION 'snapshot and durable result must commit together'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER export_snapshot_requires_result AFTER INSERT ON export_snapshots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_export_session_result();
