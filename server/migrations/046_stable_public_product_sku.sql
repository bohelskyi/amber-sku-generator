-- Stable public product identity. Existing encoded products.full_sku remains the
-- immutable configuration/history SKU and sku_registry remains unchanged.
CREATE SEQUENCE public_product_sku_sequence AS BIGINT
  MINVALUE 1 NO MAXVALUE NO CYCLE START WITH 1;

CREATE TABLE public_product_identities (
  id BIGSERIAL PRIMARY KEY,
  public_sku TEXT NOT NULL UNIQUE CHECK (length(btrim(public_sku)) > 0),
  allocation_number BIGINT UNIQUE CHECK (allocation_number > 0),
  origin TEXT NOT NULL CHECK (origin IN ('legacy', 'allocated')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((origin = 'allocated') = (allocation_number IS NOT NULL))
);

-- The existing SKU reservation contract requires canonical values. Refuse a
-- lossy normalization or a case/whitespace collision rather than rewriting history.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM products WHERE full_sku IS DISTINCT FROM upper(btrim(full_sku))) THEN
    RAISE EXCEPTION 'stable public SKU backfill requires canonical legacy full_sku values';
  END IF;
  IF EXISTS (SELECT upper(btrim(full_sku)) FROM products
    GROUP BY upper(btrim(full_sku)) HAVING count(DISTINCT full_sku) > 1) THEN
    RAISE EXCEPTION 'stable public SKU backfill found a normalized legacy SKU collision';
  END IF;
END;
$$;

-- Preserve the exact externally visible legacy value. Equal historical values
-- share an external identity, but correction traversal continues to use product
-- IDs and explicit correction links.
INSERT INTO public_product_identities(public_sku, origin)
SELECT DISTINCT full_sku, 'legacy'
FROM products
WHERE full_sku IS NOT NULL AND btrim(full_sku) <> ''
ORDER BY full_sku;

DO $$
DECLARE
  legacy_floor NUMERIC;
BEGIN
  IF EXISTS (SELECT 1 FROM products WHERE full_sku IS NULL OR btrim(full_sku) = '') THEN
    RAISE EXCEPTION 'stable public SKU backfill requires every product to have an exact SKU';
  END IF;
  SELECT max(substring(public_sku FROM 4)::numeric) INTO legacy_floor
  FROM public_product_identities
  WHERE public_sku ~ '^AG-[0-9]{6,}$';
  IF legacy_floor IS NULL THEN
    PERFORM setval('public_product_sku_sequence', 1, FALSE);
  ELSIF legacy_floor >= 9223372036854775807 THEN
    RAISE EXCEPTION 'legacy AG public SKU exceeds BIGINT allocation range';
  ELSE
    PERFORM setval('public_product_sku_sequence', legacy_floor::bigint, TRUE);
  END IF;
END;
$$;

ALTER TABLE products ADD COLUMN public_product_identity_id BIGINT;
UPDATE products p
SET public_product_identity_id = i.id
FROM public_product_identities i
WHERE i.public_sku = p.full_sku;
-- The backfill update queues migration 039's deferred lifecycle trigger. Drain
-- those checks before further products DDL, then preserve deferred behavior for
-- the rest of this migration transaction.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE products ALTER COLUMN public_product_identity_id SET NOT NULL;
ALTER TABLE products ADD CONSTRAINT products_public_product_identity_fk
  FOREIGN KEY (public_product_identity_id) REFERENCES public_product_identities(id) ON DELETE RESTRICT;
CREATE INDEX products_public_product_identity_idx ON products(public_product_identity_id, id);
SET CONSTRAINTS ALL DEFERRED;

CREATE TABLE public_sku_activation (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  activated_at TIMESTAMPTZ,
  activated_by_user_id BIGINT REFERENCES application_users(id) ON DELETE RESTRICT,
  activation_event_id BIGINT REFERENCES audit_events(id) ON DELETE RESTRICT,
  CHECK ((NOT enabled AND num_nonnulls(activated_at, activated_by_user_id, activation_event_id) = 0)
    OR (enabled AND num_nonnulls(activated_at, activated_by_user_id, activation_event_id) = 3))
);
INSERT INTO public_sku_activation(singleton) VALUES(TRUE);

