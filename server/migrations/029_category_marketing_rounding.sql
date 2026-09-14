ALTER TABLE categories
  ADD COLUMN marketing_rounding_enabled INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT categories_marketing_rounding_flag CHECK (marketing_rounding_enabled IN (0, 1));
