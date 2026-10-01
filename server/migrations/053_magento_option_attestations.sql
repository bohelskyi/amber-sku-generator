-- Action-specific Administrator review; never a permanent non-swatch certificate.
CREATE TABLE magento_option_capability_attestations (
  id UUID PRIMARY KEY,
  origin_hash TEXT NOT NULL CHECK(origin_hash ~ '^[a-f0-9]{64}$'),
  installation_key TEXT NOT NULL,
  attribute_id BIGINT NOT NULL CHECK(attribute_id>0),
  attribute_code TEXT NOT NULL CHECK(attribute_code ~ '^[a-zA-Z][a-zA-Z0-9_]{0,99}$'),
  metadata_fingerprint TEXT NOT NULL CHECK(metadata_fingerprint ~ '^[a-f0-9]{64}$'),
  target_hash TEXT NOT NULL CHECK(target_hash ~ '^[a-f0-9]{64}$'),
  target JSONB NOT NULL CHECK(jsonb_typeof(target)='object' AND octet_length(target::text)<=16384),
  actor_user_id BIGINT NOT NULL REFERENCES application_users(id) ON DELETE RESTRICT,
  evidence TEXT NOT NULL CHECK(length(btrim(evidence)) BETWEEN 3 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP + INTERVAL '10 minutes',
  CHECK(expires_at=created_at+INTERVAL '10 minutes')
);
CREATE FUNCTION protect_magento_option_attestation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'option capability attestation evidence is immutable'; END $$;
CREATE TRIGGER magento_option_attestation_guard BEFORE UPDATE OR DELETE ON magento_option_capability_attestations
  FOR EACH ROW EXECUTE FUNCTION protect_magento_option_attestation();
CREATE TRIGGER magento_option_attestation_no_truncate BEFORE TRUNCATE ON magento_option_capability_attestations
  FOR EACH STATEMENT EXECUTE FUNCTION protect_magento_option_attestation();
ALTER TABLE magento_configuration_actions DROP CONSTRAINT magento_configuration_actions_kind_check;
ALTER TABLE magento_configuration_actions ADD CONSTRAINT magento_configuration_actions_kind_check CHECK(kind IN ('category','option'));
ALTER TABLE magento_configuration_actions ADD COLUMN attestation_id UUID UNIQUE
  REFERENCES magento_option_capability_attestations(id) ON DELETE RESTRICT;
ALTER TABLE magento_configuration_actions ADD CONSTRAINT magento_option_action_attestation
  CHECK ((kind='option')=(attestation_id IS NOT NULL));
