-- Durable pre-save public articles. Installation allocates no identity or product.
CREATE TABLE product_creation_sku_reservations (
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  category_code TEXT NOT NULL REFERENCES categories(code) ON UPDATE RESTRICT ON DELETE RESTRICT,
  is_test_product BOOLEAN NOT NULL DEFAULT FALSE,
  public_product_identity_id BIGINT UNIQUE REFERENCES public_product_identities(id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','cancelled','consumed')),
  product_id INTEGER UNIQUE REFERENCES products(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMPTZ,
  PRIMARY KEY(actor_user_id,idempotency_key),
  CHECK ((state='reserved' AND public_product_identity_id IS NOT NULL AND product_id IS NULL AND closed_at IS NULL)
    OR (state='cancelled' AND product_id IS NULL AND closed_at IS NOT NULL)
    OR (state='consumed' AND public_product_identity_id IS NOT NULL AND product_id IS NOT NULL AND closed_at IS NOT NULL))
);
CREATE FUNCTION guard_creation_sku_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'creation SKU reservations are permanent'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state='consumed' OR (NEW.public_product_identity_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public_product_identities i WHERE i.id=NEW.public_product_identity_id
        AND i.origin='allocated' AND i.is_test_product=NEW.is_test_product
        AND NOT EXISTS(SELECT 1 FROM products p WHERE p.public_product_identity_id=i.id))) THEN
      RAISE EXCEPTION 'creation SKU reservation requires an unused allocated identity';
    END IF;
  ELSIF OLD.state<>'reserved' OR NEW.state NOT IN ('cancelled','consumed')
    OR (NEW.actor_user_id,NEW.idempotency_key,NEW.category_code,NEW.is_test_product,
        NEW.public_product_identity_id,NEW.created_at) IS DISTINCT FROM
       (OLD.actor_user_id,OLD.idempotency_key,OLD.category_code,OLD.is_test_product,
        OLD.public_product_identity_id,OLD.created_at) THEN
    RAISE EXCEPTION 'creation SKU reservation identity and terminal state are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER creation_sku_reservation_guard BEFORE INSERT OR UPDATE OR DELETE ON product_creation_sku_reservations
  FOR EACH ROW EXECUTE FUNCTION guard_creation_sku_reservation();
CREATE TRIGGER creation_sku_reservation_no_truncate BEFORE TRUNCATE ON product_creation_sku_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION guard_creation_sku_reservation();
CREATE FUNCTION require_creation_sku_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reservation product_creation_sku_reservations;
BEGIN
  SELECT * INTO reservation FROM product_creation_sku_reservations
    WHERE actor_user_id=NEW.actor_user_id AND idempotency_key=NEW.idempotency_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME='product_creation_receipts' AND reservation.state<>'consumed' THEN
    RAISE EXCEPTION 'creation receipt requires consumption of its reserved public identity';
  END IF;
  IF reservation.state='consumed' AND NOT EXISTS (
    SELECT 1 FROM products p JOIN product_creation_receipts r ON r.product_id=p.id
    JOIN public_product_identities i ON i.id=p.public_product_identity_id
    WHERE p.id=reservation.product_id AND p.public_product_identity_id=reservation.public_product_identity_id
      AND p.created_by_user_id=reservation.actor_user_id AND p.corrected_from_product_id IS NULL
      AND p.category=reservation.category_code AND i.is_test_product=reservation.is_test_product
      AND r.actor_user_id=reservation.actor_user_id AND r.idempotency_key=reservation.idempotency_key
      AND r.result->>'publicSku'=i.public_sku) THEN
    RAISE EXCEPTION 'creation SKU consumption requires the exact atomic product and receipt';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER creation_sku_consumption_atomic AFTER INSERT OR UPDATE ON product_creation_sku_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_creation_sku_consumption();
CREATE CONSTRAINT TRIGGER creation_receipt_reserved_identity AFTER INSERT ON product_creation_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_creation_sku_consumption();

CREATE OR REPLACE FUNCTION assign_product_public_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_identity BIGINT;
  allocation BIGINT;
  active BOOLEAN;
  reservation product_creation_sku_reservations;
  reservation_key TEXT;
BEGIN
  SELECT enabled INTO STRICT active FROM public_sku_activation WHERE singleton FOR SHARE;
  reservation_key := NULLIF(current_setting('amber.creation_reservation_key',TRUE),'');
  IF reservation_key IS NOT NULL AND NEW.corrected_from_product_id IS NULL THEN
    IF NOT active OR NEW.characteristic_version_id IS NULL OR NEW.public_product_identity_id IS NOT NULL
      OR NEW.created_by_user_id IS DISTINCT FROM NULLIF(current_setting('amber.creation_reservation_actor',TRUE),'')::bigint THEN
      RAISE EXCEPTION 'reserved public identity requires native server creation authority';
    END IF;
    PERFORM pg_advisory_xact_lock_shared(hashtext('amber_application_user_admin_active_administrators'));
    IF NOT EXISTS(SELECT 1 FROM application_users u
      JOIN user_role_assignments a ON a.application_user_id=u.id JOIN roles r ON r.id=a.role_id
      JOIN role_permissions rp ON rp.role_id=r.id AND rp.permission_key='products.create'
      WHERE u.id=NEW.created_by_user_id AND u.status='active' AND a.revoked_at IS NULL AND r.status='active') THEN
      RAISE EXCEPTION 'reserved public identity requires active product creation permission';
    END IF;
    SELECT * INTO STRICT reservation FROM product_creation_sku_reservations
      WHERE actor_user_id=NEW.created_by_user_id AND idempotency_key=reservation_key::uuid FOR UPDATE;
    IF reservation.state<>'reserved' OR reservation.category_code<>NEW.category
      OR reservation.is_test_product IS DISTINCT FROM (COALESCE(current_setting('amber.create_test_product',TRUE),'')='on')
      OR EXISTS(SELECT 1 FROM products WHERE public_product_identity_id=reservation.public_product_identity_id) THEN
      RAISE EXCEPTION 'reserved public identity context changed or is already closed';
    END IF;
    IF reservation.is_test_product AND NOT EXISTS(SELECT 1 FROM application_users u
      JOIN user_role_assignments a ON a.application_user_id=u.id JOIN roles r ON r.id=a.role_id
      WHERE u.id=NEW.created_by_user_id AND u.id=NULLIF(current_setting('amber.create_test_product_actor',TRUE),'')::bigint
        AND u.status='active' AND a.revoked_at IS NULL AND r.status='active' AND r.role_key='administrator' AND r.is_system=TRUE) THEN
      RAISE EXCEPTION 'TEST creation requires actual active Administrator';
    END IF;
    NEW.public_product_identity_id := reservation.public_product_identity_id;
    UPDATE product_creation_sku_reservations SET state='consumed',product_id=NEW.id,closed_at=CURRENT_TIMESTAMP
      WHERE actor_user_id=reservation.actor_user_id AND idempotency_key=reservation.idempotency_key;
    RETURN NEW;
  END IF;
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
