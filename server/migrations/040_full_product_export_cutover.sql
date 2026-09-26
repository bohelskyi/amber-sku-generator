-- Forward-only cutover contract. No acceptance, release, or selector activation.
ALTER TABLE export_snapshots ADD COLUMN full_product_selection JSONB
  CHECK (full_product_selection IS NULL OR jsonb_typeof(full_product_selection)='object');
CREATE FUNCTION protect_full_product_selection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.full_product_selection IS DISTINCT FROM OLD.full_product_selection THEN
    RAISE EXCEPTION 'snapshot lifecycle selection is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER snapshot_full_selection_immutable BEFORE UPDATE ON export_snapshots
  FOR EACH ROW EXECUTE FUNCTION protect_full_product_selection();

ALTER TABLE product_full_export_state
  ADD COLUMN cutover_baseline_revision BIGINT NOT NULL DEFAULT 0
    CHECK (cutover_baseline_revision >= 0 AND cutover_baseline_revision <= revision),
  ADD COLUMN cutover_baseline_event_id BIGINT REFERENCES audit_events(id) ON DELETE RESTRICT,
  ADD COLUMN business_exclusion_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (business_exclusion_state IN ('unknown', 'none', 'excluded')),
  ADD COLUMN recount_compatibility_excluded BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT full_export_baseline_event_pair CHECK
    ((cutover_baseline_revision = 0) = (cutover_baseline_event_id IS NULL));

UPDATE product_full_export_state f SET business_exclusion_state = 'none'
FROM products p WHERE p.id = f.product_id AND COALESCE(p.exclude_from_export, 0) = 0;

DROP INDEX product_full_export_state_pending_idx;
CREATE INDEX product_full_export_state_pending_idx ON product_full_export_state(route, product_id)
  WHERE route IN ('normal', 'replacement')
    AND revision > GREATEST(confirmed_revision, cutover_baseline_revision);