CREATE FUNCTION guard_public_sku_activation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'stable public SKU activation state is permanent';
  END IF;
  IF OLD.enabled AND NOT NEW.enabled THEN
    RAISE EXCEPTION 'stable public SKU activation is permanent';
  END IF;
  IF NOT OLD.enabled AND NEW.enabled THEN
    IF current_setting('amber.public_sku_activation', TRUE) IS DISTINCT FROM 'on'
      OR num_nonnulls(NEW.activated_at, NEW.activated_by_user_id, NEW.activation_event_id) <> 3 THEN
      RAISE EXCEPTION 'stable public SKU activation requires the command boundary';
    END IF;
  END IF;
  IF OLD.enabled AND
    (NEW.activated_at, NEW.activated_by_user_id, NEW.activation_event_id) IS DISTINCT FROM
    (OLD.activated_at, OLD.activated_by_user_id, OLD.activation_event_id) THEN
    RAISE EXCEPTION 'stable public SKU activation receipt is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER public_sku_activation_guard BEFORE UPDATE OR DELETE ON public_sku_activation
  FOR EACH ROW EXECUTE FUNCTION guard_public_sku_activation();
CREATE TRIGGER public_sku_activation_no_truncate BEFORE TRUNCATE ON public_sku_activation
  FOR EACH STATEMENT EXECUTE FUNCTION guard_public_sku_activation();

CREATE FUNCTION guard_public_product_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'public product identities are immutable and permanent';
END;
$$;
CREATE TRIGGER public_product_identity_immutable BEFORE UPDATE OR DELETE ON public_product_identities
  FOR EACH ROW EXECUTE FUNCTION guard_public_product_identity();
CREATE TRIGGER public_product_identity_no_truncate BEFORE TRUNCATE ON public_product_identities
  FOR EACH STATEMENT EXECUTE FUNCTION guard_public_product_identity();

CREATE FUNCTION assign_product_public_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_identity BIGINT;
  allocation BIGINT;
  active BOOLEAN;
BEGIN
  SELECT enabled INTO STRICT active FROM public_sku_activation WHERE singleton FOR SHARE;
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
-- Runs after products_reserve_sku by trigger-name ordering, and is still robust
-- to direct writers because it applies the same trim/upper normalization.
CREATE TRIGGER zz_products_assign_public_identity
  BEFORE INSERT ON products FOR EACH ROW EXECUTE FUNCTION assign_product_public_identity();

CREATE FUNCTION guard_product_public_identity_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.public_product_identity_id IS DISTINCT FROM OLD.public_product_identity_id THEN
    RAISE EXCEPTION 'product public identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER products_public_identity_immutable
  BEFORE UPDATE OF public_product_identity_id ON products
  FOR EACH ROW EXECUTE FUNCTION guard_product_public_identity_reference();

-- Recount temporarily has two active rows inside its transaction. Enforce the
-- externally current revision only at commit, after source retirement.
CREATE FUNCTION require_one_current_public_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_identity BIGINT;
BEGIN
  target_identity := CASE WHEN TG_OP = 'INSERT' THEN NEW.public_product_identity_id
    ELSE NEW.public_product_identity_id END;
  IF (SELECT count(*) FROM products
      WHERE public_product_identity_id = target_identity
        AND status = 'active' AND corrected_to_product_id IS NULL) > 1 THEN
    RAISE EXCEPTION 'public product identity has multiple current revisions';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER products_one_current_public_revision
  AFTER INSERT OR UPDATE OF public_product_identity_id, status, corrected_to_product_id ON products
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_one_current_public_revision();

