> Historical record. This document describes the state/planning at the time it was written. Current behavior is defined by current code/migrations and the [maintained domain guides](../../README.md). Dates, findings and acceptance limits below are historical evidence, not current deployment claims.

> Earlier 4,817-product rehearsal and original runbook checkpoint. Commands/counts below are retained as evidence only; use the [current production runbook](../../FULL_PRODUCT_CUTOVER_RUNBOOK.md). The later 4,978-product rehearsal is recorded there separately.

# Full-product cutover: 038 to activated lifecycle

This is the canonical deployment procedure for the approved Phase 3B + Phase 4
implementation. Code deployment does **not** approve a useful-database manifest,
attest to any exclusion, confirm delivery, or prove Magento import.

**Required order: 039 → 040 → preparing gate → fresh indexing manifest → historical
indexing → fresh post-index cutover manifest → bounded batches → final validation
→ selector activation.** A different rehearsal order is not a deployment option.
Migration 039 and all earlier migrations remain unchanged.

## Approved policy and outcome

`delivery_floor = greatest(confirmed_revision, cutover_baseline_revision)`.
Acceptance of a baseline is an explicit business assertion about current ordinary
inventory, never evidence that an old artifact contained today's payload.

| Ordinary retained evidence | Count | Cutover route / hold | revision | confirmed_revision | baseline_revision | New | Update at cutover | Required decision |
| --- | ---: | --- | ---: | ---: | ---: | --- | --- | --- |
| Exact confirmed historical SKU membership | 106 | normal | 1 | 0 | 1 | no | no | Accept exact manifest's legacy baseline |
| Legacy indicators only | 2,087 | normal | 1 | 0 | 1 | no | no | Same baseline assertion; exposure and current payload equality remain unproven |
| Generated-only exact membership | 40 | hold / prior_exposure | 1 | 0 | 0 | no | no | Resolve retained files and explicitly authorize controlled delivery |
| No retained exposure indicators | 44 | normal | 1 | 0 | 0 | yes | no | Preserve first-delivery obligation |

All four classes keep `exclude_from_export=0`. Future informational/name changes
increment `revision`; a baseline product at revision 2 appears in Update, while an
unconfirmed first-delivery product remains in New. Price exports retain their
independent stream. The observed 2,193 baseline products already have price-stream
snapshot exposure; baseline initialization does not manufacture it.

| Active correction successors | Count | Preparing and activation state | After individual resolution | Automatic exclusion release |
| --- | ---: | --- | --- | --- |
| Reliably unexposed: 4512, 4846, 4847, 4848 | 4 | hold / historical_ambiguity; unknown business policy; exclusion 1 | Explicit recount-only attestation → normal, baseline 0, confirmed 0, exclusion 0; New | no |
| Confirmed ancestor | 28 | hold / prior_exposure; exclusion 1 | Old SKU + every file reconciled; independent/unknown exclusion resolved → replacement | no |
| Ambiguous historical lineage | 965 | hold / historical_ambiguity; exclusion 1 | External history, old SKUs, files and exclusion resolved → replacement | no |

The 1,543 retired rows remain retired and unchanged. At activation the queue counts
are **44 New, 0 Update, 0 replacement-ready, 1,037 held**. Four separately approved
unexposed releases would produce **48 New and 1,033 held**. Held work remains
visible in the queue; a generic range cannot export it. Names restored from the
source pair require review. The SV source wording includes test/audit text and is
not approved production-facing copy.

| Historical sidecars | Meaning | Revision acknowledgment |
| --- | --- | --- |
| 136 confirmed memberships, four snapshots, 134 unique SKUs | Exact historical product/SKU representation and local confirmation | none: full_revision and delivery_version remain NULL |
| 40 generated memberships, one snapshot | Exact historical representation; file may already have escaped the application | none |
| All 176 memberships; nine retained Magento artifacts checked | Immutable sidecars, hashes and exact SKU matching; consumed by lineage/replacement evidence | Neither current payload equality nor Magento import is established |

A later local confirmation of an old file still does not acknowledge a modern full
revision or release the 40 generated-only holds. New lifecycle captures bind exact
product IDs, full revisions, delivery versions, routes, and gate generation. A
replacement uses one product ID plus its expected delivery version. Its first
confirmation changes replacement → normal; later changes use the same-SKU Update
workflow. Reconfirming an older artifact cannot acknowledge a newer revision or
revive a retired product.

The restored data also contains duplicate historical SKU `CH13122211026` on rows
1089 and 1092. Baseline acceptance does not resolve this identity conflict. Its
retained diagnostics remain in the manifest. Active capture fails closed on a
duplicate SKU or a mismatching permanent reservation, even for a one-product
manual selection. No SKU is renamed, reused, merged, or silently discarded.

## Migration 040 contract

`product_full_export_state` gains:

- `cutover_baseline_revision BIGINT NOT NULL DEFAULT 0`, between 0 and revision;
  `cutover_baseline_event_id BIGINT NULL REFERENCES audit_events(id) ON DELETE RESTRICT`.
  Zero and NULL must occur together. Acceptance is a one-time preparing-only
  transition to the current revision, bound to an immutable per-product decision.