CREATE TABLE full_product_export_activation (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  phase TEXT NOT NULL DEFAULT 'legacy' CHECK (phase IN ('legacy', 'preparing', 'active')),
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  selector_version SMALLINT NOT NULL DEFAULT 0 CHECK (selector_version IN (0, 1)),
  required_writer_version SMALLINT NOT NULL DEFAULT 1 CHECK (required_writer_version > 0),
  manifest_hash TEXT CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  approval_event_id BIGINT REFERENCES audit_events(id) ON DELETE RESTRICT,
  historical_index_event_id BIGINT REFERENCES audit_events(id) ON DELETE RESTRICT,
  activation_event_id BIGINT REFERENCES audit_events(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((manifest_hash IS NULL) = (approval_event_id IS NULL)),
  CHECK ((phase = 'active' AND selector_version = 1 AND manifest_hash IS NOT NULL
      AND activation_event_id IS NOT NULL)
    OR (phase <> 'active' AND selector_version = 0 AND activation_event_id IS NULL)),
  CHECK (phase <> 'legacy' OR manifest_hash IS NULL)
);
INSERT INTO full_product_export_activation(singleton) VALUES (TRUE);

CREATE FUNCTION protect_full_product_activation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'full product activation is permanent'; END IF;
  IF NEW.singleton IS DISTINCT FROM OLD.singleton OR NEW.generation <= OLD.generation
    OR (OLD.phase = 'active') OR (OLD.phase = 'preparing' AND NEW.phase = 'legacy')
    OR (OLD.phase = 'legacy' AND NEW.phase <> 'preparing') THEN
    RAISE EXCEPTION 'invalid full product activation transition';
  END IF;
  IF current_setting('amber.lifecycle_maintenance', TRUE) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'activation requires the cutover command boundary';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER full_product_activation_protected BEFORE UPDATE OR DELETE ON full_product_export_activation
  FOR EACH ROW EXECUTE FUNCTION protect_full_product_activation();
CREATE TRIGGER full_product_activation_no_truncate BEFORE TRUNCATE ON full_product_export_activation
  FOR EACH STATEMENT EXECUTE FUNCTION protect_full_product_activation();

CREATE OR REPLACE FUNCTION protect_full_product_export_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'full product export state is permanent'; END IF;
  IF NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.source_correction_id IS DISTINCT FROM OLD.source_correction_id
    OR NEW.revision < OLD.revision OR NEW.confirmed_revision < OLD.confirmed_revision
    OR NEW.delivery_version < OLD.delivery_version THEN
    RAISE EXCEPTION 'full product export identity and counters cannot regress';
  END IF;
  IF (NEW.cutover_baseline_revision, NEW.cutover_baseline_event_id)
    IS DISTINCT FROM (OLD.cutover_baseline_revision, OLD.cutover_baseline_event_id) THEN
    IF OLD.cutover_baseline_revision <> 0 OR NEW.cutover_baseline_revision <> NEW.revision
      OR NEW.revision <> OLD.revision
      OR (SELECT phase FROM full_product_export_activation WHERE singleton) <> 'preparing'
      OR current_setting('amber.lifecycle_maintenance', TRUE) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'baseline acceptance is a one-time cutover decision';
    END IF;
  END IF;
  IF (NEW.route, NEW.hold_reason, NEW.evidence, NEW.repair_manifest_hash,
      NEW.last_resolution_key, NEW.resolved_by_user_id, NEW.resolved_at,
      NEW.cutover_baseline_revision, NEW.cutover_baseline_event_id,
      NEW.business_exclusion_state, NEW.recount_compatibility_excluded)
    IS DISTINCT FROM (OLD.route, OLD.hold_reason, OLD.evidence, OLD.repair_manifest_hash,
      OLD.last_resolution_key, OLD.resolved_by_user_id, OLD.resolved_at,
      OLD.cutover_baseline_revision, OLD.cutover_baseline_event_id,
      OLD.business_exclusion_state, OLD.recount_compatibility_excluded)
    AND NEW.delivery_version <= OLD.delivery_version THEN
    RAISE EXCEPTION 'full product delivery changes require a new version';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_full_product_cutover_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  product_key INTEGER;
  p products%ROWTYPE;
  f product_full_export_state%ROWTYPE;
  a audit_events%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'products' THEN product_key = NEW.id; ELSE product_key = NEW.product_id; END IF;
  SELECT * INTO p FROM products WHERE id = product_key;
  SELECT * INTO f FROM product_full_export_state WHERE product_id = product_key;
  IF NOT FOUND THEN
    IF (SELECT phase FROM full_product_export_activation WHERE singleton) = 'active' THEN
      RAISE EXCEPTION 'product requires full export state';
    END IF;
    RETURN NULL;
  END IF;
  IF f.cutover_baseline_revision > 0 THEN
    SELECT * INTO a FROM audit_events WHERE id = f.cutover_baseline_event_id;
    IF a.event_key IS DISTINCT FROM 'product.full_export_baselined'
      OR a.subject_type IS DISTINCT FROM 'product' OR a.subject_id IS DISTINCT FROM product_key::text
      OR a.details->>'baselineRevision' IS DISTINCT FROM f.cutover_baseline_revision::text
      OR a.details->>'manifestHash' IS DISTINCT FROM f.repair_manifest_hash THEN
      RAISE EXCEPTION 'baseline requires exact immutable decision evidence';
    END IF;
  END IF;
  -- Legacy fixture/upgrade rows stay untouched until their reviewed resolution.
  IF (SELECT phase FROM full_product_export_activation WHERE singleton) = 'active' THEN
    IF COALESCE(p.exclude_from_export, 0) <> (CASE WHEN f.route = 'retired'
      OR f.business_exclusion_state <> 'none' OR f.recount_compatibility_excluded THEN 1 ELSE 0 END) THEN
      RAISE EXCEPTION 'product exclusion disagrees with its durable policy';
    END IF;
    IF (p.status <> 'active' OR p.corrected_to_product_id IS NOT NULL) AND f.route <> 'retired' THEN
      RAISE EXCEPTION 'inactive product must be retired';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER product_cutover_state_consistent AFTER INSERT OR UPDATE ON products
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_full_product_cutover_state();
CREATE CONSTRAINT TRIGGER full_product_cutover_state_consistent AFTER INSERT OR UPDATE ON product_full_export_state
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_full_product_cutover_state();

CREATE FUNCTION require_full_product_writer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gate full_product_export_activation%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext('amber_full_product_cutover'));
  SELECT * INTO STRICT gate FROM full_product_export_activation WHERE singleton FOR SHARE;
  IF gate.phase <> 'legacy' THEN
    IF current_setting('amber.lifecycle_writer_version', TRUE) IS DISTINCT FROM gate.required_writer_version::text THEN
      RAISE EXCEPTION 'lifecycle-aware writer required' USING ERRCODE = '55000';
    END IF;
    IF gate.phase = 'preparing' AND current_setting('amber.lifecycle_maintenance', TRUE) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'full product cutover is preparing' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
