-- Publication evidence and exact product obligations, not a report/job engine.
CREATE TABLE magento_binding_handoffs (
  id TEXT PRIMARY KEY,
  binding_revision_id TEXT NOT NULL REFERENCES magento_binding_revisions(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('publication','broader_resync','name_rule')),
  preview_hash TEXT NOT NULL CHECK (preview_hash ~ '^[a-f0-9]{64}$'),
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=4194304),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX magento_one_publication_handoff ON magento_binding_handoffs(binding_revision_id) WHERE kind='publication';
CREATE UNIQUE INDEX magento_handoff_review_identity ON magento_binding_handoffs(binding_revision_id,kind,preview_hash);
CREATE TABLE magento_binding_handoff_items (
  handoff_id TEXT NOT NULL REFERENCES magento_binding_handoffs(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  public_product_identity_id BIGINT NOT NULL REFERENCES public_product_identities(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason IN ('unblocked','delivery_changed','reviewed_resync','name_rule')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','enrolled','protected','retired')),
  generation BIGINT CHECK (generation>0),
  PRIMARY KEY(handoff_id,product_id),
  CHECK ((state='enrolled')=(generation IS NOT NULL))
);
CREATE INDEX magento_handoff_pending ON magento_binding_handoff_items(handoff_id,product_id) WHERE state='pending';
CREATE TABLE magento_binding_name_pins (
  binding_revision_id TEXT NOT NULL REFERENCES magento_binding_revisions(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  generated JSONB NOT NULL CHECK (jsonb_typeof(generated)='object'),
  effective_names JSONB NOT NULL CHECK (jsonb_typeof(effective_names)='object'),
  PRIMARY KEY(binding_revision_id,product_id),
  CHECK (octet_length(generated::text)+octet_length(effective_names::text)<=8192)
);
CREATE FUNCTION protect_magento_publication_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='magento_binding_handoff_items' AND TG_OP='UPDATE' THEN
    IF OLD.state='pending' AND NEW.state<>'pending' AND
      ROW(NEW.handoff_id,NEW.product_id,NEW.public_product_identity_id,NEW.reason)
      IS NOT DISTINCT FROM ROW(OLD.handoff_id,OLD.product_id,OLD.public_product_identity_id,OLD.reason) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Magento publication evidence is immutable; obligations settle once';
END $$;
CREATE TRIGGER magento_handoff_immutable BEFORE UPDATE OR DELETE ON magento_binding_handoffs FOR EACH ROW EXECUTE FUNCTION protect_magento_publication_evidence();
CREATE TRIGGER magento_handoff_no_truncate BEFORE TRUNCATE ON magento_binding_handoffs FOR EACH STATEMENT EXECUTE FUNCTION protect_magento_publication_evidence();
CREATE TRIGGER magento_handoff_item_progress BEFORE UPDATE OR DELETE ON magento_binding_handoff_items FOR EACH ROW EXECUTE FUNCTION protect_magento_publication_evidence();
CREATE TRIGGER magento_handoff_item_no_truncate BEFORE TRUNCATE ON magento_binding_handoff_items FOR EACH STATEMENT EXECUTE FUNCTION protect_magento_publication_evidence();
CREATE TRIGGER magento_name_pin_immutable BEFORE UPDATE OR DELETE ON magento_binding_name_pins FOR EACH ROW EXECUTE FUNCTION protect_magento_publication_evidence();
CREATE TRIGGER magento_name_pin_no_truncate BEFORE TRUNCATE ON magento_binding_name_pins FOR EACH STATEMENT EXECUTE FUNCTION protect_magento_publication_evidence();
