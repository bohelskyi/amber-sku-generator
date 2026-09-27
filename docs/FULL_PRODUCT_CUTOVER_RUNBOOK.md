# Full-product lifecycle cutover

**Current operational runbook. Production activation remains pending.** This is the canonical one-time procedure for the implemented Phase 3B / Phase 4 machinery. Code deployment and migration installation do not approve an inventory baseline, attest exclusion provenance, confirm delivery or prove a Magento import. Ordinary later deployments follow [Operations](OPERATIONS.md).

Required production order:

**039 → 040 → preparing → fresh indexing manifest → historical indexing → fresh post-index cutover manifest → approval → bounded batches → validate → activate → post-activation reconciliations.**

Keep the maintenance freeze through activation and final checks. Drain all old writers; do not run mixed old/new applications. Generate both manifests afresh against the exact target database and checkpoint. No rehearsal hash, row count, batch count or product ID is a production approval.

## Policy to review in the fresh manifest

| Retained evidence / product class | Cutover disposition |
| --- | --- |
| Ordinary active inventory with exact confirmed membership or legacy exposure indicators | Explicit audited legacy baseline at revision 1; confirmed revision remains 0. Current payload equality and actual import are not proven. |
| Ordinary active inventory reliably unexposed within retained evidence | Normal pending first delivery; baseline and confirmed revision 0. |
| Ordinary inventory with generated-only exact files | Hold for file reconciliation and explicit redelivery authorization. |
| Active correction successors | Preserve exclusions and evidence-based holds through activation; later individual review/attestation is required. |
| Corrected, archived or superseded products | Preserve retired state and permanent SKU reservations. |