DO $$
DECLARE target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['products', 'product_corrections', 'correction_requests',
    'product_full_export_state', 'export_snapshot_products', 'export_snapshots', 'magento_export_artifacts',
    'product_export_revisions', 'price_export_snapshots', 'export_state', 'export_events',
    'categories', 'questions', 'options', 'sku_schema_versions', 'price_scenarios', 'price_matrix', 'price_modifiers'] LOOP
    EXECUTE format('CREATE TRIGGER lifecycle_writer_required BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION require_full_product_writer()', target);
  END LOOP;
END;
$$;

-- Extend the existing binding contract without changing stored snapshots.
ALTER TABLE export_snapshots DROP CONSTRAINT export_snapshot_template_complete;
ALTER TABLE export_snapshots
  ADD CONSTRAINT export_snapshot_template_complete CHECK (
    (request_contract = 'legacy'
      AND num_nonnulls(template_id, template_version_id, template_definition_hash,
        template_evaluator_version, template_output_contract, template_format_version,
        request_intent, input_fingerprint, binding_evidence) = 0)
    OR (request_contract = 'template-v1'
      AND num_nonnulls(template_id, template_version_id, template_definition_hash,
        template_evaluator_version, template_output_contract, template_format_version,
        request_intent, input_fingerprint, binding_evidence) = 9
      AND template_output_contract IN ('magento-products-v1', 'magento-products-columns-v2')
      AND input_fingerprint ~ '^[a-f0-9]{64}$'
      AND row_count > 0
      AND jsonb_typeof(request_intent) = 'object'
      AND jsonb_typeof(binding_evidence) = 'object'
      AND (binding_evidence->'intent' = request_intent) IS TRUE
      AND (binding_evidence->>'inputFingerprint' = input_fingerprint) IS TRUE
      AND (binding_evidence->'effective'->>'templateId' = template_id) IS TRUE
      AND (binding_evidence->'effective'->>'versionId' = template_version_id) IS TRUE
      AND (binding_evidence->'effective'->>'definitionHash' = template_definition_hash) IS TRUE
      AND (binding_evidence->'effective'->>'evaluatorVersion' = template_evaluator_version) IS TRUE
      AND (binding_evidence->'effective'->>'outputContract' = template_output_contract) IS TRUE
      AND (binding_evidence->'effective'->'formatVersion' = to_jsonb(template_format_version)) IS TRUE
      AND (request_intent->>'requestContract' = request_contract) IS TRUE
      AND (request_intent->>'profile' = 'magento-products-v1') IS TRUE
      AND request_intent ?& ARRAY['mode', 'fromSku', 'toSku', 'selection']
      AND (request_intent->>'mode' IN ('manual', 'new', 'replacement')) IS TRUE
      AND (binding_evidence->'range'->>'fromSku' = from_sku) IS TRUE
      AND (binding_evidence->'range'->>'toSku') IS NOT DISTINCT FROM to_sku
      AND (binding_evidence->'range'->>'resolvedToSku' = resolved_to_sku) IS TRUE
      AND (binding_evidence->'range'->'exportedToProductId' = to_jsonb(exported_to_product_id)) IS TRUE
      AND binding_evidence ? 'cursor'
      AND ((request_intent->>'mode' = 'new' AND (binding_evidence->>'cursor' ~ '^(0|[1-9][0-9]*)$') IS TRUE)
        OR (request_intent->>'mode' IN ('manual','replacement') AND binding_evidence->'cursor' = 'null'::jsonb))
      AND ((request_intent->'selection'->>'mode' = 'active'
          AND (binding_evidence->'effective'->>'activationGeneration' ~ '^[1-9][0-9]*$') IS TRUE)
        OR (request_intent->'selection'->>'mode' = 'explicit'
          AND (request_intent->'selection'->>'templateId' = template_id) IS TRUE
          AND (request_intent->'selection'->>'versionId' = template_version_id) IS TRUE
          AND binding_evidence->'effective'->'activationGeneration' = 'null'::jsonb)) IS TRUE)
  );
