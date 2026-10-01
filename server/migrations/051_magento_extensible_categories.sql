-- Opt-in v4 category syntax. No publication, catalog or product data is changed.
ALTER TABLE magento_binding_routes DROP CONSTRAINT magento_binding_routes_amber_group_check;
ALTER TABLE magento_binding_routes ADD CONSTRAINT magento_binding_routes_amber_group_check
  CHECK (amber_group ~ '^[A-Z][A-Z0-9_]{0,31}$');
ALTER TABLE magento_binding_options DROP CONSTRAINT magento_binding_options_amber_group_check;
ALTER TABLE magento_binding_options ADD CONSTRAINT magento_binding_options_amber_group_check
  CHECK (amber_group ~ '^[A-Z][A-Z0-9_]{0,31}$');

-- Existing six-category rows retain their original rules. A future category
-- additionally requires the exact immutable v4 template pinned by its revision.
CREATE FUNCTION check_magento_extensible_category() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amber_group IS NULL OR NEW.amber_group IN ('BR','NM','KL','CH','AR','SV') THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM magento_binding_revisions r
    JOIN export_template_versions v ON v.id=r.template_version_id
    WHERE r.id=NEW.revision_id AND r.evaluator_version='magento-declarative-4'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(v.definition->'groups') g
        WHERE g->>'route'=NEW.amber_group)
  ) THEN
    RAISE EXCEPTION 'new binding category requires a declared v4 template group';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER binding_route_extensible_category BEFORE INSERT OR UPDATE ON magento_binding_routes
  FOR EACH ROW EXECUTE FUNCTION check_magento_extensible_category();
CREATE TRIGGER binding_option_extensible_category BEFORE INSERT OR UPDATE ON magento_binding_options
  FOR EACH ROW EXECUTE FUNCTION check_magento_extensible_category();
