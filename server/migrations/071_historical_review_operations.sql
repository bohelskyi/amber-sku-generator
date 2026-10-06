-- Explicit actor-owned review work only; no startup enrollment or remote writes.
CREATE TABLE historical_review_operations (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f-]{36}$'),
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('preview','confirm')),
  request JSONB NOT NULL CHECK (jsonb_typeof(request)='object'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  deadline_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','ready','failed')),
  run_token TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  progress JSONB NOT NULL,
  result JSONB,
  failure_code TEXT,
  failure_status INTEGER,
  CHECK ((state IN ('ready','failed')) = (completed_at IS NOT NULL)),
  CHECK ((state='ready') = (result IS NOT NULL)),
  CHECK ((state='failed') = (failure_code IS NOT NULL AND failure_status IS NOT NULL)),
  CHECK (state='failed' OR failure_code IS NULL AND failure_status IS NULL),
  CHECK (failure_status IS NULL OR failure_status BETWEEN 400 AND 599),
  CHECK (state='queued' OR run_token IS NOT NULL AND started_at IS NOT NULL)
);
CREATE UNIQUE INDEX historical_review_one_active ON historical_review_operations(actor_user_id,kind)
  WHERE state IN ('queued','running');
CREATE INDEX historical_review_pending ON historical_review_operations(created_at,id)
  WHERE state IN ('queued','running');
CREATE FUNCTION protect_historical_review_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'historical review operation is permanent'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'queued' OR NEW.run_token IS NOT NULL OR NEW.started_at IS NOT NULL
      OR NEW.completed_at IS NOT NULL OR NEW.result IS NOT NULL OR NEW.failure_code IS NOT NULL
      OR NEW.failure_status IS NOT NULL THEN RAISE EXCEPTION 'historical review starts queued'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['state','run_token','started_at','completed_at','progress','result','failure_code','failure_status'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','run_token','started_at','completed_at','progress','result','failure_code','failure_status'])
    OR OLD.state IN ('ready','failed') AND NEW IS DISTINCT FROM OLD
    OR OLD.state='running' AND NEW.state='queued'
    OR NEW.state='queued'
  THEN RAISE EXCEPTION 'historical review proof cannot be rewritten'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER historical_review_protected BEFORE INSERT OR UPDATE OR DELETE ON historical_review_operations
  FOR EACH ROW EXECUTE FUNCTION protect_historical_review_operation();
CREATE TRIGGER historical_review_no_truncate BEFORE TRUNCATE ON historical_review_operations
  FOR EACH STATEMENT EXECUTE FUNCTION protect_historical_review_operation();
