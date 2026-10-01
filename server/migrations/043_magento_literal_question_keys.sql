-- Preserve literal Amber question identity, including SV.2. Magento codes retain
-- their separate constraints. No rows, aliases, bindings or publications change.
ALTER TABLE magento_binding_options
  DROP CONSTRAINT magento_binding_options_question_key_check;
ALTER TABLE magento_binding_options
  ADD CONSTRAINT magento_binding_options_question_key_check
  CHECK (question_key ~ '^[a-zA-Z0-9][a-zA-Z0-9_]{0,99}$');
CREATE OR REPLACE FUNCTION magento_binding_route_key(amber_group TEXT, predicates JSONB) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE p JSONB; parts TEXT[] := '{}'; part TEXT;
BEGIN
  IF jsonb_typeof(predicates) <> 'array' THEN RAISE EXCEPTION 'invalid binding route predicates'; END IF;
  FOR p IN SELECT value FROM jsonb_array_elements(predicates) LOOP
    IF jsonb_typeof(p) <> 'object' OR p - ARRAY['questionKey','valueId','equal'] <> '{}'
      OR (jsonb_typeof(p->'questionKey') = 'string' AND p->>'questionKey' ~ '^[a-zA-Z0-9][a-zA-Z0-9_]{0,99}$'
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
