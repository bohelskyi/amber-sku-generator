-- NUMERIC keeps persisted pricing deterministic. Node converts all of these values
-- through Number at calculation boundaries; API payloads therefore remain compatible.
ALTER TABLE products
  ALTER COLUMN weight TYPE NUMERIC(14,3) USING weight::numeric,
  ALTER COLUMN total_price TYPE NUMERIC(18,4) USING total_price::numeric,
  ALTER COLUMN total_price_uah TYPE NUMERIC(18,2) USING total_price_uah::numeric,
  ALTER COLUMN price_per_gram TYPE NUMERIC(18,4) USING price_per_gram::numeric,
  ALTER COLUMN uah_rate TYPE NUMERIC(18,6) USING uah_rate::numeric;

ALTER TABLE price_matrix
  ALTER COLUMN price TYPE NUMERIC(18,4) USING price::numeric;

ALTER TABLE price_modifiers
  ALTER COLUMN factor TYPE NUMERIC(12,6) USING factor::numeric;

ALTER TABLE product_corrections
  ALTER COLUMN price_delta_uah TYPE NUMERIC(18,2) USING price_delta_uah::numeric;

ALTER TABLE categories
  ADD CONSTRAINT categories_code_nonempty CHECK (BTRIM(code) <> '') NOT VALID,
  ADD CONSTRAINT categories_requires_weight_flag CHECK (requires_weight IN (0, 1)) NOT VALID,
  ADD CONSTRAINT categories_skip_hidden_flag CHECK (skip_hidden_sku_questions IN (0, 1)) NOT VALID;

ALTER TABLE questions
  ADD CONSTRAINT questions_category_required CHECK (category_code IS NOT NULL) NOT VALID,
  ADD CONSTRAINT questions_key_nonempty CHECK (key IS NOT NULL AND BTRIM(key) <> '') NOT VALID,
  ADD CONSTRAINT questions_label_required CHECK (label IS NOT NULL) NOT VALID,
  ADD CONSTRAINT questions_required_flag CHECK (required IN (0, 1)) NOT VALID,
  ADD CONSTRAINT questions_include_sku_flag CHECK (include_in_sku IN (0, 1)) NOT VALID,
  ADD CONSTRAINT questions_input_type_allowed CHECK (input_type IN ('options', 'text')) NOT VALID;

ALTER TABLE options
  ADD CONSTRAINT options_question_required CHECK (question_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT options_value_required CHECK (value_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT options_sku_code_nonempty CHECK (BTRIM(sku_code) <> '') NOT VALID,
  ADD CONSTRAINT options_label_required CHECK (label IS NOT NULL) NOT VALID;

ALTER TABLE products
  ADD CONSTRAINT products_category_required CHECK (category IS NOT NULL AND BTRIM(category) <> '') NOT VALID,
  ADD CONSTRAINT products_status_allowed CHECK (status IN ('active', 'archived', 'corrected')) NOT VALID,
  ADD CONSTRAINT products_export_flag CHECK (exclude_from_export IN (0, 1)) NOT VALID,
  ADD CONSTRAINT products_weight_nonnegative CHECK (weight IS NULL OR weight >= 0) NOT VALID,
  ADD CONSTRAINT products_total_price_nonnegative CHECK (total_price IS NULL OR total_price >= 0) NOT VALID,
  ADD CONSTRAINT products_uah_price_positive CHECK (total_price_uah IS NULL OR total_price_uah > 0) NOT VALID,
  ADD CONSTRAINT products_price_per_gram_nonnegative CHECK (price_per_gram IS NULL OR price_per_gram >= 0) NOT VALID,
  ADD CONSTRAINT products_uah_rate_positive CHECK (uah_rate IS NULL OR uah_rate > 0) NOT VALID;

ALTER TABLE products
  ADD CONSTRAINT products_category_fk
  FOREIGN KEY (category) REFERENCES categories(code)
  ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;

ALTER TABLE price_scenarios
  ADD CONSTRAINT price_scenarios_status_allowed CHECK (status IN ('draft', 'active', 'archived')) NOT VALID,
  ADD CONSTRAINT price_scenarios_mode_allowed CHECK (price_mode IN ('category_default', 'per_gram_usd', 'fixed_uah')) NOT VALID;

ALTER TABLE price_matrix
  ADD CONSTRAINT price_matrix_price_positive CHECK (price IS NULL OR price > 0) NOT VALID;

ALTER TABLE price_modifiers
  ADD CONSTRAINT price_modifiers_factor_positive CHECK (factor IS NULL OR factor > 0) NOT VALID;

ALTER TABLE exchange_rate_cache
  ADD CONSTRAINT exchange_rate_cache_pair_nonempty CHECK (BTRIM(currency_pair) <> '') NOT VALID;

CREATE OR REPLACE FUNCTION prevent_duplicate_question_key()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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

DROP TRIGGER IF EXISTS questions_unique_category_key ON questions;
CREATE TRIGGER questions_unique_category_key
BEFORE INSERT OR UPDATE OF category_code, key ON questions
FOR EACH ROW EXECUTE FUNCTION prevent_duplicate_question_key();