- `business_exclusion_state TEXT NOT NULL DEFAULT 'unknown'`, constrained to
  `unknown`, `none`, `excluded`. Existing flag-zero rows become `none`; flag-one
  rows are not assigned invented provenance.
- `recount_compatibility_excluded BOOLEAN NOT NULL DEFAULT false`.
  Future legacy-mode recounts explicitly record this compatibility policy.
- The pending partial index uses `revision > greatest(confirmed_revision,
  cutover_baseline_revision)`. Changes to delivery policy/baseline require a new
  delivery version. Revision and confirmation counters cannot regress.

The singleton `full_product_export_activation` stores phase (`legacy`, `preparing`,
`active`), positive monotonic generation, selector version 0/1, required writer
version, exact approved manifest hash and FK references to indexing, approval and
activation audit events. The phase/selector/event shape is constrained; active
cannot return to legacy. Baseline events, the complete compact approved manifest,
parent amendment approvals and batch receipts use the existing immutable audit
ledger. There is no second mutable reconciliation ledger.

`export_snapshots.full_product_selection` stores immutable capture provenance;
old rows remain NULL. The existing template binding constraint admits explicit
single-product replacement intent. Existing CSV bytes, snapshot rows and full
membership version 1 are not retroactively rewritten.

At active commit, deferred constraints require each product's exclusion projection
to equal `retired OR business_policy != none OR recount_compatibility_excluded`.
An inactive/corrected source must be retired. A lifecycle hold is a separate export
gate and does not falsely claim an independent business exclusion.

Statement guards require writer contract 1 after preparation and a maintenance
boundary during preparation. Runtime transactions take a shared session advisory
gate **before BEGIN**, avoiding stale repeatable-read snapshots after waiting.
Preparation, indexing, approval, each batch and activation take its exclusive
counterpart. Existing access/session authority ordering and product → lifecycle
ordering remain intact; confirmation does not lock products. These guards detect
unaware application writers. They are not a security boundary against a DBA who
can change schema or session settings.

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
   gate blocks ordinary mutations, previews/captures and confirmations. Auth,
   health, inventory reads and stored-file access remain available. Restarting a
   preparing server skips startup seed/schema work.
4. Generate **fresh** `index-manifest`; review exact database/schema/generation,
   immutable file hashes and diagnostics. Execute `index` with that file and its
   exact content hash. The 176 insertions and receipt are one transaction.
5. Generate **fresh** `cutover-manifest` after indexing. Review every proposed
   disposition and exact inventory/environment hash. Execute `approve` with an
   explicit baseline business reason. This does not approve any successor release.
6. Execute zero-based `batch` operations, at most 100 actionable entries each,
   ordered by product ID; each batch locks its complete affected lineages. There
   are 33 batches for the restored 3,274 active rows. Preserve all result receipts.
7. Run `validate`. It rechecks all 4,817 rows, preserved rows included, complete
   coverage, unchanged products/evidence/cursor, policy projections and every
   required immutable receipt. Run `activate`; it repeats that validation while
   holding exclusive authority, then commits the selector switch and audit event.
   **It clears zero successor exclusions.** Release the operational traffic freeze
   only after final queue/health verification.
8. Only after active, perform separately authorized reconciliation commands.
   Verify four-candidate names/readiness before their first actual Magento files.
   Review generated files and Magento processing operationally; application
   confirmation remains a local acknowledgment.

Use an explicitly configured secret `DATABASE_URL` in the operator environment.
Do not place credentials in JSON, shell history, source control or result files.
Each invocation supplies `expectedDatabase` and an active application `actorUserId`
holding `exports.reconcile`, revalidated inside the authority boundary:

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
| approve | manifestPath, manifestHash, reason |
| batch | manifestHash, batchNumber (0…32 for this inventory) |
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

The supported writer history establishes default 0, recount compatibility/source
retirement 1, archive 1 and the old status migration preserving exclusions. It
does not prove that external SQL or restore activity never replaced the intent of
4512/4846/4847/4848. No supported business exclusion setter was found before this
implementation. The new typed command durably distinguishes independent policy,
compatibility policy, retirement and hold; clearing business policy alone never
clears a lifecycle hold.

