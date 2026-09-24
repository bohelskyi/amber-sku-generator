-- Extend supported output identities; preserve historical rows and all evidence.
ALTER TABLE magento_export_artifacts DROP CONSTRAINT magento_export_artifacts_profile_version_check;
ALTER TABLE magento_export_artifacts ADD CONSTRAINT magento_export_artifacts_profile_version_check
  CHECK (profile_version IN ('magento-products-v1', 'magento-products-columns-v2'));
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

ALTER TABLE export_snapshots ADD COLUMN legacy_preview_fingerprint TEXT
  CHECK (legacy_preview_fingerprint IS NULL OR (request_contract = 'legacy' AND legacy_preview_fingerprint ~ '^[a-f0-9]{64}$'));
CREATE FUNCTION protect_legacy_preview_fingerprint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.legacy_preview_fingerprint IS DISTINCT FROM OLD.legacy_preview_fingerprint THEN
    RAISE EXCEPTION 'legacy preview evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER legacy_preview_fingerprint_immutable BEFORE UPDATE ON export_snapshots
  FOR EACH ROW EXECUTE FUNCTION protect_legacy_preview_fingerprint();
