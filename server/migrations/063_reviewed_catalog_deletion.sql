-- Future explicit Administrator actions only: no catalog rows, role grants,
-- Magento requests, automatic jobs or historical snapshot updates.
ALTER TABLE magento_configuration_actions DROP CONSTRAINT magento_configuration_actions_kind_check;
ALTER TABLE magento_configuration_actions ADD CONSTRAINT magento_configuration_actions_kind_check
  CHECK(kind IN ('category','option','option_label','attribute','attribute_assignment','attribute_delete','option_delete'));

CREATE TABLE catalog_deletion_completions (
  action_id UUID PRIMARY KEY REFERENCES magento_configuration_actions(id) ON DELETE RESTRICT,
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  local_target JSONB NOT NULL CHECK(jsonb_typeof(local_target)='object'),
  remote_verification JSONB NOT NULL CHECK(jsonb_typeof(remote_verification)='object' AND remote_verification->'absent'='true'::jsonb),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION protect_catalog_deletion_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE action magento_configuration_actions;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'catalog deletion evidence is permanent'; END IF;
  SELECT * INTO action FROM magento_configuration_actions WHERE id=NEW.action_id FOR UPDATE;
  IF action.kind NOT IN ('attribute_delete','option_delete') OR action.state IS DISTINCT FROM 'verified'
    OR NEW.local_target IS DISTINCT FROM action.intent->'localTarget'
    OR NEW.remote_verification IS DISTINCT FROM action.verification THEN
    RAISE EXCEPTION 'catalog deletion completion requires exact verified evidence';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_deletion_completion_guard BEFORE INSERT OR UPDATE OR DELETE ON catalog_deletion_completions
  FOR EACH ROW EXECUTE FUNCTION protect_catalog_deletion_completion();
CREATE TRIGGER catalog_deletion_completion_no_truncate BEFORE TRUNCATE ON catalog_deletion_completions
  FOR EACH STATEMENT EXECUTE FUNCTION protect_catalog_deletion_completion();

CREATE FUNCTION require_catalog_deletion_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IN ('attribute_delete','option_delete') AND NEW.state='verified' THEN
    IF NOT EXISTS(SELECT 1 FROM catalog_deletion_completions d WHERE d.action_id=NEW.id)
      OR (NEW.kind='attribute_delete' AND EXISTS(SELECT 1 FROM questions q WHERE q.id=(NEW.intent #>> '{command,questionId}')::bigint))
      OR (NEW.kind='option_delete' AND EXISTS(SELECT 1 FROM options o WHERE o.id=(NEW.intent #>> '{command,optionId}')::bigint)) THEN
      RAISE EXCEPTION 'verified catalog deletion requires permanent exact local completion';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER catalog_deletion_final_state AFTER INSERT OR UPDATE ON magento_configuration_actions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_catalog_deletion_completion();

-- Durable fences survive a lost DELETE response/restart. Catalog/product
-- mutations cannot introduce dependencies while the remote result is uncertain.
CREATE FUNCTION guard_catalog_deletion_local_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_row JSONB; after_row JSONB; category_before TEXT; category_after TEXT; action magento_configuration_actions;
BEGIN
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS(SELECT 1 FROM magento_configuration_actions a WHERE a.kind IN ('attribute_delete','option_delete')) THEN
      RAISE EXCEPTION 'catalog deletion identities and fences cannot be truncated';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP<>'INSERT' THEN before_row:=to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN after_row:=to_jsonb(NEW); END IF;
  category_before:=coalesce(before_row->>'category_code',before_row->>'category',CASE WHEN TG_TABLE_NAME='categories' THEN before_row->>'code' END);
  category_after:=coalesce(after_row->>'category_code',after_row->>'category',CASE WHEN TG_TABLE_NAME='categories' THEN after_row->>'code' END);
  IF TG_TABLE_NAME='options' THEN
    SELECT category_code INTO category_before FROM questions WHERE id=(before_row->>'question_id')::bigint;
    SELECT category_code INTO category_after FROM questions WHERE id=(after_row->>'question_id')::bigint;
  END IF;
  FOR action IN SELECT a.* FROM magento_configuration_actions a WHERE a.kind IN ('attribute_delete','option_delete')
    AND NOT EXISTS(SELECT 1 FROM catalog_deletion_completions d WHERE d.action_id=a.id)
  LOOP
    IF TG_OP='DELETE' AND action.state='verified' AND current_setting('amber.catalog_deletion_action',true)=action.id::text
      AND ((TG_TABLE_NAME='questions' AND action.kind='attribute_delete' AND before_row->>'id'=action.intent #>> '{command,questionId}')
        OR (TG_TABLE_NAME='options' AND before_row->>'question_id'=action.intent #>> '{command,questionId}'
          AND (action.kind='attribute_delete' OR before_row->>'id'=action.intent #>> '{command,optionId}'))) THEN
      RETURN OLD;
    END IF;
    IF action.intent #>> '{localTarget,categoryCode}' IN (category_before,category_after)
      OR (TG_TABLE_NAME='options' AND action.intent #>> '{command,questionId}' IN (before_row->>'question_id',after_row->>'question_id')) THEN
      RAISE EXCEPTION 'catalog deletion % requires reconciliation before this category can change',action.id;
    END IF;
  END LOOP;
  -- A removed active semantic value must not become valid for a future product
  -- through an old published schema. Historical schema/identity tables are intact.
  IF TG_TABLE_NAME='products' AND TG_OP<>'DELETE' AND EXISTS(
    SELECT 1 FROM magento_configuration_actions a WHERE a.kind IN ('attribute_delete','option_delete') AND a.state='verified'
      AND a.intent #>> '{localTarget,categoryCode}'=category_after
      AND after_row->'details'->'answers' ? (a.intent #>> '{localTarget,questionKey}')
      AND (a.kind='attribute_delete' OR after_row #>> ARRAY['details','answers',a.intent #>> '{localTarget,questionKey}']=a.intent #>> '{localTarget,valueId}')
  ) THEN RAISE EXCEPTION 'a permanently removed catalog value is invalid for future products'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER catalog_deletion_question_fence BEFORE INSERT OR UPDATE OR DELETE ON questions FOR EACH ROW EXECUTE FUNCTION guard_catalog_deletion_local_write();
CREATE TRIGGER catalog_deletion_option_fence BEFORE INSERT OR UPDATE OR DELETE ON options FOR EACH ROW EXECUTE FUNCTION guard_catalog_deletion_local_write();
CREATE TRIGGER catalog_deletion_category_fence BEFORE INSERT OR UPDATE OR DELETE ON categories FOR EACH ROW EXECUTE FUNCTION guard_catalog_deletion_local_write();
CREATE TRIGGER catalog_deletion_product_fence BEFORE INSERT OR UPDATE OR DELETE ON products FOR EACH ROW EXECUTE FUNCTION guard_catalog_deletion_local_write();
CREATE TRIGGER catalog_deletion_scenario_fence BEFORE INSERT OR UPDATE OR DELETE ON price_scenarios FOR EACH ROW EXECUTE FUNCTION guard_catalog_deletion_local_write();
CREATE TRIGGER catalog_deletion_modifier_fence BEFORE INSERT OR UPDATE OR DELETE ON price_modifiers FOR EACH ROW EXECUTE FUNCTION guard_catalog_deletion_local_write();
CREATE TRIGGER catalog_deletion_question_no_truncate BEFORE TRUNCATE ON questions FOR EACH STATEMENT EXECUTE FUNCTION guard_catalog_deletion_local_write();
CREATE TRIGGER catalog_deletion_option_no_truncate BEFORE TRUNCATE ON options FOR EACH STATEMENT EXECUTE FUNCTION guard_catalog_deletion_local_write();

CREATE FUNCTION guard_catalog_deletion_configuration_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data JSONB; target_code TEXT;
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'configuration identities cannot be truncated'; END IF;
  IF TG_OP='DELETE' THEN row_data:=to_jsonb(OLD); ELSE row_data:=to_jsonb(NEW); END IF;
  target_code:=coalesce(row_data->>'attribute_code',row_data #>> '{intent,target,attributeCode}');
  IF EXISTS(SELECT 1 FROM magento_configuration_actions a WHERE a.kind IN ('attribute_delete','option_delete')
    AND NOT EXISTS(SELECT 1 FROM catalog_deletion_completions d WHERE d.action_id=a.id)
    AND (target_code IS NULL OR a.intent #>> '{command,target,attributeCode}'=target_code)
  ) THEN RAISE EXCEPTION 'pending catalog deletion prevents configuration drift'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER catalog_deletion_binding_fence BEFORE INSERT OR UPDATE OR DELETE ON magento_binding_attributes FOR EACH ROW EXECUTE FUNCTION guard_catalog_deletion_configuration_write();
CREATE TRIGGER catalog_deletion_mapping_fence BEFORE INSERT OR UPDATE OR DELETE ON magento_binding_options FOR EACH ROW EXECUTE FUNCTION guard_catalog_deletion_configuration_write();
CREATE TRIGGER catalog_deletion_template_fence BEFORE INSERT OR UPDATE OR DELETE ON export_template_drafts FOR EACH ROW EXECUTE FUNCTION guard_catalog_deletion_configuration_write();
CREATE TRIGGER catalog_deletion_activation_fence BEFORE INSERT OR UPDATE OR DELETE ON export_template_activation FOR EACH ROW EXECUTE FUNCTION guard_catalog_deletion_configuration_write();
CREATE TRIGGER catalog_deletion_publication_fence BEFORE INSERT OR UPDATE OR DELETE ON magento_binding_revisions FOR EACH ROW EXECUTE FUNCTION guard_catalog_deletion_configuration_write();
CREATE TRIGGER catalog_deletion_action_fence BEFORE INSERT ON magento_configuration_actions FOR EACH ROW EXECUTE FUNCTION guard_catalog_deletion_configuration_write();
