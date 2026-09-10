UPDATE sku_schema_versions
SET marker = version::text || '/'
WHERE version > 1
  AND marker <> version::text || '/';
