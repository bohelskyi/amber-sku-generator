# Read-only exact-SKU discovery for local-batch preview

`server/scripts/first-sync-local-discovery.js` is a standalone adapter to the
services already present in PR 68 (`30a34e0`). It can be copied into a private
temporary directory alongside an existing configured server checkout/container.
It needs no application deployment, migration, dependency installation or worker
startup. It has no apply, adoption, enqueue, media or reconciliation operation.
Repository validation is not production execution or delivery acceptance.

## Input

Use exact public SKUs and known local product IDs/categories from the frozen
comparison. The helper never discovers by category, SKU prefix, fuzzy search or
Magento numeric-ID guessing. It preserves input order; arrange silver candidates
last in the input. A null `remoteProductId` requests fresh identity discovery.
A supplied ID must match exactly.

```json
{
  "items": [{
    "sku": "SYNTHETIC-EXAMPLE",
    "productId": 1,
    "category": "NM",
    "remoteProductId": null,
    "fields": [
      {"target":"decor_weight","scope":"all","local":"132.300","remote":132,"policy":"manager_weight_rounding"},
      {"target":"meta_title","scope":"all","local":"Amber title","remote":"Magento title","policy":"amber_seo"}
    ]
  }]
}
```

Input is at most 4 MiB/2000 products, with 1–8 selected fields per product.
SKUs and local IDs must be unique. Unknown properties and sparse arrays are
rejected. Optional `policy` values are `manager_price` for `price:all`,
`manager_weight_rounding` for `decor_weight:all`/`vaha_vyrobu:all`, and `amber_seo`
for `meta_title`/`meta_description` in `all` (UA/global) or `en`. The policy is the
explicit reconciliation choice, not a replacement for a published binding policy.

Optional top-level `bindingRevisionId` and `expectedDefinitionHash` must be
supplied together and must match the current publication. Optional per-item
`expectedProduct` must contain every key of the existing batch source contract;
it is compared with the fresh snapshot. Without it, frozen product ID, category,
SKU, provided remote ID and all selected local/remote field facts still match.

Price comparisons use the canonical decimal scale 2, physical weights scale 3;
numeric formatting alone is equivalent. SEO strings are compared literally.
Changed frozen facts produce `DISCOVERY_FROZEN_FIELD_CHANGED` with both old and
fresh values and no packet item. Refresh those facts only after review. Empty
or unknown cells, unproven EN observations, unproven physical-weight mappings,
nonrounding weight, history/lifecycle restrictions and remaining first-sync
blockers also produce no packet item. All selected discrepancies must pass.

## Run discovery

Use the deployed server's existing environment, exact database name, actual
active Administrator application-user ID and known installation key. The helper
does not load `.env` itself. `--help` needs no environment or database.

```sh
node /private/path/first-sync-local-discovery.js \
  --server-root /path/to/deployed/server \
  --input /private/path/candidates.json \
  --output-dir /private/path/discovery-001 \
  --expected-database DATABASE_NAME \
  --actor-id ADMIN_ID \
  --installation-key INSTALLATION_KEY \
  --offset 0 --limit 10
```

`--server-root` is the directory containing the deployed server's `package.json`,
`src` and `scripts`. It can be omitted when the helper file itself is located in
that server's `scripts` directory, regardless of the working directory. For a
copied helper, pass it explicitly. Default limit is 10; explicit limits up to 2000 are accepted.
Only the selected slice is read. Larger invocations remain sequential per SKU;
each ordinary preview performs its usual bounded schema/product GETs. There is
no cross-product schema cache and no claim of an atomic remote catalog snapshot.

The helper checks actual database identity and requires PostgreSQL
`default_transaction_read_only=on`. Its own pool supplies that setting. It uses
`assertActorStillAuthorized(..., {readOnly:true})`, the existing Administrator
check and current-publication reader before/after each item and at completion.
The canonical ordinary `previewProduct` provides
`identity.observedMagentoId`; it must match exact raw identity and local product.
The same observation's original product object supplies `batch.source`, preserving
its private historical evidence. `first.inspect`/`prepareDecision` retain the
existing field/history/protected-work gates. A final canonical local reread
detects source/lifecycle drift. No prospective historical product substitution
or write-capable recovery guard is used. `observeUsdRate` cannot persist its cache.

## Checkpoints and output

Output directory must not exist. It is private (0700); files are 0600 and never
overwrite an existing path. Each `results.jsonl` entry is fsynced before the next
SKU. Standard output emits one progress JSON line per SKU plus completion.

- `results.jsonl`: start metadata, exact input indices, per-SKU observed identity,
  blockers, changed frozen facts, first-sync diagnostics and candidate snapshots.
- `packet-0001.json`, etc.: at most 10 candidate products, validated by the existing
  `batch.command`; created only after the final authority check.
- `manifest.json`: input/publication hashes, selected slice, counts, next offset,
  remaining input, packet names and canonical JSON hashes, and completion state.

Use packet files only when `manifest.complete === true`, `globalFailure === null`
and that manifest lists the packet. Completion covers the selected slice, not
necessarily the entire input; check `remainingInput`. Exit 0 means the slice has
no blockers; exit 2 means completed blocker reporting or a global invalidation;
exit 1 means setup/output failure. Global failures invalidate every earlier
candidate and produce no usable packets. Interrupted/output-failed runs without
a valid completion manifest are unusable, even if partial packet files exist.
`results.jsonl` candidate entries are diagnostic checkpoints, never apply plans.

To continue a completed slice, rerun the unchanged input with `--offset` equal
to its `nextOffset` and a new output directory. If an invocation is interrupted
before its completion manifest, rerun its original offset into a new directory
so no earlier unpublished candidates are lost. Never append to or trust a
partial final JSONL line. All resumed observations are fresh; nothing is applied.

## Required next step

Discovery candidates are not `readyForApply` claims. Review the blocker report,
then run the already deployed preview separately for each listed packet:

```sh
cd /path/to/deployed/server
node scripts/first-sync-local-batch.js --mode preview \
  --input /private/path/discovery-001/packet-0001.json \
  --output /private/path/new-preview-0001.json \
  --expected-database DATABASE_NAME --actor-id ADMIN_ID
```

That fresh preview retains its normal locks, history/lifecycle/identity and
empty-field checks. Review its choices, initial imports and remaining blockers.
This helper supplies no apply runner or automatic resync. Follow
[the local-batch contract](FIRST_SYNC_LOCAL_BATCH.md) for separately authorized
later work. Magento outward confirmation remains independent.

## Verification

Focused synthetic tests cover frozen-fact drift, exact identities, decimal and
rounding rules, empty/unknown/local-choice refusal, history/ordinary modes,
source drift, authority invalidation, sequential checkpoints, 10-product packet
limits, exclusive/private output and GET-only transport. The local-authority
PostgreSQL fixture additionally runs real canonical ordinary preview and
first-sync services through a read-only connection, asserts all-table fingerprints
unchanged and proves the packet is accepted by the existing batch preflight.

```sh
cd server
node --require ./test/setup-env.js --test test/magento-first-sync-local-discovery.test.js
# Only against an explicitly configured disposable _test PostgreSQL database:
node --test integration-test/magento-first-sync-local-authority.test.js
```
