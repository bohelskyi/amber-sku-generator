-- Explicit pre-API-cutover acknowledgement of an exact Amber full-product
-- revision already delivered externally. This is neither snapshot confirmation,
-- cutover baselining nor the post-cutover CSV-retirement floor.
ALTER TABLE product_full_export_state
  ADD COLUMN externally_delivered_revision BIGINT NOT NULL DEFAULT 0
    CHECK (externally_delivered_revision >= 0 AND externally_delivered_revision <= revision),
  ADD COLUMN externally_delivered_event_id BIGINT REFERENCES audit_events(id) ON DELETE RESTRICT,
  ADD CONSTRAINT full_export_external_delivery_event_pair CHECK
    ((externally_delivered_revision = 0) = (externally_delivered_event_id IS NULL));

DROP INDEX product_full_export_state_pending_idx;
CREATE INDEX product_full_export_state_pending_idx ON product_full_export_state(route, product_id)
  WHERE route IN ('normal', 'replacement')
    AND revision > GREATEST(confirmed_revision, cutover_baseline_revision,
      externally_delivered_revision, csv_retired_revision);

CREATE FUNCTION guard_external_full_product_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delivery_gate magento_auto_sync_activation%ROWTYPE;
  lifecycle_gate full_product_export_activation%ROWTYPE;
  proof audit_events%ROWTYPE;
BEGIN
  IF NEW.externally_delivered_revision < OLD.externally_delivered_revision THEN
    RAISE EXCEPTION 'external delivery acknowledgement cannot regress';
  END IF;

  IF NEW.externally_delivered_revision IS DISTINCT FROM OLD.externally_delivered_revision THEN
    SELECT * INTO STRICT delivery_gate FROM magento_auto_sync_activation WHERE singleton FOR SHARE;
    SELECT * INTO STRICT lifecycle_gate FROM full_product_export_activation WHERE singleton FOR SHARE;
    IF current_setting('amber.external_delivery_acknowledgement', TRUE) IS DISTINCT FROM 'on'
      OR lifecycle_gate.phase <> 'active' OR lifecycle_gate.selector_version <> 1
      OR delivery_gate.legacy_product_csv_enabled IS NOT TRUE
      OR delivery_gate.enabled IS NOT FALSE
      OR delivery_gate.cutover_at IS NOT NULL
      OR delivery_gate.cutover_by_user_id IS NOT NULL
      OR delivery_gate.cutover_event_id IS NOT NULL
      OR NEW.externally_delivered_revision <= OLD.externally_delivered_revision
      OR NEW.externally_delivered_revision <> NEW.revision
      OR NEW.externally_delivered_event_id IS NULL
      OR NEW.externally_delivered_event_id IS NOT DISTINCT FROM OLD.externally_delivered_event_id
      OR (NEW.product_id, NEW.revision, NEW.confirmed_revision,
          NEW.cutover_baseline_revision, NEW.cutover_baseline_event_id,
          NEW.csv_retired_revision, NEW.hold_reason, NEW.source_correction_id,
          NEW.evidence, NEW.repair_manifest_hash, NEW.last_resolution_key,
          NEW.created_at, NEW.resolved_by_user_id, NEW.resolved_at,
          NEW.business_exclusion_state, NEW.recount_compatibility_excluded)
        IS DISTINCT FROM
         (OLD.product_id, OLD.revision, OLD.confirmed_revision,
          OLD.cutover_baseline_revision, OLD.cutover_baseline_event_id,
          OLD.csv_retired_revision, OLD.hold_reason, OLD.source_correction_id,
          OLD.evidence, OLD.repair_manifest_hash, OLD.last_resolution_key,
          OLD.created_at, OLD.resolved_by_user_id, OLD.resolved_at,
          OLD.business_exclusion_state, OLD.recount_compatibility_excluded)
      OR NEW.updated_at < OLD.updated_at
      OR OLD.route NOT IN ('normal', 'replacement')
      OR NEW.route <> 'normal'
      OR (OLD.route = 'normal' AND NEW.delivery_version <> OLD.delivery_version)
      OR (OLD.route = 'replacement' AND NEW.delivery_version <> OLD.delivery_version + 1) THEN
      RAISE EXCEPTION 'external delivery acknowledgement requires the exact pre-cutover command boundary';
    END IF;

    SELECT * INTO STRICT proof FROM audit_events WHERE id=NEW.externally_delivered_event_id;
    IF proof.event_key IS DISTINCT FROM 'product.external_delivery_acknowledged'
      OR proof.subject_type IS DISTINCT FROM 'product'
      OR proof.subject_id IS DISTINCT FROM NEW.product_id::text
      OR proof.details->>'fullRevision' IS DISTINCT FROM NEW.externally_delivered_revision::text
      OR proof.details->>'deliveryVersionBefore' IS DISTINCT FROM OLD.delivery_version::text
      OR proof.details->>'routeBefore' IS DISTINCT FROM OLD.route
      OR proof.details->>'externalDeliverySemantic' IS DISTINCT FROM 'true'
      OR proof.details->>'planHash' !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'external delivery acknowledgement requires exact immutable audit evidence';
    END IF;
  ELSIF NEW.externally_delivered_event_id IS DISTINCT FROM OLD.externally_delivered_event_id THEN
    RAISE EXCEPTION 'external delivery audit reference is immutable without a newer acknowledgement';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER product_external_delivery_guard
  BEFORE UPDATE ON product_full_export_state
  FOR EACH ROW EXECUTE FUNCTION guard_external_full_product_delivery();