DO $$
BEGIN
  IF EXISTS (
    SELECT public_product_identity_id FROM products
    WHERE status = 'active' AND corrected_to_product_id IS NULL
    GROUP BY public_product_identity_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'legacy public SKU has multiple current product revisions';
  END IF;
END;
$$;

-- Once stable identity is activated, ordinary product/recount writes remain
-- frozen until the independent Magento delivery cutover retires hazardous CSV.
CREATE FUNCTION guard_public_sku_delivery_window() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stable_enabled BOOLEAN;
DECLARE legacy_csv_enabled BOOLEAN;
BEGIN
  -- Share-lock the activation row so an in-flight activation and this writer
  -- serialize whichever transaction reaches the gate first.
  SELECT enabled INTO STRICT stable_enabled
    FROM public_sku_activation WHERE singleton FOR SHARE;
  SELECT legacy_product_csv_enabled INTO STRICT legacy_csv_enabled
    FROM magento_auto_sync_activation WHERE singleton;
  IF stable_enabled AND legacy_csv_enabled THEN
    RAISE EXCEPTION 'product writes remain frozen until Magento delivery cutover';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER products_public_sku_delivery_window
  BEFORE INSERT OR UPDATE OR DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION guard_public_sku_delivery_window();

-- New lifecycle-aware membership captures both identities. Existing rows and
-- artifact bytes remain untouched; sku_at_capture retains its internal meaning.
ALTER TABLE export_snapshot_products
  ADD COLUMN identity_contract SMALLINT CHECK (identity_contract = 1),
  ADD COLUMN internal_sku_at_capture TEXT,
  ADD COLUMN public_sku_at_capture TEXT,
  ADD CONSTRAINT export_snapshot_product_dual_sku_shape CHECK (
    (identity_contract IS NULL
      AND internal_sku_at_capture IS NULL AND public_sku_at_capture IS NULL)
    OR
    (identity_contract = 1 AND evidence_origin = 'live_capture'
      AND length(btrim(internal_sku_at_capture)) > 0
      AND length(btrim(public_sku_at_capture)) > 0
      AND sku_at_capture = internal_sku_at_capture)
  );

-- Immutable jobs retain the exact product revision but also bind the stable
-- remote identity. Existing jobs are additive legacy evidence.
ALTER TABLE magento_sync_jobs ADD COLUMN public_product_identity_id BIGINT;
UPDATE magento_sync_jobs j SET public_product_identity_id = p.public_product_identity_id
FROM products p WHERE p.id = j.product_id;
ALTER TABLE magento_sync_jobs ALTER COLUMN public_product_identity_id SET NOT NULL;
ALTER TABLE magento_sync_jobs ADD CONSTRAINT magento_sync_jobs_public_identity_fk
  FOREIGN KEY(public_product_identity_id) REFERENCES public_product_identities(id) ON DELETE RESTRICT;

DROP INDEX magento_sync_automatic_intent_identity;
CREATE UNIQUE INDEX magento_sync_automatic_intent_identity
  ON magento_sync_jobs(origin_hash,public_product_identity_id,binding_revision_id,automatic_generation)
  WHERE automatic_generation IS NOT NULL AND state <> 'superseded';
DROP INDEX magento_sync_one_unfinished;
CREATE UNIQUE INDEX magento_sync_one_unfinished ON magento_sync_jobs(origin_hash,sku)
  WHERE state NOT IN ('succeeded','superseded');

ALTER TABLE magento_product_sync_requests ADD COLUMN public_product_identity_id BIGINT;
UPDATE magento_product_sync_requests r SET public_product_identity_id = p.public_product_identity_id
FROM products p WHERE p.id = r.product_id;
ALTER TABLE magento_product_sync_requests ALTER COLUMN public_product_identity_id SET NOT NULL;
ALTER TABLE magento_product_sync_requests ADD CONSTRAINT magento_product_sync_requests_public_identity_fk
  FOREIGN KEY(public_product_identity_id) REFERENCES public_product_identities(id) ON DELETE RESTRICT;
ALTER TABLE magento_product_sync_requests DROP CONSTRAINT magento_product_sync_requests_pkey;
ALTER TABLE magento_product_sync_requests ADD PRIMARY KEY(public_product_identity_id);
DROP INDEX magento_product_sync_pending;
CREATE INDEX magento_product_sync_pending
  ON magento_product_sync_requests(next_attempt_at,public_product_identity_id)
  WHERE state IN ('pending','syncing');

CREATE OR REPLACE FUNCTION magento_sync_product_input(p products) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_array(p.public_product_identity_id,p.full_sku,p.category,p.weight,p.total_price_uah,
    p.sku_schema_version_id,p.details->'answers',p.magento_name_subject_ua,p.magento_name_subject_en,
    p.magento_name_review_required,p.status,p.corrected_to_product_id,p.exclude_from_export)
$$;

CREATE OR REPLACE FUNCTION request_magento_product_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active BOOLEAN;
DECLARE desired_product INTEGER;
BEGIN
  IF TG_OP='UPDATE' AND magento_sync_product_input(NEW) IS NOT DISTINCT FROM magento_sync_product_input(OLD) THEN
    RETURN NEW;
  END IF;
  SELECT enabled INTO active FROM magento_auto_sync_activation WHERE singleton FOR SHARE;
  IF active IS NOT TRUE THEN RETURN NEW; END IF;

  -- A recount successor is inserted before its source is retired. Once the
  -- identity request points at that successor, source retirement is not a
  -- second desired remote obligation.
  IF NEW.status <> 'active' OR NEW.corrected_to_product_id IS NOT NULL THEN
    SELECT product_id INTO desired_product FROM magento_product_sync_requests
    WHERE public_product_identity_id = NEW.public_product_identity_id;
    IF desired_product IS NULL OR desired_product <> NEW.id THEN RETURN NEW; END IF;
  END IF;

  INSERT INTO magento_product_sync_requests(public_product_identity_id,product_id)
  VALUES(NEW.public_product_identity_id,NEW.id)
  ON CONFLICT(public_product_identity_id) DO UPDATE SET
    product_id=EXCLUDED.product_id,
    desired_generation=magento_product_sync_requests.desired_generation+1,
    state=CASE WHEN magento_product_sync_requests.reason_code='reconciliation_required'
      THEN 'needs_attention' ELSE 'pending' END,
    reason_code=CASE WHEN magento_product_sync_requests.reason_code='reconciliation_required'
      THEN 'reconciliation_required' ELSE NULL END,
    attempts=0,next_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;
