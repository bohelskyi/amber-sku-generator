# Recount → correction → export correctness plan

**Status:** Proposed — release-blocking recount/export correctness design; implementation in progress incrementally.

**Intended document:** `D:\Work\amber-sku-generator\docs\RECOUNT_EXPORT_CORRECTNESS_PLAN.md`

**Delivery boundary:** Only Phase 0 is authorized in this implementation. Sections describing ledger, migration, lifecycle, repair, names, requests and UI are the approved future architecture, not implemented behavior. Phase 1 has not started. The current release-blocker regression retains its existing expectations.

## 1. Recommendation and decisions

Retain successor-based recount and permanent SKU reservations. Add:

1. A durable, separate **full-product export revision ledger**.
2. Exact, immutable **snapshot membership records**.
3. An explicit reconciliation workflow for successors whose lineage may already have reached Magento.

Continue using the existing normal snapshot, CSV artifact, template, session, audit and confirmation infrastructure. Do not create another CSV generation engine or reuse the price revision stream.

The governing invariant becomes:

> Every active product requiring full-product delivery has a durable pending revision or a visible, actionable hold. Cursor advancement cannot remove that obligation.

The following choices were selected during planning:

| Decision | Selected behavior |
|---|---|
| Reliably unexposed correction lineage | Successor automatically remains pending for first full export. |
| Previously exposed or ambiguous lineage | Reviewed replacement; no automatic entry into ordinary new-product exports. |
| In-place corrections | Retain the existing narrow informational workflow; do not add general canonicalization or weight editing. |
| Manual Magento names | Inherit both subjects; require review when semantic SKU answers or schema change. |
| Coverage | Track ordinary newly saved products as well as successors. |
| Informational/name changes after generation | Track separate full-product revisions so an older confirmation cannot clear newer changes. |
| Replacement release | Require recorded reconciliation of old SKUs and generated files. |

Approval of this architecture does not itself authorize modification of restored or production data.

## 2. Inspection baseline and confirmed facts

### Repository

- Branch: `feature/magento-export-constructor`
- HEAD: `8d5656a6893b4fb165157729c4b89a6914908faa`
- Git status: **49 modified tracked files, 6 untracked files, nothing staged**.
- Existing changes concern UX-5 client components/tests, export documentation, export history, and integration coverage.
- Relevant existing changes include the investigation document and the recount-exclusion characterization test.
- No files, database rows, snapshots, configuration or dependencies were changed during this investigation.
- `git diff --check` passed; Git reported existing LF/CRLF conversion warnings.
- No test suite was rerun for this planning task.

Preserve the complete dirty worktree. Do not reset it or incorporate unrelated UX changes into the correctness implementation accidentally.

The six untracked files are:

- `SearchablePicker.jsx`
- `export-ux5.test.jsx`
- `helpers/searchable-picker.jsx`
- `EXPORT_RECOUNT_INVESTIGATION_2026-09-26.md`
- `EXPORT_UX_ACCEPTANCE_AUDIT_POST_UX5_2026-09-26.md`
- `11-export-recount-exclusion.cases.js`

### Migration inventory

The repository and restored database both contain **39 migrations, 000–038**:

```text
000 initial_schema
001 sku_registry_and_indexes
002 pricing_scenario_controls
003 repricing_batches
004 option_hidden_rules
005 option_archiving
006 sku_schema_versions
007 compact_sku_version_markers
008 repricing_rollback
009 repricing_drafts
010 repricing_reviewed_products
011 correction_requests
012 exchange_rate_cache
013 export_snapshots
014 numeric_and_business_invariants
015 concurrency_and_upgrade_invariants
016 legacy_zero_price_compatibility
017 global_repricing
018 correction_request_claims
019 postgres_session_store
020 application_users_rbac
021 business_permission_enforcement
022 manager_correction_request_permissions
023 audit_events
024 product_actor_attribution
025 correction_request_user_ownership
026 repricing_actor_attribution
027 export_and_sku_schema_actor_attribution
028 custom_roles
029 category_marketing_rounding
030 correction_request_pricing_decisions
031 product_price_reexports
032 price_change_requests_and_price_exports
033 magento_snapshot_artifacts
034 product_magento_manual_names
035 export_templates
036 export_snapshot_template_binding
037 shared_export_sessions
038 editable_export_columns
```

Each entry corresponds to its existing numbered `.sql` file. Treat **all 000–038 as immutable**, regardless of older documentation naming a shorter immutable range.

The proposed next migration is `039_full_product_export_lifecycle.sql`, provided no intervening migration lands first.

### Authoritative implementation areas

| Area | Current services and routes |
|---|---|
| Recount | `product.service.js`: `buildProductRecountPreview()`, `applyProductRecount()`, `saveProduct()`; `POST /api/recount/preview`, `/apply` |
| Request workflow | `correction-request.service.js`; `/api/admin/correction-requests`, including preview, claim, release, force-release, refresh, status and complete |
| Product signatures/answers | `product-signatures.js`, `product-answers.js`, `product-validation.js` |
| Informational edits | `product-information.service.js`; `/api/product-information/preview`, `/apply` |
| Manual names | `product-magento-name.service.js`; `/api/product-magento-name/preview`, `/apply`, `/suggest` |
| Full exports | `export.service.js`: range selection, exposure capture, snapshot creation, confirmation and status |
| Export API | `exports.routes.js`; `/api/export/status`, `/preview`, `/snapshots`, stored CSV/artifact routes and snapshot confirmation |
| Published exports | `published-capture.js`, `snapshot-binding.js`, `input-projection.js` |
| Controlled sessions | `export-sessions.service.js`, `export-session-access.js` |
| Price delivery | `product-price-change.service.js`, `price-export.service.js`; `/api/product-price-change/*`, `/api/price-export/*` |
| Presentation/history | `magento-products-v1.js`, `export-history.service.js`, correction history and product timeline projections |

Primary code evidence: [recount application](/D:/Work/amber-sku-generator/server/src/services/product.service.js:556), [export selection and exposure](/D:/Work/amber-sku-generator/server/src/services/export.service.js:132), and [snapshot confirmation](/D:/Work/amber-sku-generator/server/src/services/export.service.js:687).

Relevant tables are:

- `products`, `product_corrections`, `correction_requests`, `sku_registry`
- `categories`, `questions`, `options`
- `sku_schema_versions`, `sku_schema_questions`, `sku_schema_options`
- `price_scenarios`, `price_matrix`, `price_modifiers`, pricing/rate evidence
- `export_snapshots`, `magento_export_artifacts`, `export_state`, `export_events`
- `product_export_revisions`, `price_export_snapshots`
- Export template, session, membership and attempt tables
- `audit_events`, `application_users`, permissions and role mappings

### Restored database

Inspection used the existing local Docker `postgres` service, database `amber`, PostgreSQL **16.15**, exclusively inside read-only transactions. This was not an integration-test target.

Confirmed state:

- Normal cursor: **4063**
- Normal snapshots: **5**, comprising **4 confirmed** and **1 generated**
- Confirmed snapshots contain 136 stored product rows across snapshots, representing **134 distinct SKUs**
- The generated snapshot contains **40 products**
- All five internal CSVs parsed successfully, with row counts matching their snapshot metadata
- All `reexport_revisions` arrays in these five snapshots are empty

Empty revision arrays therefore cannot mean empty snapshot membership.

## 3. Root cause and dual-exclusion history

Current recount inserts an active successor with `exclude_from_export=1`, then marks the source corrected and excluded.

Normal export selection requires `exclude_from_export=0`. New-product selection additionally requires `id > confirmed cursor`. Confirmation advances that cursor with `GREATEST`.

Consequently:

1. Recount removes the source from eligibility.
2. Its successor is ineligible immediately.
3. No durable full-export obligation replaces the source’s eligibility.
4. A later confirmation can advance past the successor.
5. Clearing exclusion afterward would still not restore it to cursor-based New selection.

