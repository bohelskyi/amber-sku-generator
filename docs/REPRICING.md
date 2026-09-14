# Repricing

## Scopes and preview

Repricing supports scenario and global scopes:

- scenario preview considers active products matched to one selected scenario;
- global preview considers every active product exactly once, loads pricing context by category plus one exchange-rate result, and applies normal authoritative scenario priority where scenarios overlap.

Rows are classified as changed, unchanged, skipped, or error. `repricing.view` allows viewing scenarios, drafts, previews, batches, and history. Creating, editing, synchronizing, discarding, or previewing drafts requires `repricing.prepare`.

## Drafts and state binding

One active global draft is allowed separately from one active draft per scenario. Drafts persist the authoritative preview snapshot, manual overrides, automatic-switch product IDs, reviewed product IDs, and UI state. Synchronization refreshes the snapshot and drops reviewed IDs no longer present.

Persisted drafts record the local application user who created them and the local user responsible for their latest successful save, resolution change, or synchronization. Discard records its local-user actor. Creation and discard emit immutable `repricing_draft.created` and `repricing_draft.discarded` events; autosave, manual-resolution edits, and routine synchronization update only last-modifier attribution.

The preview token and draft fingerprint bind:

- scope and candidate/product state;
- complete pricing configuration;
- raw and category-selected automatic calculations;
- normalized manual and automatic resolutions.

Manual price itself is independently validated user input, but normalized resolution choices and all real product/pricing dependencies participate in stale-state protection.

Products created from a protected correction-request USD-per-gram decision are revalued from that stored basis, current authoritative rate, and stored rounding choice. Matrix, modifier, and category-rounding edits do not alter that basis. An explicit manual repricing resolution clears the protected basis; the batch's exact old payload retains and restores the complete basis and provenance on rollback. The existing global transition to automatic applies only to manual-priced rows and does not create a separate return-to-matrix action for protected custom pricing.

An active repricing draft does not block a direct in-place product price change, and the price-change command does not silently rewrite or discard the draft. Because repricing snapshots and preview tokens bind the complete candidate product state, a successful in-place change makes an affected saved snapshot stale. Applying that old preview is rejected; the draft must be synchronized and reviewed again through the normal repricing flow.

## Explicit manual resolutions

Manual-priced rows are never silently converted:

- a positive manual override equal to the stored price explicitly keeps manual pricing;
- a different positive manual override explicitly sets a new manual price;
- a row without usable automatic pricing requires a positive manual resolution;
- in global scope only, a manual-priced row with a valid authoritative automatic result may explicitly switch to automatic through `automaticProductIds`, clearing `manualPriceUah` and selecting the category-selected automatic result.

A product cannot receive both manual and automatic resolutions. Missing-price rows cannot switch to nonexistent automatic pricing, and unrelated calculation errors cannot be resolved through either mechanism.

## Atomic apply

Apply requires `repricing.apply`. It re-previews and rejects stale configuration/product state, unsaved draft resolutions, unresolved errors, and products with active correction requests.

Changed products are locked in stable ID order. The completed batch, authenticated local-user apply attribution, every product update, old/new item payloads, normal draft transition to applied, and one `repricing.applied` audit event commit in one transaction. An audit or mid-apply failure leaves no completed batch and no partial product changes. Idempotent retries return the existing completed batch without another event.

Stored repricing details retain `calculatedPriceUah`, category-selected `autoPriceUah`, the selected manual/automatic state, and batch ownership. A unique application token makes completed apply idempotent; a rolled-back batch no longer occupies its active token.

Repricing apply and direct in-place price-change apply both lock the affected product rows and revalidate authoritative state inside their transactions. If they run concurrently, the locks serialize the writes; after the first transaction commits, the later operation rejects its stale product state instead of overwriting the committed pricing.

## Atomic rollback

Rollback requires `repricing.rollback`. It locks the batch and all affected products, then requires every product to remain active, owned by that batch, and exactly equal to its recorded new payload. Only then are all old payloads restored, the authenticated local-user rollback actor is recorded, and `repricing.rolled_back` is appended in one transaction. Any later edit or audit failure blocks the entire rollback; already-rolled-back retries do not append another event.

A successful in-place price change after repricing replaces the product's pricing state without retaining the earlier batch-ownership marker. The product therefore no longer satisfies rollback's ownership and exact-recorded-new-payload checks, so rollback rejects the entire batch rather than overwriting the later price change. The price-change transaction does not mutate repricing drafts or batch history.

Correction completion may synchronize active drafts only after the correction transaction commits. Each successful synchronization records the correction actor as the draft's last modifier without a routine repricing audit event. A failed synchronization remains best effort and cannot undo the completed correction.

## Initial built-in role permissions

| Role | Repricing behavior |
| --- | --- |
| Administrator | View, prepare drafts/previews, apply, and rollback. |
| Manager | View and prepare drafts/previews; Apply and Rollback are denied and hidden. |
| Storekeeper | View and prepare drafts/previews; Apply and Rollback are denied and hidden. |

Manager and Storekeeper permissions are Administrator-editable, so these rows describe the initial built-in mappings, not a guarantee about a deployed user's current access. The UI uses effective permission keys from `/api/auth/me`; route middleware remains authoritative.
