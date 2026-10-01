-- One-way retirement of new Magento product CSV artifacts, coupled to automatic
-- synchronization activation. Existing snapshots, artifacts and confirmations
-- remain unchanged and readable. Price exports are a separate stream.
ALTER TABLE magento_auto_sync_activation
  ADD COLUMN legacy_product_csv_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN cutover_at TIMESTAMPTZ,
  ADD COLUMN cutover_by_user_id BIGINT REFERENCES application_users(id) ON DELETE RESTRICT,
  ADD COLUMN cutover_event_id BIGINT REFERENCES audit_events(id) ON DELETE RESTRICT,
  ADD CONSTRAINT magento_delivery_cutover_shape CHECK (
    (legacy_product_csv_enabled AND num_nonnulls(cutover_at, cutover_by_user_id, cutover_event_id) = 0)
    OR
    (NOT legacy_product_csv_enabled AND num_nonnulls(cutover_at, cutover_by_user_id, cutover_event_id) = 3)
  );

ALTER TABLE product_full_export_state
  ADD COLUMN csv_retired_revision BIGINT NOT NULL DEFAULT 0
    CHECK (csv_retired_revision >= 0 AND csv_retired_revision <= revision);

CREATE FUNCTION guard_product_csv_retired_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.csv_retired_revision < OLD.csv_retired_revision THEN
    RAISE EXCEPTION 'Magento product CSV retirement floor cannot regress';
  END IF;
  IF NEW.csv_retired_revision IS DISTINCT FROM OLD.csv_retired_revision AND
    ((SELECT legacy_product_csv_enabled FROM magento_auto_sync_activation WHERE singleton) IS NOT FALSE
      OR NEW.csv_retired_revision <> NEW.revision) THEN
    RAISE EXCEPTION 'Magento product CSV retirement floor requires retired delivery';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER product_csv_retired_revision_guard
  BEFORE UPDATE ON product_full_export_state
  FOR EACH ROW EXECUTE FUNCTION guard_product_csv_retired_revision();

CREATE FUNCTION guard_magento_delivery_cutover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.legacy_product_csv_enabled IS FALSE AND NEW.legacy_product_csv_enabled IS TRUE THEN
    RAISE EXCEPTION 'Magento product CSV retirement is permanent';
  END IF;
  IF OLD.legacy_product_csv_enabled IS TRUE AND NEW.legacy_product_csv_enabled IS FALSE THEN
    IF current_setting('amber.magento_delivery_cutover', TRUE) IS DISTINCT FROM 'on'
      OR NEW.enabled IS NOT TRUE OR NEW.installation_key IS NULL OR NEW.actor_user_id IS NULL
      OR num_nonnulls(NEW.cutover_at, NEW.cutover_by_user_id, NEW.cutover_event_id) <> 3 THEN
      RAISE EXCEPTION 'Magento delivery cutover requires the command boundary';
    END IF;
  END IF;
  IF OLD.legacy_product_csv_enabled IS FALSE AND
    (NEW.cutover_at, NEW.cutover_by_user_id, NEW.cutover_event_id) IS DISTINCT FROM
    (OLD.cutover_at, OLD.cutover_by_user_id, OLD.cutover_event_id) THEN
    RAISE EXCEPTION 'Magento delivery cutover receipt is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER magento_delivery_cutover_guard
  BEFORE UPDATE ON magento_auto_sync_activation
  FOR EACH ROW EXECUTE FUNCTION guard_magento_delivery_cutover();

CREATE FUNCTION guard_new_magento_product_csv() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed BOOLEAN;
BEGIN
  -- The row lock makes the cutover boundary atomic even for an older writer that
  -- does not yet know about migration 045.
  SELECT legacy_product_csv_enabled INTO STRICT allowed
  FROM magento_auto_sync_activation WHERE singleton FOR SHARE;
  IF allowed IS NOT TRUE THEN
    RAISE EXCEPTION 'new Magento product CSV work is retired';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER magento_product_csv_creation_guard
  BEFORE INSERT ON magento_export_artifacts
  FOR EACH ROW EXECUTE FUNCTION guard_new_magento_product_csv();
