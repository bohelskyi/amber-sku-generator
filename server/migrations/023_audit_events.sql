CREATE TABLE audit_events (
  id BIGSERIAL PRIMARY KEY,
  event_key TEXT NOT NULL,
  actor_user_id BIGINT NOT NULL
    REFERENCES application_users(id) ON DELETE RESTRICT,
  actor_snapshot JSONB NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  request_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT audit_events_event_key_format CHECK (
    event_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
  ),
  CONSTRAINT audit_events_actor_snapshot_shape CHECK (
    jsonb_typeof(actor_snapshot) = 'object'
    AND actor_snapshot ? 'displayName'
    AND actor_snapshot ? 'preferredUsername'
    AND actor_snapshot - 'displayName' - 'preferredUsername' = '{}'::jsonb
    AND (
      actor_snapshot->'displayName' = 'null'::jsonb
      OR jsonb_typeof(actor_snapshot->'displayName') = 'string'
    )
    AND (
      actor_snapshot->'preferredUsername' = 'null'::jsonb
      OR jsonb_typeof(actor_snapshot->'preferredUsername') = 'string'
    )
  ),
  CONSTRAINT audit_events_subject_type_format CHECK (
    subject_type ~ '^[a-z][a-z0-9_]*$'
  ),
  CONSTRAINT audit_events_subject_id_format CHECK (
    BTRIM(subject_id) <> '' AND LENGTH(subject_id) <= 256
  ),
  CONSTRAINT audit_events_request_id_format CHECK (
    request_id IS NULL OR (BTRIM(request_id) <> '' AND LENGTH(request_id) <= 128)
  ),
  CONSTRAINT audit_events_details_object CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX audit_events_occurred_idx
  ON audit_events (occurred_at DESC, id DESC);

CREATE INDEX audit_events_actor_idx
  ON audit_events (actor_user_id, occurred_at DESC, id DESC);

CREATE INDEX audit_events_subject_idx
  ON audit_events (subject_type, subject_id, occurred_at DESC, id DESC);

CREATE INDEX audit_events_event_key_idx
  ON audit_events (event_key, occurred_at DESC, id DESC);

CREATE OR REPLACE FUNCTION protect_audit_event_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events are immutable';
  RETURN NULL;
END;
$$;

CREATE TRIGGER audit_events_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION protect_audit_event_immutability();

CREATE TRIGGER audit_events_no_truncate
BEFORE TRUNCATE ON audit_events
FOR EACH STATEMENT EXECUTE FUNCTION protect_audit_event_immutability();

INSERT INTO permissions (permission_key, description)
VALUES ('audit.view', 'View the immutable durable audit event ledger');

INSERT INTO role_permissions (role_id, permission_key)
SELECT id, 'audit.view'
FROM roles
WHERE role_key = 'administrator'
  AND is_system = TRUE
  AND status = 'active';
