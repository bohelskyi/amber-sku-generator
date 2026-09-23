ALTER TABLE export_template_versions
  ADD CONSTRAINT export_template_versions_snapshot_identity
  UNIQUE (id, template_id, definition_hash, evaluator_version, output_contract, format_version);

ALTER TABLE export_snapshots
  ADD COLUMN request_contract TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN template_id TEXT,
  ADD COLUMN template_version_id TEXT,
  ADD COLUMN template_definition_hash TEXT,
  ADD COLUMN template_evaluator_version TEXT,
  ADD COLUMN template_output_contract TEXT,
  ADD COLUMN template_format_version INTEGER,
  ADD COLUMN request_intent JSONB,
  ADD COLUMN input_fingerprint TEXT,
  ADD COLUMN binding_evidence JSONB,
  ADD CONSTRAINT export_snapshot_template_identity FOREIGN KEY
    (template_version_id, template_id, template_definition_hash, template_evaluator_version,
     template_output_contract, template_format_version)
    REFERENCES export_template_versions
    (id, template_id, definition_hash, evaluator_version, output_contract, format_version)
    ON DELETE RESTRICT,
  ADD CONSTRAINT export_snapshot_template_complete CHECK (
    (request_contract = 'legacy'
      AND num_nonnulls(template_id, template_version_id, template_definition_hash,
        template_evaluator_version, template_output_contract, template_format_version,
        request_intent, input_fingerprint, binding_evidence) = 0)
    OR (request_contract = 'template-v1'
      AND num_nonnulls(template_id, template_version_id, template_definition_hash,
        template_evaluator_version, template_output_contract, template_format_version,
        request_intent, input_fingerprint, binding_evidence) = 9
      AND template_output_contract = 'magento-products-v1'
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
      AND (request_intent->>'profile' = template_output_contract) IS TRUE
      AND request_intent ?& ARRAY['mode', 'fromSku', 'toSku', 'selection']
      AND (request_intent->>'mode' IN ('manual', 'new')) IS TRUE
      AND (binding_evidence->'range'->>'fromSku' = from_sku) IS TRUE
      AND (binding_evidence->'range'->>'toSku') IS NOT DISTINCT FROM to_sku
      AND (binding_evidence->'range'->>'resolvedToSku' = resolved_to_sku) IS TRUE
      AND (binding_evidence->'range'->'exportedToProductId' = to_jsonb(exported_to_product_id)) IS TRUE
      AND binding_evidence ? 'cursor'
      AND ((request_intent->>'mode' = 'new' AND (binding_evidence->>'cursor' ~ '^(0|[1-9][0-9]*)$') IS TRUE)
        OR (request_intent->>'mode' = 'manual' AND binding_evidence->'cursor' = 'null'::jsonb))
      AND ((request_intent->'selection'->>'mode' = 'active'
          AND (binding_evidence->'effective'->>'activationGeneration' ~ '^[1-9][0-9]*$') IS TRUE)
        OR (request_intent->'selection'->>'mode' = 'explicit'
          AND (request_intent->'selection'->>'templateId' = template_id) IS TRUE
          AND (request_intent->'selection'->>'versionId' = template_version_id) IS TRUE
          AND binding_evidence->'effective'->'activationGeneration' = 'null'::jsonb)) IS TRUE)
  );

-- Retain every protection from 031, including initial confirmer attribution.
CREATE OR REPLACE FUNCTION protect_export_snapshot_payload()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.from_sku IS DISTINCT FROM OLD.from_sku
     OR NEW.to_sku IS DISTINCT FROM OLD.to_sku
     OR NEW.resolved_to_sku IS DISTINCT FROM OLD.resolved_to_sku
     OR NEW.exported_to_product_id IS DISTINCT FROM OLD.exported_to_product_id
     OR NEW.row_count IS DISTINCT FROM OLD.row_count
     OR NEW.file_name IS DISTINCT FROM OLD.file_name
     OR NEW.csv_content IS DISTINCT FROM OLD.csv_content
     OR NEW.generated_at IS DISTINCT FROM OLD.generated_at
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.reexport_revisions IS DISTINCT FROM OLD.reexport_revisions
     OR NEW.request_contract IS DISTINCT FROM OLD.request_contract
     OR NEW.template_id IS DISTINCT FROM OLD.template_id
     OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id
     OR NEW.template_definition_hash IS DISTINCT FROM OLD.template_definition_hash
     OR NEW.template_evaluator_version IS DISTINCT FROM OLD.template_evaluator_version
     OR NEW.template_output_contract IS DISTINCT FROM OLD.template_output_contract
     OR NEW.template_format_version IS DISTINCT FROM OLD.template_format_version
     OR NEW.request_intent IS DISTINCT FROM OLD.request_intent
     OR NEW.input_fingerprint IS DISTINCT FROM OLD.input_fingerprint
     OR NEW.binding_evidence IS DISTINCT FROM OLD.binding_evidence
     OR (OLD.confirmed_by_user_id IS NOT NULL
       AND NEW.confirmed_by_user_id IS DISTINCT FROM OLD.confirmed_by_user_id) THEN
    RAISE EXCEPTION 'export snapshot payload is immutable';
  END IF;
  RETURN NEW;
END;
$$;