| Authoritative writer/path | Operation / states / value | Reason and provenance | Historical period |
| --- | --- | --- | --- |
| Products column default; `product.service.saveProduct` | Insert ordinary active; default 0 | Ordinary inventory; modern `ordinary_save` lifecycle and actor audit | Field introduced `f175ecd` (2026-08-20); migration 000 default since `acbd5d7` (2026-08-31) |
| `product.service.applyProductRecount` successor INSERT | Originally correction/1; later active/1 | Recount compatibility exclusion; correction links and later actor audit prove the operation, not absence of subsequent SQL writes | `f175ecd`; active successor changed by `ae00104` (2026-08-28) |
| Same recount source UPDATE | corrected/1 with successor pointer | Permanent source retirement; correction history | Since `f175ecd` |
| `product.service.deleteProductBySku` | archived/1 | Archive instead of physical deletion; later archive actor/audit | Since `5ab1c8e` (2026-08-20) |
| Legacy `db/init-db` compatibility initializer | Add/default field; NULL → 0 | Mechanical initialization only, no business intent record | Pre-migration initialization; retained compatibility code |
| Migrations 000, 011, 014 | Default 0; correction → active preserving flag; 0/1 check, respectively | Historical schema/status compatibility; no per-row exclusion provenance | 000/014 migration framework from `acbd5d7`; 011 retains prior recount exclusions |
| Backup/restore (`scripts/postgres-restore.sh`) and external product imports/direct SQL | Can reproduce arbitrary retained values/states | Restores stored rows; does not establish original intent or absence of later independent exclusion | Restore tooling since `acbd5d7`; external actions are not disproven by Git |
| SQLite configuration import | No product exclusion writes | Categories/questions/pricing/schema only | Current and inspected historical importer |
| Phase 3A repair primitive | Exact manifest-bound flag/name/state mutation | Immutable repair receipt; now cannot clear exclusions before active; canonical batches use the new cutover service | Uncommitted Phase 3A tooling |
| Current full-product successor initialization | Legacy: compatibility bit true/flag 1; active: flag follows explicit business policy | Normal pending unexposed delivery or distinct lifecycle hold; unknown remains unknown | This implementation, after 040 |
| Current reconciliation / typed business policy command | Active terminal release/0, or explicit business policy 0/1 | Exact reviewed evidence, actor, reason, version, unique resolution key and immutable audit | This implementation, active gate only |
| Tests/fixtures | Synthetic inserts/updates | Non-production evidence only; cannot prove historical business intent | Integration/unit fixtures |

Source correction and archive are retired-state writes, not independent exclusions
on an active successor. No additional admin/service setter was found in the
inspected production history. Actor/audit support introduced by `cc84ac4`
(2026-09-10) records recount operations but the four historical correction payloads
do not record exclusion intent. The stored rows plus Git therefore cannot prove
that no later independent SQL/import action replaced it.

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

## Disposable restored-data rehearsal

`scripts/rehearse-full-product-cutover.js OUTPUT_DIRECTORY` requires an explicit
`DATABASE_URL`, verifies the actual database name ends in `_test`, and requires
038 as the initial checkpoint. Restore only into the canonical `postgres-test`
instance first. It executes the canonical procedure, writes both fresh manifests
and timing/results outside the repository, then labels four attestations as
**DISPOSABLE simulations**. They are not useful-database approvals.

The 2026-09-27 local rehearsal used PostgreSQL 16 on that service, Node 20.20.2,
and a read-only dump of the unchanged 038 `amber` source. Results: 4,817 lifecycle
rows, 176 sidecars, 2,193 baselines, 44 pending first deliveries, 1,037 holds, 1,543
preserved retired rows, 33 batches. All 4,817 confirmed revisions remained zero.
Snapshots, artifacts, cursor, product rows at activation, and SKU reservations
were compared and preserved. After four simulated releases the New count was 48.

Observed transaction-command elapsed times in the final complete run: migrations
164 ms; preparation 15 ms; indexing 1.02 s; batches 1.03–1.30 s; final validation
1.07 s; activation 1.10 s. These include client/revalidation overhead and bound
the exclusive-lock interval from above; they are not production lock guarantees.
The individual forensic release commands took about 9.4–9.7 s each, including
two full inventory classifications. No useful database was migrated or repaired.

Rehearsal manifests are database/checkpoint specific. In particular,
`2c9492d55e6710e343b61fa3a6728b9bd0dc3b4aef9673c7ab1f801ce2c6456d`
is the old **pre-039 projection**, never an apply hash. Fresh `_test` hashes are
also not production approvals. Generate both manifests again inside the actual
production preparing gate.

Final disposable evidence (`amber_cutover_rehearsal_test`, external directory
`%TEMP%/amber-cutover-20260927/run4`):

| Artifact | SHA-256 content hash; never a production apply approval |
| --- | --- |
| Fresh indexing manifest | `23db444ec320055ee8127d54c3ac1fb3087af95c20f3a38e53cb63afab99c596` |
| Fresh post-index cutover manifest | `099324cbbd5560d5644d2218d379884420a36faf7ccd6e66c037196c79226294` |

Verification: server 572 unit tests; serialized PostgreSQL 268 outer cases,
including the migration-040 rollback/repeat test and isolated cutover races;
client 149 unit and 313 rendered tests; server/client lint and client build pass.
Server lint retains two pre-existing unused-variable warnings in product-timeline.
The final amendment regression additionally rejects payload drift on completed
entries while permitting a reviewed amendment for untouched work. All 40 original
migration file hashes (000–039) match the pre-implementation record. The useful
source was rechecked read-only: migration 038 and 4,817 products. No deployment,
useful-data approval, release, migration or activation was performed.
