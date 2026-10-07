# Automatic Magento product synchronization

Migration `044_magento_automatic_sync.sql` adds a separate, durable activation gate.
It starts **disabled** and enrolls no historical products. Installation of the code
or migration does not activate sync or retire CSV. The restored operator dump is
not a deployment default; no binding UUID from it is a default.

As reported by the production operator on 2026-10-01, Wave 1 is deployed at PR #19 / `daf627fc2458e5215cbf52735a8f186a3777361f`, with migrations through `050_test_product_deletion.sql`. Stable public `AG-*` identities, the reviewed production binding and automatic Amber → Magento synchronization are active. Magento product CSV delivery is retired; the separate price-export stream and immutable historical evidence remain supported. Historical delivery/collision cutover is complete and the operational freeze has been lifted. This documentation update did not query production or Magento.

## Local transaction boundary

Wave 2 reviewed publication records only its exact affected/unblocked products in
immutable `magento_binding_handoffs/items` (migration 055). The existing worker
settles at most 25 pending obligations before each ordinary queue pass. Enrollment
increments the existing request generation once per item, under the usual local
authorization/lifecycle boundary; no Magento I/O occurs during enrollment. Historical
and unrelated synced products are not globally re-enrolled. Disabled activation
retains pending obligations, retired/test-deleted rows are skipped, and unresolved
manual/dispatched work is protected without reset. Reviewed broader resync and name
rule application are separate actions. See [publication and handoff](MAGENTO_INTEGRATION.md#reviewed-publication-and-controlled-handoff-h3b).

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
| Reviewed stable-public-SKU recount exposure | The CLI atomically records a reviewed `broader_resync` handoff with the lifecycle change. Existing enrollment advances the safe parked request generation; uncertain work remains protected. See the [preview/review procedure](FULL_PRODUCT_CUTOVER_RUNBOOK.md#stable-public-sku-recount-exposure). |

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

The SV keychain optional-size correction does not, by deployment alone, retry parked `needs_attention` requests or alter their published template. Review/publish the [corrected template and binding successor](EXPORT_TEMPLATES.md#sv-keychain-size-correction) through H3b: its exact affected/unblocked scope creates the existing bounded handoff, which advances safe request generations. If an earlier publication did not capture the product, use the existing separately reviewed broader resync. Do not change prices or fabricate sizes just to trigger reevaluation. Historical comma-decimal `SV.answers.weight` still requires the reviewed [`sv-readiness-repair.js`](../server/scripts/sv-readiness-repair.js) operation; future writes normalize that answer authoritatively. Other blockers must still pass review, and manual/dispatched/uncertain work remains protected. There is no unrestricted retry/reset or automatic resend.

After normal migrations/startup, the server starts one worker lane with a separate
five-connection PostgreSQL pool. Each poll selects at most ten due requests and
processes them sequentially; the idle polling interval is five seconds. A product
session lock coordinates replicas, and the existing origin/SKU lock coordinates
automatic and manual jobs. No product/request row lock spans remote I/O. Shutdown
stops new claims, drains the current operation and closes the worker pool before
the main pool; the existing ten-second force-exit leaves durable recovery evidence.

The queue cadence subtracts the preceding pass's elapsed time, so a long batch does
not add another five-second idle wait. Passes still never overlap. Automatic enqueue
and APPLY each read the complete fresh schema. Independent topology, set memberships
and option lists use batches of at most four GETs. Pagination retains its order.
Each parallel audit has one 512-request/60-second budget, and failed
batches drain before errors propagate. No schema evidence is cached between jobs,
generations or publications. Product preconditions, dispatch markers and every
step/final readback remain unchanged. Safe `magento.auto_sync.phase` logs distinguish
schema discovery, observation, precondition reads, dispatch and readback timings;
the immutable job/step ledger remains the delivery authority.

Automatic topology reads (websites, groups and views) also use that bounded batch;
manual discovery with concurrency 1 retains sequential reads. All three complete
before cross-reference validation and attribute pagination. A failed batch drains;
no read, identity check, dispatch marker or readback is skipped or reused.

Phase logs distinguish `stage: enqueue|apply`, UTC start/end, total elapsed time
and a bounded transport aggregate of at most 32 closed endpoint kinds/methods and
scopes (`all`, `en`, `other`). Transport time ends when response headers arrive;
it excludes response-body parsing. Phase duration includes parsing/local work and
nested discovery, so nested phase totals must not be added to their parent.
Aggregates never contain URLs, query strings, headers, credentials, request/response
bodies or SKU text. They forward the original transport arguments, exact response,
cancellation and failure without consuming its body or retrying. Logging failures
are ignored and cannot alter authorization or delivery.

`magento.auto_sync.request_claimed` records local identity/generation, claim UTC,
the latest durable request update and next-attempt timestamps, and age/due-delay.
Age since that update is not necessarily age since the original save: retries or
coalesced changes can move it. Immutable audit/dispatch timestamps remain authority;
`CURRENT_TIMESTAMP` normally marks transaction start, not exact commit or wire time.
These logs are non-durable container stdout. Capture them before rebuilding/recreating
containers; a later DB receipt cannot reconstruct individual GET/dispatch latency.

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

## Test product deletion

Migration 050 introduces a separate explicit Administrator workflow, **Видалити
тестовий товар**, on recent products and the decoded current product. Ordinary
archive is unchanged: local `archived`, excluded, lifecycle retired, `product.archived`,
and no Magento DELETE. An archived automatic request can still require `product_retired`
attention; this hotfix does not reinterpret inventory archive as remote destruction.

POST `/api/products/test-delete/preview` and `/apply` require active authentication,
CSRF and Administrator-reserved `products.delete_test`. Preview accepts a numeric
`productId`, performs eligibility checks and exact GET, and returns only identifiers,
state and a review hash. Apply requires the same product/hash and exact unmodified
public SKU in `confirmation`. Both revalidate the actor inside the access boundary.
No browser-supplied remote ID, URL, credential or arbitrary DELETE route is accepted.

Eligibility requires one active/current ordinary-save revision with an allocated
public identity and its exact permanent internal reservation; normal unexcluded
lifecycle; no correction/request history, price revision/delivery, repricing history
or active repricing draft containing the exact product ID in stored
`preview_snapshot.items[].productId` (category/global scope alone does not establish
membership); no immutable export exposure or other product
business audit history; no unfinished sync job/unverified step or pending generation;
and one succeeded CREATE with a consistent known remote identity. Normal succeeded
CREATE/UPDATE evidence remains immutable and does not itself block eligibility.
The exact remote ID/SKU must match and Magento status must still be disabled (`2`).
Known historical enabled status also blocks. A blocker requires ordinary archive;
there is no eligibility override. No global historical enrollment occurs.

The dedicated `magento_test_deletions` ledger avoids weakening active-product
CREATE/UPDATE job invariants. Its unique public identity binds product ID, internal
and public SKU, origin hash, expected remote ID, CREATE receipt, actor and reviewed
local/remote hashes. Public-identity then origin/SKU session locks coordinate it with
normal workers, name discovery and manual sync. Short access/lifecycle/product/state
transactions finish before all HTTP calls. Persisted product/lifecycle fences remain
effective across crashes and process restarts.

| Ledger state | Meaning and recovery |
| --- | --- |
| `sealed` | Intent committed; no DELETE dispatch authorized yet. Local business changes are frozen. Fresh exact reads and local revalidation precede dispatch. |
| `dispatched` | Dispatch marker committed before the sole DELETE. It remains uncertain until an exact GET proves absence. Every subsequent apply is GET-only; no timeout, HTTP rejection or still-present product causes resend. |
| `verified` | Exact query GET proved zero matching products; verification is durably audited. Local finalization can recover independently after a crash or audit failure. |
| `finalized` | Product is `voided`/excluded, full-product state retired, immutable `product.test_delete_finalized` audit recorded. Identical apply returns this receipt. |

Already-proven remote absence can move sealed directly to verified without DELETE.
Finalization records a distinct automatic-request `voided` state in the product
transaction, clears its active association/reason/diagnostics and leaves its actual
`synced_generation` unchanged. It creates no normal success job and preserves prior
CREATE/UPDATE receipts. Workers and name discovery skip sealed identities.
Pending deletion receipts appear as a separate safe recovery problem, including
when no automatic request exists; finalized receipts disappear from that view.
Voided rows disappear from ordinary recent, lookup/history and sample-search results;
technical evidence remains in the ledger and Administrator audit viewer.

After an uncertain response, reopen the same action, perform preview and enter the
same public SKU to **Перевірити результат видалення**. The durable intent survives
reload; an absent product completes without a second DELETE. A still-present or
mismatched counterpart stays frozen for technical review. There is no force/reset,
automatic DELETE retry, or cancellation after dispatch. Undispatched remote drift
also stays sealed for technical review; the workflow never silently changes intent.

Magento's SKU DELETE has no conditional-ID/precondition API. Exact reads detect
identity drift before dispatch, but independent Magento writers are outside Amber's
locks. Use an exclusive operator window: no concurrent rename, recreation, activation
or sale activity for the target. Remote order history is not queried; the operator's
explicit test-product attestation and conservative retained evidence are required.

## Manager status

The existing authenticated `GET /api/product-timeline?sku=...` (`history.view`)
adds `magentoSync: { state, reason }` per product in its lineage. Product history
shows not tracked/legacy, pending, syncing, synced or needs attention in Ukrainian.
Status refreshes when history is loaded; this is not a live administration console.
Reasons come from a fixed local dictionary. Credentials, OAuth data, remote bodies,
job payloads and retry/activation controls are not returned.

## Safe verification

Local problem/page and product-status reads classify a recorded
`AMBER_SYNC_ELIGIBILITY_UNRESOLVED` using the current lifecycle row. A matching
`hold/historical_ambiguity` with historical-ambiguity evidence is presented as
**Потрібне підтвердження історії доставки**, with `resolution:
"lifecycle_reconciliation"` and a normalized `eligibilityIssue` (route, hold reason,
allowlisted primary reason/classification, correction ID, ancestor IDs and decimal
delivery version). Arbitrary lifecycle JSON is not exposed. Missing/mismatched
evidence receives a neutral responsible-operator handoff, never an inferred mapping
diagnosis. Dispatched/uncertain work keeps its higher-priority reconciliation state.

Attention and Product Detail offer read-only evidence/history and a capability-based
handoff; `exports.reconcile` reveals the existing review procedure, not a browser
release or retry. Integration overview labels held products separately from
structural preparation and routes their attention to product problems. Genuine
mapping issues retain exact-field navigation; resource issues point to integration
preparation. All these reads are local, with no audit, enqueue or Magento I/O.
See the [post-recount review procedure](FULL_PRODUCT_CUTOVER_RUNBOOK.md#historical-ambiguity-after-recount).

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

The stable-public-SKU activation and delivery cutover remain distinct audited commands. For a new installation that has not completed cutover, the required ordering is: freeze all business writers; reconcile pending normal/replacement legacy product CSV work, including any separately reviewed migration-048 external-delivery acknowledgements; verify zero pending normal/replacement work and zero generated-unconfirmed product artifacts; apply the reviewed `public-sku:activation` preflight; establish, validate and explicitly publish the reviewed public-SKU-aware successor Magento template/binding; run a fresh delivery-cutover preflight; apply the separate one-way delivery cutover; verify automatic status and product CSV retirement; only then resume ordinary product/recount writes. Migration 046's database guard rejects product writes in the interval between stable-SKU activation and delivery cutover. Do not use the hazardous legacy `magento-products-v1` UPDATE CSV in that interval: its `product_online=2` can disable an existing Magento product.

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

## Shared-authority product names

Migration `049` stores one exact full UA/EN name baseline per Magento origin and stable public product identity, remote ID, observed sides, bounded explicit resolution, and version. An acknowledged succeeded intent supplies existing confirmed evidence; no historical job is rewritten. Initial CREATE establishes the baseline only after durable writes and final read verification. Missing baseline with unequal names requires explicit choice.

Three-way comparison uses field values only: equal names confirm the baseline; external-only changes are accepted locally; Amber-only changes go through the ordinary durable job; differing changes on both sides block without overwriting either. Magento/product `updated_at` never chooses a winner. Full external names are stored losslessly in `products.magento_name_override` against the exact generated full-name pair. Structured subjects remain untouched; a name-driving generated change invalidates the override. Recount inherits subjects without automatic inherited-name confirmation.

The recount form displays exact effective UA/EN names through local `GET /api/product-names/:productId` (`products.decode`). Fields are read-only until an authorized direct-recount user selects “Змінити назву”; cancellation restores the original values. Recount preview/apply binds an optional exact-name decision and shared-name evidence; apply persists the successor override atomically. Unchanged recounts inherit the exact effective names, anchored to the successor's generated-name context. An explicit edit retains both `products.recount` and the existing name-edit permission `exports.create`, with transactional actor checks. Existing name conflicts disable editing and retain their separate resolution workflow while unrelated recount remains available. The separate name-edit block is retired; the local save API remains compatible. Only verified worker delivery advances the common baseline. Neither recount nor the browser performs remote name I/O or reverse-parses full names into subjects.

GET `/api/magento/summary`, `/api/magento/problems`, and `/api/magento/product-status/:productId` require `products.view`. Safe planner diagnostics distinguish configuration, product data, names, and unresolved dispatch. No raw remote payload or credential reaches these surfaces. POST `/api/magento/name-resolution/preview` and `/apply` retain existing `exports.create`, active-user and CSRF boundaries. Explicit choices bind both observed sides, product, published binding, remote identity, and durable name state; apply re-reads and transactionally revalidates. Choosing Amber authorizes only these exact sides and leaves the baseline unchanged until verified delivery. Unresolved dispatched work rejects resolution and is never blindly resent.

Historical restore review can explicitly accept the exact current Magento UA/EN names while the local product remains archived. The same name-resolution endpoints accept `intent: historical`, `choice: magento`, and exact `productId`, `article`, `remoteProductId`, and `bindingRevisionId`. In addition to `exports.create`, the actual Administrator must retain all historical-review permissions. The actor-bound five-minute preview covers the complete local product, lifecycle, published binding, request state and full names; apply re-reads Magento and transactionally revalidates that evidence. Existing lineage, remote ownership, unresolved dispatch, media, deletion and independent exclusion guards remain in force. Acceptance preserves the retired lifecycle and common full-name baseline without creating a delivery job, restore intent or Magento write, and requires no new global name policy publication. The UI discards restore selections and consent, then runs a fresh ordinary historical preview of the complete original SKU list. A lost acceptance reply permits only another exact names read; an already accepted baseline can then proceed to a fresh restore preview without repeating the save. Opening, declining or closing the names review saves nothing.

A separate GET-only discovery lane runs with the existing automatic-sync activation gate and revalidated service actor. Its durable origin cursor visits at most ten active, automatically enrolled public identities with known remote job or durable name-observation evidence per minute, using at most two product GETs each (base and required English). It skips unresolved dispatched work, retains baselines on failed reads, resumes from the cursor after restart, wraps after the end, and revisits failures on a later cycle. A fresh equal-name observation resolves a previous name conflict or missing-baseline blocker and queues ordinary full evaluation; it never resets unresolved dispatched work. No Magento mutation occurs in discovery. Remote I/O remains outside product/access transactions; shutdown waits for both worker lanes before closing their isolated pool. Unchanged observations do not advance the state version or invalidate reviewed previews.
