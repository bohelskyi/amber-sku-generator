-- Display metadata only: no translations, schema snapshots or SKU changes.
ALTER TABLE options ADD COLUMN label_en TEXT;
ALTER TABLE options ADD CONSTRAINT options_label_en_valid CHECK
  (label_en IS NULL OR (length(label_en) BETWEEN 1 AND 255 AND label_en=btrim(label_en)
    AND label_en !~ '[[:cntrl:]]'));

-- Label edits reuse the immutable configuration ledger. Unlike CREATE, a
-- verified label update can be followed by another separately reviewed update.
-- Undispatched reseal and dispatched no-resend protections are unchanged.
ALTER TABLE magento_configuration_actions DROP CONSTRAINT magento_configuration_actions_kind_check;
ALTER TABLE magento_configuration_actions ADD CONSTRAINT magento_configuration_actions_kind_check
  CHECK(kind IN ('category','option','option_label'));
ALTER TABLE magento_configuration_actions DROP CONSTRAINT magento_option_action_attestation;
ALTER TABLE magento_configuration_actions ADD CONSTRAINT magento_option_action_attestation
  CHECK ((kind IN ('option','option_label'))=(attestation_id IS NOT NULL));
DROP INDEX magento_configuration_active_resource;
CREATE UNIQUE INDEX magento_configuration_active_resource ON magento_configuration_actions(origin_hash,kind,resource_key)
  WHERE state<>'superseded' AND (kind<>'option_label' OR state<>'verified');
