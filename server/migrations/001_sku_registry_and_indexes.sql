CREATE TABLE IF NOT EXISTS sku_registry (
  full_sku TEXT PRIMARY KEY,
  first_product_id INTEGER,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO sku_registry (full_sku, first_product_id)
SELECT UPPER(TRIM(full_sku)), MIN(id)
FROM products
WHERE full_sku IS NOT NULL AND TRIM(full_sku) <> ''
GROUP BY UPPER(TRIM(full_sku))
ON CONFLICT (full_sku) DO NOTHING;

CREATE OR REPLACE FUNCTION reserve_product_sku()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.full_sku IS NULL OR TRIM(NEW.full_sku) = '' THEN
    RAISE EXCEPTION 'Артикул не може бути порожнім' USING ERRCODE = '23502';
  END IF;

  NEW.full_sku := UPPER(TRIM(NEW.full_sku));

  IF TG_OP = 'UPDATE' AND NEW.full_sku = OLD.full_sku THEN
    RETURN NEW;
  END IF;

  INSERT INTO sku_registry (full_sku, first_product_id)
  VALUES (NEW.full_sku, NEW.id)
  ON CONFLICT (full_sku) DO NOTHING;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Артикул % вже зарезервований', NEW.full_sku USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS products_reserve_sku ON products;
CREATE TRIGGER products_reserve_sku
BEFORE INSERT OR UPDATE OF full_sku ON products
FOR EACH ROW
EXECUTE FUNCTION reserve_product_sku();

CREATE INDEX IF NOT EXISTS products_full_sku_idx ON products (full_sku);
CREATE INDEX IF NOT EXISTS products_base_sequence_idx ON products (base_sku, sequence_number DESC);
CREATE INDEX IF NOT EXISTS products_export_queue_idx ON products (id) WHERE COALESCE(exclude_from_export, 0) = 0;
CREATE INDEX IF NOT EXISTS product_corrections_source_idx ON product_corrections (source_product_id);
CREATE INDEX IF NOT EXISTS product_corrections_corrected_idx ON product_corrections (corrected_product_id);
