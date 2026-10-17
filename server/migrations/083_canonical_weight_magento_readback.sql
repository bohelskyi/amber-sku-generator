-- Reviewed canonical weight from Magento decor_weight (approved by the catalog owner):
-- only current legacy SV rows with canonical weight exactly zero and an absent, JSON
-- null or zero recorded answer. The receipt copies the GET-only readback value into
-- products.weight and details.answers.weight; everything else, including stored
-- prices, SKU and identity, stays byte-identical. Existing recorded-answer receipts
-- keep their meaning. No backfill, enrollment, sync request or remote call.
ALTER TABLE product_weight_repair_receipts
  ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'recorded_answer' CHECK(source_kind IN ('recorded_answer','magento_readback')),
  ADD COLUMN target_answer JSONB,
  ADD COLUMN remote_evidence JSONB CHECK(remote_evidence IS NULL OR octet_length(remote_evidence::text)<=4096),
  ADD CONSTRAINT product_weight_repair_receipts_source_evidence
    CHECK((source_kind='magento_readback')=(target_answer IS NOT NULL AND remote_evidence IS NOT NULL));

CREATE FUNCTION sv_weight_numeric_rules_ok(rules JSONB, source_text TEXT, weight_value NUMERIC)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF rules IS NULL THEN RETURN TRUE; END IF;
  RETURN NOT coalesce(coalesce(rules->>'kind','') NOT IN ('integer','decimal')
    OR (rules->>'kind'='integer' AND source_text ~ '[.,]')
    OR (rules->>'maxFractionDigits' IS NOT NULL AND length(split_part(replace(source_text,',','.'),'.',2))>(rules->>'maxFractionDigits')::int)
    OR (rules->>'min' IS NOT NULL AND (weight_value<(rules->>'min')::numeric OR (weight_value=(rules->>'min')::numeric AND NOT coalesce((rules->>'minInclusive')::boolean,TRUE))))
    OR (rules->>'max' IS NOT NULL AND (weight_value>(rules->>'max')::numeric OR (weight_value=(rules->>'max')::numeric AND NOT coalesce((rules->>'maxInclusive')::boolean,TRUE)))),FALSE);
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END $$;

