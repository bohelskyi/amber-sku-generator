-- Schema only: no installation IDs, credentials, candidates, or publication seeds.
CREATE TYPE magento_binding_review AS ENUM ('proposed', 'review_required', 'approved', 'blocked');
CREATE TYPE magento_binding_strategy AS ENUM
  ('scalar', 'semantic_option', 'dynamic_exact_label_option', 'numeric_band_option', 'constant_option', 'transport_control');

CREATE TABLE magento_binding_revisions (
  id TEXT PRIMARY KEY,
  installation_key TEXT NOT NULL CHECK (installation_key ~ '^[a-z][a-z0-9_-]{0,79}$'),
  origin_hash TEXT NOT NULL CHECK (origin_hash ~ '^[a-f0-9]{64}$'),
  template_id TEXT NOT NULL,
  template_version_id TEXT NOT NULL,
  template_definition_hash TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  output_contract TEXT NOT NULL,
  format_version INTEGER NOT NULL,
  schema_fingerprint TEXT NOT NULL CHECK (schema_fingerprint ~ '^[a-f0-9]{64}$'),
  topology_fingerprint TEXT NOT NULL CHECK (topology_fingerprint ~ '^[a-f0-9]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  observation_store_code TEXT NOT NULL CHECK (observation_store_code ~ '^[a-zA-Z][a-zA-Z0-9_]{0,99}$'),
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  version_number BIGINT CHECK (version_number > 0),
  created_by_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  modified_by_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  published_by_user_id BIGINT REFERENCES application_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modified_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TIMESTAMPTZ,
  UNIQUE (installation_key, version_number),
  FOREIGN KEY (template_version_id, template_id, template_definition_hash, evaluator_version, output_contract, format_version)
    REFERENCES export_template_versions(id, template_id, definition_hash, evaluator_version, output_contract, format_version) ON DELETE RESTRICT,
  CHECK ((state = 'draft' AND num_nonnulls(version_number, published_by_user_id, published_at) = 0)
    OR (state = 'published' AND num_nonnulls(version_number, published_by_user_id, published_at) = 3))
);
CREATE INDEX magento_binding_history_idx ON magento_binding_revisions(installation_key, created_at DESC, id);

-- Detached, normalized GET observation. These rows are frozen even while bindings are a draft.
CREATE TABLE magento_binding_schema_sets (
  revision_id TEXT NOT NULL REFERENCES magento_binding_revisions(id) ON DELETE RESTRICT,
  set_id BIGINT NOT NULL CHECK (set_id > 0),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 4096),
  PRIMARY KEY (revision_id, set_id)
);
CREATE TABLE magento_binding_schema_attributes (
  revision_id TEXT NOT NULL REFERENCES magento_binding_revisions(id) ON DELETE RESTRICT,
  code TEXT NOT NULL CHECK (code ~ '^[a-zA-Z][a-zA-Z0-9_]{0,99}$'),
  attribute_id BIGINT NOT NULL CHECK (attribute_id > 0),
  metadata JSONB NOT NULL CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 16384),
  PRIMARY KEY (revision_id, code),
  UNIQUE (revision_id, attribute_id),
  CHECK ((metadata->>'attribute_code' = code AND metadata->>'attribute_id' = attribute_id::text) IS TRUE)
);
CREATE TABLE magento_binding_schema_options (
  revision_id TEXT NOT NULL,
  attribute_code TEXT NOT NULL,
  option_id TEXT NOT NULL CHECK (length(option_id) <= 4096),
  label TEXT NOT NULL CHECK (length(label) <= 4096),
  PRIMARY KEY (revision_id, attribute_code, option_id),
  FOREIGN KEY (revision_id, attribute_code) REFERENCES magento_binding_schema_attributes(revision_id, code) ON DELETE RESTRICT
);
CREATE TABLE magento_binding_schema_members (
  revision_id TEXT NOT NULL,
  set_id BIGINT NOT NULL,
  attribute_code TEXT NOT NULL,
  PRIMARY KEY (revision_id, set_id, attribute_code),
  FOREIGN KEY (revision_id, set_id) REFERENCES magento_binding_schema_sets(revision_id, set_id) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id, attribute_code) REFERENCES magento_binding_schema_attributes(revision_id, code) ON DELETE RESTRICT
);
CREATE TABLE magento_binding_schema_stores (
  revision_id TEXT NOT NULL REFERENCES magento_binding_revisions(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('websites', 'storeGroups', 'storeViews')),
  remote_id BIGINT NOT NULL CHECK (remote_id >= 0),
  code TEXT CHECK (code ~ '^[a-zA-Z][a-zA-Z0-9_]{0,99}$'),
  metadata JSONB NOT NULL CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 16384),
  PRIMARY KEY (revision_id, kind, remote_id),
  UNIQUE (revision_id, kind, code),
  UNIQUE (revision_id, kind, remote_id, code),
  CHECK (kind = 'storeGroups' OR code IS NOT NULL),
  CHECK ((metadata->>'id' = remote_id::text) IS TRUE),
  CHECK ((metadata->>'code') IS NOT DISTINCT FROM code)
);

