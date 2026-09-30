# Automatic Magento product synchronization

Migration `044_magento_automatic_sync.sql` adds a separate, durable activation gate.
It starts **disabled** and enrolls no historical products. Installation of the code
or migration does not activate sync or retire CSV. The restored operator dump is
not the final frozen production database; no binding UUID from it is a default.

## Local transaction boundary

`product_magento_sync_request` runs after product INSERT/UPDATE in the business
transaction. With the gate enabled it upserts one `magento_product_sync_requests`
row and increments `desired_generation`. Rollback also rolls back the request.
No remote discovery, enqueue or writer runs in a business request.

The trigger compares stored evaluator/eligibility inputs: SKU, category, physical
weight, final UAH price, schema ID, saved answers, UA/EN subjects, name review,
active/successor identity and exclusion. Unchanged inputs, attribution and pricing
metadata alone do not create requests. This covers actual authoritative writers:

| Writer | Relevant behavior |
| --- | --- |
| `product.service.js` | Ordinary save, direct recount, source retirement, archive. Recount enrolls the inserted successor; an untouched legacy predecessor is not enrolled. Already tracked predecessors retain a retirement obligation for attention. |
| `product-information.service.js`, `product-magento-name.service.js` | Saved informational answers, paired names and inherited-name review. |
| `product-price-change.service.js` | Direct and request-completed final price changes. |
| `correction-request.service.js` | Completion delegates to the same recount/price primitives; create/claim/preview are not product mutations. |
| `repricing.service.js` | APPLY and exact-state rollback for every changed product. |
| Catalog key/category/schema maintenance, recount/SV repairs, full-product reconciliation | Actual changed product inputs are covered by the same trigger; these commands are not invoked by the worker. |

The existing planner remains authoritative for recount compatibility exclusions,
holds, product identity, pricing, source proof, names and published bindings.
The worker does not release exclusions, rewrite reservations, recalculate prices,
create categories, reconcile snapshots or acknowledge either CSV export stream.
Catalog-only edits and export acknowledgements are not product payload mutations.

## Request and job state

Each request stores desired/synced generations, the active immutable job and its
captured generation, state, a closed safe reason, retry attempts and next-attempt
time. Multiple edits coalesce before planning. Enqueue and active-job attachment
commit together. Successful acknowledgement advances only the captured generation;
an edit during an older APPLY therefore stays pending after that job succeeds.

Migration 044 extends the existing jobs with `automatic_generation` and the
terminal `superseded` state. Only automatic jobs with **no step evidence at all**
can be superseded. Their intent stays immutable. Partial unique indexes still
allow only one unfinished job per origin/SKU, preserve manual hash idempotency and
identify automatic intent by generation. Returning from state A to B to A requires
a fresh generation/remote observation, never an old successful A receipt.
Unchanged manual CLI invocations use the existing explicit APPLY contract.

## Worker and recovery

After normal migrations/startup, the server starts one worker lane with a separate
five-connection PostgreSQL pool. Each poll selects at most ten due requests and
processes them sequentially; the idle polling interval is five seconds. A product
session lock coordinates replicas, and the existing origin/SKU lock coordinates
automatic and manual jobs. No product/request row lock spans remote I/O. Shutdown
stops new claims, drains the current operation and closes the worker pool before
the main pool; the existing ten-second force-exit leaves durable recovery evidence.

The gate stores an installation key and an active local actor with
`export_templates.publish`. The worker looks up that installation's highest
**published** binding version for the configured origin on each attempt. Drafts
are never selected. Actor, activation, publication and CSV-maintenance gates are
rechecked in short transactions before dispatch evidence is committed. Disabling
prevents further dispatch authorization; it cannot cancel a request already sent.

The automatic mode reuses `enqueue`, `applyJob`, the planner and native writer.
It captures/revalidates a coherent local snapshot before dispatch and releases
business locks before remote discovery and APPLY. Once started, the immutable
plan may finish while a newer generation is saved; only its older generation is
acknowledged. Magento outage is independent of `/health/ready` and Amber saves.

| Outcome | Durable behavior |
| --- | --- |
| Transient pre-dispatch read/connectivity failure | Pending, exponential delay from 5 seconds capped at 300 seconds; no HTTP write retry. |
| Newer inputs/publication before dispatch | Supersede only an automatic job with zero step evidence, then plan current state. |
| Invalid product, binding or policy | `needs_attention`; a later product mutation can request reevaluation. Binding-only repairs need a separately reviewed local requeue. |
| Uncertain job or any unverified dispatch marker | Sticky `needs_attention/reconciliation_required`; no automatic APPLY or resend, including after restart or later edits. |
| Existing unfinished manual job | Operator attention; never automatically adopted for APPLY. |
| Crash before dispatch | Reopen the persisted request/job; safe pre-dispatch work can resume. |
| Crash after verified partial steps | Existing job revalidation may resume unsent steps; changed local evidence remains blocked for review. |
| Crash after successful job acknowledgement | Consume the stored active generation; retain any newer desired generation. |

Trusted manual `magento:sync -- --job ... --apply` retains its existing
reconciliation checks. It never blindly resends an unresolved step. If newer
Amber data or publication prevents old intent revalidation, explicit operator
reconciliation remains necessary; there is no force/reset endpoint. When an
attached job is reconciled successfully, polling consumes its receipt, including
requests previously marked needs-attention. No historical backfill or unrestricted
retry/queue API is included.

## Manager status

