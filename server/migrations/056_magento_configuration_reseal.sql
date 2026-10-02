-- A new reviewed intent may replace only provably undispatched work.
ALTER TABLE magento_configuration_actions DROP CONSTRAINT magento_configuration_actions_origin_hash_kind_resource_key_key;
ALTER TABLE magento_configuration_actions DROP CONSTRAINT magento_configuration_actions_state_check;
ALTER TABLE magento_configuration_actions DROP CONSTRAINT magento_configuration_actions_check;
ALTER TABLE magento_configuration_actions ADD CONSTRAINT magento_configuration_actions_state_check
  CHECK(state IN ('sealed','superseded','dispatched','returned','verified'));
ALTER TABLE magento_configuration_actions ADD CONSTRAINT magento_configuration_action_dispatch_check
  CHECK((state IN ('dispatched','returned','verified'))=(dispatched_at IS NOT NULL));
ALTER TABLE magento_configuration_actions ADD COLUMN supersedes_id UUID UNIQUE
  REFERENCES magento_configuration_actions(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX magento_configuration_active_resource
  ON magento_configuration_actions(origin_hash,kind,resource_key) WHERE state<>'superseded';
CREATE OR REPLACE FUNCTION protect_magento_configuration_action() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior magento_configuration_actions;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'sealed' OR num_nonnulls(NEW.remote_id,NEW.verification,NEW.dispatched_at,NEW.returned_at,NEW.verified_at)<>0 THEN
      RAISE EXCEPTION 'configuration action must start sealed';
    END IF;
    IF NEW.supersedes_id IS NOT NULL THEN
      SELECT * INTO prior FROM magento_configuration_actions WHERE id=NEW.supersedes_id FOR UPDATE;
      IF prior.state IS DISTINCT FROM 'superseded' OR prior.dispatched_at IS NOT NULL
        OR ROW(prior.origin_hash,prior.kind,prior.resource_key) IS DISTINCT FROM ROW(NEW.origin_hash,NEW.kind,NEW.resource_key) THEN
        RAISE EXCEPTION 'replacement requires an undispatched same-resource predecessor';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'configuration action evidence is permanent'; END IF;
  IF (to_jsonb(NEW)-ARRAY['state','remote_id','verification','dispatched_at','returned_at','verified_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['state','remote_id','verification','dispatched_at','returned_at','verified_at'])
    OR NOT ((OLD.state='sealed' AND NEW.state IN ('dispatched','superseded')) OR (OLD.state='dispatched' AND NEW.state='returned')
      OR (OLD.state='returned' AND NEW.state='verified'))
    OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
    OR (OLD.returned_at IS NOT NULL AND NEW.returned_at IS DISTINCT FROM OLD.returned_at)
    OR (OLD.remote_id IS NOT NULL AND NEW.remote_id IS DISTINCT FROM OLD.remote_id) THEN
    RAISE EXCEPTION 'configuration intent and confirmed progress are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION require_magento_configuration_successor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='superseded' AND NOT EXISTS(SELECT 1 FROM magento_configuration_actions WHERE supersedes_id=NEW.id) THEN
    RAISE EXCEPTION 'superseded configuration action requires a permanent successor';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER magento_configuration_successor_guard AFTER UPDATE ON magento_configuration_actions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_magento_configuration_successor();