CREATE FUNCTION sv_weight_magento_candidate(p products, require_zero BOOLEAN DEFAULT TRUE)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE reasons TEXT[] := '{}'; DECLARE q questions; DECLARE answer JSONB; DECLARE source_text TEXT;
DECLARE identity public_product_identities;
BEGIN
  IF p.category IS DISTINCT FROM 'SV' OR p.status IS DISTINCT FROM 'active'
    OR p.corrected_to_product_id IS NOT NULL
    OR p.full_sku IS NULL OR p.sku_schema_version_id IS NULL OR p.characteristic_version_id IS NOT NULL THEN
    reasons:=array_append(reasons,'NOT_CURRENT_LEGACY_SV'); END IF;
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
  IF (SELECT count(*) FROM questions WHERE category_code='SV' AND key='weight')=1 THEN
    SELECT * INTO q FROM questions WHERE category_code='SV' AND key='weight'; END IF;
  IF q.id IS NULL OR q.archived OR q.input_type<>'text' OR q.include_in_sku<>0 THEN
    reasons:=array_append(reasons,'WEIGHT_QUESTION_NOT_UNAMBIGUOUS'); END IF;
  IF (SELECT count(*) FROM categories WHERE code='SV' AND requires_weight=0)<>1 THEN
    reasons:=array_append(reasons,'WEIGHT_ENCODED_SKU'); END IF;
  answer:=p.details#>'{answers,weight}';
  IF jsonb_typeof(p.details->'answers') IS DISTINCT FROM 'object' THEN
    reasons:=array_append(reasons,'ANSWER_NOT_MISSING_OR_ZERO');
  ELSIF require_zero AND answer IS NOT NULL AND jsonb_typeof(answer)<>'null' THEN
    source_text:=btrim(answer#>>'{}');
    IF jsonb_typeof(answer) NOT IN ('string','number') OR source_text IS NULL OR length(source_text)>128 THEN
      reasons:=array_append(reasons,'ANSWER_NOT_MISSING_OR_ZERO');
    ELSIF source_text ~ '^\+?0+([.,]0+)?$' THEN NULL;
    ELSIF source_text ~ '^\+?[0-9]+([.,][0-9]+)?$' THEN reasons:=array_append(reasons,'RECORDED_ANSWER_LANE');
    ELSE reasons:=array_append(reasons,'ANSWER_NOT_MISSING_OR_ZERO'); END IF;
  END IF;
  RETURN jsonb_build_object('eligible',cardinality(reasons)=0,'reasonCodes',to_jsonb(reasons),
    'sourceAnswer',answer,'sourceAnswerPresent',answer IS NOT NULL,'weightQuestionId',q.id);
END $$;

CREATE OR REPLACE FUNCTION guard_weight_repair_plan() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE manifest JSONB;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Canonical weight plans are permanent'; END IF;
  manifest:=NEW.manifest_text::jsonb;
  IF current_setting('amber.canonical_weight_repair_plan',true) IS DISTINCT FROM NEW.plan_hash
    OR NEW.transaction_id<>txid_current()
    OR manifest->>'format' IS NULL OR manifest->>'format' NOT IN ('sv-canonical-weight-repair-v1','sv-canonical-weight-magento-v1')
    OR manifest->>'database' IS DISTINCT FROM current_database()
    OR manifest->>'configurationText' IS DISTINCT FROM sv_weight_repair_configuration(manifest->>'bindingRevisionId')::text
    OR jsonb_array_length(manifest->'entries')>1000 THEN RAISE EXCEPTION 'SV_WEIGHT_REPAIR_PLAN_INVALID'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_weight_repair_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE manifest JSONB; DECLARE entry JSONB; DECLARE p products; DECLARE source JSONB;
DECLARE original product_weight_repair_receipts; DECLARE q questions; DECLARE remote_text TEXT; DECLARE remote_value NUMERIC;
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
  IF (manifest->>'format'='sv-canonical-weight-magento-v1') IS DISTINCT FROM (NEW.source_kind='magento_readback') THEN
    RAISE EXCEPTION 'SV_WEIGHT_REPAIR_STALE'; END IF;
  IF NEW.source_kind='recorded_answer' THEN
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
        OR original.source_kind<>'recorded_answer'
        OR entry->>'originalReceiptId' IS DISTINCT FROM original.id::text OR NEW.target_weight<>0
        OR NEW.before_state IS DISTINCT FROM original.after_state OR NEW.after_state IS DISTINCT FROM original.before_state
        OR NEW.source_answer IS DISTINCT FROM original.source_answer OR NEW.weight_question_id<>original.weight_question_id THEN
        RAISE EXCEPTION 'SV_WEIGHT_REPAIR_ROLLBACK_STALE'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  -- magento_readback: the plan entry, exact current state and remote evidence agree.
  IF entry IS NULL OR entry->>'eligible' IS DISTINCT FROM 'true' OR manifest->>'direction' IS DISTINCT FROM NEW.direction
    OR manifest->>'configurationText' IS DISTINCT FROM sv_weight_repair_configuration(manifest->>'bindingRevisionId')::text
    OR (entry->>'beforeEvidence')::jsonb IS DISTINCT FROM NEW.before_state
    OR sv_weight_repair_state(NEW.product_id) IS DISTINCT FROM NEW.before_state
    OR (entry->>'targetWeight')::numeric IS DISTINCT FROM NEW.target_weight
    OR entry->'targetAnswer' IS DISTINCT FROM NEW.target_answer OR entry->'remoteEvidence' IS DISTINCT FROM NEW.remote_evidence
    OR entry->'sourceAnswer' IS DISTINCT FROM NEW.source_answer
    OR (entry->>'weightQuestionId')::int IS DISTINCT FROM NEW.weight_question_id
    OR entry->>'beforeFingerprint' IS DISTINCT FROM encode(sha256(convert_to(NEW.before_state::text,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'SV_WEIGHT_REPAIR_STALE'; END IF;
  SELECT * INTO p FROM products WHERE id=NEW.product_id;
  source:=sv_weight_magento_candidate(p,NEW.direction='apply');
  IF source->>'eligible' IS DISTINCT FROM 'true' OR (source->>'weightQuestionId')::int IS DISTINCT FROM NEW.weight_question_id THEN
    RAISE EXCEPTION 'SV_WEIGHT_REPAIR_SOURCE'; END IF;
  IF NEW.direction='apply' THEN
    SELECT * INTO q FROM questions WHERE id=NEW.weight_question_id;
    remote_text:=btrim(NEW.remote_evidence->>'value');
    IF remote_text IS NULL OR length(remote_text)>128 OR remote_text !~ '^\+?[0-9]+([.,][0-9]+)?$' THEN RAISE EXCEPTION 'SV_WEIGHT_REPAIR_SOURCE'; END IF;
    remote_value:=trim_scale(replace(remote_text,',','.')::numeric);
    IF NEW.target_weight<=0 OR scale(remote_value)>3 OR remote_value IS DISTINCT FROM NEW.target_weight
      OR NEW.target_answer IS DISTINCT FROM to_jsonb(trim_scale(NEW.target_weight)::text)
      OR NOT sv_weight_numeric_rules_ok(q.numeric_validation,trim_scale(NEW.target_weight)::text,NEW.target_weight)
      OR source->'sourceAnswer' IS DISTINCT FROM NEW.source_answer
      OR jsonb_typeof(NEW.remote_evidence)<>'object'
      OR (SELECT count(*) FROM jsonb_object_keys(NEW.remote_evidence))<>9
      OR NEW.remote_evidence->>'target' IS DISTINCT FROM 'decor_weight' OR NEW.remote_evidence->>'scope' IS DISTINCT FROM 'all'
      OR NEW.remote_evidence->>'sku' IS DISTINCT FROM NEW.before_state#>>'{identity,public_sku}'
      OR NEW.remote_evidence->>'fieldReason' IS DISTINCT FROM 'FIRST_SYNC_LEGACY_MISSING_ONLY_REVIEW_REQUIRED'
      OR NEW.remote_evidence->>'bindingRevisionId' IS DISTINCT FROM manifest->>'bindingRevisionId'
      OR NEW.remote_evidence->>'definitionHash' IS DISTINCT FROM (manifest->>'configurationText')::jsonb#>>'{binding,definition_hash}'
      OR coalesce(NEW.remote_evidence->>'remoteProductId','') !~ '^[1-9][0-9]{0,18}$'
      OR NEW.after_state IS DISTINCT FROM jsonb_set(jsonb_set(NEW.before_state,'{product,weight}',to_jsonb(NEW.target_weight)),
        '{product,details,answers,weight}',NEW.target_answer) THEN
      RAISE EXCEPTION 'SV_WEIGHT_REPAIR_SOURCE'; END IF;
  ELSE
    SELECT * INTO original FROM product_weight_repair_receipts WHERE id=NEW.inverse_of;
    IF original.id IS NULL OR original.state<>'applied' OR original.direction<>'apply' OR original.product_id<>NEW.product_id
      OR original.source_kind<>'magento_readback'
      OR entry->>'originalReceiptId' IS DISTINCT FROM original.id::text OR NEW.target_weight<>0
      OR NEW.before_state IS DISTINCT FROM original.after_state OR NEW.after_state IS DISTINCT FROM original.before_state
      OR NEW.source_answer IS DISTINCT FROM original.source_answer OR NEW.weight_question_id<>original.weight_question_id
      OR NEW.target_answer IS DISTINCT FROM original.target_answer OR NEW.remote_evidence IS DISTINCT FROM original.remote_evidence THEN
      RAISE EXCEPTION 'SV_WEIGHT_REPAIR_ROLLBACK_STALE'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION require_weight_repair_completion() RETURNS trigger LANGUAGE plpgsql AS $$
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
    OR event.details->>'sourceKind' IS DISTINCT FROM receipt.source_kind
    OR (receipt.source_kind='magento_readback' AND (event.details->'remoteEvidence' IS DISTINCT FROM receipt.remote_evidence
      OR event.details->'targetAnswer' IS DISTINCT FROM receipt.target_answer))
    OR event.details->>'beforeFingerprint' IS DISTINCT FROM encode(sha256(convert_to(receipt.before_state::text,'UTF8')),'hex')
    OR event.details->>'afterFingerprint' IS DISTINCT FROM encode(sha256(convert_to(receipt.after_state::text,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'SV_WEIGHT_REPAIR_INCOMPLETE'; END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION assert_weight_repair_product_delta(old_product products,new_product products) RETURNS void LANGUAGE plpgsql AS $$
DECLARE receipt product_weight_repair_receipts;
BEGIN
  SELECT * INTO receipt FROM product_weight_repair_receipts
    WHERE id=current_setting('amber.canonical_weight_repair',true)::uuid;
  IF receipt.id IS NULL OR receipt.transaction_id<>txid_current() OR receipt.state<>'sealed'
    OR receipt.product_id<>new_product.id OR to_jsonb(old_product) IS DISTINCT FROM receipt.before_state->'product'
    OR to_jsonb(new_product) IS DISTINCT FROM receipt.after_state->'product' THEN
    RAISE EXCEPTION 'SV_WEIGHT_REPAIR_DELTA'; END IF;
  IF receipt.source_kind='magento_readback' THEN
    IF (to_jsonb(old_product)-ARRAY['weight','details'])::text IS DISTINCT FROM (to_jsonb(new_product)-ARRAY['weight','details'])::text
      OR (old_product.details #- '{answers,weight}')::text IS DISTINCT FROM (new_product.details #- '{answers,weight}')::text THEN
      RAISE EXCEPTION 'SV_WEIGHT_REPAIR_DELTA'; END IF;
  ELSIF (to_jsonb(old_product)-'weight') IS DISTINCT FROM (to_jsonb(new_product)-'weight') THEN
    RAISE EXCEPTION 'SV_WEIGHT_REPAIR_DELTA'; END IF;
END $$;