This is a server lifecycle defect, not a stale React review or frozen-range defect.

### Origin

Commit `f175ecdbb1e7332681c534ae8cf7892fe48ff380`, dated **2026-08-20**, introduced recount, dual exclusion and export filtering together. Its client explicitly said:

> «Створено коригувальний артикул … Він не потрапить в експорт.»

Originally, successors had status `correction`. Migration 011 later changed those rows to `active`, explicitly retaining export exclusion as an independent control.

Immutable snapshots arrived later, in commit `acbd5d7`, dated **2026-08-31**. Migration 013 carried forward the existing cursor from `export_events`.

**Confirmed:** exclusion of correction SKUs was intentional in the original workflow.

**Not established:** the historical business reason. The inspected history does not prove whether the intended purpose was duplicate prevention, external manual correction, or another operational convention. No companion full-product correction-export mechanism was found.

Preventing historical source export remains valid. Unconditional successor exclusion without a pending/reconciliation path is no longer a valid lifecycle invariant.

## 4. Authoritative exposure model

“Exported” must be qualified. Snapshot confirmation records operator acceptance/consumption; it does **not** prove a successful Magento import.

Use these classifications for each product and its complete predecessor chain:

| Classification | Required evidence | Consequence |
|---|---|---|
| Reliably unexposed | No exact generated or confirmed membership; no unresolved historical indicators; coverage established for the relevant lifecycle | Eligible for automatic first delivery |
| Generated, unconfirmed | Exact membership in an immutable generated snapshot | Potential external exposure; a changed-SKU successor requires reconciliation |
| Confirmed product snapshot | Exact membership in a confirmed normal snapshot | Established application export evidence; successor requires reconciliation |
| Historical/ambiguous | Cursor/range inference, legacy events without rows, unmatched exposure flags, missing/conflicting lineage or incomplete artifacts | Hold and investigate; do not infer “never exported” |

Evidence precedence:

1. Exact immutable snapshot membership, linked to snapshot status.
2. Verified historical CSV/artifact membership matched by permanently reserved SKU.
3. Recorded operator reconciliation of external history.
4. Conservative exposure indicators, which establish uncertainty but not exact membership.

Specific limitations:

- `product_id <= cursor` is not proof of representation.
- `has_product_snapshot=true` is not proof of confirmation.
- Migration 032 populated that flag using cursor and range inference as well as exact revision evidence.
- `reexport_revisions` contains selected price revision evidence, not every represented product.
- An empty array does not prove absence.
- A descendant inherits its lineage’s **exposure risk**, not its ancestor’s completed export revision.
- Absence from retained records is not proof that no out-of-band Magento operation ever occurred.

Preserve the existing conservative price-exposure flag. Add stronger evidence rather than rewriting its historical meaning.

## 5. Correction classes

These classes overlap; exposure and identity must be evaluated separately.

| Class | Persistence and export rule |
|---|---|
| **A. Never represented in a confirmed snapshot** | Split further: reliably unexposed versus generated/unconfirmed versus ambiguous. Only reliably unexposed lineages receive automatic successor first-export eligibility. |
| **B. Already represented in a confirmed snapshot** | Keep successor lineage. Hold its full export until old-SKU reconciliation is recorded. |
| **C. Equivalent/canonical representation** | Do not assume identity neutrality from displayed text. Existing approved informational edits may remain in-place; other recounts retain successors. |
| **D. SKU-relevant answer changes** | Successor required; target-schema validation and permanent reservation remain authoritative. |
| **E. Authoritative weight changes** | Successor required through recount; recompute applicable SKU and pricing evidence. |
| **F. Informational-only answer changes** | Use existing guarded in-place service when eligible. Record a full-product revision when exported content changes. If processed through recount, retain successor semantics. |
| **G. Consequential price changes** | Recount successor’s first full export contains its authoritative final price. Subsequent price-only changes use the existing price revision stream. |
| **H. Different proposed SKU** | New internal SKU remains the successor’s identity; exposure determines delivery route. |
| **I. Same logical proposed SKU, reservation forces `-NNN`** | Treat the actual reserved successor SKU as different external identity. A suffix does not authorize an automatic Magento duplicate. |

### The real weight example

The restored metadata establishes:

- `SV.weight` is question **69**, non-SKU, text, optional and visible.
- It is an axis of active pricing scenario **60**, matched to `souvenir=6`.
- The reproduced product has `souvenir=1`; that particular scenario does not match it.
- The approved informational allowlist deliberately excludes `SV.weight`.
- Source and successor use schema **6**, SV version 1.
- SV uses sequence allocation: `SV23150004` was the next proposed SKU, not a forced `-NNN` variation.
- Stored physical weight is unchanged at `1260.000`.
- Stored final price remains `21700.00`, with a manual price decision.
- Magento currently applies `Number()` to the stored weight answer, so the comma string and number have different mapper behavior.

Therefore the edit is a **human-equivalent representation repair**, but it is not eligible for the existing server-proven informational path. It does not justify a general weight bypass.

The old correction payload also contains decoded `symbolic_stat:0`; the stored source answers do not. Do not misclassify removal of that decoded placeholder as an independently entered semantic correction.

## 6. Architecture comparison

| Model | Advantages | Defects/costs | Verdict |
|---|---|---|---|
| **A: successor plus exposure-dependent exclusion** | Preserves existing recount, audit and SKU invariants | Clearing exclusion alone cannot recover IDs behind the cursor or protect out-of-order commits | Necessary foundation, insufficient alone |
| **B: broader in-place correction** | Avoids unnecessary new identities for proven neutral edits | Requires dependency proof, signatures, audit/timeline semantics and request parity; does not repair existing successors or solve identity-changing corrections | Defer expansion |
| **C: dedicated correction queue and separate snapshot engine** | Explicit recovery independent of cursor | Duplicates artifact, template, session, confirmation and authorization infrastructure | Reject separate engine |
| **C variant: separate full-product revision ledger using existing snapshots** | Durable pending work, exact acknowledgment, reuse of immutable infrastructure | Requires two tables and coordinated selection/confirmation changes | Recommended |
| **External Magento SKU alias** | Could preserve one external identity across successors | Introduces another identity authority, mapping conflicts and exporter changes | Defer until separately designed |
| **Bounded manual re-export only** | Small implementation | Work remains undiscoverable without a durable queue; operators must know missing SKUs | Useful action, insufficient architecture |

**Primary architecture:** Model A with the small ledger/membership form of Model C, preserving the existing narrow Model B service.

## 7. Recommended lifecycle

### Product creation and recount

Every successful ordinary save creates full-product revision `1`, unconfirmed, in the same transaction as its product and audit.

Every recount:

1. Locks and revalidates the active source.
2. Rebuilds the target configuration and pricing.
3. Reserves the actual successor SKU using existing ordering.
4. Inserts the successor and correction history.
5. Retires the source’s delivery eligibility.
6. Creates the successor’s independent full-product revision `1`.
7. Classifies the complete lineage under the same transaction.
8. Completes the request, where applicable, and writes audit atomically.

Successor disposition:

- **Reliably unexposed:** normal first delivery; successor exclusion becomes `0`.
- **Generated/confirmed predecessor exposure:** held for reconciliation; exclusion remains `1`.
- **Historical uncertainty:** held for evidence review; exclusion remains `1`.
- **Intentional source exclusion:** preserve a visible exclusion hold; correction cannot silently remove an independent business exclusion.

Corrected sources always remain excluded and inactive for delivery.

### First-export selection

`mode:"new"` selects active, uncorrected, non-excluded products with an outstanding first full-product obligation and normal disposition.

It does **not** require `id > cursor`.

Selection uses exact product membership, ordered by product ID. Returned range endpoints describe the selected set; they must not cause intervening already-exported products to be included accidentally.

