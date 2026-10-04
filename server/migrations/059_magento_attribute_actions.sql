-- Attribute creation and additive set membership reuse the permanent, single
-- dispatch configuration ledger. No existing intents or permissions change.
ALTER TABLE magento_configuration_actions DROP CONSTRAINT magento_configuration_actions_kind_check;
ALTER TABLE magento_configuration_actions ADD CONSTRAINT magento_configuration_actions_kind_check
  CHECK(kind IN ('category','option','option_label','attribute','attribute_assignment'));
