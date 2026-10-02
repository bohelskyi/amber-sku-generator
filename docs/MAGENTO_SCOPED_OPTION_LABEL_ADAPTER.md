# Scoped Magento option-label adapter contract

This is the Amber client contract required for reviewed label updates. The Magento
adapter implementation/deployment is not included or asserted by this repository.
Until the configured installation exposes this contract, Amber blocks writes.
Read-only inspection can show standard GET effective labels with an explicit
fallback warning; these never authorize attestation, preview, apply or reconciliation.
Standard option PUT must never substitute for it.

Both fixed endpoints require Magento OAuth authorization and an attribute-management
ACL. They address one exact existing ordinary user-defined select/multiselect
attribute and one exact option ID. They must reject system/swatch/custom-source
attributes and identity mismatches independently of Amber's attestation.

`GET /rest/all/V1/amber/attributes/:attributeCode/options/:optionId/labels`
returns this closed shape:

```json
{
  "contractVersion": "amber-scoped-option-labels-v1",
  "attributeId": 1471,
  "attributeCode": "suveniry",
  "optionId": "5738",
  "revision": "<64 lowercase SHA-256 hex characters>",
  "labels": {
    "all": "Скриньки",
    "en": { "storeId": 9, "label": "Amber boxes" }
  }
}
```

`all` is the exact stored store-0 label. `en.label` is the exact stored EN label or
null when no EN row exists; it must never report a translated/global fallback as
a stored label. `en` itself is null only when there is no active uniquely identified
`en` store. The revision must deterministically bind exact attribute/option identity,
classification, sort order, default state, all explicit option-label rows including
other/inactive stores, and relevant store identity/activity evidence. GET must read
this evidence coherently; it performs no mutation.

`PUT` to the same fixed path accepts only:

```json
{
  "expectedRevision": "<exact reviewed revision>",
  "labels": {
    "all": "Скриньки",
    "en": { "storeId": 9, "label": "Amber boxes" }
  }
}
```

Within one Magento transaction, lock/re-read the exact option and relevant evidence,
verify its attribute association, current ordinary capability, current active EN
identity and complete revision, then change only store-0 and the explicitly reviewed
EN label. Preserve sort order, default status, identity and all other stored labels.
Reject stale revision with 409 before any write. Never delegate to Magento's stock
full option replacement. Return JSON `true` only after commit. A lost response is
uncertain even if the adapter committed; Amber reconciles by exact GET and never
automatically repeats PUT.

The adapter must serialize this boundary with Magento's existing option writers.
Its Magento tests must prove stale concurrent edits reject, unrelated translations
and ordering survive, missing EN remains distinguishable from fallback, identities
cannot be substituted, and transaction failure rolls back the complete operation.
An endpoint merely returning the contract string is not deployment acceptance.
Amber fixture tests prove client boundaries, not those Magento implementation facts.

See [the reviewed Amber workflow](MAGENTO_INTEGRATION.md#reviewed-existing-option-label-updates)
and [migration 057](DATABASE_MIGRATIONS.md#057--authoritative-catalog-english-labels-and-reviewed-label-actions).