The normal cursor continues to advance monotonically for compatibility and history. It becomes a watermark, not an acknowledgment ledger.

### Subsequent full-product changes

The existing informational and manual-name services increment the new full-product revision in their product/audit transaction.

- Before confirmed full delivery: the latest revision remains pending for first delivery.
- After confirmed exposure: the changed product appears in an explicit same-SKU full-update queue.
- An older snapshot confirms only its captured full revision.
- Identity-neutral edits continue preserving ID, SKU, schema and correction lineage.

Do not increment this ledger for price-only changes. Those remain owned by `product_export_revisions`.

### Reviewed replacements

A held successor cannot be exported through ordinary New or a generic manual range.

An authorized reconciliation records:

- Exact current successor and full ancestor SKU list.
- Generated/confirmed snapshot evidence available to the application.
- For each potentially exposed old SKU: externally verified absent, or retired/reconciled.
- Disposition of previously generated files, including instructions preventing their later import.
- Operator, time, reason and evidence reference.

Successful reconciliation releases a **replacement delivery**, not an ordinary new-product row.

Use an explicit single-product replacement selection on the existing export preview/create endpoints. It creates ordinary immutable full-product artifacts with replacement provenance. Confirmation acknowledges that successor only.

After its first replacement confirmation, subsequent changes follow the ordinary same-SKU update workflow.

A recorded human reconciliation cannot technically revoke downloaded files or guarantee Magento state. The UI must make that boundary explicit without describing local confirmation as an import receipt.

### Price stream

- Do not inherit predecessor price revisions or exposure as successor price state.
- Full capture establishes exposure for the actual successor SKU.
- Preserve current initial-price revision capture and dedicated price confirmation rules.
- Full-product acknowledgment must never clear a later price revision.
- After exposure, redundant same-SKU price delivery remains acceptable under existing semantics.

## 8. Interfaces and compatibility

Add a shared lifecycle service used by save, recount, informational edits, name edits, snapshot capture, confirmation and repair.

Add these API capabilities:

| Interface | Behavior |
|---|---|
| Export status | Add first-delivery, full-update, replacement-ready and held counts |
| Pending full-product list | Paginated products with ID/SKU, category, route, revision, hold reason and safe lineage evidence |
| Reconciliation command | Version-checked, audited release of a specific held successor |
| Existing preview/create | Add explicit `mode:"replacement"` with product ID and expected delivery-state version |
| Existing manual single-SKU export | Serve explicit same-SKU updates using the same ledger |
| Recount preview/result | Return server-derived delivery outcome and manual-name inheritance/review information |
| Stored snapshot metadata | Show captured full revisions, replacement provenance and superseded-product warnings |

Use `exports.view` for reads and `exports.create` for capture/confirmation. Add a delegable `exports.reconcile` capability, initially available only to Administrator, for releasing historical/exposed holds.

Preserve private/shared session access checks. A queue may disclose the minimal exposure classification needed for safe correction; it must not expose inaccessible session titles, participants or files.

Compatibility rules:

- Existing completed snapshot keys return their original stored result.
- Existing stored downloads and confirmations do not evaluate current products.
- Bind new selection membership, lifecycle version, revisions and replacement authorization into new preview expectations/tokens.
- Unused previews from before lifecycle activation require refresh.
- Old completed correction requests retain current idempotent response behavior.
- Pending recount requests using old signature formats require refresh before completion when the new lifecycle/name evidence is absent.
- Preserve claim epochs and legacy claim-token adoption.
- Keep `countSinceLastExport` temporarily as a compatibility alias for pending first-delivery count; introduce accurately named fields and update documentation.

Direct recount must carry the preview’s new lifecycle binding. Missing or stale evidence returns a refresh-required conflict; it must not silently apply a different delivery outcome.

## 9. Cursor and concurrency proof

### Required lock order

Extend the existing order without introducing product locks into confirmation:

- **Capture:** existing access/session boundaries → idempotency lock → template selection → products ascending → full-product state ascending → price revisions ascending → cursor → snapshot/members/artifacts/audit.
- **Recount:** source product → existing sequence/SKU locks and reservation → existing request finalization boundary → full-product state ascending → audit/commit.
- **Confirmation:** snapshot → full-product state ascending → price revisions ascending → cursor.
- **Information/name changes:** product → existing catalog checks where applicable → full-product state → audit.
- **Repair/reconciliation:** existing authority boundary → affected products ascending → full-product state ascending → audit.

No path may hold a full-product state lock and subsequently acquire an existing product lock.

Confirmation reads immutable membership and never locks current products. Recount must not lock existing snapshot rows while holding product/state locks.

Use coherent transactional capture for every creation path, including legacy compatibility calls. Preserve fresh-transaction idempotent winner recovery after serialization failure.

### Safety arguments

| Scenario | Required outcome |
|---|---|
| Successor above cursor | Its durable unconfirmed revision selects it for first delivery. |
| Successor below cursor | The same obligation selects it; no cursor rewind is needed. |
| Lower ID commits after a higher ID is confirmed | Product and obligation commit together; selection discovers the lower ID independently of cursor. |
| Manual high-ID range omits other new products | Only represented revisions are acknowledged. Omitted products stay pending. |
| Recount wins before capture | Source is excluded; stale capture fails or fresh capture sees the successor’s correct route. |
| Capture wins before recount | Product share lock protects source capture; recount then observes generated exposure and holds the successor. |
| Preview races with recount | Preview reserves nothing. Its changed membership/signature becomes stale at creation. |
| Confirmation races with recount | Both serialize on the source’s full-product state. Generated and confirmed exposure both require a hold, so neither ordering permits unsafe automatic delivery. |
| Two recounts | Existing source lock and final state check allow one successor and one durable obligation. |
| Old source confirmed after successor exists | Acknowledgment belongs only to the source ID/revision. It cannot satisfy or release the successor. |
| Repeated/out-of-order confirmations | `GREATEST` advances only captured revisions; attribution remains first-write and newer revisions remain pending. |
| Repair races with capture | Product/state locks and expected versions produce either the old coherent state or the repaired coherent state; stale manifests fail. |
| Request completion races with export | It invokes the same recount primitive and receives the same guarantees. |
| Price changes after correction | Product/price revision locks preserve current price-stream behavior; full confirmation cannot consume uncaptured price changes. |
| Another recount after replacement release | Source delivery is retired; the new successor is reclassified against the entire lineage and requires its own release when exposed. |

Generated snapshots remain immutable and potentially exposed. Generation never clears pending full revisions. Existing-key retries return original files rather than silently substituting a successor.

The guarantee is durable discoverability and correct acknowledgment. Ambiguous external history remains visibly held until an operator resolves it.

## 10. Existing affected-data inventory

### Aggregate results

“Confirmed” below means exact SKU membership in a retained confirmed normal snapshot, not inferred Magento import.

| Measure | All correction pairs | Active excluded successors |
|---|---:|---:|
| Total | **1,436** | **997** |
| Immediate source in confirmed snapshot | 28 | 6 |
| Successor in confirmed snapshot | 0 | 0 |
| Neither immediate row in confirmed snapshot | 1,408 | 991 |
| Either immediate row in generated-only snapshot | 0 | 0 |
| Successor above cursor 4063 | 658 | 557 |
| Successor at/below cursor | 778 | 440 |
| Confirmed ancestor anywhere in lineage | 50 | 28 |
| Historical ambiguity without confirmed ancestor | 1,382 | 965 |
| No retained exposure indicator in lineage | 4 | 4 |

The 1,436 successor rows comprise **997 active**, **430 subsequently corrected**, and **9 archived** rows.

No missing source/successor rows, duplicate source/target correction links, or disagreement between correction records and product lineage pointers was found.

### Active excluded successors by category

ID intervals below are bounds, not claims that every ID inside an interval belongs to the group.