-- The key encodes a canonical conjunction of semantic predicates, never audit order.
CREATE FUNCTION magento_binding_route_key(amber_group TEXT, predicates JSONB) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE p JSONB; parts TEXT[] := '{}'; part TEXT;
BEGIN
  IF jsonb_typeof(predicates) <> 'array' THEN RAISE EXCEPTION 'invalid binding route predicates'; END IF;
  FOR p IN SELECT value FROM jsonb_array_elements(predicates) LOOP
    IF jsonb_typeof(p) <> 'object' OR p - ARRAY['questionKey','valueId','equal'] <> '{}'
      OR (jsonb_typeof(p->'questionKey') = 'string' AND p->>'questionKey' ~ '^[a-zA-Z][a-zA-Z0-9_]{0,99}$'
        AND jsonb_typeof(p->'valueId') = 'string' AND p->>'valueId' ~ '^(0|-?[1-9][0-9]*)$'
        AND jsonb_typeof(p->'equal') = 'boolean') IS NOT TRUE THEN
      RAISE EXCEPTION 'invalid binding route predicate';
    END IF;
    PERFORM (p->>'valueId')::INTEGER;
    part := (p->>'questionKey') || CASE WHEN (p->>'equal')::BOOLEAN THEN '=' ELSE '!=' END || 'value_id:' || (p->>'valueId');
    IF part = ANY(parts) THEN RAISE EXCEPTION 'duplicate binding route predicate'; END IF;
    parts := array_append(parts, part);
  END LOOP;
  RETURN amber_group || CASE WHEN cardinality(parts) = 0 THEN ':all'
    ELSE '.' || (SELECT string_agg(value, '&' ORDER BY value COLLATE "C") FROM unnest(parts) value) END;
