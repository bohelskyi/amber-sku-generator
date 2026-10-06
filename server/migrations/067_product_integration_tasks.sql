-- Local configuration tasks. This ledger neither creates products nor calls Magento.
CREATE TABLE product_integration_tasks (
  id UUID PRIMARY KEY,
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id),
  defect_hash TEXT NOT NULL CHECK (defect_hash ~ '^[a-f0-9]{64}$'),
  defect JSONB NOT NULL CHECK (jsonb_typeof(defect)='object'),
  category_code TEXT NOT NULL REFERENCES categories(code),
  category_label TEXT NOT NULL,
  question_label TEXT,
  value_label TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved','cancelled')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMPTZ,
  resolved_by_user_id BIGINT REFERENCES application_users(id),
  resolution_hash TEXT CHECK (resolution_hash IS NULL OR resolution_hash ~ '^[a-f0-9]{64}$'),
  CHECK ((state='open' AND resolved_at IS NULL AND resolved_by_user_id IS NULL AND resolution_hash IS NULL)
    OR (state<>'open' AND resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL AND resolution_hash IS NOT NULL))
);
CREATE UNIQUE INDEX product_integration_tasks_open_defect ON product_integration_tasks(actor_user_id,defect_hash) WHERE state='open';
CREATE INDEX product_integration_tasks_page ON product_integration_tasks(state,created_at DESC,id);
CREATE TABLE product_integration_task_attempts (
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id),
  request_id UUID NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  task_id UUID NOT NULL REFERENCES product_integration_tasks(id),
  creation_payload JSONB NOT NULL CHECK (jsonb_typeof(creation_payload)='object' AND octet_length(creation_payload::text)<=32768),
  configuration_hash TEXT NOT NULL CHECK (configuration_hash ~ '^[a-f0-9]{64}$'),
  preview_hash TEXT NOT NULL CHECK (preview_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_user_id,request_id)
);
CREATE INDEX product_integration_task_context ON product_integration_task_attempts(task_id,created_at DESC,request_id);
CREATE FUNCTION guard_product_integration_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Integration task evidence is permanent'; END IF;
  IF ROW(NEW.id,NEW.actor_user_id,NEW.defect_hash,NEW.defect,NEW.category_code,NEW.category_label,
      NEW.question_label,NEW.value_label,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.actor_user_id,OLD.defect_hash,OLD.defect,OLD.category_code,OLD.category_label,
      OLD.question_label,OLD.value_label,OLD.created_at)
    OR OLD.state<>'open' OR NEW.state NOT IN ('resolved','cancelled') OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'Integration task evidence or final state is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION guard_product_integration_task_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Integration request attempts are immutable'; END $$;
CREATE TRIGGER product_integration_task_guard BEFORE UPDATE OR DELETE ON product_integration_tasks
FOR EACH ROW EXECUTE FUNCTION guard_product_integration_task();
CREATE TRIGGER product_integration_task_no_truncate BEFORE TRUNCATE ON product_integration_tasks
FOR EACH STATEMENT EXECUTE FUNCTION guard_product_integration_task();
CREATE TRIGGER product_integration_task_attempt_guard BEFORE UPDATE OR DELETE ON product_integration_task_attempts
FOR EACH ROW EXECUTE FUNCTION guard_product_integration_task_attempt();
CREATE TRIGGER product_integration_task_attempt_no_truncate BEFORE TRUNCATE ON product_integration_task_attempts
FOR EACH STATEMENT EXECUTE FUNCTION guard_product_integration_task_attempt();
