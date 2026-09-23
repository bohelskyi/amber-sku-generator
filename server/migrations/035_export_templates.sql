CREATE TABLE export_templates (
  id TEXT PRIMARY KEY,
  template_key TEXT NOT NULL UNIQUE CHECK (template_key ~ '^[a-z][a-z0-9_-]{0,79}$'),
  display_name TEXT NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  created_by_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE export_template_versions (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES export_templates(id) ON DELETE RESTRICT,
  version_number BIGINT NOT NULL CHECK (version_number > 0),
  source_draft_revision BIGINT NOT NULL CHECK (source_draft_revision > 0),
  definition JSONB NOT NULL CHECK (jsonb_typeof(definition) = 'object' AND octet_length(definition::text) <= 524288),
  definition_hash TEXT NOT NULL CHECK (definition_hash ~ '^[a-f0-9]{64}$'),
  format_version INTEGER NOT NULL CHECK (format_version > 0),
  evaluator_version TEXT NOT NULL,
  output_contract TEXT NOT NULL,
  published_by_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  published_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (template_id, version_number),
  UNIQUE (template_id, source_draft_revision),
  UNIQUE (template_id, id),
  CHECK (definition ?& ARRAY['formatVersion', 'evaluatorVersion', 'outputContract']),
  CHECK (definition->'formatVersion' = to_jsonb(format_version)
    AND definition->'evaluatorVersion' = to_jsonb(evaluator_version)
    AND definition->'outputContract' = to_jsonb(output_contract))
);

CREATE TABLE export_template_drafts (
  template_id TEXT PRIMARY KEY REFERENCES export_templates(id) ON DELETE RESTRICT,
  base_version_id TEXT,
  definition JSONB NOT NULL CHECK (jsonb_typeof(definition) = 'object' AND octet_length(definition::text) <= 524288),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  modified_by_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  modified_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (template_id, base_version_id)
    REFERENCES export_template_versions(template_id, id) ON DELETE RESTRICT
);

CREATE TABLE export_template_activation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  implementation TEXT NOT NULL CHECK (implementation IN ('legacy', 'template')),
  template_version_id TEXT REFERENCES export_template_versions(id) ON DELETE RESTRICT,
  changed_by_user_id BIGINT REFERENCES application_users(id) ON DELETE RESTRICT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((implementation = 'legacy' AND template_version_id IS NULL)
    OR (implementation = 'template' AND template_version_id IS NOT NULL))
);
-- Configuration metadata only. No template capture, publication or synthetic actor/event.
INSERT INTO export_template_activation (id, implementation) VALUES (1, 'legacy');

CREATE FUNCTION protect_export_template_publication()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'export template publications are immutable';
END;
$$;
CREATE TRIGGER export_template_version_immutable
BEFORE UPDATE OR DELETE ON export_template_versions
FOR EACH ROW EXECUTE FUNCTION protect_export_template_publication();
CREATE TRIGGER export_template_version_no_truncate
BEFORE TRUNCATE ON export_template_versions
FOR EACH STATEMENT EXECUTE FUNCTION protect_export_template_publication();

CREATE FUNCTION protect_export_template_state()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'export template identities and state are permanent';
  END IF;
  IF TG_TABLE_NAME = 'export_templates' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.template_key IS DISTINCT FROM OLD.template_key
      OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'export template identity is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'export_template_drafts' THEN
    IF NEW.template_id IS DISTINCT FROM OLD.template_id OR NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'export template draft revision must advance by one';
    END IF;
  ELSIF NEW.id IS DISTINCT FROM OLD.id OR NEW.generation <> OLD.generation + 1 THEN
    RAISE EXCEPTION 'export template selection generation must advance by one';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER export_template_identity_protected
BEFORE UPDATE OR DELETE ON export_templates
FOR EACH ROW EXECUTE FUNCTION protect_export_template_state();
CREATE TRIGGER export_template_draft_protected
BEFORE UPDATE OR DELETE ON export_template_drafts
FOR EACH ROW EXECUTE FUNCTION protect_export_template_state();
CREATE TRIGGER export_template_activation_protected
BEFORE UPDATE OR DELETE ON export_template_activation
FOR EACH ROW EXECUTE FUNCTION protect_export_template_state();
CREATE TRIGGER export_template_no_truncate
BEFORE TRUNCATE ON export_templates
FOR EACH STATEMENT EXECUTE FUNCTION protect_export_template_state();
CREATE TRIGGER export_template_draft_no_truncate
BEFORE TRUNCATE ON export_template_drafts
FOR EACH STATEMENT EXECUTE FUNCTION protect_export_template_state();
CREATE TRIGGER export_template_activation_no_truncate
BEFORE TRUNCATE ON export_template_activation
FOR EACH STATEMENT EXECUTE FUNCTION protect_export_template_state();

INSERT INTO permissions (permission_key, description) VALUES
  ('export_templates.view', 'View export template definitions and source references'),
  ('export_templates.manage', 'Manage and test export template drafts'),
  ('export_templates.publish', 'Publish immutable export template versions'),
  ('export_templates.activate', 'Change export template selection metadata');
-- Migration 028 propagates new permissions to Administrator only. These remain delegable.
