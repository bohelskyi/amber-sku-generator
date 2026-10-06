-- A separate permanent native TEST namespace. Existing identities are unchanged.
ALTER TABLE public_product_identities ADD COLUMN is_test_product BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public_product_identities ADD COLUMN test_allocation_number BIGINT UNIQUE CHECK (test_allocation_number > 0);
ALTER TABLE public_product_identities DROP CONSTRAINT public_product_identities_check;
ALTER TABLE public_product_identities ADD CONSTRAINT public_product_identity_allocation_kind CHECK (
  (origin='legacy' AND NOT is_test_product AND allocation_number IS NULL AND test_allocation_number IS NULL)
  OR (origin='allocated' AND NOT is_test_product AND allocation_number IS NOT NULL AND test_allocation_number IS NULL
    AND public_sku !~ '^TEST-[0-9]{6,}$')
  OR (origin='allocated' AND is_test_product AND allocation_number IS NULL AND test_allocation_number IS NOT NULL
    AND public_sku='TEST-' || lpad(test_allocation_number::text, GREATEST(6,length(test_allocation_number::text)), '0')));
CREATE SEQUENCE test_product_sku_sequence AS BIGINT MINVALUE 1 NO MAXVALUE NO CYCLE START WITH 1;
DO $$ DECLARE legacy_floor NUMERIC; BEGIN
  IF EXISTS (SELECT 1 FROM public_product_identities WHERE upper(btrim(public_sku)) ~ '^TEST-[0-9]{6,}$'
    AND public_sku IS DISTINCT FROM upper(btrim(public_sku))) THEN
    RAISE EXCEPTION 'TEST namespace requires canonical retained identities';
  END IF;
  SELECT max(substring(public_sku FROM 6)::numeric) INTO legacy_floor
    FROM public_product_identities WHERE public_sku ~ '^TEST-[0-9]{6,}$';
  IF legacy_floor IS NULL THEN PERFORM setval('test_product_sku_sequence',1,FALSE);
  ELSIF legacy_floor >= 9223372036854775807 THEN RAISE EXCEPTION 'legacy TEST namespace exceeds BIGINT';
  ELSE PERFORM setval('test_product_sku_sequence',legacy_floor::bigint,TRUE); END IF;
END; $$;

CREATE OR REPLACE FUNCTION assign_product_public_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_identity BIGINT;
  allocation BIGINT;
  active BOOLEAN;
BEGIN
  SELECT enabled INTO STRICT active FROM public_sku_activation WHERE singleton FOR SHARE;
  IF current_setting('amber.create_test_product', TRUE) = 'on' AND NEW.corrected_from_product_id IS NULL THEN
    IF NOT active OR NEW.characteristic_version_id IS NULL OR NEW.public_product_identity_id IS NOT NULL THEN
      RAISE EXCEPTION 'TEST creation requires native active server allocation';
    END IF;
    PERFORM pg_advisory_xact_lock_shared(hashtext('amber_application_user_admin_active_administrators'));
    IF NOT EXISTS (SELECT 1 FROM application_users u
      JOIN user_role_assignments a ON a.application_user_id=u.id JOIN roles r ON r.id=a.role_id
      JOIN role_permissions rp ON rp.role_id=r.id AND rp.permission_key='products.create'
      WHERE u.id=NULLIF(current_setting('amber.create_test_product_actor', TRUE), '')::bigint
        AND u.id=NEW.created_by_user_id AND u.status='active' AND a.revoked_at IS NULL
        AND r.status='active' AND r.role_key='administrator' AND r.is_system=TRUE) THEN
      RAISE EXCEPTION 'TEST creation requires actual active Administrator';
    END IF;
    allocation := nextval('test_product_sku_sequence');
    INSERT INTO public_product_identities(public_sku, test_allocation_number, origin, is_test_product)
    VALUES ('TEST-' || lpad(allocation::text, GREATEST(6, length(allocation::text)), '0'), allocation, 'allocated', TRUE)
    RETURNING id INTO NEW.public_product_identity_id;
    RETURN NEW;
  END IF;
  IF active AND NEW.corrected_from_product_id IS NOT NULL THEN
    SELECT public_product_identity_id INTO STRICT source_identity
    FROM products WHERE id = NEW.corrected_from_product_id;
    IF NEW.public_product_identity_id IS NOT NULL
      AND NEW.public_product_identity_id <> source_identity THEN
      RAISE EXCEPTION 'recount successor must inherit the source public identity';
    END IF;
    NEW.public_product_identity_id := source_identity;
    RETURN NEW;
  END IF;
  IF NEW.public_product_identity_id IS NOT NULL THEN
    RAISE EXCEPTION 'ordinary product public identity is server allocated';
  END IF;
  IF active THEN
    allocation := nextval('public_product_sku_sequence');
    INSERT INTO public_product_identities(public_sku, allocation_number, origin)
    VALUES ('AG-' || lpad(allocation::text,
      GREATEST(6, length(allocation::text)), '0'), allocation, 'allocated')
    RETURNING id INTO NEW.public_product_identity_id;
  ELSE
    INSERT INTO public_product_identities(public_sku, origin)
    VALUES (upper(btrim(NEW.full_sku)), 'legacy')
    ON CONFLICT(public_sku) DO NOTHING;
    SELECT id INTO STRICT NEW.public_product_identity_id
    FROM public_product_identities WHERE public_sku = upper(btrim(NEW.full_sku));
  END IF;
  RETURN NEW;
