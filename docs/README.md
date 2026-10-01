# Amber SKU Manager documentation

The current pre-production UI/runtime review boundary is documented in [Wave 1 UX/runtime cleanup](UX_RUNTIME_WAVE_1.md). Catalog + Magento self-service remains the separately reviewed Wave 2.

This is the canonical documentation index. Current code and PostgreSQL migrations define implemented behavior; deployment data and operator evidence define environment-specific facts. Historical plans do not override the maintained guides.

## Start here

1. [Project context](../PROJECT_CONTEXT.md) — architecture, capabilities, implementation/deployment distinction.
2. [AGENTS](../AGENTS.md) — engineering guardrails and verification/safe test environments.
3. [Root README](../README.md) — local startup and Docker quickstart.

## Current domain guides

Each guide is the maintained authority for its domain; other documents summarize and link to it.

| Guide | Scope |
| --- | --- |
| [SKU and catalog](SKU_CATALOG.md) | Schema versions, semantic IDs, calibration, preview/save/decode, permanent SKU reservation. |
| [Pricing](PRICING.md) | Matrices/modifiers, rate handling, rounding, calculated/automatic/manual meanings and legacy zeros. |
| [Recount and corrections](RECOUNT_CORRECTIONS.md) | Target validation, lineage, inherited names/review, request parity/ownership, stale evidence. |
| [Repricing](REPRICING.md) | Drafts, authoritative preview, atomic apply and exact-state rollback. |
| [Exports](EXPORTS.md) | Gate-dependent lifecycle queues, immutable membership, acknowledgment, price stream and reconciliation semantics. |
| [Magento integration](MAGENTO_INTEGRATION.md) | Persistent bindings, explicit category flow, durable direct sync/verification, first successful KL receipt and remaining-group review. |
| [Export templates](EXPORT_TEMPLATES.md) | Administrative API, editor, immutable publications, source support and signed capture binding. |
| [Shared export sessions](SHARED_EXPORT_SESSIONS.md) | Private/shared workflows, scoped invitations, access epochs, durable attempts and recovery. |
| [Authentication and RBAC](AUTH_RBAC.md) | OIDC, sessions, active-user/CSRF boundary, permission catalog and administration. |
| [Database and migrations](DATABASE_MIGRATIONS.md) | Migration/checksum policy, full inventory 000–050 and database protections. |
| [Operations](OPERATIONS.md) | Topology, ordinary deployments, health, graceful shutdown, backup/restore and integrity audit. |

Local technical references: [client development](../client/README.md), [serialized PostgreSQL tests](../server/integration-test/README.md), [synthetic Magento fixture maintenance](../server/test/fixtures/magento-v1/README.md).

## Current operational runbooks

- [Full-product cutover](FULL_PRODUCT_CUTOVER_RUNBOOK.md) — current until production activation and its separately reviewed reconciliations are complete. The machinery through Phase 3B / Phase 4 is implemented; production must use maintenance/freeze and fresh manifests. Rehearsal counts are explicitly separate from production facts.

## Historical archive

[Archive index](archive/README.md) groups export plans, UX audits, investigations and implementation/acceptance records. They preserve dates, old findings, rejected alternatives and test counts as historical evidence, **not current behavior contracts**. Current guides do not require reading them to understand the application.

The [consolidation inventory](archive/implementation/DOCUMENTATION_CONSOLIDATION_2026-09-27.md) classifies every original documentation file and records moves/extractions and the inspection baseline.

## Deferred work and operationally pending items

- **Production cutover and reconciliation:** fresh manifests, explicit baseline approval, activation and per-case external SKU/file/exclusion attestations. Backend tooling and queues are already implemented. See the [runbook](FULL_PRODUCT_CUTOVER_RUNBOOK.md).
- **Historical data quality:** duplicate SKUs, incomplete/ambiguous lineage, unknown exclusions and unapproved name/mapping data remain case-specific work. Cutover does not silently repair them. See [Exports](EXPORTS.md#acceptance-boundary).
- **Target template/Magento acceptance:** source/alias evidence, frozen business mappings (including KL zero semantics, narrow SV names and deferred AR values), measurement units and fresh controlled Check Data/import decisions. Existing template support, publication and recovery are implemented; an old successful Check Data run is not blanket acceptance.
- **Manual UX acceptance evidence:** the latest retained browser audit still leaves genuine 200% zoom and second-account collaboration scenarios unverified manually. Automated coverage and implemented UX are separate from this operational evidence gap; see the [audit](archive/ux/EXPORT_UX_ACCEPTANCE_AUDIT_POST_UX5_2026-09-26.md#що-ще-потребує-оператора).
- **Account-onboarding invitations:** not implemented. Scoped export-session invitations are implemented and grant no global rights; see [RBAC](AUTH_RBAC.md#correction-ownership-and-remaining-gap).
- **Magento integration and export retirement:** the [automatic workflow](MAGENTO_AUTOMATIC_SYNC.md) is implemented behind a default-disabled gate. Final production publication, activation, controlled remote acceptance and reconciled CSV retirement remain separate operator work. Attribute/option creation APIs and explicit `url_key` generation remain unimplemented; full export review is bounded, not server-streamed/windowed. See [Magento integration](MAGENTO_INTEGRATION.md) and [Exports](EXPORTS.md#planned-csv-retirement).
- **Infrastructure policy:** production database exposure, runtime/image upgrades and pin/update policy, non-root/read-only container work, backup scheduling/retention/encryption/off-host monitoring remain separate operational work. Current topology and backup boundaries are in [Operations](OPERATIONS.md).

These items do not reopen completed PR/phase implementations. The dated Magento review verifies one succeeded job and bounded live GET evidence; it does not revalidate production OIDC configuration or the historical CSV lifecycle rehearsal/cutover.