| Category | Count | Successor ID bounds | Above cursor | Behind cursor | Confirmed ancestor | Ambiguous | No recorded exposure |
|---|---:|---|---:|---:|---:|---:|---:|
| BR | 279 | 2847–4303 | 4 | 275 | 0 | 279 | 0 |
| CH | 131 | 4632–4779 | 131 | 0 | 0 | 131 | 0 |
| KL | 113 | 4521–4805 | 113 | 0 | 28 | 85 | 0 |
| NM | 471 | 2892–4517 | 306 | 165 | 0 | 470 | 1 |
| SV | 3 | 4846–4848 | 3 | 0 | 0 | 0 | 3 |

### Exact first-delivery repair candidates

| Correction | Category | Source | Successor | Recorded changes |
|---|---|---|---|---|
| 1152 | NM | 4400 / `NM4/111120621026` | 4512 / `NM4/113120611026-001` | Quality/style changed; decoded hidden size removed; price 3500 → 2950 |
| 1434 | SV | 4501 / `SV13150002` | 4846 / `SV13150005` | `"1520,0"` → `1520`; physical weight and price unchanged |
| 1435 | SV | 4503 / `SV13150003` | 4847 / `SV13150006` | `"1890,0"` → `1890`; physical weight and price unchanged |
| 1436 | SV | 4502 / `SV23150003` | 4848 / `SV23150004` | `"1260,0"` → `1260`; physical weight and price unchanged |

These four have no retained snapshot membership or exposure flag in their ancestry. They are candidates for proven first-delivery repair after the repair manifest validates history coverage and independent exclusion.

### Representative other groups

| Group | Exact example | Evidence/classification |
|---|---|---|
| BR historical ambiguity | 1208 / `BR11384452017` → 2847 / `BR11184452017` | Quality changed; historical exposure cannot be resolved from a cursor alone |
| CH historical ambiguity | 1097 / `CH13322211026` → 4632 / `CH2/14322211026` | Quality/discount and schema changed |
| KL confirmed source | 3897 / `KL2/11121350004-001` → 4557 / `KL2/11131251004` | Exact confirmed source membership; size/additional/texture changes |
| KL confirmed ancestor through another correction | 3883 / `KL2/11141350005` → 4570 / `KL2/11141251005` → 4780 / `KL3/11141351005` | Review the whole lineage, not only 4570 |
| Informational-looking historical edit | 37 / `NM113125511016` → 3670 / `NM4/113125511016` | `neckle_size` changed, but schema and price also changed; not proven neutral |
| Reserved same proposed SKU | `NM4/211730220005` → `NM4/211730220005-001` | Reservation variation; changes include size/discount |

Across all records:

- All **1,436** actual successor SKUs differ from their source.
- **1,003** change schema-version ID.
- **1,398** have different stored old/new final UAH prices.
- Stored physical weights agree across every pair; immutable payload weight comparisons also found no changes where present.
- **259** actual successor SKUs differ from their proposed SKU.
- **25** propose the exact source SKU before reservation forces another identifier.
- The three SV cases are the only observed lost manual-name pairs.

The repair tool must reproduce a complete per-pair manifest containing both IDs/SKUs, category, terminal descendant, snapshot matches, inferred indicators and change evidence. Do not replace that manifest with these representative examples when executing repair.

## 11. Forward repair

### Procedure

1. Enter a controlled maintenance window for lifecycle activation.
2. Parse retained snapshot CSVs using the repository’s CSV semantics, including quoted cells and multiline fields.
3. Match exact SKUs to permanent product identities.
4. Validate row counts, artifact membership and duplicate Main/EN representation.
5. Insert immutable sidecar membership evidence; never alter stored snapshots or artifacts.
6. Build and review a manifest for all existing product states and correction lineages.
7. Repair only terminal active successors.
8. Classify confirmed-exposed and ambiguous cases into visible holds.
9. Release verified first-delivery candidates into durable pending state.
10. Preserve archived and superseded rows.
11. Record actor, manifest hash, evidence, before/after state and reason.
12. Re-run the read-only inventory and verify every affected active successor has a pending obligation or actionable hold.

The manifest must be version-checked at apply time. Changed products, names, lineage, snapshot evidence or disposition invalidate the affected entry. Replaying an already applied identical entry produces no duplicate mutation/audit event.

### Concrete repair: 4502 → 4848

For correction 1436:

- Keep 4502 corrected, excluded and permanently reserved.
- Keep 4848 active with SKU `SV23150004`; do not allocate another SKU.
- Retain weight `1260.000`, answer `1260`, price `21700.00` and schema 6.
- Restore both saved manual subjects from 4502, provided 4848 still has null subjects and the manifest matches.
- Record that restoration as a new repair action; do not rewrite correction 1436 or the original name audit.
- Create full revision 1, unconfirmed, with normal first-delivery disposition.
- Clear 4848’s recount-created exclusion.
- Verify it appears in New preview even when a test cursor is above 4848.
- Confirm only a new snapshot actually representing 4848.

The restored source names contain UX-audit wording. Preserve that evidence exactly during repair; the operator must approve or replace the wording before a real production-facing export. Do not invent production names.

The original 4085–4845 preview remains unchanged. A fresh preview may include 4848 through its durable obligation.

If evidence of external exposure or independent exclusion is discovered, the same repair command puts 4848 on an explicit hold rather than guessing.

### Why other repair shortcuts are insufficient

- Clearing exclusion alone loses behind-cursor products.
- Rewinding the cursor risks unrelated re-export.
- Rewriting a snapshot falsifies historical evidence.
- Reactivating the source violates lineage.
- Allocating another successor creates another identity problem.
- A manual re-export without durable pending state leaves undiscovered cases unresolved.

## 12. Field inheritance policy

| Field | Policy |
|---|---|
| Manual Magento UA/EN subjects | **Must inherit together.** Never copy a rendered name containing the old SKU. |
| Name review | **Must require review** when real SKU-semantic answers, category or schema change, or inheritance safety cannot be established. Representation-only/informational edits with unchanged identity evidence preserve approval. |
| Informational answers | **Must inherit** omitted values; apply explicit patches and current validation. |
| SKU answers | **Must rebuild and validate** against the target published schema. |
| Target-hidden/obsolete SKU answers | **Must clear** according to the existing recount cleanup rules; preserve genuine zero values. |
| Hidden/non-SKU historical answers | Preserve existing semantics; do not broaden cleanup merely because a field is absent from today’s form. |
| Weight | **Must recompute/validate** through the authoritative target rules; never infer it from display formatting alone. |
| Calibration | **Must preserve distinct states**, including state 2; target validation remains authoritative. |
| Calculated/automatic pricing | **Must recompute** with existing meanings and dependency signatures. |
| Manual price decisions | **Must require an explicit applicable decision** or the persisted request decision. Do not silently carry an old override onto a changed configuration. |
| Custom USD/gram basis | Persist only when selected by the authorized request decision; preserve provenance. |
| SKU schema version | **Must use the target active published schema** for recount; informational edits retain their existing schema. |
| New SKU/base/sequence/variation | **Must recompute/reserve** through existing primitives. |
| Repricing ownership metadata | **Must clear** obsolete batch ownership from the new product. |
| Export state/revisions | **Must initialize independently.** Inherit exposure risk through lineage, not predecessor confirmation counters. |
| Creator | Successor creator is the authenticated applying/completing user. Original creator stays on the source. |
| Correction/audit attribution | **Must preserve** source links, reason, actor and old/new evidence transactionally. |
| Archive attribution/legacy-zero exemption | **Must not inherit** onto a new active positively priced successor. |

Add a server-owned inherited-name review flag. Existing name preview/apply may confirm an unchanged inherited pair only when that review is pending. Otherwise retain current no-change rejection.

