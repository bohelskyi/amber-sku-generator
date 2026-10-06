-- Native products carry only their existing public identity and immutable semantic
-- configuration. Existing encoded identifiers, publications and reservations stay exact.
CREATE TABLE product_characteristic_versions (
  id BIGSERIAL PRIMARY KEY,
  category_code TEXT NOT NULL REFERENCES categories(code) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version BIGINT NOT NULL CHECK(version > 0),
  config_hash TEXT NOT NULL CHECK(config_hash ~ '^[0-9a-f]{64}$'),
  snapshot JSONB NOT NULL CHECK(jsonb_typeof(snapshot)='object'
    AND snapshot->>'contract'='product-characteristics-v1'
    AND snapshot->>'category_code'=category_code
    AND jsonb_typeof(snapshot->'questions')='array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(category_code,version), UNIQUE(category_code,config_hash)
);
CREATE FUNCTION guard_product_characteristic_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'product characteristic versions are immutable and permanent'; END;
$$;
CREATE TRIGGER product_characteristic_version_immutable BEFORE UPDATE OR DELETE ON product_characteristic_versions
  FOR EACH ROW EXECUTE FUNCTION guard_product_characteristic_version();
CREATE TRIGGER product_characteristic_version_no_truncate BEFORE TRUNCATE ON product_characteristic_versions
  FOR EACH STATEMENT EXECUTE FUNCTION guard_product_characteristic_version();
CREATE TABLE product_creation_receipts (
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  result JSONB NOT NULL CHECK(jsonb_typeof(result)='object' AND result->>'success'='true'
    AND (result->>'id')::integer=product_id AND result->>'publicSku' IS NOT NULL),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(actor_user_id,idempotency_key), UNIQUE(product_id)
);
CREATE FUNCTION guard_product_creation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'product creation receipts are immutable and permanent'; END;
$$;
CREATE TRIGGER product_creation_receipts_immutable BEFORE UPDATE OR DELETE ON product_creation_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_product_creation_receipt();
CREATE TRIGGER product_creation_receipts_no_truncate BEFORE TRUNCATE ON product_creation_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION guard_product_creation_receipt();
ALTER TABLE products ADD COLUMN characteristic_version_id BIGINT
  REFERENCES product_characteristic_versions(id) ON DELETE RESTRICT;
-- The future test-retirement ledger retains a nullable historical identifier;
-- native public identities never manufacture a replacement internal code.
ALTER TABLE magento_test_deletions ALTER COLUMN internal_sku DROP NOT NULL;
ALTER TABLE correction_requests ALTER COLUMN proposed_sku DROP NOT NULL;

CREATE FUNCTION guard_product_characteristic_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active BOOLEAN;
BEGIN
  IF TG_OP='UPDATE' AND ((NEW.characteristic_version_id,NEW.full_sku)
    IS DISTINCT FROM (OLD.characteristic_version_id,OLD.full_sku)
    OR (OLD.sku_schema_version_id IS NOT NULL AND NEW.sku_schema_version_id IS DISTINCT FROM OLD.sku_schema_version_id)) THEN
    RAISE EXCEPTION 'product creation configuration and historical SKU are immutable';
  END IF;
  IF TG_OP='INSERT' THEN
    SELECT enabled INTO STRICT active FROM public_sku_activation WHERE singleton FOR SHARE;
    IF active AND (NEW.full_sku IS NOT NULL OR NEW.base_sku IS NOT NULL OR NEW.sequence_number IS NOT NULL
      OR NEW.sku_schema_version_id IS NOT NULL OR NEW.characteristic_version_id IS NULL) THEN
      RAISE EXCEPTION 'native public identity products require characteristics without an encoded SKU';
    END IF;
    IF NOT active AND NEW.characteristic_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'native characteristics require public identity activation';
    END IF;
  END IF;
  IF NEW.characteristic_version_id IS NOT NULL AND (NEW.full_sku IS NOT NULL OR NEW.base_sku IS NOT NULL
    OR NEW.sequence_number IS NOT NULL OR NEW.sku_schema_version_id IS NOT NULL) THEN
    RAISE EXCEPTION 'native characteristic products cannot acquire an encoded SKU';
  END IF;
  IF NEW.characteristic_version_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM product_characteristic_versions v WHERE v.id=NEW.characteristic_version_id AND v.category_code=NEW.category) THEN
    RAISE EXCEPTION 'product characteristic version belongs to another category';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER products_characteristic_reference BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION guard_product_characteristic_reference();

CREATE OR REPLACE FUNCTION reserve_product_sku() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.full_sku IS NULL AND NEW.characteristic_version_id IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.full_sku IS NULL OR TRIM(NEW.full_sku)='' THEN
    RAISE EXCEPTION 'Артикул не може бути порожнім' USING ERRCODE='23502';
  END IF;
  NEW.full_sku:=UPPER(TRIM(NEW.full_sku));
  IF TG_OP='UPDATE' AND NEW.full_sku=OLD.full_sku THEN RETURN NEW; END IF;
  INSERT INTO sku_registry(full_sku,first_product_id) VALUES(NEW.full_sku,NEW.id) ON CONFLICT(full_sku) DO NOTHING;
  IF NOT FOUND THEN RAISE EXCEPTION 'Артикул % вже зарезервований',NEW.full_sku USING ERRCODE='23505'; END IF;
  RETURN NEW;
END;
$$;
-- Immutable semantic reference participates in automatic sync state without
-- rewriting historical job payloads or activating any writer.
CREATE OR REPLACE FUNCTION magento_sync_product_input(p products) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_array(p.public_product_identity_id,p.full_sku,p.category,p.weight,p.total_price_uah,
    p.sku_schema_version_id,p.details->'answers',p.magento_name_subject_ua,p.magento_name_subject_en,
    p.magento_name_review_required,p.magento_name_override,p.status,p.corrected_to_product_id,p.exclude_from_export)
    || CASE WHEN p.characteristic_version_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p.characteristic_version_id) END
$$;

CREATE OR REPLACE FUNCTION check_magento_extensible_category() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amber_group IS NULL OR NEW.amber_group IN ('BR','NM','KL','CH','AR','SV') THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM magento_binding_revisions r JOIN export_template_versions v ON v.id=r.template_version_id
    WHERE r.id=NEW.revision_id AND r.evaluator_version IN ('magento-declarative-4','magento-declarative-5')
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.definition->'groups') g WHERE g->>'route'=NEW.amber_group)) THEN
    RAISE EXCEPTION 'new binding category requires a declared extensible template group';
  END IF;
  RETURN NEW;
END;
$$;

-- Native eligibility preserves the fresh single-revision identity policy; legacy
-- retirement still requires its permanent SKU registry owner and exact code.
CREATE OR REPLACE FUNCTION validate_test_deletion_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state<>'sealed' OR num_nonnulls(NEW.dispatched_at,NEW.verified_at,NEW.finalized_at)<>0
    OR NOT EXISTS(SELECT 1 FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
      LEFT JOIN sku_registry r ON r.full_sku=p.full_sku AND r.first_product_id=p.id
      JOIN magento_sync_jobs j ON j.id=NEW.create_job_id
      WHERE p.id=NEW.product_id AND p.status='active' AND p.public_product_identity_id=NEW.public_product_identity_id
        AND i.origin='allocated' AND i.public_sku=NEW.public_sku
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
