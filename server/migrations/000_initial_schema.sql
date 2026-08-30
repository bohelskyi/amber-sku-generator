CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  full_sku TEXT,
  base_sku TEXT,
  sequence_number INTEGER,
  category TEXT,
  weight REAL,
  total_price REAL,
  total_price_uah REAL,
  price_per_gram REAL,
  uah_rate REAL,
  details JSONB,
  status TEXT DEFAULT 'active',
  exclude_from_export INTEGER DEFAULT 0,
  corrected_from_product_id INTEGER REFERENCES products(id),
  corrected_to_product_id INTEGER REFERENCES products(id),
  correction_reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  code TEXT PRIMARY KEY,
  name TEXT,
  requires_weight INTEGER DEFAULT 1,
  sku_separator TEXT DEFAULT '',
  skip_hidden_sku_questions INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS questions (
  id SERIAL PRIMARY KEY,
  category_code TEXT REFERENCES categories(code) ON UPDATE CASCADE ON DELETE CASCADE,
  key TEXT,
  label TEXT,
  sku_index INTEGER,
  display_order REAL,
  required INTEGER DEFAULT 1,
  include_in_sku INTEGER DEFAULT 1,
  input_type TEXT DEFAULT 'options',
  sku_separator TEXT DEFAULT '',
  visible_if_json JSONB
);

CREATE TABLE IF NOT EXISTS options (
  id SERIAL PRIMARY KEY,
  question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
  value_id INTEGER,
  sku_code TEXT,
  label TEXT,
  visible_if_json JSONB,
  hidden_if_json JSONB,
  archived BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS price_scenarios (
  id SERIAL PRIMARY KEY,
  category_code TEXT REFERENCES categories(code) ON UPDATE CASCADE ON DELETE CASCADE,
  name TEXT,
  group_name TEXT DEFAULT '',
  match_json JSONB,
  axis_x_key TEXT,
  axis_y_key TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  price_mode TEXT NOT NULL DEFAULT 'category_default',
  apply_modifiers BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS price_matrix (
  scenario_id INTEGER REFERENCES price_scenarios(id) ON DELETE CASCADE,
  x_val INTEGER NOT NULL,
  y_val INTEGER NOT NULL DEFAULT 0,
  price REAL,
  PRIMARY KEY (scenario_id, x_val, y_val)
);

CREATE TABLE IF NOT EXISTS price_modifiers (
  id SERIAL PRIMARY KEY,
  category_code TEXT REFERENCES categories(code) ON UPDATE CASCADE ON DELETE CASCADE,
  trigger_key TEXT,
  trigger_val INTEGER,
  match_json JSONB,
  factor REAL
);

CREATE TABLE IF NOT EXISTS export_events (
  id SERIAL PRIMARY KEY,
  from_sku TEXT,
  to_sku TEXT,
  resolved_to_sku TEXT,
  exported_to_product_id INTEGER,
  row_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_corrections (
  id SERIAL PRIMARY KEY,
  source_product_id INTEGER REFERENCES products(id),
  corrected_product_id INTEGER REFERENCES products(id),
  source_sku TEXT,
  corrected_sku TEXT,
  old_payload JSONB,
  new_payload JSONB,
  reason TEXT,
  price_delta_uah REAL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