Include copied names and review state in recount signatures. The current generic product signature omits the name columns, so copying names without extending binding would permit stale inheritance.

## 13. Schema and migration proposal

Add two tables, one product review flag, snapshot lifecycle provenance and one permission.

### `product_full_export_state`

One row per product:

| Column | Definition |
|---|---|
| `product_id` | Integer PK, FK to `products`, delete restricted |
| `revision` | Bigint, initially 1, positive |
| `confirmed_revision` | Bigint, initially 0; `0 <= confirmed_revision <= revision` |
| `delivery_version` | Positive bigint CAS counter for routing/reconciliation changes |
| `route` | `normal`, `replacement`, `hold`, `retired` |
| `hold_reason` | Nullable constrained reason: historical ambiguity, prior exposure, intentional exclusion, invalid lineage |
| `source_correction_id` | Nullable FK to `product_corrections`; unique when present |
| `evidence` | JSONB object containing classification/repair references, not copied CSV bodies |
| `repair_manifest_hash` | Nullable validated SHA-256 hex |
| `last_resolution_key` | Nullable unique command key for immediate safe resolution retries |
| `created_at`, `updated_at` | Timestamps |
| `resolved_by_user_id`, `resolved_at` | Nullable local-user FK/time |

Constraints enforce route/reason consistency and counter bounds. Add pending-route/product and held-reason/product indexes.

Full revisions advance for informational/name payload changes. Delivery versions advance for routing/review changes. Neither counter may regress.

### `export_snapshot_products`

Exact immutable membership:

| Column | Definition |
|---|---|
| `snapshot_id` | Text FK to `export_snapshots`, delete restricted |
| `product_id` | Integer FK to `products`, delete restricted |
| `sku_at_capture` | Exact immutable captured SKU |
| `full_revision` | Positive bigint for new qualifying full captures; nullable for historical evidence |
| `delivery_version` | Captured version for new lifecycle captures; nullable for historical evidence |
| `capture_kind` | Qualifying full-product capture or legacy compatibility evidence |
| `evidence_origin` | Live capture or verified stored-CSV backfill |
| `evidence_hash` | Hash of the stored evidence used |
| `recorded_at` | Sidecar insertion timestamp |

Primary key: `(snapshot_id, product_id)`. Add `(product_id, snapshot_id)` for exposure and lineage queries.

Reject UPDATE, DELETE and TRUNCATE. Historical backfill timestamps must describe when evidence was indexed, not fabricate its original capture time.

A deferred integrity check verifies complete membership for newly marked lifecycle snapshots. New product commits must also have their ledger row; use a deferred constraint trigger so product and state can be inserted in either necessary statement order within one transaction.

### Other additions

- `products.magento_name_review_required BOOLEAN NOT NULL DEFAULT FALSE`
- Nullable immutable `export_snapshots.full_product_lifecycle_version`
- `exports.reconcile` permission
- Supporting lineage lookup indexes if absent

Use existing immutable audit events for repair and reconciliation history; no third repair-history table is needed.

### Historical and fresh paths

- Fresh database: ordinary save/recount immediately creates state; every new snapshot writes exact membership.
- Existing database: migration creates conservative baseline state for existing products; unresolved active products start held, corrected/archived rows retired.
- A separate manifest-driven repair command imports historical membership and classifies baseline states before traffic resumes.
- Historical membership without a captured full revision establishes exposure but cannot falsely acknowledge today’s payload.
- New internal compatibility CSVs may establish exposure, but must not discharge an obligation for a qualifying full Magento product artifact.

Migration and repair are separate transactions and separately verifiable. Migration 039 must not contain guessed production eligibility changes.

## 14. Correction-request parity and preserved invariants

Request creation, claim, release and refresh do not create products or export obligations.

Refresh recomputes:

- Target validity and pricing evidence.
- Source state and manual-name inheritance.
- Lineage exposure and expected delivery route.

Completion invokes the same transactional recount primitive as direct apply. Product, correction, request completion, full-product state and audits either all commit or all roll back.

Concurrent duplicate completion retains one successor and one obligation. Same-user/same-epoch completed retries preserve current behavior. Release/reclaim or stale signature conflicts cannot consume an export obligation.

Preserved invariants:

- Server authority, authentication, active-user gating, RBAC and CSRF.
- Permanent reservation and no SKU reuse.
- Immutable published schemas.
- Target-based recount validation and target-hidden SKU answer cleanup.
- Genuine zero/calibration semantics.
- Existing pricing meanings and positive-or-absent matrix rules.
- Final-state validation, transactional audit and claim epochs.
- Immutable snapshot/artifact bytes.
- Idempotent creation/confirmation and monotonic cursor.
- Independent price-export revisions.
- Spreadsheet formula neutralization.
- Session ownership/membership and completed-attempt recovery.

Intentional refinements:

1. Dual exclusion becomes source exclusion plus evidence-based successor routing.
2. The cursor no longer defines whether first delivery is owed.
3. Full informational/name changes gain their own revision acknowledgment.
4. New exact membership supplements historical conservative exposure.
5. New recount previews bind inheritance and delivery consequences.

## 15. Regression and acceptance plan

Extend the existing recount, corrections, exports, Magento, template/session and migration suites.

| Case | Required assertion |
|---|---|
| 1. Never-exposed source corrected | Source retired; successor pending; one correction and one obligation |
| 2. Successor above cursor | Included in first-delivery preview/capture |
| 3. Successor behind cursor | Still included; cursor never rewinds |
| 4. Confirmed source | Successor visibly held; generic range cannot bypass reconciliation |
| 5. Generated-only source | Potential exposure hold; old confirmation cannot acknowledge successor |
| 6. SKU-changing correction | New reservation and correct delivery classification |
| 7. Informational correction | Existing in-place rules preserved; full revision advances |
| 8. Equivalent-value case | Real SV reproduction repaired through successor lifecycle; no new weight bypass |
| 9. Weight change | Target SKU/pricing recalculated and captured correctly |
| 10. Request completion | Same outcome as direct recount, with ownership/epoch protection |
| 11. Correction versus capture | Independent PostgreSQL connections; both winner orders |
| 12. Correction versus confirmation | Both winner orders; no lost obligation or unsafe release |
| 13. Repeated/out-of-order confirmation | Only captured revisions acknowledged; one first-confirm audit |
| 14. Excluded/archived products | No accidental delivery; exclusions remain visible and intentional |
| 15. Manual names | Paired inheritance, changed-semantic review, stale-name conflict, exact final SKU rendering |
| 16. Price consequences | Initial full price correct; later price revisions remain independent |
| 17. Ambiguous history | Cursor/range/flag alone never authorizes first delivery |
| 18. Existing-data repair | Above/below-cursor cases, immutable snapshots, dry-run/apply/retry and stale manifest |
| 19. Low-ID late commit | Higher-ID confirmation cannot skip the later-committing product |
| 20. Older file after metadata edit | Full revision N confirmation leaves N+1 pending |
| 21. Same proposed SKU/variation | Actual new identity follows exposure policy |
| 22. Repeated correction chain | Ancestor exposure reaches terminal successor |
| 23. Failures | Inject ledger, member, artifact, request and audit failures; assert total rollback |
| 24. Permissions/sessions | Reconciliation capability, disabled users, CSRF and private-session disclosure boundaries |
| 25. Compatibility | Historical stored-key retries, old snapshots and immutable publication bindings |
| 26. Migration | Fresh, 038 checkpoint, repeated startup, failure rollback, unchanged historical checksums/bytes |

Real races must use independent connections/processes and synchronization barriers proving overlap. Assert final database rows, revisions, lineage, audit counts and artifact bytes.

Update the existing exclusion characterization test into a correctness regression when the lifecycle switches. Do not retain assertions that approve the blocker.

Run narrow tests first, then required server unit/lint/integration and client test/lint/build checks, followed by `git diff --check` and status.

