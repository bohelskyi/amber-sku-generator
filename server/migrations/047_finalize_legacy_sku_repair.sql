-- Finalize only explicitly staged schema-045 legacy SKU collision repairs.
-- Migration 046 remains immutable. This migration performs no Magento write,
-- activation, delivery cutover, correction, SKU rewrite, or registry rewrite.

DO $$
DECLARE duplicate_target RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name='046_stable_public_product_sku.sql') THEN
    RAISE EXCEPTION 'migration 047 requires migration 046 stable public SKU infrastructure';
  END IF;
  IF EXISTS (SELECT 1 FROM audit_events WHERE event_key='legacy_sku_repair.staged'
      AND subject_type='legacy_sku_repair_plan')
    AND (SELECT enabled FROM public_sku_activation WHERE singleton) IS NOT FALSE THEN
    RAISE EXCEPTION 'legacy SKU repair requires stable public SKU activation to remain disabled';
  END IF;
  IF EXISTS (SELECT 1 FROM audit_events WHERE event_key='legacy_sku_repair.staged'
      AND subject_type='legacy_sku_repair_plan')
    AND EXISTS (SELECT 1 FROM magento_auto_sync_activation WHERE singleton
      AND (enabled OR NOT legacy_product_csv_enabled OR cutover_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'legacy SKU repair requires automatic delivery disabled and legacy CSV uncut';
  END IF;
  IF EXISTS (SELECT 1 FROM audit_events WHERE event_key='legacy_sku_repair.staged'
      AND subject_type='legacy_sku_repair_plan')
    AND (SELECT phase FROM full_product_export_activation WHERE singleton) IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'legacy SKU repair requires active full-product lifecycle';
  END IF;
  IF EXISTS (SELECT subject_id FROM audit_events
    WHERE event_key='legacy_sku_repair.staged' AND subject_type='legacy_sku_repair_plan'
    GROUP BY subject_id HAVING count(*) <> 1) THEN
    RAISE EXCEPTION 'legacy SKU repair staging receipts are ambiguous';
  END IF;
  IF EXISTS (SELECT 1 FROM audit_events product_event
    WHERE product_event.event_key IN
      ('product.legacy_duplicate_retired','product.legacy_public_identity_staged')
      AND NOT EXISTS (SELECT 1 FROM audit_events plan_event
        WHERE plan_event.event_key='legacy_sku_repair.staged'
          AND plan_event.subject_type='legacy_sku_repair_plan'
          AND plan_event.subject_id=product_event.details->>'planHash')) THEN
    RAISE EXCEPTION 'legacy SKU repair has orphaned per-product staging evidence';
  END IF;
  SELECT target->>'productId' AS product_id INTO duplicate_target
  FROM audit_events event
  CROSS JOIN LATERAL jsonb_array_elements(
    ((event.details->>'canonicalReceipt')::jsonb)->'targets') target
  WHERE event.event_key='legacy_sku_repair.staged'
    AND event.subject_type='legacy_sku_repair_plan'
  GROUP BY target->>'productId' HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'legacy SKU repair product appears in multiple plans'; END IF;
  EXECUTE $function$
    CREATE OR REPLACE FUNCTION guard_product_public_identity_reference() RETURNS trigger LANGUAGE plpgsql AS $guard$
    DECLARE plan_hash TEXT;
    BEGIN
      IF NEW.public_product_identity_id IS NOT DISTINCT FROM OLD.public_product_identity_id THEN
        RETURN NEW;
      END IF;
      plan_hash := current_setting('amber.legacy_sku_repair_plan', TRUE);
      IF plan_hash ~ '^[a-f0-9]{64}$'
        AND OLD.status='archived'
        AND EXISTS (
          SELECT 1
          FROM audit_events event
          CROSS JOIN LATERAL jsonb_array_elements(
            ((event.details->>'canonicalReceipt')::jsonb)->'targets') target
          JOIN public_product_identities identity ON identity.id=NEW.public_product_identity_id
          WHERE event.event_key='legacy_sku_repair.staged'
            AND event.subject_type='legacy_sku_repair_plan'
            AND event.subject_id=plan_hash
            AND event.details->>'planHash'=plan_hash
            AND target->>'action'='split_public_identity'
            AND (target->>'productId')::integer=OLD.id
            AND target->>'sku'=OLD.full_sku
            AND identity.origin='allocated'
            AND identity.allocation_number IS NOT NULL
        ) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'product public identity is immutable';
    END;
    $guard$
  $function$;
END;
$$;

-- The exception exists only while this migration transaction is running. It is
-- bound to the current plan hash, immutable staging audit, exact product row and
-- a newly inserted allocated identity. The strict runtime function is restored
-- below before commit.
DO $$
DECLARE
  event RECORD;
  receipt JSONB;
  plan JSONB;
  target JSONB;
  decision JSONB;
  plan_product JSONB;
  keeper_plan_product JSONB;
  original_product JSONB;
  staged_product JSONB;
  original_lifecycle JSONB;
  staged_lifecycle JSONB;
  product_row RECORD;
  expected_product_row RECORD;
  lifecycle_row RECORD;
  expected_lifecycle_row RECORD;
  keeper_row RECORD;
  keeper_lifecycle_row RECORD;
  current_registry JSONB;
  legacy_identity RECORD;
  allocation BIGINT;
  allocated_identity BIGINT;
  allocated_sku TEXT;
  allocations JSONB;
  individual_event_key TEXT;
  individual_count BIGINT;
  changed_count BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name='046_stable_public_product_sku.sql') THEN
    RAISE EXCEPTION 'migration 047 requires migration 046 stable public SKU infrastructure';
  END IF;
  FOR event IN
    SELECT * FROM audit_events
    WHERE event_key='legacy_sku_repair.staged' AND subject_type='legacy_sku_repair_plan'
    ORDER BY id
  LOOP
    IF event.subject_id !~ '^[a-f0-9]{64}$'
      OR event.details - ARRAY['version','format','planHash','receiptHash','canonicalReceipt'] <> '{}'::jsonb
      OR event.details->'version' <> '2'::jsonb
      OR event.details->>'format' IS DISTINCT FROM 'amber-legacy-sku-repair-staging-receipt-v2'
      OR event.details->>'planHash' IS DISTINCT FROM event.subject_id
      OR event.details->>'receiptHash' !~ '^[a-f0-9]{64}$'
      OR event.details->>'canonicalReceipt' IS NULL
      OR EXISTS (SELECT 1 FROM audit_events final
        WHERE final.event_key='legacy_sku_repair.finalized'
          AND final.subject_type='legacy_sku_repair_plan' AND final.subject_id=event.subject_id) THEN
      RAISE EXCEPTION 'legacy SKU repair staging receipt is incomplete or already finalized';
    END IF;

    receipt := (event.details->>'canonicalReceipt')::jsonb;
    IF event.details->>'canonicalReceipt' IS DISTINCT FROM receipt::text
      OR event.details->>'receiptHash' IS DISTINCT FROM
        encode(sha256(convert_to(receipt::text,'UTF8')),'hex')
      OR receipt - ARRAY['format','planHash','database','actorUserId','plan','targets','magentoCreateProductIds'] <> '{}'::jsonb
      OR receipt->>'format' IS DISTINCT FROM 'amber-legacy-sku-repair-staging-receipt-v2'
      OR receipt->>'planHash' IS DISTINCT FROM event.subject_id
      OR receipt->>'database' IS DISTINCT FROM current_database()
      OR (receipt->>'actorUserId')::bigint IS DISTINCT FROM event.actor_user_id
      OR jsonb_typeof(receipt->'plan') IS DISTINCT FROM 'object'
      OR jsonb_typeof(receipt->'targets') IS DISTINCT FROM 'array'
      OR jsonb_typeof(receipt->'magentoCreateProductIds') IS DISTINCT FROM 'array'
      OR jsonb_array_length(receipt->'targets') < 1 THEN
      RAISE EXCEPTION 'legacy SKU repair canonical staging receipt hash is invalid';
    END IF;

    plan := receipt->'plan';
    IF encode(sha256(convert_to(plan::text,'UTF8')),'hex') IS DISTINCT FROM event.subject_id
      OR plan - ARRAY['database','format','schemaCheckpoint','actorUserId','decisions','environment'] <> '{}'::jsonb
      OR plan->>'database' IS DISTINCT FROM current_database()
      OR plan->>'format' IS DISTINCT FROM 'amber-legacy-sku-repair-plan-v1'
      OR plan->>'schemaCheckpoint' IS DISTINCT FROM '045-pre-046'
      OR (plan->>'actorUserId')::bigint IS DISTINCT FROM event.actor_user_id
      OR jsonb_typeof(plan->'decisions') IS DISTINCT FROM 'array'
      OR jsonb_typeof(plan->'environment') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'legacy SKU repair canonical plan identity is invalid';
    END IF;

    IF (SELECT COALESCE(jsonb_agg((item->>'productId')::integer ORDER BY (item->>'productId')::integer),'[]'::jsonb)
        FROM jsonb_array_elements(receipt->'targets') item
        WHERE item->>'action'='split_public_identity')
      IS DISTINCT FROM
      (SELECT COALESCE(jsonb_agg(value::integer ORDER BY value::integer),'[]'::jsonb)
        FROM jsonb_array_elements_text(receipt->'magentoCreateProductIds') value) THEN
      RAISE EXCEPTION 'legacy SKU repair Magento follow-up scope is inconsistent';
    END IF;

    allocations := '[]'::jsonb;
    PERFORM set_config('amber.legacy_sku_repair_plan', event.subject_id, TRUE);
    FOR target IN SELECT value FROM jsonb_array_elements(receipt->'targets')
    LOOP
      IF target - ARRAY['action','sku','keeperProductId','productId','reason',
          'originalProduct','originalProductHash','stagedProduct','stagedProductHash',
          'originalLifecycle','originalLifecycleHash','stagedLifecycle','stagedLifecycleHash'] <> '{}'::jsonb
        OR target->>'action' NOT IN ('deduplicate','split_public_identity')
        OR target->>'sku' IS NULL OR target->>'sku' <> upper(btrim(target->>'sku'))
        OR target->>'keeperProductId' !~ '^[1-9][0-9]*$'
        OR target->>'productId' !~ '^[1-9][0-9]*$'
        OR target->>'reason' IS NULL OR length(btrim(target->>'reason')) NOT BETWEEN 1 AND 500
        OR jsonb_typeof(target->'originalProduct') IS DISTINCT FROM 'object'
        OR jsonb_typeof(target->'stagedProduct') IS DISTINCT FROM 'object'
        OR jsonb_typeof(target->'originalLifecycle') IS DISTINCT FROM 'object'
        OR jsonb_typeof(target->'stagedLifecycle') IS DISTINCT FROM 'object'
        OR target->>'originalProductHash' !~ '^[a-f0-9]{64}$'
        OR target->>'stagedProductHash' !~ '^[a-f0-9]{64}$'
        OR target->>'originalLifecycleHash' !~ '^[a-f0-9]{64}$'
        OR target->>'stagedLifecycleHash' !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION 'legacy SKU repair target evidence is malformed';
      END IF;
      IF (target->>'keeperProductId')::integer=(target->>'productId')::integer THEN
        RAISE EXCEPTION 'legacy SKU repair keeper cannot be a target';
      END IF;
      SELECT value INTO decision FROM jsonb_array_elements(plan->'decisions')
      WHERE value->>'sku'=target->>'sku'
        AND value->>'action'=target->>'action'
        AND value->>'keeperProductId'=target->>'keeperProductId'
        AND value->>'reason'=target->>'reason'
        AND value->'targetProductIds' @> jsonb_build_array((target->>'productId')::integer);
      IF NOT FOUND OR decision - ARRAY['sku','action','keeperProductId','targetProductIds','reason',
          'registry','currentProductIds','products','groupHash'] <> '{}'::jsonb
        OR jsonb_typeof(decision->'registry') IS DISTINCT FROM 'array'
        OR jsonb_typeof(decision->'products') IS DISTINCT FROM 'array'
        OR jsonb_typeof(decision->'currentProductIds') IS DISTINCT FROM 'array'
        OR jsonb_typeof(decision->'targetProductIds') IS DISTINCT FROM 'array'
        OR jsonb_array_length(decision->'registry') <> 1
        OR decision->'currentProductIds' IS DISTINCT FROM
          (SELECT jsonb_agg(id ORDER BY id) FROM (
            SELECT (decision->>'keeperProductId')::integer AS id
            UNION ALL SELECT value::integer FROM jsonb_array_elements_text(decision->'targetProductIds') value
          ) reviewed_ids)
        OR decision->'registry'->0->>'full_sku' IS DISTINCT FROM target->>'sku'
        OR (decision->'registry'->0->>'first_product_id')::integer
          IS DISTINCT FROM (target->>'keeperProductId')::integer
        OR decision->>'groupHash' IS DISTINCT FROM encode(sha256(convert_to(
          jsonb_build_object('registryRows',decision->'registry','products',decision->'products')::text,
          'UTF8')),'hex') THEN
        RAISE EXCEPTION 'legacy SKU repair target lacks its exact decision';
      END IF;

      SELECT value INTO plan_product FROM jsonb_array_elements(decision->'products')
      WHERE (value->>'id')::integer=(target->>'productId')::integer;
      SELECT value INTO keeper_plan_product FROM jsonb_array_elements(decision->'products')
      WHERE (value->>'id')::integer=(target->>'keeperProductId')::integer;
      IF plan_product IS NULL OR keeper_plan_product IS NULL
        OR plan_product->'row' IS DISTINCT FROM target->'originalProduct'
        OR plan_product->'lifecycle' IS DISTINCT FROM target->'originalLifecycle'
        OR plan_product->>'rowHash' IS DISTINCT FROM target->>'originalProductHash'
        OR plan_product->>'lifecycleHash' IS DISTINCT FROM target->>'originalLifecycleHash'
        OR plan_product->>'rowHash' IS DISTINCT FROM encode(sha256(convert_to(
          (plan_product->'row')::text,'UTF8')),'hex')
        OR plan_product->>'businessRowHash' IS DISTINCT FROM encode(sha256(convert_to(
          ((plan_product->'row') - ARRAY['id','created_at'])::text,'UTF8')),'hex')
        OR plan_product->>'lifecycleHash' IS DISTINCT FROM encode(sha256(convert_to(
          (plan_product->'lifecycle')::text,'UTF8')),'hex')
        OR keeper_plan_product->>'rowHash' IS DISTINCT FROM encode(sha256(convert_to(
          (keeper_plan_product->'row')::text,'UTF8')),'hex')
        OR keeper_plan_product->>'lifecycleHash' IS DISTINCT FROM encode(sha256(convert_to(
          (keeper_plan_product->'lifecycle')::text,'UTF8')),'hex') THEN
        RAISE EXCEPTION 'legacy SKU repair canonical plan product evidence is invalid';
      END IF;

      original_product := target->'originalProduct';
      staged_product := target->'stagedProduct';
      original_lifecycle := target->'originalLifecycle';
      staged_lifecycle := target->'stagedLifecycle';
      IF target->>'originalProductHash' IS DISTINCT FROM encode(sha256(convert_to(original_product::text,'UTF8')),'hex')
        OR target->>'stagedProductHash' IS DISTINCT FROM encode(sha256(convert_to(staged_product::text,'UTF8')),'hex')
        OR target->>'originalLifecycleHash' IS DISTINCT FROM encode(sha256(convert_to(original_lifecycle::text,'UTF8')),'hex')
        OR target->>'stagedLifecycleHash' IS DISTINCT FROM encode(sha256(convert_to(staged_lifecycle::text,'UTF8')),'hex')
        OR (target->>'action'='deduplicate' AND
          (original_product - ARRAY['id','created_at']) IS DISTINCT FROM
            ((keeper_plan_product->'row') - ARRAY['id','created_at']))
        OR original_product->>'id' IS DISTINCT FROM target->>'productId'
        OR staged_product->>'id' IS DISTINCT FROM target->>'productId'
        OR original_product->>'full_sku' IS DISTINCT FROM target->>'sku'
        OR staged_product->>'full_sku' IS DISTINCT FROM target->>'sku'
        OR original_product->>'status' IS DISTINCT FROM 'active'
        OR original_product->'corrected_to_product_id' <> 'null'::jsonb
        OR original_product->'corrected_from_product_id' <> 'null'::jsonb
        OR staged_product->>'status' IS DISTINCT FROM 'archived'
        OR (staged_product->>'exclude_from_export')::integer <> 1
        OR (staged_product->>'archived_by_user_id')::bigint <> event.actor_user_id
        OR (staged_product - ARRAY['status','exclude_from_export','archived_by_user_id'])
          IS DISTINCT FROM (original_product - ARRAY['status','exclude_from_export','archived_by_user_id'])
        OR original_lifecycle->>'product_id' IS DISTINCT FROM target->>'productId'
        OR staged_lifecycle->>'product_id' IS DISTINCT FROM target->>'productId'
        OR original_lifecycle->>'route' IS NOT DISTINCT FROM 'retired'
        OR staged_lifecycle->>'route' IS DISTINCT FROM 'retired'
        OR staged_lifecycle->'hold_reason' <> 'null'::jsonb
        OR (staged_lifecycle->>'delivery_version')::bigint
          <> (original_lifecycle->>'delivery_version')::bigint + 1
        OR (staged_lifecycle - ARRAY['route','hold_reason','delivery_version','updated_at'])
          IS DISTINCT FROM (original_lifecycle - ARRAY['route','hold_reason','delivery_version','updated_at']) THEN
        RAISE EXCEPTION 'legacy SKU repair staged transition is not the narrow reviewed transition';
      END IF;

      individual_event_key := CASE target->>'action'
        WHEN 'deduplicate' THEN 'product.legacy_duplicate_retired'
        ELSE 'product.legacy_public_identity_staged' END;
      SELECT count(*) INTO individual_count FROM audit_events proof
      WHERE proof.event_key=individual_event_key AND proof.subject_type='product'
        AND proof.actor_user_id=event.actor_user_id
        AND proof.subject_id=target->>'productId'
        AND proof.details->>'planHash'=event.subject_id
        AND proof.details->>'action'=target->>'action'
        AND proof.details->>'sku'=target->>'sku'
        AND proof.details->>'keeperProductId'=target->>'keeperProductId'
        AND proof.details->>'stagedProductHash'=target->>'stagedProductHash'
        AND proof.details->>'stagedLifecycleHash'=target->>'stagedLifecycleHash';
      IF individual_count <> 1 THEN
        RAISE EXCEPTION 'legacy SKU repair per-product audit evidence is missing or ambiguous';
      END IF;

      SELECT * INTO STRICT product_row FROM products WHERE id=(target->>'productId')::integer FOR UPDATE;
      SELECT * INTO STRICT lifecycle_row FROM product_full_export_state
        WHERE product_id=product_row.id FOR UPDATE;
      expected_product_row := jsonb_populate_record(NULL::products, staged_product);
      expected_product_row.public_product_identity_id := product_row.public_product_identity_id;
      expected_lifecycle_row := jsonb_populate_record(NULL::product_full_export_state, staged_lifecycle);
      IF product_row IS DISTINCT FROM expected_product_row
        OR lifecycle_row IS DISTINCT FROM expected_lifecycle_row THEN
        RAISE EXCEPTION 'legacy SKU repair staged product changed before finalization';
      END IF;
      SELECT * INTO STRICT keeper_row FROM products WHERE id=(target->>'keeperProductId')::integer FOR KEY SHARE;
      SELECT * INTO STRICT keeper_lifecycle_row FROM product_full_export_state
        WHERE product_id=keeper_row.id FOR KEY SHARE;
      SELECT to_jsonb(registry) INTO STRICT current_registry FROM sku_registry registry
        WHERE registry.full_sku=target->>'sku' FOR KEY SHARE;
      IF (to_jsonb(keeper_row) - 'public_product_identity_id')
          IS DISTINCT FROM keeper_plan_product->'row'
        OR to_jsonb(keeper_lifecycle_row) IS DISTINCT FROM keeper_plan_product->'lifecycle'
        OR current_registry IS DISTINCT FROM decision->'registry'->0
        OR keeper_row.full_sku IS DISTINCT FROM target->>'sku'
        OR keeper_row.status IS DISTINCT FROM 'active' OR keeper_row.corrected_to_product_id IS NOT NULL THEN
        RAISE EXCEPTION 'legacy SKU repair keeper is no longer current';
      END IF;
      SELECT identity.* INTO STRICT legacy_identity FROM public_product_identities identity
      WHERE identity.id=keeper_row.public_product_identity_id;
      IF legacy_identity.public_sku IS DISTINCT FROM target->>'sku'
        OR legacy_identity.origin IS DISTINCT FROM 'legacy'
        OR product_row.public_product_identity_id IS DISTINCT FROM keeper_row.public_product_identity_id
        OR (SELECT count(*) FROM sku_registry registry WHERE registry.full_sku=target->>'sku'
          AND registry.first_product_id=keeper_row.id) <> 1 THEN
        RAISE EXCEPTION 'legacy SKU repair keeper no longer owns the exact legacy identity';
      END IF;
      IF EXISTS (SELECT 1 FROM magento_sync_jobs WHERE product_id=product_row.id)
        OR EXISTS (SELECT 1 FROM magento_product_sync_requests WHERE product_id=product_row.id) THEN
        RAISE EXCEPTION 'legacy SKU repair cannot create automatic or normal Magento work';
      END IF;

      IF target->>'action'='split_public_identity' THEN
        allocation := nextval('public_product_sku_sequence');
        allocated_sku := 'AG-' || lpad(allocation::text, greatest(6,length(allocation::text)), '0');
        IF EXISTS (SELECT 1 FROM public_product_identities
          WHERE public_sku=allocated_sku OR allocation_number=allocation) THEN
          RAISE EXCEPTION 'legacy SKU repair public allocation conflict';
        END IF;
        INSERT INTO public_product_identities(public_sku,allocation_number,origin)
        VALUES(allocated_sku,allocation,'allocated') RETURNING id INTO allocated_identity;
        UPDATE products SET public_product_identity_id=allocated_identity WHERE id=product_row.id;
        GET DIAGNOSTICS changed_count = ROW_COUNT;
        IF changed_count <> 1 THEN RAISE EXCEPTION 'legacy SKU repair identity assignment failed'; END IF;

        UPDATE product_full_export_state SET
          route=original_lifecycle->>'route',
          hold_reason=NULLIF(original_lifecycle->>'hold_reason',''),
          evidence=original_lifecycle->'evidence',
          repair_manifest_hash=NULLIF(original_lifecycle->>'repair_manifest_hash',''),
          last_resolution_key=NULLIF(original_lifecycle->>'last_resolution_key',''),
          resolved_by_user_id=NULLIF(original_lifecycle->>'resolved_by_user_id','')::bigint,
          resolved_at=NULLIF(original_lifecycle->>'resolved_at','')::timestamptz,
          business_exclusion_state=original_lifecycle->>'business_exclusion_state',
          recount_compatibility_excluded=(original_lifecycle->>'recount_compatibility_excluded')::boolean,
          delivery_version=delivery_version+1,
          updated_at=CURRENT_TIMESTAMP
        WHERE product_id=product_row.id;
        UPDATE products SET
          status=original_product->>'status',
          exclude_from_export=(original_product->>'exclude_from_export')::integer,
          archived_by_user_id=NULLIF(original_product->>'archived_by_user_id','')::bigint
        WHERE id=product_row.id;
        allocations := allocations || jsonb_build_array(jsonb_build_object(
          'productId',product_row.id,'publicProductIdentityId',allocated_identity,
          'publicSku',allocated_sku,'allocationNumber',allocation,
          'magentoCreateRequired',TRUE));
      END IF;
    END LOOP;

    INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id,details)
    VALUES('legacy_sku_repair.finalized',event.actor_user_id,event.actor_snapshot,
      'legacy_sku_repair_plan',event.subject_id,'migration-047',jsonb_build_object(
        'version',1,'planHash',event.subject_id,'stagingAuditEventId',event.id,
        'allocatedPublicIdentities',allocations,
        'magentoCreateRequired',jsonb_array_length(allocations) > 0,
        'magentoJobsCreated',FALSE,'internalSkusChanged',FALSE,'skuRegistryChanged',FALSE));
  END LOOP;
END;
$$;

-- No migration-only exception survives commit.
DO $$
BEGIN
  EXECUTE $function$
    CREATE OR REPLACE FUNCTION guard_product_public_identity_reference() RETURNS trigger LANGUAGE plpgsql AS $guard$
    BEGIN
      IF NEW.public_product_identity_id IS DISTINCT FROM OLD.public_product_identity_id THEN
        RAISE EXCEPTION 'product public identity is immutable';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $function$;
END;
$$;
