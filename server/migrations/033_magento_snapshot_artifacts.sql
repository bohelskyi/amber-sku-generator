CREATE TABLE magento_export_artifacts (
  snapshot_id TEXT NOT NULL REFERENCES export_snapshots(id) ON DELETE RESTRICT,
  profile_version TEXT NOT NULL CHECK (profile_version = 'magento-products-v1'),
  group_code TEXT NOT NULL CHECK (group_code IN ('BR', 'NM', 'KL', 'CH', 'AR', 'SV')),
  file_name TEXT NOT NULL,
  csv_content TEXT NOT NULL,
  product_count INTEGER NOT NULL CHECK (product_count > 0),
  row_count INTEGER NOT NULL CHECK (row_count = product_count * 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (snapshot_id, profile_version, group_code)
);

CREATE FUNCTION protect_magento_export_artifact()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Magento export artifacts are immutable';
END;
$$;

CREATE TRIGGER magento_export_artifact_immutable
BEFORE UPDATE OR DELETE ON magento_export_artifacts
FOR EACH ROW EXECUTE FUNCTION protect_magento_export_artifact();

CREATE TRIGGER magento_export_artifact_no_truncate
BEFORE TRUNCATE ON magento_export_artifacts
FOR EACH STATEMENT EXECUTE FUNCTION protect_magento_export_artifact();