END;
$$;
-- Immutable identity flags are already covered by the permanent identity guards.
-- SQL/API bypasses cannot enqueue activation for a TEST identity.
CREATE FUNCTION guard_test_product_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity_id BIGINT; is_test BOOLEAN;
BEGIN
  IF TG_TABLE_NAME='product_photo_sets' THEN
    SELECT public_product_identity_id INTO identity_id FROM products WHERE id=NEW.product_id;
  ELSE identity_id := NEW.public_product_identity_id; END IF;
  SELECT is_test_product INTO is_test FROM public_product_identities WHERE id=identity_id;
  IF is_test AND ((TG_TABLE_NAME IN ('product_photo_sets','product_media_jobs') AND to_jsonb(NEW)->>'enable_when_verified'='true')
    OR (TG_TABLE_NAME IN ('product_visibility_intents','historical_standard_intents','historical_reactivation_intents') AND (to_jsonb(NEW)->>'target_status')::int=1)) THEN
    RAISE EXCEPTION 'TEST product activation is forbidden';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER test_photo_set_activation BEFORE INSERT OR UPDATE ON product_photo_sets FOR EACH ROW EXECUTE FUNCTION guard_test_product_activation();
CREATE TRIGGER test_media_activation BEFORE INSERT OR UPDATE ON product_media_jobs FOR EACH ROW EXECUTE FUNCTION guard_test_product_activation();
CREATE TRIGGER test_visibility_activation BEFORE INSERT OR UPDATE ON product_visibility_intents FOR EACH ROW EXECUTE FUNCTION guard_test_product_activation();
CREATE TRIGGER test_historical_standard_activation BEFORE INSERT OR UPDATE ON historical_standard_intents FOR EACH ROW EXECUTE FUNCTION guard_test_product_activation();
CREATE TRIGGER test_historical_atomic_activation BEFORE INSERT OR UPDATE ON historical_reactivation_intents FOR EACH ROW EXECUTE FUNCTION guard_test_product_activation();

-- Retain the exact succeeded CREATE/tombstone policy for TEST articles as well.
ALTER TABLE magento_test_deletions DROP CONSTRAINT magento_test_deletions_public_sku_check;
ALTER TABLE magento_test_deletions ADD CONSTRAINT magento_test_deletion_article CHECK (public_sku ~ '^(AG|TEST)-[0-9]{6,}$');
CREATE OR REPLACE FUNCTION validate_test_deletion_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state<>'sealed' OR num_nonnulls(NEW.dispatched_at,NEW.verified_at,NEW.finalized_at)<>0
    OR NOT EXISTS(SELECT 1 FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
      LEFT JOIN sku_registry r ON r.full_sku=p.full_sku AND r.first_product_id=p.id
      JOIN magento_sync_jobs j ON j.id=NEW.create_job_id
      WHERE p.id=NEW.product_id AND p.status='active' AND p.public_product_identity_id=NEW.public_product_identity_id
        AND i.origin='allocated' AND i.public_sku=NEW.public_sku
        AND ((i.is_test_product AND i.public_sku ~ '^TEST-[0-9]{6,}$') OR (NOT i.is_test_product AND i.public_sku ~ '^AG-[0-9]{6,}$'))
        AND ((p.characteristic_version_id IS NULL AND r.first_product_id=p.id AND p.full_sku=NEW.internal_sku)
          OR (p.characteristic_version_id IS NOT NULL AND NEW.internal_sku IS NULL
            AND num_nonnulls(p.full_sku,p.base_sku,p.sequence_number,p.sku_schema_version_id)=0
            AND p.corrected_from_product_id IS NULL AND p.corrected_to_product_id IS NULL
            AND (SELECT count(*) FROM products other WHERE other.public_product_identity_id=i.id)=1))
        AND j.product_id=p.id AND j.public_product_identity_id=i.id AND j.sku=i.public_sku
        AND j.origin_hash=NEW.origin_hash AND j.remote_product_id=NEW.remote_product_id
        AND j.state='succeeded' AND j.intent->>'mode'='create') THEN
    RAISE EXCEPTION 'test deletion requires exact allocated product and succeeded CREATE identity';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION guard_test_sync_job_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public_product_identities WHERE id=NEW.public_product_identity_id AND is_test_product)
    AND ((NEW.intent->>'mode'='create' AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.intent->'operations') op
      WHERE op->>'domain'='coreProduct' AND op#>'{payload,product,status}'='2'::jsonb))
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.intent->'operations') op
        WHERE (op#>'{payload,product}') ? 'status' AND (op#>'{payload,product,status}') IS DISTINCT FROM '2'::jsonb)) THEN
    RAISE EXCEPTION 'TEST sync must create disabled and never enable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER test_sync_status BEFORE INSERT OR UPDATE ON magento_sync_jobs FOR EACH ROW EXECUTE FUNCTION guard_test_sync_job_status();
