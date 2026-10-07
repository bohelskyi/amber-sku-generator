-- Reviewed canonical bookkeeping only: no enrollment, backfill or remote I/O.
-- Existing products, prices, queues, activations and immutable versions are untouched.
CREATE FUNCTION sv_weight_repair_state(target_id INTEGER) RETURNS JSONB LANGUAGE sql VOLATILE AS $$
  SELECT jsonb_build_object(
    'product',to_jsonb(p),
    'identity',to_jsonb(i),
    'reservation',to_jsonb(r),
    'lifecycle',to_jsonb(f),
    'currentIdentityCount',(SELECT count(*) FROM products q WHERE q.public_product_identity_id=p.public_product_identity_id AND q.status='active' AND q.corrected_to_product_id IS NULL),
    'internalIdentityCount',(SELECT count(*) FROM products q WHERE q.full_sku=p.full_sku),
    'priceRevision',(SELECT to_jsonb(t) FROM product_export_revisions t WHERE t.product_id=p.id),
    'syncRequests',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.public_product_identity_id) FROM magento_product_sync_requests t WHERE t.public_product_identity_id=p.public_product_identity_id), '[]'::jsonb),
    'syncJobs',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM magento_sync_jobs t WHERE t.public_product_identity_id=p.public_product_identity_id), '[]'::jsonb),
    'syncSteps',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.job_id,t.ordinal) FROM magento_sync_steps t WHERE t.job_id IN (SELECT id FROM magento_sync_jobs WHERE public_product_identity_id=p.public_product_identity_id)), '[]'::jsonb),
    'mediaJobs',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM product_media_jobs t WHERE t.public_product_identity_id=p.public_product_identity_id), '[]'::jsonb),
    'mediaSteps',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.job_id,t.step_key) FROM product_media_steps t WHERE t.job_id IN (SELECT id FROM product_media_jobs WHERE public_product_identity_id=p.public_product_identity_id)), '[]'::jsonb),
    'photoSet',(SELECT to_jsonb(t) FROM product_photo_sets t WHERE t.product_id=p.id),
    'photos',COALESCE((SELECT jsonb_agg(to_jsonb(t)-'content' ORDER BY id) FROM product_photo_assets t WHERE t.product_id=p.id), '[]'::jsonb),
    'visibility',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM product_visibility_intents t WHERE t.public_product_identity_id=p.public_product_identity_id), '[]'::jsonb),
    'historicalLegacy',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM historical_reactivation_intents t WHERE t.public_product_identity_id=p.public_product_identity_id), '[]'::jsonb),
    'historicalStandard',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM historical_standard_intents t WHERE t.public_product_identity_id=p.public_product_identity_id), '[]'::jsonb),
    'testDeletion',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM magento_test_deletions t WHERE t.public_product_identity_id=p.public_product_identity_id), '[]'::jsonb),
    'nameStates',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.origin_hash,t.public_product_identity_id) FROM magento_name_sync_states t WHERE t.public_product_identity_id=p.public_product_identity_id), '[]'::jsonb),
    'namePins',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.binding_revision_id) FROM magento_binding_name_pins t WHERE t.product_id=p.id), '[]'::jsonb),
    'corrections',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM product_corrections t WHERE t.source_product_id=p.id OR t.corrected_product_id=p.id), '[]'::jsonb),
    'correctionRequests',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM correction_requests t WHERE t.source_product_id=p.id OR t.corrected_product_id=p.id), '[]'::jsonb),
    'repricingItems',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM repricing_items t WHERE t.product_id=p.id), '[]'::jsonb),
    'exportMemberships',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.snapshot_id) FROM export_snapshot_products t WHERE t.product_id=p.id), '[]'::jsonb),
    'exportSnapshots',COALESCE((SELECT jsonb_agg((to_jsonb(t)-ARRAY['csv_content','reexport_revisions']) || jsonb_build_object('payloadHash',encode(sha256(convert_to(t.csv_content,'UTF8')),'hex')) ORDER BY id) FROM export_snapshots t WHERE t.id IN (SELECT snapshot_id FROM export_snapshot_products WHERE product_id=p.id)), '[]'::jsonb),
    'priceSnapshots',COALESCE((SELECT jsonb_agg((to_jsonb(t)-ARRAY['csv_content','captured_revisions']) || jsonb_build_object('payloadHash',encode(sha256(convert_to(t.csv_content,'UTF8')),'hex')) ORDER BY id) FROM price_export_snapshots t WHERE t.captured_revisions @> jsonb_build_array(jsonb_build_object('productId',p.id))), '[]'::jsonb),
    'productAudits',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM audit_events t WHERE t.subject_type='product' AND t.subject_id=p.id::text), '[]'::jsonb))
  FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
  LEFT JOIN sku_registry r ON r.full_sku=p.full_sku
  LEFT JOIN product_full_export_state f ON f.product_id=p.id WHERE p.id=target_id
