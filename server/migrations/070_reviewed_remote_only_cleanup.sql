-- Explicit reviewed actions only. No cleanup, adoption, publication or grants.
CREATE OR REPLACE FUNCTION validate_test_deletion_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state<>'sealed' OR num_nonnulls(NEW.dispatched_at,NEW.verified_at,NEW.finalized_at)<>0
    OR NOT EXISTS(SELECT 1 FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
      LEFT JOIN sku_registry r ON r.full_sku=p.full_sku AND r.first_product_id=p.id
      JOIN magento_sync_jobs j ON j.id=NEW.create_job_id
      WHERE p.id=NEW.product_id AND (p.status='active' OR (i.is_test_product AND p.status='archived' AND p.exclude_from_export=1
        AND EXISTS(SELECT 1 FROM product_visibility_intents h JOIN product_full_export_state s ON s.product_id=h.product_id
          WHERE h.product_id=p.id AND h.public_product_identity_id=i.id AND h.public_sku=i.public_sku
            AND h.origin_hash=NEW.origin_hash AND h.remote_product_id=NEW.remote_product_id
            AND h.kind='hide' AND h.state='verified' AND h.target_status=2 AND h.previous_remote_status=2
            AND h.previous_product->>'status'='active' AND h.previous_lifecycle->>'route'='normal' AND s.route='retired')))
        AND p.public_product_identity_id=NEW.public_product_identity_id
        AND i.origin='allocated' AND i.public_sku=NEW.public_sku
        AND ((i.is_test_product AND i.public_sku ~ '^TEST-[0-9]{6,}$') OR (NOT i.is_test_product AND i.public_sku ~ '^AG-[0-9]{6,}$'))
        AND ((p.characteristic_version_id IS NULL AND r.first_product_id=p.id AND p.full_sku=NEW.internal_sku)
          OR (p.characteristic_version_id IS NOT NULL AND NEW.internal_sku IS NULL
            AND num_nonnulls(p.full_sku,p.base_sku,p.sequence_number,p.sku_schema_version_id)=0
            AND p.corrected_from_product_id IS NULL AND p.corrected_to_product_id IS NULL
            AND (SELECT count(*) FROM products other WHERE other.public_product_identity_id=i.id)=1))
        AND j.product_id=p.id AND j.public_product_identity_id=i.id AND j.sku=i.public_sku
        AND j.origin_hash=NEW.origin_hash AND j.remote_product_id=NEW.remote_product_id
        AND j.state='succeeded' AND j.acknowledged_at IS NOT NULL AND j.intent->>'mode'='create') THEN
    RAISE EXCEPTION 'test deletion requires exact allocated product and succeeded CREATE identity';
  END IF;
  RETURN NEW;
END $$;

-- Completed TEST media/visibility evidence is preserved and frozen at sealing.
CREATE FUNCTION fence_test_cleanup_auxiliary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity_id BIGINT;
BEGIN
  IF TG_TABLE_NAME='product_photo_sets' THEN
    SELECT public_product_identity_id INTO identity_id FROM products WHERE id=NEW.product_id;
  ELSE identity_id:=NEW.public_product_identity_id; END IF;
  IF EXISTS(SELECT 1 FROM magento_test_deletions WHERE public_product_identity_id=identity_id) THEN
    RAISE EXCEPTION 'test deletion freezes media and visibility evidence' USING ERRCODE='P0050';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER test_cleanup_photo_fence BEFORE INSERT OR UPDATE ON product_photo_sets FOR EACH ROW EXECUTE FUNCTION fence_test_cleanup_auxiliary();
CREATE TRIGGER test_cleanup_media_fence BEFORE INSERT OR UPDATE ON product_media_jobs FOR EACH ROW EXECUTE FUNCTION fence_test_cleanup_auxiliary();
CREATE TRIGGER test_cleanup_visibility_fence BEFORE INSERT OR UPDATE ON product_visibility_intents FOR EACH ROW EXECUTE FUNCTION fence_test_cleanup_auxiliary();

