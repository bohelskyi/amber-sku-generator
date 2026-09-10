-- Legacy product price 0 meant "not set". Keep that stored value so decoding
-- cannot fall back to today's automatic matrix price, but explicitly mark the
-- grandfathered rows so new products remain subject to the positive-price rule.
ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_uah_price_positive,
  ADD COLUMN IF NOT EXISTS legacy_uah_price_unset BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE products
SET legacy_uah_price_unset = TRUE
WHERE total_price_uah = 0;

ALTER TABLE products
  ADD CONSTRAINT products_uah_price_positive CHECK (
    total_price_uah IS NULL
    OR total_price_uah > 0
    OR (total_price_uah = 0 AND legacy_uah_price_unset)
  ) NOT VALID;

-- A zero matrix value represented an absent automatic price rather than a
-- valid price. Removing the row preserves that lookup behavior explicitly.
DELETE FROM price_matrix
WHERE price = 0;