$$;
CREATE FUNCTION sv_weight_repair_configuration(binding_id TEXT) RETURNS JSONB LANGUAGE sql VOLATILE AS $$
  SELECT jsonb_build_object(
    'activation',(SELECT to_jsonb(t) FROM magento_auto_sync_activation t WHERE singleton),
    'lifecycleActivation',(SELECT to_jsonb(t) FROM full_product_export_activation t WHERE singleton),
    'publicSkuActivation',(SELECT to_jsonb(t) FROM public_sku_activation t WHERE singleton),
    'category',(SELECT to_jsonb(t) FROM categories t WHERE code='SV'),
    'questions',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM questions t WHERE t.category_code='SV'), '[]'::jsonb),
    'options',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM options t WHERE t.question_id IN (SELECT id FROM questions WHERE category_code='SV')), '[]'::jsonb),
    'scenarios',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM price_scenarios t WHERE t.category_code='SV'), '[]'::jsonb),
    'matrix',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.scenario_id,t.x_val,t.y_val) FROM price_matrix t WHERE t.scenario_id IN (SELECT id FROM price_scenarios WHERE category_code='SV')), '[]'::jsonb),
    'modifiers',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM price_modifiers t WHERE t.category_code='SV'), '[]'::jsonb),
    'bands',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM price_weight_bands t WHERE t.scenario_id IN (SELECT id FROM price_scenarios WHERE category_code='SV')), '[]'::jsonb),
    'binding',jsonb_build_object('id',b.id,'installation_key',b.installation_key,'origin_hash',b.origin_hash,'state',b.state,'template_version_id',b.template_version_id,'definition_hash',b.template_definition_hash,'revision',b.revision::text,'version_number',b.version_number::text),
    'bindingFingerprint',encode(sha256(convert_to(to_jsonb(b)::text,'UTF8')),'hex'),
    'templateFingerprint',(SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') FROM export_template_versions t WHERE id=b.template_version_id),
    'currentBinding',(SELECT t.id FROM magento_binding_revisions t JOIN magento_auto_sync_activation a ON a.singleton AND a.installation_key=t.installation_key WHERE t.state='published' AND t.origin_hash=b.origin_hash ORDER BY t.version_number DESC LIMIT 1))
  FROM magento_binding_revisions b WHERE b.id=binding_id
$$;