The baseline is a business assertion, separate from actual captured confirmation. The [export guide](EXPORTS.md#full-product-revisions-and-cutover-baseline) defines delivery floor and queues. Historical compatibility memberships have null revision counters and cannot acknowledge modern payloads. Typed business exclusions are distinct from recount compatibility and lifecycle holds; see [exclusion/reconciliation semantics](EXPORTS.md#reconciliation-and-exclusion-provenance).

The manifest is exact evidence, not permission to waive unresolved cases. Unsupported ordinary exclusions or unexpected post-039 state can block generation; stale inputs, incomplete indexing/receipts or inconsistent policy block validation. Do not silently repair them or infer external history. Baseline acceptance does not resolve duplicate-SKU/data-quality diagnostics; active capture fails closed on duplicate or mismatched reserved identity, even for a single product.

## Gate and writer contract

Migration 040 creates a `legacy` gate with selector version 0 and writer contract 1. Preparation advances to `preparing`; audited activation advances to `active`, selector version 1. The active gate cannot return to legacy. See [schema constraints](DATABASE_MIGRATIONS.md#cutover-and-activation--migration-040).

Runtime operations acquire the shared session advisory gate before BEGIN. Preparation, indexing, approval, batches and activation use its exclusive counterpart. Preparation blocks ordinary mutations, full-product preview/capture and confirmations; auth/health, inventory and stored-file reads remain available, and startup skips seed/schema writes. Read-only price preview remains observational. Statement guards detect unaware writers but cannot fence an old read-only CSV preview, so draining old processes is mandatory. These guards are not a security boundary against a DBA who can alter schema/settings.

## Deployment and operator commands

1. Back up and restore-test normally. Freeze business traffic and background work
   through activation. Stop/drain **all** old web and worker processes. An old
   read-only CSV preview cannot be fenced by a write trigger; draining is required.
2. Deploy the gate-aware build with the selector inactive. Run normal checksum-
   verified migrations through 039, then 040 on the exact intended database.
   Every application instance must report `X-Amber-Full-Product-Writer: 1` on
   `/health/ready`; verify the deployed build and process inventory, including
   non-HTTP workers. Keep the operational freeze in place.
3. Execute `prepare`, recording deployment/drain/freeze evidence. The preparing
   gate blocks ordinary mutations, full-product previews/captures and confirmations. Auth,
   health, inventory reads and stored-file access remain available. Restarting a
   preparing server skips startup seed/schema work.
4. Generate **fresh** `index-manifest`; review exact database/schema/generation,
   immutable file hashes and diagnostics. Execute `index` with that file and its
   exact content hash. The exact reviewed membership insertions and receipt are one transaction.
5. Generate **fresh** `cutover-manifest` after indexing. Review every proposed
   disposition and exact inventory/environment hash. Execute `approve` with an
   explicit baseline business reason. This does not approve any successor release.
6. Execute zero-based `batch` operations, at most 100 actionable entries each,
   ordered by product ID; each batch locks its complete affected lineages. Derive the number of batches from the fresh approved manifest: `ceil(actionable entries / 100)`. Preserve all result receipts.
7. Run `validate`. It rechecks every manifest row, preserved rows included, complete
   coverage, unchanged products/evidence/cursor, policy projections and every
   required immutable receipt. Run `activate`; it repeats that validation while
   holding exclusive authority, then commits the selector switch and audit event.
   **It clears zero successor exclusions.** Release the operational traffic freeze
   only after final queue/health verification.
8. Only after active, perform separately authorized reconciliation commands.
   Verify each released product’s names/readiness before its first actual Magento file.
   Review generated files and Magento processing operationally; application
   confirmation remains a local acknowledgment.

Use an explicitly configured secret `DATABASE_URL` in the operator environment.
Do not place credentials in JSON, shell history, source control or result files.
Each CLI invocation supplies `expectedDatabase` and a local `actorUserId`. Use an active actor holding `exports.reconcile` for the procedure: all mutation commands and `status` revalidate that capability inside the authority boundary. Read-only manifest generation and `review` require database access but do not themselves perform that actor/capability recheck:

```text
cd server
node scripts/full-product-cutover.js /secure/command.json /secure/unique-result.json
```

Output files must be new (`wx`); evidence is never overwritten. Base command:

```json
{
  "action": "prepare",
  "expectedDatabase": "EXACT_TARGET_NAME",
  "actorUserId": 123,
  "deploymentEvidence": "Reviewed build ID, drained instance/worker inventory, and freeze ticket",
  "requestId": "operator-change-reference"
}
```

Keep the database/actor/request fields for subsequent commands:

| action | Additional fields |
| --- | --- |
| index-manifest | none; output is the fresh manifest |
| index | manifestPath, manifestHash |
| cutover-manifest | none; requires completed canonical indexing |
| amendment-manifest | none; requires an approved preparing manifest; review drift before approval |
| approve | manifestPath, manifestHash, reason |
| batch | manifestHash, batchNumber (zero-based; derive the final number from this manifest) |
| validate / activate | manifestHash |
| status | none; inspect active gate/hash and final queue counts before unfreezing |
| review | productIds; returns current exact lineage/evidence/version descriptors |
| resolve | resolution object described below |
| business-exclusion | resolution: productId, deliveryVersion, excluded boolean, reason, unique resolutionKey |

Resolution requires `successorId` (also the ordinary product ID for generated-only
resolution), `deliveryVersion`, `beforeFingerprint`, reason, unique resolutionKey,
the complete ancestorSkus set, explicit oldSkus dispositions/evidence, and every
retained snapshot's files disposition/evidence. Take these from a fresh `review`:

- `action: "unexposed_first_delivery"`: retained evidence must remain reliably
  unexposed. For unknown legacy exclusions, `exclusionResolution.disposition` must
  be `recount_only_attested`, with evidence that recount created the exclusion and
  no subsequent independent business exclusion replaced it. A known independent
  exclusion instead requires an explicit `release` business decision.
- `action: "generated_first_delivery"`: ordinary product, retained generated or
  subsequently confirmed exact file evidence; `redeliveryAuthorization` must have
  disposition `authorized` and evidence. Resolve every file and old SKU. This
  authorizes normal first delivery; it does not turn the row into replacement or
  set confirmed_revision.
- `action: "replacement"`: held terminal correction successor; resolve all old
  SKUs/files. Ambiguous history additionally requires `externalHistory` with
  disposition `resolved` and evidence; unknown/independent exclusions require
  `exclusionResolution` with disposition `release` and evidence.

SKU dispositions are `verified_absent` or `retired_reconciled`; file dispositions
are `quarantined_do_not_import` or `consumed_and_reconciled`. These are recorded
operator assertions. An application cannot revoke a downloaded file.

## Failure, amendment and rollback

A stale entry or failed write rolls back the **whole current batch**. It blocks
activation of the manifest; earlier committed batches remain durable. Lost replies
are recovered by replaying the same hash/batch number. After approval no actor may
silently replace the manifest or waive missing entries.

If reviewed non-lifecycle input drift cannot be restored to the exact approved
state, generate `amendment-manifest` and explicitly `approve` its new hash/reason.
The amendment binds its parent approval, keeps completed decisions as preserved
rows with their original baseline events/hashes, and batches only remaining work.
It refuses payload changes on already completed/preserved entries, changed
inventory identity/scope, exposure classification, lifecycle
counter/policy drift, or indexing failures; these require a separately reviewed
forward correction rather than an automatic waiver. A stale old hash cannot be
used against an amended gate. Record the incident and keep the freeze until the
new manifest is fully validated.

Crash recovery resumes from gate phase, stored approval and batch receipts. Do not
rerun pre-index manifests as post-index approvals. Do not rewrite a stored checksum.
Before activation the freeze can remain while code is fixed. After activation,
rollback uses a lifecycle-aware compatible build or stops traffic for a forward
fix. Never restore the old cursor selector, clear holds to compensate, rewrite an
artifact, or rewind the cursor. A DB backup restore must be coordinated with all
files already released; it is not the application's cutover rollback mechanism.

## Rehearsal evidence and limits

The fresh local rehearsal reported for this handoff restored the current production backup at checkpoint 038 and completed:

**038 → 039 → 040 → preparing → historical indexing → fresh post-index cutover manifest → 34 bounded batches → validate → activate.**

| Observation | Reported local rehearsal result |
| --- | ---: |
| Products | 4,978 |
| Baseline accepted | 2,169 |
| First-delivery pending | 155 |
| Full-update pending | 0 |
| Replacement-ready | 0 |
| Held | 1,017 |
| Retired | 1,637 |
| Historical sidecar memberships | 133 |
| Selector version after activation | 1 |
| Writer contract | 1 |
| Health | Ready |

These are user-reported **rehearsal facts**, not a production inventory, production activation, attestation or reconciliation. The documentation cleanup did not restore a dump, query a useful database, rerun this rehearsal or independently verify its external manifests. No new rehearsal hashes are supplied here. Production must generate fresh manifests and receive its own operator approvals.

The [earlier 4,817-product rehearsal](archive/exports/FULL_PRODUCT_CUTOVER_REHEARSAL_2026-09-27.md) retains its original counts, hashes, timings, test results, four simulated releases and writer-provenance investigation. Do not combine those results with this later rehearsal or use either as fixed production expectations. Duplicate-SKU/data-quality cases remain unresolved by cutover itself.

The checked-in `server/scripts/rehearse-full-product-cutover.js OUTPUT_DIRECTORY` is a **dataset-specific disposable helper**, not the production entrypoint. It requires explicit `DATABASE_URL`, an actual `_test` database and initial checkpoint 038, writes new evidence files, and includes hard-coded simulations for historical IDs 4512/4846/4847/4848 plus old policy wording. Inspect applicability before a disposable run; do not treat those simulations as generic approvals for a new backup. Use only the canonical `postgres-test` environment in [AGENTS.md](../AGENTS.md); if it fails, stop rather than falling back to another PostgreSQL instance. Production uses the explicit commands above.
