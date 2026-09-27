# Documentation consolidation — 2026-09-27

Historical maintenance record. [Current documentation index](../../README.md) defines navigation; this inventory does not duplicate domain authority.

## Inspection baseline before edits

- Branch: `main`.
- HEAD: `6d7ab5309f872e21a841de42a4c5c655b9c297cc`.
- `git status --short`: one unrelated untracked file, `?? scripts/amber-20260926T225117Z.dump`; preserved without reading/restoring it.
- Documentation: 25 Markdown files; no other repository-owned `.txt`, `.rst` or `.adoc` files in the inventory. Dependencies/build output excluded.
- Migrations: 41 SQL files, consecutive `000`–`040`; exact names are maintained in the [migration inventory](../../DATABASE_MIGRATIONS.md#migration-inventory). No migration changed.

## Classification of every original Markdown file

Each original path has exactly one category. Sections may be extracted without changing the containing file’s current-reference role.

| Original path | Category | Final location |
| --- | --- | --- |
| `AGENTS.md` | A — current authoritative | [Current location](../../../AGENTS.md) |
| `PROJECT_CONTEXT.md` | A — current authoritative | [Current location](../../../PROJECT_CONTEXT.md) |
| `README.md` | A — current authoritative | [Current location](../../../README.md) |
| `client/README.md` | A — current authoritative | [Current location](../../../client/README.md) |
| `docs/AUTH_RBAC.md` | A — current authoritative | [Current location](../../AUTH_RBAC.md) |
| `docs/DATABASE_MIGRATIONS.md` | A — current authoritative | [Current location](../../DATABASE_MIGRATIONS.md) |
| `docs/EXPORTS.md` | A — current authoritative | [Current location](../../EXPORTS.md) |
| `docs/EXPORT_RECOUNT_INVESTIGATION_2026-09-26.md` | C — historical record | [Current location](../investigations/EXPORT_RECOUNT_INVESTIGATION_2026-09-26.md) |
| `docs/EXPORT_TEMPLATES_PR4.md` | C — historical record | [Current location](../exports/EXPORT_TEMPLATES_PR4.md) |
| `docs/EXPORT_TEMPLATES_V1_PLAN.md` | C — historical record | [Current location](../exports/EXPORT_TEMPLATES_V1_PLAN.md) |
| `docs/EXPORT_UX_ACCEPTANCE_AUDIT_2026-09-26.md` | C — historical record | [Current location](../ux/EXPORT_UX_ACCEPTANCE_AUDIT_2026-09-26.md) |
| `docs/EXPORT_UX_ACCEPTANCE_AUDIT_POST_UX5_2026-09-26.md` | C — historical record | [Current location](../ux/EXPORT_UX_ACCEPTANCE_AUDIT_POST_UX5_2026-09-26.md) |
| `docs/EXPORT_UX_REDESIGN_PLAN.md` | C — historical record | [Current location](../ux/EXPORT_UX_REDESIGN_PLAN.md) |
| `docs/FULL_PRODUCT_CUTOVER_RUNBOOK.md` | B — current operational runbook | [Current location](../../FULL_PRODUCT_CUTOVER_RUNBOOK.md) |
| `docs/OPERATIONS.md` | A — current authoritative | [Current location](../../OPERATIONS.md) |
| `docs/PRICING.md` | A — current authoritative | [Current location](../../PRICING.md) |
| `docs/README.md` | A — current authoritative | [Current location](../../README.md) |
| `docs/RECOUNT_CORRECTIONS.md` | A — current authoritative | [Current location](../../RECOUNT_CORRECTIONS.md) |
| `docs/RECOUNT_EXPORT_CORRECTNESS_PLAN.md` | C — historical record | [Current location](../exports/RECOUNT_EXPORT_CORRECTNESS_PLAN.md) |
| `docs/REPRICING.md` | A — current authoritative | [Current location](../../REPRICING.md) |
| `docs/SHARED_EXPORT_SESSIONS.md` | A — current authoritative | [Current location](../../SHARED_EXPORT_SESSIONS.md) |
| `docs/SKU_CATALOG.md` | A — current authoritative | [Current location](../../SKU_CATALOG.md) |
| `docs/archive/REFACTOR_2026.md` | C — historical record | [Current location](REFACTOR_2026.md) |
| `server/integration-test/README.md` | A — current authoritative | [Current location](../../../server/integration-test/README.md) |
| `server/test/fixtures/magento-v1/README.md` | A — current authoritative | [Current location](../../../server/test/fixtures/magento-v1/README.md) |

## Consolidation decisions

Eight existing historical files were moved (seven from `docs/`, plus the prior refactor archive). No document was classified D (safe deletion) or E (whole-file merge/removal): uncertain or unique evidence was retained.

- Template administration, publication, editor, source support and signed binding were extracted from `EXPORTS.md` into current `EXPORT_TEMPLATES.md`.
- The old cutover runbook was preserved as historical rehearsal evidence before the current runbook was made independent of fixed counts/hashes.
- Dated local launch, Magento Check Data and fixture characterization evidence were extracted into historical records; their current source guides remain maintained.
- Root context was condensed; current exports/recount/database/RBAC guides replace phase-status contradictions with gate-dependent semantics. Current rules belong to their domain guides; old plans remain evidence.
- The user-reported fresh 4,978-product rehearsal is distinct from the retained 4,817-product record. Neither is a production-state claim. Production activation and per-case attestations remain pending.

New files are classified A: `docs/EXPORT_TEMPLATES.md`, `docs/archive/README.md` (archive navigation). New historical evidence files are classified C: this record, `HUMAN_ACCEPTANCE_2026-09-24.md`, `MAGENTO_CHECK_DATA_2026-09-23.md`, `MAGENTO_V1_CHARACTERIZATION_2026-09-23.md`, and `FULL_PRODUCT_CUTOVER_REHEARSAL_2026-09-27.md` in their linked archive groups. All other final documents retain their table classification.

## Verification boundary

Implementation inspection covered migrations 000–040, SKU/recount target handling, price modes, repricing transaction boundaries, export/price/template/session routes and services, full lifecycle/selection, evidence/indexing/cutover/reconciliation, startup, Compose and CI. No database connection or production operation was needed. Existing unit/integration cases were inspected as contract evidence; expensive suites were not run for this documentation-only change.

Fresh rehearsal counts, deployed production/provider settings, external manifests and manual/Magento acceptance cannot be independently established from repository code. They are labeled user-reported or operationally pending. The rehearsal helper still hard-codes four historical simulation IDs and old policy wording; the current runbook documents that limitation without changing runtime code.

Markdown paths/fragments, moved-name references, endpoint/permission names, migration inventory and documentation-only scope are checked before handoff. Historical dates, findings, test counts and rejected alternatives are preserved; only headers and navigation references change in moved records. No staging, commit or push is part of this task.

Final checks: 213 local Markdown links (including fragments) resolve; all 41 migration names match the inventory and migration contents match HEAD with canonical line endings; all 33 RBAC catalog keys and 52 documented full/relative endpoint occurrences match repository contracts. All eight moved bodies retain their original wording except link destinations. No current guide or runtime/test source retains a broken moved-path reference. Remaining old path strings are intentional historical status/file registers and this original-path inventory. No documentation-specific package check exists; no runtime test or test-path change was required. `git diff --check` and supplemental new-file whitespace checks pass.

Final scope: 32 Markdown files in the repository; 13 existing current files updated, eight historical files moved, seven additional documentation files created, and no unique document deleted. Git shows the moves as unstaged deletions plus untracked destinations until staging; nothing is staged. The pre-existing dump remains untracked and untouched. Runtime code, tests, SQL/migrations, dependencies, Compose/workflows, configuration and business behavior are unchanged.