CREATE FUNCTION sv_weight_repair_candidate(p products, require_zero BOOLEAN DEFAULT TRUE)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE reasons TEXT[] := '{}'; DECLARE q questions; DECLARE weight_value NUMERIC(14,3);
DECLARE answer JSONB; DECLARE source_text TEXT; DECLARE rules JSONB; DECLARE identity public_product_identities;
BEGIN
  IF p.category IS DISTINCT FROM 'SV' OR p.status IS DISTINCT FROM 'active'
    OR p.corrected_to_product_id IS NOT NULL OR p.details#>>'{answers,souvenir}' IS DISTINCT FROM '5'
    OR p.full_sku IS NULL OR p.sku_schema_version_id IS NULL OR p.characteristic_version_id IS NOT NULL THEN
    reasons:=array_append(reasons,'NOT_CURRENT_LEGACY_SV_STONE'); END IF;
  IF require_zero AND p.weight IS DISTINCT FROM 0::numeric THEN
    reasons:=array_append(reasons,'CANONICAL_WEIGHT_NOT_ZERO'); END IF;
  SELECT * INTO identity FROM public_product_identities WHERE id=p.public_product_identity_id;
  IF identity.id IS NULL OR identity.origin IS DISTINCT FROM 'legacy' OR identity.is_test_product
    OR identity.public_sku IS DISTINCT FROM p.full_sku
    OR (SELECT count(*) FROM products WHERE full_sku=p.full_sku)<>1
    OR (SELECT count(*) FROM products WHERE public_product_identity_id=p.public_product_identity_id
      AND status='active' AND corrected_to_product_id IS NULL)<>1
    OR NOT EXISTS(SELECT 1 FROM sku_registry WHERE full_sku=p.full_sku AND first_product_id=p.id) THEN
    reasons:=array_append(reasons,'IDENTITY_OR_RESERVATION_AMBIGUOUS'); END IF;
  IF p.corrected_from_product_id IS NOT NULL OR EXISTS(SELECT 1 FROM product_corrections
    WHERE source_product_id=p.id OR corrected_product_id=p.id)
    OR EXISTS(SELECT 1 FROM products WHERE corrected_from_product_id=p.id OR corrected_to_product_id=p.id) THEN
    reasons:=array_append(reasons,'CORRECTION_HISTORY'); END IF;
  IF NOT EXISTS(SELECT 1 FROM product_full_export_state WHERE product_id=p.id AND route<>'retired') THEN
    reasons:=array_append(reasons,'LIFECYCLE_NOT_CURRENT'); END IF;
  IF EXISTS(SELECT 1 FROM correction_requests WHERE (source_product_id=p.id OR corrected_product_id=p.id)
    AND status IN ('pending','in_progress')) THEN reasons:=array_append(reasons,'ACTIVE_CORRECTION'); END IF;
  IF EXISTS(SELECT 1 FROM magento_product_sync_requests WHERE public_product_identity_id=p.public_product_identity_id
      AND (state IN ('pending','syncing') OR active_job_id IS NOT NULL))
    OR EXISTS(SELECT 1 FROM magento_sync_jobs WHERE public_product_identity_id=p.public_product_identity_id AND state NOT IN ('succeeded','superseded'))
    OR EXISTS(SELECT 1 FROM product_media_jobs WHERE public_product_identity_id=p.public_product_identity_id AND state NOT IN ('succeeded','superseded'))
    OR EXISTS(SELECT 1 FROM product_visibility_intents WHERE public_product_identity_id=p.public_product_identity_id AND state NOT IN ('verified','superseded'))
    OR EXISTS(SELECT 1 FROM historical_reactivation_intents WHERE public_product_identity_id=p.public_product_identity_id AND state<>'completed')
    OR EXISTS(SELECT 1 FROM historical_standard_intents WHERE public_product_identity_id=p.public_product_identity_id AND state NOT IN ('completed','cancelled'))
    OR EXISTS(SELECT 1 FROM magento_test_deletions WHERE public_product_identity_id=p.public_product_identity_id AND state<>'finalized') THEN
    reasons:=array_append(reasons,'UNFINISHED_DELIVERY_WORK'); END IF;
  answer:=p.details#>'{answers,weight}'; source_text:=btrim(p.details#>>'{answers,weight}');
  IF (SELECT count(*) FROM questions WHERE category_code='SV' AND key='weight')=1 THEN
    SELECT * INTO q FROM questions WHERE category_code='SV' AND key='weight'; END IF;
  BEGIN
    IF q.id IS NULL OR q.archived OR q.input_type<>'text' OR q.include_in_sku<>0
      OR jsonb_typeof(answer) NOT IN ('string','number') OR source_text IS NULL
      OR length(source_text)>128 OR source_text !~ '^\+?[0-9]+([.,][0-9]{1,3})?$' THEN
      RAISE EXCEPTION 'Invalid source'; END IF;
    weight_value:=replace(source_text,',','.')::numeric(14,3);
    IF weight_value<=0 THEN RAISE EXCEPTION 'Nonpositive source'; END IF;
    rules:=q.numeric_validation;
    IF rules IS NOT NULL THEN
      IF coalesce(rules->>'kind','') NOT IN ('integer','decimal')
        OR (rules->>'kind'='integer' AND source_text ~ '[.,]')
        OR (rules->>'maxFractionDigits' IS NOT NULL AND length(split_part(replace(source_text,',','.'),'.',2))>(rules->>'maxFractionDigits')::int)
        OR (rules->>'min' IS NOT NULL AND (weight_value<(rules->>'min')::numeric OR (weight_value=(rules->>'min')::numeric AND NOT coalesce((rules->>'minInclusive')::boolean,TRUE))))
        OR (rules->>'max' IS NOT NULL AND (weight_value>(rules->>'max')::numeric OR (weight_value=(rules->>'max')::numeric AND NOT coalesce((rules->>'maxInclusive')::boolean,TRUE)))) THEN
        RAISE EXCEPTION 'Numeric rules'; END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    weight_value:=NULL; reasons:=array_append(reasons,'QUESTION_WEIGHT_NOT_UNAMBIGUOUS_POSITIVE');
  END;
  RETURN jsonb_build_object('eligible',cardinality(reasons)=0,'reasonCodes',to_jsonb(reasons),
    'targetWeight',weight_value::text,'sourceAnswer',answer,'weightQuestionId',q.id);