The existing authenticated `GET /api/product-timeline?sku=...` (`history.view`)
adds `magentoSync: { state, reason }` per product in its lineage. Product history
shows not tracked/legacy, pending, syncing, synced or needs attention in Ukrainian.
Status refreshes when history is loaded; this is not a live administration console.
Reasons come from a fixed local dictionary. Credentials, OAuth data, remote bodies,
job payloads and retry/activation controls are not returned.

## Safe verification

From `server/`, with Node 20 and an explicitly supplied `DATABASE_URL` for the
intended database (do not paste real credentials into retained commands):

```powershell
npm run magento:auto-status -- --expected-database amber --expect-disabled
```

This command reads local tables only. It does not load `.env`, migrate, start a
worker or call Magento. It exits nonzero on the wrong database, missing migration,
or an enabled gate with `--expect-disabled`. Change `amber` only to the verified
database name. Do not run ordinary server startup merely to inspect an unmigrated
restored production dump.

The following controlled activation runs **only in the canonical disposable test
environment**. The integration harness refuses names not ending `_test`, resets
only test schemas, creates synthetic actors/publications, activates the test gate
inside its cases and uses injected Magento responses (no real endpoint). It also
spawns a fresh process to prove an unresolved dispatch is not resent.

```powershell
# Repository root, Node 20 on PATH
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d postgres-test
$env:TEST_DATABASE_URL = 'postgresql://amber_test:amber_test_local_only@127.0.0.1:55432/amber_test'
Set-Location server
node --test --test-concurrency=1 '--test-name-pattern=Magento sync durable jobs|automatic Magento|automatic sync migration' integration-test/critical-flows.test.js
$env:DATABASE_URL = $env:TEST_DATABASE_URL
npm run magento:auto-status -- --expected-database amber_test --expect-disabled
Set-Location ..
docker compose -f docker-compose.yml -f docker-compose.local.yml stop postgres-test
```

Do not fall back to another PostgreSQL instance if the canonical service fails.
For all regression suites, use the checks in [AGENTS](../AGENTS.md).

## Final CSV to API cutover

Migration 045 adds the explicit operator boundary; it performs no cutover by itself. Migration 046 separately changes the durable request key from product revision ID to immutable public-product identity while retaining `product_id` on each request/job as the exact desired revision that produced the generation. A recount therefore replaces the desired revision for one remote SKU rather than creating a second remote identity. Source retirement does not enqueue a competing request.

Migration 047, when immutable schema-045 legacy-collision staging evidence exists, restores explicitly split real product rows under newly allocated public identities. It requires automatic delivery and public-SKU activation to remain disabled and creates no automatic request or Magento job. Each restored split product therefore remains an explicit post-cutover Magento CREATE/requeue obligation; the legacy remote product stays owned by the keeper and must not be renamed.

An undispatched predecessor automatic job can be superseded only through the existing zero-step-evidence guard. Any dispatched/uncertain predecessor remains `needs_attention/reconciliation_required`. Generation acknowledgement is conditional: a successful older attached job advances only its own generation and leaves a newer successor generation pending.

The stable-public-SKU activation and delivery cutover remain distinct audited commands. The required production ordering is: freeze all business writers; reconcile pending normal/replacement legacy product CSV work, including any separately reviewed migration-048 external-delivery acknowledgements; verify zero pending normal/replacement work and zero generated-unconfirmed product artifacts; apply the reviewed `public-sku:activation` preflight; establish, validate and explicitly publish the reviewed public-SKU-aware successor Magento template/binding; run a fresh delivery-cutover preflight; apply the separate one-way delivery cutover; verify automatic status and product CSV retirement; only then resume ordinary product/recount writes. Migration 046's database guard rejects product writes in the interval between stable-SKU activation and delivery cutover. Do not use the hazardous legacy `magento-products-v1` UPDATE CSV in that interval: its `product_online=2` can disable an existing Magento product.

```powershell
cd server
$env:DATABASE_URL = '<secret target URL>'
npm run public-sku:activation -- preflight --expected-database <DB> --actor-user-id <USER_ID> --output <NEW_PUBLIC_SKU_PREFLIGHT_JSON>
npm run public-sku:activation -- apply --expected-database <DB> --actor-user-id <USER_ID> --plan <PUBLIC_SKU_PREFLIGHT_JSON> --expected-hash <PLAN_HASH>
```

These commands are not part of normal startup and were not run by this implementation.

`magento:delivery-cutover preflight` is read-only and reports the current publication,
worker actor, automatic jobs/requests, generated-unconfirmed product files, current
shared attempts, pending normal/replacement work and preserved Held count. Apply
requires the exact reviewed preflight hash and atomically enables automatic sync
while permanently retiring new Magento-product CSV artifacts. Existing evidence is
unchanged. Held rows are reported and preserved; deliverable normal/replacement work,
unconfirmed files and active shared attempts block apply. Price CSV remains separate.

```powershell
cd server
$env:DATABASE_URL = '<secret target URL>'
npm run magento:delivery-cutover -- preflight --expected-database <DB> --installation <KEY> --actor-user-id <USER_ID> --output <NEW_PREFLIGHT_JSON>
npm run magento:delivery-cutover -- apply --expected-database <DB> --installation <KEY> --actor-user-id <USER_ID> --plan <PREFLIGHT_JSON> --expected-hash <PLAN_HASH>
npm run magento:auto-status -- --expected-database <DB>
```

Emergency stop does not reopen CSV:

```powershell
npm run magento:delivery-cutover -- disable --expected-database <DB> --actor-user-id <USER_ID> --reason "<incident reference>"
```