END;
$$;
CREATE TABLE magento_binding_routes (
  revision_id TEXT NOT NULL REFERENCES magento_binding_revisions(id) ON DELETE RESTRICT,
  route_key TEXT NOT NULL CHECK (length(route_key) BETWEEN 1 AND 512),
  amber_group TEXT NOT NULL CHECK (amber_group IN ('BR','NM','KL','CH','AR','SV')),
  predicates JSONB NOT NULL CHECK (jsonb_typeof(predicates) = 'array' AND octet_length(predicates::text) <= 8192),
  evaluator_set_name TEXT NOT NULL CHECK (length(evaluator_set_name) BETWEEN 1 AND 4096),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  set_id BIGINT,
  review_state magento_binding_review NOT NULL DEFAULT 'review_required',
  evidence JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 8192),
  PRIMARY KEY (revision_id, route_key),
  UNIQUE (revision_id, amber_group, predicates),
  CHECK (route_key = magento_binding_route_key(amber_group, predicates)),
  FOREIGN KEY (revision_id, set_id) REFERENCES magento_binding_schema_sets(revision_id, set_id) ON DELETE RESTRICT,
  CHECK (review_state <> 'approved' OR set_id IS NOT NULL)
);
CREATE TABLE magento_binding_attributes (
  revision_id TEXT NOT NULL,
  binding_key TEXT NOT NULL CHECK (binding_key ~ '^[a-f0-9]{64}$'),
  route_key TEXT NOT NULL,
  row_id TEXT NOT NULL CHECK (row_id IN ('base','english')),
  target TEXT NOT NULL CHECK (target ~ '^[a-zA-Z][a-zA-Z0-9_]{0,99}$'),
  strategy magento_binding_strategy NOT NULL,
  attribute_code TEXT,
  attribute_ref TEXT GENERATED ALWAYS AS (coalesce(attribute_code, '')) STORED NOT NULL,
  transport_target TEXT CHECK (transport_target ~ '^[a-zA-Z][a-zA-Z0-9_.]{0,159}$'),
  field_target TEXT GENERATED ALWAYS AS (coalesce(attribute_code, transport_target, target)) STORED NOT NULL,
  unknown_output_policy TEXT NOT NULL DEFAULT 'block' CHECK (unknown_output_policy = 'block'),
  review_state magento_binding_review NOT NULL DEFAULT 'review_required',
  evidence JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 8192),
  PRIMARY KEY (revision_id, binding_key),
  UNIQUE (revision_id, route_key, row_id, target),
  UNIQUE (revision_id, binding_key, strategy),
  UNIQUE (revision_id, binding_key, strategy, attribute_ref),
  UNIQUE (revision_id, binding_key, route_key, field_target),
  UNIQUE (revision_id, route_key, row_id, attribute_code),
  UNIQUE (revision_id, route_key, row_id, transport_target),
  FOREIGN KEY (revision_id, route_key) REFERENCES magento_binding_routes(revision_id, route_key) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id, attribute_code) REFERENCES magento_binding_schema_attributes(revision_id, code) ON DELETE RESTRICT,
  CHECK ((strategy = 'transport_control' AND attribute_code IS NULL)
    OR (strategy <> 'transport_control' AND transport_target IS NULL)),
  CHECK (review_state <> 'approved' OR
    (strategy = 'transport_control' AND transport_target IS NOT NULL) OR
    (strategy <> 'transport_control' AND attribute_code IS NOT NULL))
);
CREATE TABLE magento_binding_options (
  revision_id TEXT NOT NULL,
  binding_key TEXT NOT NULL,
  strategy magento_binding_strategy NOT NULL,
  attribute_code TEXT,
  attribute_ref TEXT GENERATED ALWAYS AS (coalesce(attribute_code, '')) STORED NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('semantic','evaluated')),
  source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 512),
  amber_group TEXT CHECK (amber_group IN ('BR','NM','KL','CH','AR','SV')),
  question_key TEXT CHECK (question_key ~ '^[a-zA-Z][a-zA-Z0-9_]{0,99}$'),
  value_id INTEGER,
  sku_code_evidence TEXT CHECK (sku_code_evidence ~ '^[0-9]+$'),
  domain_key TEXT CHECK (domain_key ~ '^[a-f0-9]{64}$'),
  output_key TEXT CHECK (length(output_key) BETWEEN 1 AND 4096),
  evaluated_output TEXT CHECK (length(evaluated_output) BETWEEN 1 AND 4096),
  option_id TEXT CHECK (length(option_id) BETWEEN 1 AND 4096),
  review_state magento_binding_review NOT NULL DEFAULT 'review_required',
  evidence JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 8192),
  PRIMARY KEY (revision_id, binding_key, source_key),
  FOREIGN KEY (revision_id, binding_key, strategy) REFERENCES magento_binding_attributes(revision_id, binding_key, strategy) ON DELETE RESTRICT,
  -- Empty is an internal NULL sentinel, impossible as an observed attribute code.
  -- Nonnullable generated references enforce both presence and absence symmetrically.
  FOREIGN KEY (revision_id, binding_key, strategy, attribute_ref) REFERENCES magento_binding_attributes(revision_id, binding_key, strategy, attribute_ref) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id, attribute_code, option_id) REFERENCES magento_binding_schema_options(revision_id, attribute_code, option_id) ON DELETE RESTRICT,
  CHECK ((source_kind = 'semantic' AND strategy = 'semantic_option'
      AND num_nonnulls(amber_group, question_key, value_id) = 3 AND domain_key IS NULL AND output_key IS NULL)
    OR (source_kind = 'evaluated' AND strategy IN ('dynamic_exact_label_option','numeric_band_option','constant_option')
      AND num_nonnulls(amber_group, question_key, value_id, sku_code_evidence) = 0 AND domain_key IS NOT NULL AND output_key IS NOT NULL)),
  CHECK (review_state <> 'approved' OR (option_id IS NOT NULL AND evaluated_output IS NOT NULL)),
  CHECK (option_id IS NULL OR attribute_code IS NOT NULL),
  CHECK (option_id IS NULL OR evaluated_output IS NOT NULL),
  CHECK (source_kind <> 'semantic' OR source_key = amber_group || '.' || question_key || '=value_id:' || value_id::text),
  CHECK (source_kind <> 'evaluated' OR evaluated_output = output_key),
  CHECK (evaluated_output IS NOT NULL OR (source_kind = 'semantic' AND review_state <> 'approved'))
);
CREATE UNIQUE INDEX magento_binding_semantic_identity_idx ON magento_binding_options
  (revision_id, binding_key, amber_group, question_key, value_id) WHERE source_kind = 'semantic';
CREATE UNIQUE INDEX magento_binding_output_identity_idx ON magento_binding_options
  (revision_id, binding_key, domain_key, output_key) WHERE source_kind = 'evaluated';