END $$;

CREATE TABLE product_weight_repair_plans (
  plan_hash TEXT PRIMARY KEY CHECK(plan_hash ~ '^[a-f0-9]{64}$'),
  manifest_text TEXT NOT NULL CHECK(octet_length(manifest_text)<=33554432),
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id),
  transaction_id BIGINT NOT NULL DEFAULT txid_current(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(encode(sha256(convert_to(manifest_text,'UTF8')),'hex')=plan_hash)
);
CREATE TABLE product_weight_repair_receipts (
  id UUID PRIMARY KEY,
  plan_hash TEXT NOT NULL REFERENCES product_weight_repair_plans(plan_hash),
  product_id INTEGER NOT NULL REFERENCES products(id),
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id),
  direction TEXT NOT NULL CHECK(direction IN ('apply','rollback')),
  inverse_of UUID UNIQUE REFERENCES product_weight_repair_receipts(id),
  before_state JSONB NOT NULL CHECK(octet_length(before_state::text)<=1048576),
  after_state JSONB NOT NULL CHECK(octet_length(after_state::text)<=1048576),
  source_answer JSONB NOT NULL,
  weight_question_id INTEGER NOT NULL REFERENCES questions(id),
  target_weight NUMERIC(14,3) NOT NULL,
  transaction_id BIGINT NOT NULL DEFAULT txid_current(),
  state TEXT NOT NULL DEFAULT 'sealed' CHECK(state IN ('sealed','applied')),
  audit_event_id BIGINT UNIQUE REFERENCES audit_events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  UNIQUE(plan_hash,product_id),
  CHECK((direction='apply')=(inverse_of IS NULL)),
  CHECK((state='applied')=(audit_event_id IS NOT NULL)),
  CHECK((state='applied')=(completed_at IS NOT NULL))
);
CREATE FUNCTION guard_weight_repair_plan() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE manifest JSONB;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Canonical weight plans are permanent'; END IF;
  manifest:=NEW.manifest_text::jsonb;
  IF current_setting('amber.canonical_weight_repair_plan',true) IS DISTINCT FROM NEW.plan_hash
    OR NEW.transaction_id<>txid_current() OR manifest->>'format'<>'sv-canonical-weight-repair-v1'
    OR manifest->>'database' IS DISTINCT FROM current_database()
    OR manifest->>'configurationText' IS DISTINCT FROM sv_weight_repair_configuration(manifest->>'bindingRevisionId')::text
    OR jsonb_array_length(manifest->'entries')>1000 THEN RAISE EXCEPTION 'SV_WEIGHT_REPAIR_PLAN_INVALID'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER weight_repair_plan_protected BEFORE INSERT OR UPDATE OR DELETE ON product_weight_repair_plans
  FOR EACH ROW EXECUTE FUNCTION guard_weight_repair_plan();
