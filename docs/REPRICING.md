# Repricing

## Scopes and preview

Repricing supports scenario and global scopes:

- scenario preview considers active products matched to one selected scenario;
- global preview considers every active product exactly once, loads pricing context by category plus one exchange-rate result, and applies normal authoritative scenario priority where scenarios overlap.

Rows are classified as changed, unchanged, skipped, or error. `repricing.view` allows viewing scenarios, drafts, previews, batches, and history. Creating, editing, synchronizing, discarding, or previewing drafts requires `repricing.prepare`.

## Drafts and state binding

One active global draft is allowed separately from one active draft per scenario. Drafts persist the authoritative preview snapshot, manual overrides, automatic-switch product IDs, reviewed product IDs, and UI state. Synchronization refreshes the snapshot and drops reviewed IDs no longer present.

The preview token and draft fingerprint bind:

- scope and candidate/product state;
- complete pricing configuration;
- raw and marketing-rounded calculations;
- normalized manual and automatic resolutions.

Manual price itself is independently validated user input, but normalized resolution choices and all real product/pricing dependencies participate in stale-state protection.

## Explicit manual resolutions

Manual-priced rows are never silently converted:

- a positive manual override equal to the stored price explicitly keeps manual pricing;
- a different positive manual override explicitly sets a new manual price;
- a row without usable automatic pricing requires a positive manual resolution;
- in global scope only, a manual-priced row with a valid authoritative automatic result may explicitly switch to automatic through `automaticProductIds`, clearing `manualPriceUah` and selecting the rounded automatic result.

A product cannot receive both manual and automatic resolutions. Missing-price rows cannot switch to nonexistent automatic pricing, and unrelated calculation errors cannot be resolved through either mechanism.

## Atomic apply

Apply requires `repricing.apply`. It re-previews and rejects stale configuration/product state, unsaved draft resolutions, unresolved errors, and products with active correction requests.

Changed products are locked in stable ID order. The completed batch, every product update, old/new item payloads, and normal draft transition to applied commit in one transaction. A mid-apply failure leaves no completed batch and no partial product changes.

Stored repricing details retain `calculatedPriceUah`, rounded `autoPriceUah`, the selected manual/automatic state, and batch ownership. A unique application token makes completed apply idempotent; a rolled-back batch no longer occupies its active token.

## Atomic rollback

Rollback requires `repricing.rollback`. It locks the batch and all affected products, then requires every product to remain active, owned by that batch, and exactly equal to its recorded new payload. Only then are all old payloads restored and the batch marked rolled back in one transaction. Any later edit blocks the entire rollback.

## Current RBAC boundary

| Role | Repricing behavior |
| --- | --- |
| Administrator | View, prepare drafts/previews, apply, and rollback. |
| Manager | View and prepare drafts/previews; Apply and Rollback are denied and hidden. |
| Storekeeper | View and prepare drafts/previews; Apply and Rollback are denied and hidden. |

These UI boundaries use effective permission keys, while route middleware remains authoritative.