-- Separate ledger: legacy paired-delete completion still requires local removal.
CREATE TABLE magento_remote_catalog_deletions (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('attribute_delete_remote','option_delete_remote')),
  origin_hash TEXT NOT NULL CHECK(origin_hash ~ '^[a-f0-9]{64}$'),
  resource_key TEXT NOT NULL CHECK(resource_key ~ '^[a-f0-9]{64}$'),
  binding_revision_id TEXT NOT NULL REFERENCES magento_binding_revisions(id) ON DELETE RESTRICT,
  binding_revision BIGINT NOT NULL CHECK(binding_revision>0),
  creation_action_id UUID NOT NULL REFERENCES magento_configuration_actions(id) ON DELETE RESTRICT,
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  preview_hash TEXT NOT NULL CHECK(preview_hash ~ '^[a-f0-9]{64}$'),
  intent JSONB NOT NULL CHECK(jsonb_typeof(intent)='object' AND octet_length(intent::text)<=32768),
  state TEXT NOT NULL DEFAULT 'sealed' CHECK(state IN ('sealed','dispatched','returned','verified')),
  remote_id TEXT CHECK(remote_id ~ '^[1-9][0-9]*$'),
  verification JSONB CHECK(jsonb_typeof(verification)='object' AND verification->'absent'='true'::jsonb),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dispatched_at TIMESTAMPTZ, returned_at TIMESTAMPTZ, verified_at TIMESTAMPTZ,
  UNIQUE(origin_hash,resource_key),
  CHECK((state<>'sealed')=(dispatched_at IS NOT NULL)),
  CHECK((state IN ('returned','verified'))=(returned_at IS NOT NULL)),
  CHECK((state IN ('returned','verified'))=(remote_id IS NOT NULL)),
  CHECK((state='verified')=(verified_at IS NOT NULL)),
  CHECK((state='verified')=(verification IS NOT NULL))
);
CREATE FUNCTION protect_remote_catalog_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'sealed' OR num_nonnulls(NEW.remote_id,NEW.verification,NEW.dispatched_at,NEW.returned_at,NEW.verified_at)<>0 THEN
      RAISE EXCEPTION 'remote catalog deletion must start sealed';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM magento_configuration_actions a JOIN questions q ON q.id=(NEW.intent#>>'{command,questionId}')::bigint
      WHERE a.id=NEW.creation_action_id AND a.kind='attribute' AND a.state='verified' AND a.origin_hash=NEW.origin_hash
        AND a.remote_id=NEW.intent#>>'{command,target,attributeId}' AND a.intent#>>'{target,attributeCode}'=NEW.intent#>>'{command,target,attributeCode}'
        AND q.key=NEW.intent#>>'{command,target,attributeCode}' AND q.key ~ '^test_[a-z0-9_]+$'
        AND q.label ~ '^TEST( |$)' AND a.intent->>'label' ~ '^TEST( |$)' AND (NEW.kind='option_delete_remote' OR q.archived)) THEN
      RAISE EXCEPTION 'remote-only deletion requires exact verified creation and retained local identity';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'remote catalog deletion evidence is permanent'; END IF;
  IF (to_jsonb(NEW)-ARRAY['state','remote_id','verification','dispatched_at','returned_at','verified_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['state','remote_id','verification','dispatched_at','returned_at','verified_at'])
    OR NOT ((OLD.state='sealed' AND NEW.state='dispatched') OR (OLD.state='dispatched' AND NEW.state='returned') OR (OLD.state='returned' AND NEW.state='verified'))
    OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
    OR (OLD.returned_at IS NOT NULL AND NEW.returned_at IS DISTINCT FROM OLD.returned_at)
    OR (OLD.remote_id IS NOT NULL AND NEW.remote_id IS DISTINCT FROM OLD.remote_id) THEN
    RAISE EXCEPTION 'remote catalog deletion intent and progress are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER remote_catalog_deletion_permanent BEFORE INSERT OR UPDATE OR DELETE ON magento_remote_catalog_deletions FOR EACH ROW EXECUTE FUNCTION protect_remote_catalog_deletion();
CREATE TRIGGER remote_catalog_deletion_no_truncate BEFORE TRUNCATE ON magento_remote_catalog_deletions FOR EACH STATEMENT EXECUTE FUNCTION protect_remote_catalog_deletion();
CREATE UNIQUE INDEX remote_catalog_exact_target ON magento_remote_catalog_deletions(origin_hash,
  (intent#>>'{command,target,attributeCode}'),coalesce(intent#>>'{command,target,optionId}',''));
-- Different option/whole-attribute commands still share the one mutable remote
-- attribute. Its unresolved DELETE must finish before another can be sealed.
CREATE UNIQUE INDEX remote_catalog_one_pending_attribute ON magento_remote_catalog_deletions
  (origin_hash,(intent#>>'{command,target,attributeCode}')) WHERE state<>'verified';

CREATE FUNCTION require_remote_catalog_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='verified' AND (NOT EXISTS(SELECT 1 FROM questions q
      WHERE q.id=(NEW.intent#>>'{command,questionId}')::bigint AND q.key=NEW.intent#>>'{localTarget,questionKey}'
        AND (NEW.kind='option_delete_remote' OR q.archived))
    OR (NEW.kind='attribute_delete_remote' AND EXISTS(SELECT 1 FROM options o WHERE o.question_id=(NEW.intent#>>'{command,questionId}')::bigint AND NOT o.archived))
    OR (NEW.kind='option_delete_remote' AND NOT EXISTS(SELECT 1 FROM options o
      WHERE o.id=(NEW.intent#>>'{command,optionId}')::bigint AND o.question_id=(NEW.intent#>>'{command,questionId}')::bigint
        AND o.archived AND o.value_id::text=NEW.intent#>>'{localTarget,valueId}'))
    OR NEW.verification#>>'{attributeCode}' IS DISTINCT FROM NEW.intent#>>'{command,target,attributeCode}'
    OR NEW.verification#>>'{attributeId}' IS DISTINCT FROM NEW.intent#>>'{command,target,attributeId}'
    OR NEW.verification->'optionId' IS DISTINCT FROM NEW.intent#>'{command,target,optionId}') THEN
    RAISE EXCEPTION 'verified remote deletion requires exact retained archive and absence proof';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER remote_catalog_retention AFTER INSERT OR UPDATE ON magento_remote_catalog_deletions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_remote_catalog_retention();

CREATE FUNCTION fence_remote_catalog_local() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_row JSONB; after_row JSONB; category_before TEXT; category_after TEXT; action magento_remote_catalog_deletions;
BEGIN
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS(SELECT 1 FROM magento_remote_catalog_deletions) THEN RAISE EXCEPTION 'remote deletion retains local history'; END IF;
    RETURN NULL;
  END IF;
  IF TG_OP<>'INSERT' THEN before_row:=to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN after_row:=to_jsonb(NEW); END IF;
  category_before:=coalesce(before_row->>'category_code',before_row->>'category');
  category_after:=coalesce(after_row->>'category_code',after_row->>'category');
  IF TG_TABLE_NAME='options' THEN
    SELECT category_code INTO category_before FROM questions WHERE id=(before_row->>'question_id')::bigint;
    SELECT category_code INTO category_after FROM questions WHERE id=(after_row->>'question_id')::bigint;
  END IF;
  FOR action IN SELECT * FROM magento_remote_catalog_deletions LOOP
    IF action.state<>'verified' AND action.intent#>>'{localTarget,categoryCode}' IN (category_before,category_after) THEN
      RAISE EXCEPTION 'remote catalog deletion requires reconciliation before category changes';
    END IF;
    IF TG_TABLE_NAME='questions' AND action.intent#>>'{command,questionId}' IN (before_row->>'id',after_row->>'id')
      AND (action.kind='attribute_delete_remote' OR TG_OP='DELETE'
        OR before_row->>'key' IS DISTINCT FROM after_row->>'key' OR before_row->>'category_code' IS DISTINCT FROM after_row->>'category_code') THEN
      RAISE EXCEPTION 'remote deletion retains archived question identity';
    END IF;
    IF TG_TABLE_NAME='options' AND ((action.kind='attribute_delete_remote' AND action.intent#>>'{command,questionId}' IN (before_row->>'question_id',after_row->>'question_id'))
      OR action.intent#>>'{command,optionId}' IN (before_row->>'id',after_row->>'id')) THEN
      RAISE EXCEPTION 'remote deletion retains archived option history';
    END IF;
    IF TG_TABLE_NAME='products' AND TG_OP<>'DELETE' AND action.intent#>>'{localTarget,categoryCode}'=category_after
      AND after_row->'details'->'answers'->(action.intent#>>'{localTarget,questionKey}') IS NOT NULL
      AND after_row->'details'->'answers'->(action.intent#>>'{localTarget,questionKey}') NOT IN ('null'::jsonb,'""'::jsonb)
      AND (action.kind='attribute_delete_remote' OR after_row#>>ARRAY['details','answers',action.intent#>>'{localTarget,questionKey}']=action.intent#>>'{localTarget,valueId}') THEN
      RAISE EXCEPTION 'remote-removed value is invalid for future products';
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER remote_catalog_question BEFORE INSERT OR UPDATE OR DELETE ON questions FOR EACH ROW EXECUTE FUNCTION fence_remote_catalog_local();
CREATE TRIGGER remote_catalog_option BEFORE INSERT OR UPDATE OR DELETE ON options FOR EACH ROW EXECUTE FUNCTION fence_remote_catalog_local();
CREATE TRIGGER remote_catalog_product BEFORE INSERT OR UPDATE OR DELETE ON products FOR EACH ROW EXECUTE FUNCTION fence_remote_catalog_local();
CREATE TRIGGER remote_catalog_scenario BEFORE INSERT OR UPDATE OR DELETE ON price_scenarios FOR EACH ROW EXECUTE FUNCTION fence_remote_catalog_local();
CREATE TRIGGER remote_catalog_modifier BEFORE INSERT OR UPDATE OR DELETE ON price_modifiers FOR EACH ROW EXECUTE FUNCTION fence_remote_catalog_local();
CREATE TRIGGER remote_catalog_question_no_truncate BEFORE TRUNCATE ON questions FOR EACH STATEMENT EXECUTE FUNCTION fence_remote_catalog_local();
CREATE TRIGGER remote_catalog_option_no_truncate BEFORE TRUNCATE ON options FOR EACH STATEMENT EXECUTE FUNCTION fence_remote_catalog_local();

CREATE FUNCTION fence_remote_catalog_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data JSONB; code TEXT; action magento_remote_catalog_deletions;
BEGIN
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS(SELECT 1 FROM magento_remote_catalog_deletions) THEN RAISE EXCEPTION 'remote deletion preserves configuration evidence'; END IF;
    RETURN NULL;
  END IF;
  IF TG_OP='DELETE' THEN row_data:=to_jsonb(OLD); ELSE row_data:=to_jsonb(NEW); END IF;
  code:=coalesce(row_data->>'attribute_code',row_data#>>'{intent,target,attributeCode}',row_data#>>'{intent,command,target,attributeCode}');
  FOR action IN SELECT * FROM magento_remote_catalog_deletions LOOP
    IF action.state<>'verified' THEN RAISE EXCEPTION 'pending remote deletion prevents configuration drift'; END IF;
    IF code=action.intent#>>'{command,target,attributeCode}' AND
      (action.kind='attribute_delete_remote' OR row_data->>'option_id'=action.intent#>>'{command,target,optionId}') THEN
      RAISE EXCEPTION 'remote-deleted identity cannot be rebound';
    END IF;
    IF TG_TABLE_NAME='magento_binding_revisions' AND row_data->>'state'='published' AND EXISTS(
      SELECT 1 FROM magento_binding_attributes b LEFT JOIN magento_binding_options o ON o.revision_id=b.revision_id AND o.binding_key=b.binding_key
      WHERE b.revision_id=row_data->>'id' AND b.attribute_code=action.intent#>>'{command,target,attributeCode}'
        AND (action.kind='attribute_delete_remote' OR o.option_id=action.intent#>>'{command,target,optionId}')) THEN
      RAISE EXCEPTION 'remote-deleted resource cannot be published';
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER remote_catalog_binding BEFORE INSERT OR UPDATE OR DELETE ON magento_binding_attributes FOR EACH ROW EXECUTE FUNCTION fence_remote_catalog_configuration();
CREATE TRIGGER remote_catalog_mapping BEFORE INSERT OR UPDATE OR DELETE ON magento_binding_options FOR EACH ROW EXECUTE FUNCTION fence_remote_catalog_configuration();
CREATE TRIGGER remote_catalog_template BEFORE INSERT OR UPDATE OR DELETE ON export_template_drafts FOR EACH ROW EXECUTE FUNCTION fence_remote_catalog_configuration();
CREATE TRIGGER remote_catalog_activation BEFORE INSERT OR UPDATE OR DELETE ON export_template_activation FOR EACH ROW EXECUTE FUNCTION fence_remote_catalog_configuration();
CREATE TRIGGER remote_catalog_publication BEFORE INSERT OR UPDATE OR DELETE ON magento_binding_revisions FOR EACH ROW EXECUTE FUNCTION fence_remote_catalog_configuration();
CREATE TRIGGER remote_catalog_action BEFORE INSERT ON magento_configuration_actions FOR EACH ROW EXECUTE FUNCTION fence_remote_catalog_configuration();

-- Already archived TEST rows remain byte-for-byte archived. The original active
-- test retirement still requires voided, and every completion stays atomic.
CREATE OR REPLACE FUNCTION validate_test_deletion_final_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id INTEGER;
BEGIN
  target_id:=NEW.product_id;
  IF (TG_TABLE_NAME='magento_test_deletions' AND NEW.state='finalized')
    OR (TG_TABLE_NAME='magento_product_sync_requests' AND NEW.state='voided') THEN
    IF NOT EXISTS(SELECT 1 FROM magento_test_deletions d JOIN products p ON p.id=d.product_id
      JOIN product_full_export_state f ON f.product_id=p.id
      JOIN public_product_identities i ON i.id=p.public_product_identity_id
      WHERE p.id=target_id AND d.state='finalized' AND p.exclude_from_export=1 AND f.route='retired'
        AND (p.status='voided' OR (p.status='archived' AND i.is_test_product AND i.public_sku=d.public_sku
          AND EXISTS(SELECT 1 FROM product_visibility_intents h WHERE h.product_id=p.id
            AND h.public_product_identity_id=d.public_product_identity_id AND h.public_sku=d.public_sku
            AND h.origin_hash=d.origin_hash AND h.remote_product_id=d.remote_product_id
            AND h.kind='hide' AND h.state='verified' AND h.target_status=2 AND h.previous_remote_status=2))))
      OR EXISTS(SELECT 1 FROM magento_product_sync_requests WHERE product_id=target_id AND state<>'voided') THEN
      RAISE EXCEPTION 'test deletion finalization must be atomic';
    END IF;
  END IF;
  RETURN NULL;
END $$;