CREATE TRIGGER weight_repair_plan_no_truncate BEFORE TRUNCATE ON product_weight_repair_plans
  FOR EACH STATEMENT EXECUTE FUNCTION guard_weight_repair_plan();

CREATE FUNCTION guard_weight_repair_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE manifest JSONB; DECLARE entry JSONB; DECLARE p products; DECLARE source JSONB;
DECLARE original product_weight_repair_receipts;
BEGIN
  IF TG_OP NOT IN ('INSERT','UPDATE') THEN RAISE EXCEPTION 'Canonical weight receipts are permanent'; END IF;
  IF current_setting('amber.canonical_weight_repair',true) IS DISTINCT FROM NEW.id::text
    OR NEW.transaction_id<>txid_current() THEN RAISE EXCEPTION 'SV_WEIGHT_REPAIR_CONTEXT'; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.state<>'sealed' OR NEW.state<>'applied' OR NEW.audit_event_id IS NULL OR NEW.completed_at IS NULL
      OR (to_jsonb(NEW)-ARRAY['state','audit_event_id','completed_at']) IS DISTINCT FROM
        (to_jsonb(OLD)-ARRAY['state','audit_event_id','completed_at']) THEN
      RAISE EXCEPTION 'Canonical weight receipt is immutable'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.state<>'sealed' OR NEW.audit_event_id IS NOT NULL OR NEW.completed_at IS NOT NULL THEN RAISE EXCEPTION 'SV_WEIGHT_REPAIR_CONTEXT'; END IF;
  IF NOT EXISTS(SELECT 1 FROM application_users u WHERE u.id=NEW.actor_user_id AND u.status='active'
    AND NOT EXISTS(SELECT wanted FROM unnest(ARRAY['exports.reconcile','products.recount']) wanted
      WHERE NOT EXISTS(SELECT 1 FROM user_role_assignments a JOIN roles r ON r.id=a.role_id AND r.status='active'
        JOIN role_permissions rp ON rp.role_id=r.id WHERE a.application_user_id=u.id AND a.revoked_at IS NULL AND rp.permission_key=wanted))) THEN
    RAISE EXCEPTION 'SV_WEIGHT_REPAIR_ACTOR'; END IF;
  SELECT manifest_text::jsonb INTO manifest FROM product_weight_repair_plans WHERE plan_hash=NEW.plan_hash;
  SELECT value INTO entry FROM jsonb_array_elements(manifest->'entries') WHERE (value->>'productId')::int=NEW.product_id;
  IF entry IS NULL OR entry->>'eligible' IS DISTINCT FROM 'true' OR manifest->>'direction' IS DISTINCT FROM NEW.direction
    OR manifest->>'configurationText' IS DISTINCT FROM sv_weight_repair_configuration(manifest->>'bindingRevisionId')::text
    OR (entry->>'beforeEvidence')::jsonb IS DISTINCT FROM NEW.before_state
    OR sv_weight_repair_state(NEW.product_id) IS DISTINCT FROM NEW.before_state
    OR NEW.after_state IS DISTINCT FROM jsonb_set(NEW.before_state,'{product,weight}',to_jsonb(NEW.target_weight))
    OR (entry->>'targetWeight')::numeric IS DISTINCT FROM NEW.target_weight
    OR entry->>'beforeFingerprint' IS DISTINCT FROM encode(sha256(convert_to(NEW.before_state::text,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'SV_WEIGHT_REPAIR_STALE'; END IF;
  SELECT * INTO p FROM products WHERE id=NEW.product_id;
  source:=sv_weight_repair_candidate(p,NEW.direction='apply');
  IF source->>'eligible' IS DISTINCT FROM 'true' OR source->'sourceAnswer' IS DISTINCT FROM NEW.source_answer
    OR (source->>'weightQuestionId')::int IS DISTINCT FROM NEW.weight_question_id THEN RAISE EXCEPTION 'SV_WEIGHT_REPAIR_SOURCE'; END IF;
  IF NEW.direction='apply' THEN
    IF NEW.target_weight IS DISTINCT FROM (source->>'targetWeight')::numeric THEN RAISE EXCEPTION 'SV_WEIGHT_REPAIR_SOURCE'; END IF;
  ELSE
    SELECT * INTO original FROM product_weight_repair_receipts WHERE id=NEW.inverse_of;
    IF original.id IS NULL OR original.state<>'applied' OR original.direction<>'apply' OR original.product_id<>NEW.product_id
      OR entry->>'originalReceiptId' IS DISTINCT FROM original.id::text OR NEW.target_weight<>0
      OR NEW.before_state IS DISTINCT FROM original.after_state OR NEW.after_state IS DISTINCT FROM original.before_state
      OR NEW.source_answer IS DISTINCT FROM original.source_answer OR NEW.weight_question_id<>original.weight_question_id THEN
      RAISE EXCEPTION 'SV_WEIGHT_REPAIR_ROLLBACK_STALE'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER weight_repair_receipt_protected BEFORE INSERT OR UPDATE OR DELETE ON product_weight_repair_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_weight_repair_receipt();
CREATE TRIGGER weight_repair_receipt_no_truncate BEFORE TRUNCATE ON product_weight_repair_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION guard_weight_repair_receipt();

CREATE FUNCTION require_weight_repair_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt product_weight_repair_receipts; DECLARE event audit_events; DECLARE manifest JSONB;
BEGIN
  IF TG_TABLE_NAME='product_weight_repair_plans' THEN
    IF NOT EXISTS(SELECT 1 FROM product_weight_repair_receipts WHERE plan_hash=NEW.plan_hash AND transaction_id=NEW.transaction_id AND state='applied') THEN
      RAISE EXCEPTION 'SV_WEIGHT_REPAIR_INCOMPLETE'; END IF;
    RETURN NULL;
  END IF;
  SELECT * INTO receipt FROM product_weight_repair_receipts WHERE id=NEW.id;
  SELECT * INTO event FROM audit_events WHERE id=receipt.audit_event_id;
  SELECT manifest_text::jsonb INTO manifest FROM product_weight_repair_plans WHERE plan_hash=receipt.plan_hash;
  IF receipt.state<>'applied' OR receipt.transaction_id<>txid_current()
    OR manifest->>'configurationText' IS DISTINCT FROM sv_weight_repair_configuration(manifest->>'bindingRevisionId')::text
    OR sv_weight_repair_state(receipt.product_id) IS DISTINCT FROM receipt.after_state
    OR event.id IS NULL OR event.actor_user_id<>receipt.actor_user_id
    OR event.subject_type<>'canonical_weight_repair' OR event.subject_id<>receipt.id::text
    OR event.event_key IS DISTINCT FROM (CASE WHEN receipt.direction='apply' THEN 'product.canonical_weight_repaired' ELSE 'product.canonical_weight_rolled_back' END)
    OR event.details->>'planHash' IS DISTINCT FROM receipt.plan_hash
    OR (event.details->>'productId')::int IS DISTINCT FROM receipt.product_id
    OR event.details->>'beforeFingerprint' IS DISTINCT FROM encode(sha256(convert_to(receipt.before_state::text,'UTF8')),'hex')
    OR event.details->>'afterFingerprint' IS DISTINCT FROM encode(sha256(convert_to(receipt.after_state::text,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'SV_WEIGHT_REPAIR_INCOMPLETE'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER weight_repair_plan_complete AFTER INSERT ON product_weight_repair_plans
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_weight_repair_completion();
CREATE CONSTRAINT TRIGGER weight_repair_receipt_complete AFTER INSERT OR UPDATE ON product_weight_repair_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_weight_repair_completion();

CREATE FUNCTION assert_weight_repair_product_delta(old_product products,new_product products) RETURNS void LANGUAGE plpgsql AS $$
DECLARE receipt product_weight_repair_receipts;
BEGIN
  SELECT * INTO receipt FROM product_weight_repair_receipts
    WHERE id=current_setting('amber.canonical_weight_repair',true)::uuid;
  IF receipt.id IS NULL OR receipt.transaction_id<>txid_current() OR receipt.state<>'sealed'
    OR receipt.product_id<>new_product.id OR to_jsonb(old_product) IS DISTINCT FROM receipt.before_state->'product'
    OR to_jsonb(new_product) IS DISTINCT FROM receipt.after_state->'product'
    OR (to_jsonb(old_product)-'weight') IS DISTINCT FROM (to_jsonb(new_product)-'weight') THEN
    RAISE EXCEPTION 'SV_WEIGHT_REPAIR_DELTA'; END IF;
END $$;
CREATE OR REPLACE FUNCTION request_magento_product_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active BOOLEAN;
DECLARE desired_product INTEGER;
BEGIN
  IF TG_OP='UPDATE' AND magento_sync_product_input(NEW) IS NOT DISTINCT FROM magento_sync_product_input(OLD) THEN
    RETURN NEW;
  END IF;
  -- A receipt authorizes exactly one weight-only bookkeeping delta in this transaction.
  -- All normal writes retain the original request/generation/retirement behavior.
  IF TG_OP='UPDATE' AND NULLIF(current_setting('amber.canonical_weight_repair',true),'') IS NOT NULL THEN
    PERFORM assert_weight_repair_product_delta(OLD,NEW);
    RETURN NEW;
  END IF;
  SELECT enabled INTO active FROM magento_auto_sync_activation WHERE singleton FOR SHARE;
  IF active IS NOT TRUE THEN RETURN NEW; END IF;

  -- A recount successor is inserted before its source is retired. Once the
  -- identity request points at that successor, source retirement is not a
  -- second desired remote obligation.
  IF NEW.status <> 'active' OR NEW.corrected_to_product_id IS NOT NULL THEN
    SELECT product_id INTO desired_product FROM magento_product_sync_requests
    WHERE public_product_identity_id = NEW.public_product_identity_id;
    IF desired_product IS NULL OR desired_product <> NEW.id THEN RETURN NEW; END IF;
  END IF;

  INSERT INTO magento_product_sync_requests(public_product_identity_id,product_id)
  VALUES(NEW.public_product_identity_id,NEW.id)
  ON CONFLICT(public_product_identity_id) DO UPDATE SET
    product_id=EXCLUDED.product_id,
    desired_generation=magento_product_sync_requests.desired_generation+1,
    state=CASE WHEN magento_product_sync_requests.reason_code='reconciliation_required'
      THEN 'needs_attention' ELSE 'pending' END,
    reason_code=CASE WHEN magento_product_sync_requests.reason_code='reconciliation_required'
      THEN 'reconciliation_required' ELSE NULL END,
    attempts=0,next_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;
