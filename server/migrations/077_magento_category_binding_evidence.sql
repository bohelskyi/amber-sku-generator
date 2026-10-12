-- Category transport bindings retain a bounded set of reviewed paths. Their
-- evidence needs more room than an ordinary field; all other rows keep 8 KiB.
-- PostgreSQL JSONB text includes whitespace, so this leaves headroom above the
-- application's 64 KiB compact UTF-8 category evidence limit.
ALTER TABLE magento_binding_attributes
  DROP CONSTRAINT magento_binding_attributes_evidence_check;

ALTER TABLE magento_binding_attributes
  ADD CONSTRAINT magento_binding_attributes_evidence_check CHECK (
    jsonb_typeof(evidence) = 'object'
    AND octet_length(evidence::text) <= CASE
      WHEN target = 'categories' AND strategy = 'transport_control' THEN 81920
      ELSE 8192
    END
  );