Use only the canonical disposable `postgres-test` service. The HOST port may be overridden locally with an external Compose override. On this workstation, 55432 is in a Windows excluded TCP range; use the established override at host `127.0.0.1:56432` with database `amber_test`. Do not change Windows exclusions or commit a workstation-specific shared Compose port. Verify `current_database()` through the actual connection ends exactly in `_test` before destructive setup, and stop `postgres-test` afterward, including on failure. If this service cannot start, report that infrastructure failure; do not use the restored `amber` database or another PostgreSQL instance.

## 16. Incremental implementation and rollout

| Phase | Areas and behavior | Verification/data implications | Rollback boundary |
|---|---|---|---|
| **0 — Evidence and foundation** | Save this design, add reproducible read-only per-pair inventory and classifier tests | Reproduce all counts; retain current blocker characterization | No production behavior/data change |
| **1 — Lifecycle primitive** | Add migration, ledger/membership service, save/recount integration, name inheritance and capture/confirmation support | Migration and transaction/race tests; synthetic data only | Keep release blocked; do not enable partially implemented selection |
| **2 — Request and in-place parity** | Bind refresh/completion, informational/name revisions and updated signatures | Direct/request parity, old-claim compatibility, stale evidence, audit rollback | Pending requests may require refresh; completed requests stay readable |
| **3 — Existing-data repair tooling** | CSV evidence indexing, manifest generation/apply and reconciliation commands | Dry-run restored copy; approve exact repair manifest separately | Before live writes, ordinary rollback remains possible; after writes, preserve ledger/evidence |
| **4 — Export/UI integration** | Queue-based New selection, update/replacement/held views, stored warnings and explicit release | Legacy/template/shared-session parity; rendered tests and operator acceptance | No mixed-version application rollout |
| **5 — Acceptance and deployment** | Maintenance-window migration, evidence indexing, baseline classification and scoped repair | Full checks, invariant audit, fresh artifacts and operator Magento validation | After activation, use forward fixes or a ledger-aware rollback build; never return to cursor-only behavior |

Deployment must be coordinated across server instances. Do not run old writers against an activated lifecycle schema.

Operational acceptance requires:

- Every active product has lifecycle state.
- Every affected active successor is pending or has a visible actionable hold.
- No unexposed pending row disappears when cursor advances.
- New snapshots have complete exact membership.
- Archived/corrected rows cannot be newly exported.
- No full confirmation clears a later full or price revision.
- Historical bytes and SKU reservations remain unchanged.

Expose held counts and oldest pending age in the existing operator status surface. No background process should silently release holds or confirm exports.

## 17. Business risks, remaining evidence and deferred UX

### Decisions and alternatives

| Decision | Alternative and risk | Selected recommendation |
|---|---|---|
| First delivery | Manual release for every correction adds unnecessary operator work | Automatic only with reliable unexposed evidence |
| Exposed source | Automatic successor export risks duplicate listings; aliasing adds another identity system | Recorded replacement reconciliation |
| Neutral correction | Broad in-place mutation requires a much larger dependency proof | Existing narrow allowlist only |
| Names | Clearing loses operator work; blind inheritance can preserve a misleading description | Inherit with semantic-change review |
| Pending coverage | Successor-only handling leaves ordinary cursor gaps | All newly saved products |
| Post-generation metadata | Manual guidance alone can be forgotten | Separate full-product revisions |

### Remaining operational evidence

These are execution gates, not unresolved architecture choices:

- Whether each ambiguous historical lineage already exists in Magento.
- Whether retained historical export evidence is complete for a proposed automatic repair.
- Which old SKUs/files have actually been retired or verified absent.
- Which real production UA/EN subjects should replace local UX-audit/test wording.
- Whether another migration occupies number 039 before implementation.

Unknown cases remain held and visible. No historical actor, import, deletion or exclusion intent is fabricated.

### Deferred UX note

Keep this separate from the correctness implementation:

```text
Назва експорту
[ ... ]

Товари
[ Нові товари | Один SKU | Діапазон | До останнього ]

Правила експорту
[ Системний профіль | Опублікований шаблон ]

Якщо шаблон:
[ шаблон / версія ]
```

UUIDs and exact internal identities belong under Technical details. This polish must not obscure pending corrections, holds or exact stored-operation recovery.

## Recommended next implementation PR

**“Add exact export-exposure classification and reproducible recount repair inventory.”**

Implement the read-only exposure classifier and per-pair manifest, with focused fixtures proving that cursor position, `has_product_snapshot` and empty `reexport_revisions` cannot substitute for exact membership.

Include the 4502 → 4848 case, a confirmed ancestor chain, generated-only exposure and a behind-cursor ambiguous successor. Preserve the existing blocker regression and production behavior in this first PR.

Its acceptance criterion is a trustworthy, repeatable evidence layer for the lifecycle migration and repair—not a claim that the release blocker is already fixed.

## 18. Phase 0 actual results — 2026-09-26

### Delivery boundary and provenance

The approved architecture above was copied in full from the accepted plan. Only its status, the explicit incremental-delivery boundary and the stale Windows test-port paragraph were adjusted; the architecture and selected business decisions remain intact. This section records implementation evidence separately from the future design.

**Phase 0 implemented; Phase 1 not started. The release blocker remains reproduced.** No migration 039, full-product state/membership tables, runtime route wiring, new delivery semantics, repair command, reconciliation workflow, Magento-name inheritance or client change was added.

Implementation remains on `feature/magento-export-constructor`, HEAD `8d5656a6893b4fb165157729c4b89a6914908faa`. The existing 49 modified tracked files and 6 untracked files were preserved. This phase adds 10 files and adds one module registration to the already modified integration entrypoint. Its existing recount-exclusion registration and the blocker test itself remain unchanged. No files were staged, committed or pushed. Migration inventory remains 39 files, `000`–`038`.

### Implemented components

| File | Responsibility |
|---|---|
| `server/src/services/export-exposure/csv-reader.js` | Strict reader for retained CSV evidence; existing CSV serialization is unchanged |
| `server/src/services/export-exposure/evidence.js` | Pure evidence parsing, exact SKU membership, integrity checks, inference indicators, classification and canonical hashing |
| `server/src/services/export-exposure/manifest.js` | Complete correction graph, ancestor/terminal analysis, stored-payload diff, deterministic manifest and summaries |
| `server/src/services/export-exposure.service.js` | Read-only PostgreSQL loader with an injected pool; no startup or business-service initialization |
| `server/scripts/inventory-correction-exposure.js` | Diagnostic CLI; requires an expected database name, emits JSON to stdout and closes its pool |
| `server/test/fixtures/export-exposure.js` | Focused synthetic evidence fixtures, including the reproduced identifiers |
| `server/test/export-exposure.test.js` | CSV, exact/weak evidence and damaged-evidence characterization |
| `server/test/correction-exposure-manifest.test.js` | Real-case fixture, complete ancestry, deterministic output, malformed lineage and loader failure characterization |
| `server/integration-test/00-export-exposure.cases.js` | Real PostgreSQL read-only/repeatable-read, concurrent writer, CLI determinism and no-write checks |
| `server/integration-test/critical-flows.test.js` | Registers the new cases in the existing sequential fixture lifecycle |
| `docs/RECOUNT_EXPORT_CORRECTNESS_PLAN.md` | Approved architecture plus these Phase 0 results |

