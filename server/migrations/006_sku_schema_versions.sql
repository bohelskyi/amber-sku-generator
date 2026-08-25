ALTER TABLE options
  ADD COLUMN IF NOT EXISTS sku_code TEXT;

UPDATE options
SET sku_code = value_id::text
WHERE sku_code IS NULL OR BTRIM(sku_code) = '';

ALTER TABLE options
  ALTER COLUMN sku_code SET NOT NULL;

CREATE TABLE IF NOT EXISTS sku_schema_versions (
  id SERIAL PRIMARY KEY,
  category_code TEXT NOT NULL REFERENCES categories(code) ON UPDATE CASCADE ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  marker TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  config_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (category_code, version),
  UNIQUE (category_code, marker)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sku_schema_versions_one_active
  ON sku_schema_versions (category_code)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS sku_schema_questions (
  id SERIAL PRIMARY KEY,
  schema_version_id INTEGER NOT NULL REFERENCES sku_schema_versions(id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,
  label TEXT NOT NULL,
  sku_index INTEGER NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  sku_separator TEXT NOT NULL DEFAULT '',
  visible_if_json JSONB,
  display_order REAL NOT NULL DEFAULT 0,
  UNIQUE (schema_version_id, question_key)
);

CREATE TABLE IF NOT EXISTS sku_schema_options (
  id SERIAL PRIMARY KEY,
  schema_question_id INTEGER NOT NULL REFERENCES sku_schema_questions(id) ON DELETE CASCADE,
  value_id INTEGER NOT NULL,
  sku_code TEXT NOT NULL,
  label TEXT NOT NULL,
  visible_if_json JSONB,
  hidden_if_json JSONB,
  archived BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_sku_schema_questions_version
  ON sku_schema_questions (schema_version_id, sku_index);

CREATE INDEX IF NOT EXISTS idx_sku_schema_options_question_code
  ON sku_schema_options (schema_question_id, sku_code);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS sku_schema_version_id INTEGER
  REFERENCES sku_schema_versions(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_products_sku_schema_version
  ON products (sku_schema_version_id);