CREATE TABLE magento_binding_field_policies (
  revision_id TEXT NOT NULL,
  binding_key TEXT NOT NULL,
  route_key TEXT NOT NULL,
  field_target TEXT NOT NULL,
  store_code TEXT NOT NULL CHECK (store_code ~ '^[a-zA-Z][a-zA-Z0-9_]{0,99}$'),
  store_kind TEXT NOT NULL DEFAULT 'storeViews' CHECK (store_kind = 'storeViews'),
  store_id BIGINT,
  policy TEXT NOT NULL CHECK (policy IN ('authoritative_create_update','initialize_create_only','magento_managed','blocked')),
  review_state magento_binding_review NOT NULL DEFAULT 'review_required',
  evidence JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 8192),
  PRIMARY KEY (revision_id, binding_key, store_code),
  UNIQUE (revision_id, route_key, field_target, store_code),
  FOREIGN KEY (revision_id, binding_key, route_key, field_target)
    REFERENCES magento_binding_attributes(revision_id, binding_key, route_key, field_target) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id, store_kind, store_id, store_code)
    REFERENCES magento_binding_schema_stores(revision_id, kind, remote_id, code) ON DELETE RESTRICT,
  CHECK ((store_code = 'all' AND store_id IS NULL) OR (store_code <> 'all' AND store_id IS NOT NULL)),
  CHECK ((review_state = 'blocked') = (policy = 'blocked') OR review_state IN ('proposed','review_required'))
);

CREATE INDEX magento_binding_option_target_idx ON magento_binding_options(revision_id, binding_key, option_id)
  WHERE option_id IS NOT NULL;
-- Source uniqueness above retains every semantic provenance. Shared remote IDs are
-- legal only for semantic sources with the same evaluator output in this binding.
-- Evaluator proof is additionally required by the authoritative publication service.
CREATE FUNCTION check_magento_binding_option() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The preceding parent lock serializes decisions. Read Committed refreshes this
  -- query's snapshot after a wait; a Repeatable Read snapshot could miss a writer.
  -- This is the isolation level used by the repository's mutation boundary.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Magento option decisions require Read Committed isolation';
  END IF;
  IF EXISTS (SELECT 1 FROM magento_binding_options o
    WHERE o.revision_id = NEW.revision_id AND o.binding_key = NEW.binding_key
      AND (TG_OP = 'INSERT' OR o.source_key <> OLD.source_key)
      AND o.option_id IS NOT NULL AND NEW.option_id IS NOT NULL
      AND ((o.option_id = NEW.option_id AND (o.source_kind <> 'semantic' OR NEW.source_kind <> 'semantic'
        OR o.evaluated_output IS DISTINCT FROM NEW.evaluated_output))
        OR (o.evaluated_output = NEW.evaluated_output AND o.option_id <> NEW.option_id))) THEN
    RAISE EXCEPTION 'ambiguous Magento option mapping' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
-- Alphabetical trigger order: binding_child_guard locks the revision first.
CREATE TRIGGER binding_option_identity_guard BEFORE INSERT OR UPDATE ON magento_binding_options
  FOR EACH ROW EXECUTE FUNCTION check_magento_binding_option();

CREATE FUNCTION protect_magento_binding_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Magento binding revisions are permanent'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'draft' OR NEW.revision <> 1 THEN RAISE EXCEPTION 'Magento bindings start as drafts'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'published' THEN RAISE EXCEPTION 'published Magento bindings are immutable'; END IF;
  IF (to_jsonb(NEW) - ARRAY['state','revision','version_number','modified_by_user_id','modified_at','published_by_user_id','published_at'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','revision','version_number','modified_by_user_id','modified_at','published_by_user_id','published_at'])
    OR NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'invalid Magento binding revision change'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER magento_binding_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON magento_binding_revisions
  FOR EACH ROW EXECUTE FUNCTION protect_magento_binding_revision();
CREATE TRIGGER magento_binding_revision_no_truncate BEFORE TRUNCATE ON magento_binding_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION protect_magento_binding_revision();

CREATE FUNCTION protect_magento_binding_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_state TEXT; parent_id TEXT;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'Magento binding evidence cannot be truncated'; END IF;
  IF TG_OP = 'UPDATE' AND NEW.revision_id IS DISTINCT FROM OLD.revision_id THEN
    RAISE EXCEPTION 'Magento binding parent is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN parent_id := OLD.revision_id; ELSE parent_id := NEW.revision_id; END IF;
  -- Serialize all child writers with publication, including direct SQL writers.
  SELECT state INTO STRICT parent_state FROM magento_binding_revisions WHERE id = parent_id FOR UPDATE;
  IF parent_state <> 'draft' THEN RAISE EXCEPTION 'published Magento bindings are immutable'; END IF;
  IF TG_TABLE_NAME LIKE 'magento_binding_schema_%' AND TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Magento schema observations are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DO $$
DECLARE target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['magento_binding_schema_sets','magento_binding_schema_attributes',
    'magento_binding_schema_options','magento_binding_schema_members','magento_binding_schema_stores',
    'magento_binding_routes','magento_binding_attributes','magento_binding_options','magento_binding_field_policies'] LOOP
    EXECUTE format('CREATE TRIGGER binding_child_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protect_magento_binding_child()', target);
    EXECUTE format('CREATE TRIGGER binding_child_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION protect_magento_binding_child()', target);
  END LOOP;
END;
$$;