The loader uses one acquired connection and begins with:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
```

It selects `current_database()`, verifies the supplied expected name, and reads projections from `products`, `product_corrections`, `export_snapshots`, `magento_export_artifacts`, `product_export_revisions`, `export_events` and `export_state`. It sets the transaction's timezone to UTC for deterministic timestamp formatting. All evidence is loaded from the same PostgreSQL snapshot. It commits a read-only transaction on success, rolls back on failure and always releases the connection.

There is no startup, seed, migration, audit write, classification write-back, `FOR UPDATE` or `FOR SHARE`. The CLI imports the configured pool only after validating its arguments. It has no HTTP endpoint and is not imported by runtime commands.

### Exact evidence hierarchy and classification

The scope string is `retained_database_evidence`. A confirmation is not a Magento import receipt, and this module cannot establish unrecorded imports or the completeness of deleted history.

1. Parse the retained normal snapshot's internal CSV, matching exact SKU spelling against products. Also accept the exact spelling produced by the existing formula-neutralizing serializer; do not strip arbitrary apostrophes or normalize identities.
2. Parse retained Magento artifacts and cross-check their SKU set against the internal CSV. A product's Main/EN pair represents one product. Preserve both row references as evidence without counting them as two products.
3. Record positive `reexport_revisions` references as supplementary evidence and check them against stored CSV membership. They do not replace exact membership. An empty array is valid and says nothing about the other products represented in that snapshot.
4. Record cursor position, `has_product_snapshot`, snapshot-range inference and legacy `export_events` separately as historical indicators. None proves exact exposure or confirmation.

The CSV reader supports BOM, quoting, escaped double quotes, CRLF/LF, multiline cells, trailing empty cells and a final record terminator. It rejects unterminated quotes, embedded unquoted quotes and unexpected content after closing quotes. Evidence validation covers headers, column/row counts, product resolution, duplicate product rows, artifact Main/EN structure, artifact product counts/category, parent/artifact membership agreement and contradictory upper bounds.

| Class | Decision rule | Primary reason code |
|---|---|---|
| `reliably_unexposed` | No exact membership, unresolved inference indicators or integrity issues in the evaluated product/ancestor chain | `NO_EXPOSURE_IN_RETAINED_EVIDENCE` |
| `generated_exact` | Exact generated membership, no confirmed membership and no integrity conflict | `GENERATED_STORED_MEMBERSHIP` |
| `confirmed_exact` | Exact confirmed membership and no integrity conflict | `CONFIRMED_STORED_MEMBERSHIP` |
| `historical_ambiguous` | Inference without exact membership, or unresolved evidence/lineage integrity | `INFERRED_HISTORY_WITHOUT_EXACT_MEMBERSHIP` or `EVIDENCE_INTEGRITY_UNRESOLVED` |

Integrity problems take precedence over proposed classification; positive row references remain visible. Broken snapshot evidence conservatively affects potential members bounded by its immutable upper ID, while a missing/contradicted upper bound cannot constrain uncertainty. A bound or cursor is never treated as positive membership. Graph validation detects missing products/correction edges, mismatched links or stored SKUs, duplicate edges, branching/merging and cycles, including pointer-only cycles without correction rows. It fails closed across the affected connected lineage.

Product exposure is distinct from lineage exposure: a successor can lack its own exact membership while its logical lineage has a confirmed ancestor. Pair ancestry runs through that pair's source/successor; terminal-successor entries evaluate the complete ancestor chain. All discovered terminal active descendants are inventoried, including malformed pointer-only or branching cases.

### Manifest format and reproduction

Format identifier: `amber-correction-exposure-manifest-v1`.

The manifest contains:

- Database name, evidence scope/limitations, cursor and export-state evidence.
- Every retained normal snapshot, file identity/hash/count, exact member references, positive revision references and integrity diagnostics.
- All projected product rows with direct exposure classification, state, exclusion, cursor relationship, stored answers, weight/price, schema version and manual-name evidence.
- Every correction pair, category, source/successor IDs and SKUs, terminal descendant/candidates, complete ancestor chain, ancestor exposure and pair-lineage classification.
- Full stored correction rows, including old/new payloads, reason, price delta, actor attribution and stored timestamp; a deterministic JSON-pointer diff preserves type differences and missing/null/zero distinctions. It does not assert semantic equivalence or authorize a repair.
- Every terminal active successor, all contributing correction IDs and full ancestor exposure.
- Separate inference indicators and snapshot/lineage integrity diagnostics, overall/category summaries and canonical-content SHA-256.

`exact[]` carries `productId`, SKU, snapshot ID/status, evidence kind, artifact group/profile where applicable and `csvRecord`. Records are one-based including the header; a multiline cell does not increase the CSV record number. Snapshot/file IDs and hashes identify the retained source of each reference.

Records use stable ID ordering; object keys use ordinal canonical ordering. JSON payload arrays retain their original order. `contentSha256` hashes compact canonical JSON **excluding the hash field itself**. Serialization produces canonical, two-space-indented JSON with a final LF. No run timestamp, random identifier, local path or process timezone is added. Stored database timestamps are retained, with timestamptz values rendered in UTC and timestamp-without-timezone values not assigned an invented timezone.

Run from `server/`, with the normal configured local database connection. `--database-name` must match the actual connection. Keep full evidence outside the repository. The Phase 0 local reproduction used Node 20.20.2 and PowerShell native stdout redirection:

```powershell
$node20 = Join-Path $env:TEMP 'amber-phase72-node20/node-v20.20.2-win-x64/node.exe'
$reportDir = Join-Path $env:TEMP 'amber-recount-export-phase0-20260926'
New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
& $node20 scripts/inventory-correction-exposure.js --database-name amber > (Join-Path $reportDir 'manifest-1.json')
if ($LASTEXITCODE -ne 0) { throw 'Read-only inventory failed' }
& $node20 scripts/inventory-correction-exposure.js --database-name amber > (Join-Path $reportDir 'manifest-2.json')
if ($LASTEXITCODE -ne 0) { throw 'Repeated read-only inventory failed' }
Get-FileHash (Join-Path $reportDir 'manifest-1.json'), (Join-Path $reportDir 'manifest-2.json') -Algorithm SHA256
```

The command itself emits UTF-8; when using an older shell that re-encodes native redirection, capture stdout without transcoding before comparing file hashes. The integration test compares the CLI's actual stdout bytes as decoded UTF-8 under two process timezones.

Actual restored `amber` results:

- Both full manifests are byte-identical: **49,136,678 bytes** each.
- Canonical `contentSha256`: `bdac18b815e034af0b6ffdaef5b5166075c78dfd6ca628add97bf44e37a5bbe6`.
- SHA-256 of each complete UTF-8 JSON file: `8f7c86715652e86bc61c11b3c0789ad0878aafc4694a75879acbc33d15b3a5b1`.
- Files are outside the repository under `%TEMP%/amber-recount-export-phase0-20260926/`.
- Five retained snapshots parsed successfully: four confirmed with 136 internal rows / 134 distinct SKUs, and one generated with 40 internal rows. Nine Magento artifacts were cross-checked. All five `reexport_revisions` arrays were empty.
- Cursor remains **4063**. There are 27 legacy export events. Snapshot and lineage integrity diagnostic lists are empty.

### Reproduced inventory

Every previously reported aggregate reproduced; there is no discrepancy to repair or reinterpret.

| Group | All correction pairs | Active excluded successors |
|---|---:|---:|
| Total | 1,436 | 997 |
| Immediate source has exact confirmed membership | 28 | 6 |
| Immediate successor has exact confirmed membership | 0 | 0 |
| Neither immediate row has exact confirmed membership | 1,408 | 991 |
| Either immediate row has exact generated membership | 0 | 0 |
| Successor ID above cursor | 658 | 557 |
| Successor ID at/below cursor | 778 | 440 |
| Confirmed ancestor / `confirmed_exact` lineage | 50 | 28 |
| `generated_exact` lineage | 0 | 0 |
| `historical_ambiguous` lineage | 1,382 | 965 |
| `reliably_unexposed` lineage | 4 | 4 |

There are **997 distinct terminal active successors**. The other immediate successors in the pair inventory are 430 corrected and 9 archived. “Neither immediate row has exact confirmed membership” does **not** mean “never exported”; ancestor and historical evidence remain decisive.

| Category | Pairs | Active excluded | Above cursor | At/below cursor | Confirmed ancestor | Ambiguous | Reliably unexposed |
|---|---:|---:|---:|---:|---:|---:|---:|
| BR | 359 | 279 | 4 | 275 | 0 | 279 | 0 |
| CH | 138 | 131 | 131 | 0 | 0 | 131 | 0 |
| KL | 138 | 113 | 113 | 0 | 28 | 85 | 0 |
| NM | 798 | 471 | 306 | 165 | 0 | 470 | 1 |
| SV | 3 | 3 | 3 | 0 | 0 | 0 | 3 |

The last five columns describe active excluded successors. The four unexposed lineages are corrections **1152, 1434, 1435, 1436**, ending at products **4512, 4846, 4847, 4848**. Their full evidence is retained in the manifest, not replaced by examples in this document.

### Four key evidence examples

| Example | Actual retained evidence | Result |
|---|---|---|
| Correction 1436: 4502 / `SV23150003` → 4848 / `SV23150004` | No exact membership, no cursor/range/flag/legacy indicators or integrity issues in the chain; successor remains active/excluded | `reliably_unexposed` |
| Corrections 1207/1408: 3883 / `KL2/11141350005` → 4570 / `KL2/11141251005` → 4780 / `KL3/11141351005` | Ancestor 3883 is CSV record 5 of confirmed snapshot `55582ac6-3d47-4719-b2d1-56eb2ad5cafd`; immediate predecessor alone would miss it | `confirmed_exact` for terminal lineage |
| Product 4806 / `BR5/11111111061` | Generated snapshot `f958dfc0-0ee0-4dd1-9413-14c0eaa4faee`, internal CSV record 2, BR artifact Main/EN records 2/3; no confirmed membership | `generated_exact` |
| Correction 1: 1208 / `BR11384452017` → 2847 / `BR11184452017` | Both behind cursor 4063; exposure flags and legacy ranges (events 14 and 27); no exact membership | `historical_ambiguous` |

The restored generated example is an ordinary product, not an invented correction lineage: the actual correction inventory has zero generated-only lineages. Synthetic unit and PostgreSQL fixtures separately verify generated-only ancestor/correction behavior.

### Verification and PostgreSQL setup

Verification uses repository-targeted **Node 20.20.2**. All destructive setup and integration fixtures use the dedicated canonical **`postgres-test`** PostgreSQL **16.15** service. The harness verifies the connected database's `_test` suffix before resetting the schema; the actual connection was also explicitly checked as `amber_test` before running the suite.

The shared Compose configuration was not edited. The already existing external override is `%TEMP%/amber-ux5-20260926/compose.test.yml`:

```yaml
services:
  postgres-test:
    ports: !override
      - "127.0.0.1:56432:5432"
