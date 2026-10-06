-- Forward metadata only; never rewrite answers, publications or remote resources.
ALTER TABLE questions ADD COLUMN archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE questions ADD COLUMN numeric_validation JSONB;
ALTER TABLE questions ADD CONSTRAINT questions_numeric_validation_shape CHECK (
  numeric_validation IS NULL OR (
    input_type = 'text' AND jsonb_typeof(numeric_validation) = 'object'
    AND numeric_validation ?& ARRAY['kind','unit','min','max','minInclusive','maxInclusive','maxFractionDigits']
    AND numeric_validation->>'kind' IN ('integer', 'decimal')
    AND jsonb_typeof(numeric_validation->'minInclusive') = 'boolean'
    AND jsonb_typeof(numeric_validation->'maxInclusive') = 'boolean'
    AND jsonb_typeof(numeric_validation->'min') IN ('number', 'null')
    AND jsonb_typeof(numeric_validation->'max') IN ('number', 'null')
    AND jsonb_typeof(numeric_validation->'unit') IN ('string', 'null')
    AND jsonb_typeof(numeric_validation->'maxFractionDigits') IN ('number', 'null')
  )
);
-- Semantic-only options need no legacy encoded digit. Historical codes remain.
ALTER TABLE options ALTER COLUMN sku_code DROP NOT NULL;

CREATE SEQUENCE catalog_semantic_value_sequence AS INTEGER MINVALUE 1 NO CYCLE;
SELECT setval('catalog_semantic_value_sequence', GREATEST(1,
  COALESCE((SELECT MAX(value_id)::bigint + 1 FROM options), 1),
  COALESCE((SELECT MAX(value_id)::bigint + 1 FROM sku_schema_options), 1),
  COALESCE((SELECT MAX(value_id)::bigint + 1 FROM magento_binding_options), 1),
  COALESCE((SELECT MAX((so->>'value_id')::bigint) + 1 FROM product_characteristic_versions cv,
    jsonb_array_elements(cv.snapshot->'questions') sq, jsonb_array_elements(sq->'options') so), 1)), false);
CREATE TABLE catalog_semantic_values (
  question_id INTEGER NOT NULL,
  value_id INTEGER NOT NULL,
  PRIMARY KEY (question_id, value_id)
);
INSERT INTO catalog_semantic_values(question_id,value_id)
  SELECT DISTINCT question_id,value_id FROM options WHERE value_id IS NOT NULL;
INSERT INTO catalog_semantic_values(question_id,value_id)
  SELECT DISTINCT q.id,o.value_id FROM sku_schema_options o
  JOIN sku_schema_questions sq ON sq.id=o.schema_question_id
  JOIN sku_schema_versions sv ON sv.id=sq.schema_version_id
  JOIN questions q ON q.category_code=sv.category_code AND q.key=sq.question_key
  ON CONFLICT DO NOTHING;
INSERT INTO catalog_semantic_values(question_id,value_id)
  SELECT DISTINCT (sq->>'id')::integer,(so->>'value_id')::integer FROM product_characteristic_versions cv,
    jsonb_array_elements(cv.snapshot->'questions') sq, jsonb_array_elements(sq->'options') so
  ON CONFLICT DO NOTHING;
CREATE FUNCTION reserve_catalog_semantic_value() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.value_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.question_id=OLD.question_id AND NEW.value_id=OLD.value_id THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('catalog_semantic_value_allocation'));
  IF TG_OP='INSERT' THEN
    PERFORM id FROM questions WHERE id=NEW.question_id FOR NO KEY UPDATE;
  END IF;
  IF EXISTS(SELECT 1 FROM catalog_semantic_values WHERE question_id=NEW.question_id AND value_id=NEW.value_id)
    AND NOT EXISTS(SELECT 1 FROM options WHERE question_id=NEW.question_id AND value_id=NEW.value_id) THEN
    RAISE EXCEPTION 'Semantic catalog identities cannot be reused';
  END IF;
  INSERT INTO catalog_semantic_values(question_id,value_id) VALUES(NEW.question_id,NEW.value_id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER options_reserve_semantic_value BEFORE INSERT OR UPDATE OF value_id,question_id ON options
  FOR EACH ROW EXECUTE FUNCTION reserve_catalog_semantic_value();
CREATE FUNCTION guard_catalog_semantic_values() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Semantic catalog identities are permanent'; END $$;
CREATE TRIGGER catalog_semantic_values_immutable BEFORE UPDATE OR DELETE ON catalog_semantic_values
  FOR EACH ROW EXECUTE FUNCTION guard_catalog_semantic_values();
CREATE TRIGGER catalog_semantic_values_no_truncate BEFORE TRUNCATE ON catalog_semantic_values
  FOR EACH STATEMENT EXECUTE FUNCTION guard_catalog_semantic_values();

-- Coordinate even controlled SQL/import inserts with native-save snapshot locks.
CREATE FUNCTION fence_catalog_question_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM code FROM categories WHERE code=NEW.category_code FOR NO KEY UPDATE;
  RETURN NEW;
END $$;
CREATE TRIGGER questions_fence_native_snapshot BEFORE INSERT ON questions
  FOR EACH ROW EXECUTE FUNCTION fence_catalog_question_insert();
