-- Reviewed canonical weight repair for every current legacy SV product, not only
-- souvenir stones (approved by the catalog owner on 2026-10-14). The candidate keeps
-- every 072 proof: exactly zero canonical weight, one positive recorded non-SKU answer,
-- legacy identity/reservation, no correction or unfinished delivery work. The repair
-- tool still requires an identical published-template result before and after.
-- Only the souvenir=5 scope condition is removed; no product or delivery data changes.
CREATE OR REPLACE FUNCTION sv_weight_repair_candidate(p products, require_zero BOOLEAN DEFAULT TRUE)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE reasons TEXT[] := '{}'; DECLARE q questions; DECLARE weight_value NUMERIC(14,3);
DECLARE answer JSONB; DECLARE source_text TEXT; DECLARE rules JSONB; DECLARE identity public_product_identities;
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