```

```powershell
# From repository root; no Windows exclusion changes.
$override = Join-Path $env:TEMP 'amber-ux5-20260926/compose.test.yml'
docker compose -f docker-compose.yml -f docker-compose.local.yml -f $override up -d postgres-test
# Wait for TCP readiness of the final server, not the initdb Unix-socket server.
docker compose -f docker-compose.yml -f docker-compose.local.yml -f $override exec -T postgres-test pg_isready -h 127.0.0.1 -U amber_test -d amber_test
$env:TEST_DATABASE_URL = 'postgresql://amber_test:amber_test_local_only@127.0.0.1:56432/amber_test'
# Verify current_database() on this connection before destructive setup.
# From server/, using Node 20 on PATH:
node --require ./test/setup-env.js --test test/export-exposure.test.js test/correction-exposure-manifest.test.js
node --test --test-concurrency=1 --test-name-pattern='exposure inventory|recount export exclusion reproduction' integration-test/critical-flows.test.js
npm test
npm run lint
npm run test:integration
# In a finally block, from repository root:
docker compose -f docker-compose.yml -f docker-compose.local.yml -f $override stop postgres-test
```

The canonical service is `postgres-test`; its HOST port can be safely overridden locally. Host 55432 is unavailable on this workstation due to a Windows excluded TCP range. Host **56432** was used throughout, and the test service is stopped after verification. No alternate database instance was used. Existing checkpoint/import tests also remain confined to disposable databases created by the established harness on this same test service.

Focused tests cover all eight requested characterization cases plus CSV syntax/row-count/member/artifact failures, serializer-safe SKU matching, contradictory bounds, complete ancestry, missing nodes/edges, branching, cycles, pointer-only cycles, raw diff semantics and order-independent output. PostgreSQL tests establish real overlapping reader/writer transactions on distinct backend PIDs: the reader retains old product and snapshot state while the writer commits both changes; a subsequent manifest sees both new values. Another test proves PostgreSQL rejects a write in the loader's transaction, and before/after retained-table snapshots confirm the inventory/CLI did not mutate data. CLI wrong-database rejection, pool closure and timezone-independent deterministic output are covered.

The unchanged blocker regression still proves that recount excludes the active successor, loses its manual-name pair under current behavior, omits it from refreshed/explicit/new exports, and allows a later confirmation to advance the cursor past it.

Final verification results:

| Check | Result |
|---|---|
| Focused classifier/manifest unit tests | **31/31 passed** |
| Focused PostgreSQL classifier/manifest + unchanged blocker regression | **4/4 selected cases passed** (205 unrelated cases skipped by name filter) |
| Full server unit suite, including relevant export/recount/correction tests | **547/547 passed** |
| Full sequential PostgreSQL integration suite, including relevant export/recount cases and the blocker | **209/209 passed**, zero skipped in the full run |
| Server lint | **0 errors**, 2 existing `no-unused-vars` warnings in unchanged `src/presenters/product-timeline.js:391` (`sortOrder`, `sourceOrder`) |
| `git diff --check` | Passed; existing Git LF/CRLF conversion warnings do not represent whitespace errors |
| Restored inventory replay | Two byte-identical full manifests, expected aggregates reproduced |
| Test service shutdown | `postgres-test` stopped in the verification command's `finally` block |

After the final pointer-only-cycle and nullable historical-endpoint guards were added, focused unit tests, full server unit/integration suites and lint were rerun. A null historical source stays null, fails closed, and cannot remove an active terminal successor from the manifest. The final classifier also reproduced the same restored manifest bytes/hash.

One repeated test-service startup initially returned `Connection terminated unexpectedly` during `initdb`; the actual-database guard stopped the run before destructive setup and the service was stopped. Logs confirmed initialization timing. The same canonical service/port was then started, TCP readiness was verified with `pg_isready -h 127.0.0.1`, and the actual `amber_test` name was verified again before the successful final run. No alternative environment was used.

All application test Node processes used the repository-targeted Node 20 runtime. Logs are outside the repository under `%TEMP%/amber-recount-export-phase0-20260926/`. No client suite was run because Phase 0 changes no client files.

Final worktree inventory: **49 modified tracked files, 16 untracked files, 0 staged**. Of the untracked files, 6 predate Phase 0 and 10 were added by it. The only previously tracked file edited in this phase is the integration entrypoint, which was already modified at the baseline. Branch and HEAD are unchanged.

### Remaining blocker and next boundary

Useful restored data was read only. No exclusions, lineage, names, prices, correction requests, snapshots, artifacts, cursor, revision state, migrations or production behavior were changed by Phase 0. This evidence does not authorize automatic repair, establish actual Magento import history or make a held product exportable.

**Recommended next implementation scope: Phase 1, separately reviewed — the forward ledger/membership migration and transactional lifecycle primitive.** Use this classifier/manifest as evidence input, preserve the approved lock order and immutable snapshot/price-stream boundaries, and add the planned migration/race tests. Do not use this Phase 0 PR to start that migration, switch selection/confirmation, release a hold or repair the four unexposed lineages. The accepted architecture above remains the design for those later changes.
