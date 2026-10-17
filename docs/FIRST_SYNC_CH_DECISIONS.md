# CH first-sync decisions

Catalog owner decisions from 2026-10-16 for the mass first sync of rosaries (CH).

## Bead dimensions: Amber is authoritative

The published CH template emits `dovzhyna_namystyny` (`bead_length`),
`diametr_namystyny` (`bead_width`) and `dovzhyna_vyrobu` (`rosary_length`) through
`decimalText`, and `rozmir_kameniu` as `{length}×{width}`. Magento historically
swapped bead length and width, and stores the decimals with six places (`33.000000`).

- First sync compares the three decimal outputs numerically as derived, forward-only
  values (type `decimal`, scale 6, positive). `33` equals `33.000000`; non-numeric
  remote text stays `REMOTE_DECIMAL_INVALID_OR_SCALE_EXCEEDED`.
- This applies only when the cell is exactly the CH information answer wrapped in
  `text` then `decimalText`, the approved binding is the same scalar attribute and the
  attribute/set metadata is unchanged from the publication. Anything else keeps
  `CANONICAL_SOURCE_SETTER_UNSUPPORTED`.
- Magento is never imported into these answers. A difference
  (`DERIVED_FORWARD_MISMATCH`) offers `keep_local` only for these four CH fields
  (`localAuthority: ch-bead-dimensions-v1`). Ordinary guarded delivery then writes
  the Amber value and the numeric readback records `outward_verified`.

## SEO: Magento may keep CH meta title and description

When the published binding approves the `magento_managed` policy for derived
`meta_title`/`meta_description` (the binding UI draft, review and publication), ordinary
delivery never writes them. First sync then lists them as ignored coverage
(`MAGENTO_MANAGED_DERIVED_SEO`) instead of a permanent `DERIVED_FORWARD_MISMATCH`.
An earlier non-terminal first-sync record of that field still blocks completion
(`FIRST_SYNC_UNSETTLED_PRIOR_FIELD`). NM SEO snapshots are unchanged.

## Batch keep_local

`server/scripts/first-sync-keep-local.js` records the approved "Amber wins" choices
for many products, sequentially and with GET-only Magento transport:

```text
node scripts/first-sync-keep-local.js --mode preview|apply --server-root /app \
  --input input.json --output NEW_FILE.jsonl --expected-database NAME \
  --actor-id ID --installation-key KEY --targets price,vaha_vyrobu,... [--allow-imports] \
  [--schema-cache-seconds 0-600]
```

- Input: `{ "bindingRevisionId": "...", "items": [{ "sku": "..." }] }`, up to 2000 SKUs.
- Targets are limited to `price`, `vaha_vyrobu`, `decor_weight`, `dovzhyna_namystyny`,
  `diametr_namystyny`, `dovzhyna_vyrobu` and `rozmir_kameniu`. A field is chosen only
  when the fresh canonical review offers `keep_local`. Weights are chosen only when
  Magento holds the historical whole-gram rounding of the Amber weight; others are
  reported as `notRounding`.
- Products whose fresh plan would also import Magento values are skipped unless
  `--allow-imports`. Preview never applies. The fresh preview token and the prepared
  transitions are revalidated before commit.
- The worker needs the usual controlled handoff (`broader_resync`) afterwards.
