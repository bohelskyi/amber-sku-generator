-- 000 creates these references with update cascades, while installations
-- bootstrapped by the former runtime DDL did not. Recreate them so fresh and
-- upgraded databases have the same referential behavior without scanning
-- existing rows during startup.
ALTER TABLE questions
  DROP CONSTRAINT IF EXISTS questions_category_code_fkey,
  ADD CONSTRAINT questions_category_code_fkey
    FOREIGN KEY (category_code) REFERENCES categories(code)
    ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

ALTER TABLE price_scenarios
  DROP CONSTRAINT IF EXISTS price_scenarios_category_code_fkey,
  ADD CONSTRAINT price_scenarios_category_code_fkey
    FOREIGN KEY (category_code) REFERENCES categories(code)
    ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

ALTER TABLE price_modifiers
  DROP CONSTRAINT IF EXISTS price_modifiers_category_code_fkey,
  ADD CONSTRAINT price_modifiers_category_code_fkey
    FOREIGN KEY (category_code) REFERENCES categories(code)
    ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

CREATE OR REPLACE FUNCTION prevent_duplicate_question_key()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Existing installations may already contain duplicate legacy rows, so this
  -- cannot be replaced by a unique index without a data migration. Serialize
  -- writers for the logical key before checking, making the trigger atomic for
  -- all new inserts and key changes.
  PERFORM pg_advisory_xact_lock(hashtext('question-key:' || NEW.category_code || ':' || NEW.key));
  IF EXISTS (
    SELECT 1 FROM questions q
    WHERE q.category_code = NEW.category_code
      AND q.key = NEW.key
      AND q.id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION 'question key % already exists in category %', NEW.key, NEW.category_code
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
