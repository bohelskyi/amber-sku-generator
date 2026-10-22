# Amber SKU Manager documentation

Canonical index. Current code and migrations define behavior; these guides explain
contracts and procedures. Archived records are dated history, not current behavior.

## Start here

1. [Project context](../PROJECT_CONTEXT.md): architecture, capabilities, deployment status.
2. [AGENTS](../AGENTS.md): engineering guardrails, verification and safe test databases.
3. [Root README](../README.md): local startup and Docker quickstart.

## Domain references (contracts)

| Guide | Scope |
| --- | --- |
| [SKU and catalog](SKU_CATALOG.md) | Schema versions, semantic IDs, calibration, preview/save/decode, permanent SKU reservation. |
| [Manager product workflows](MANAGER_PRODUCT_WORKFLOWS.md) | Native characteristics, create/recount/archive flows, pre-save article reservations. |
| [Pricing](PRICING.md) | Matrices/modifiers, exchange rate, rounding, calculated/automatic/manual prices. |
| [Recount and corrections](RECOUNT_CORRECTIONS.md) | Target validation, lineage, correction requests, stale evidence. |
| [Repricing](REPRICING.md) | Drafts, authoritative preview, atomic apply and rollback. |
| [Exports](EXPORTS.md) | Export lifecycle, immutable membership, acknowledgment, price stream, CSV retirement. |
| [Export templates](EXPORT_TEMPLATES.md) | Template API, editor, immutable publications, template-level catalog fixes. |
| [Shared export sessions](SHARED_EXPORT_SESSIONS.md) | Private/shared workflows, invitations, attempts and recovery. |
| [Authentication and RBAC](AUTH_RBAC.md) | OIDC, sessions, active-user/CSRF boundary, permissions. |
| [Database and migrations](DATABASE_MIGRATIONS.md) | Runner, forward-only rule, lock order, migration inventory 000–083. |
| [Operations](OPERATIONS.md) | Topology, deployments, health, shutdown, backup/restore, audit. |
| [Application UX](APPLICATION_UX.md) | Navigation, shared UI primitives, terminology, acceptance boundaries. |

Product lifecycle details: [photos](PRODUCT_PHOTOS.md), [archive/restore visibility](PRODUCT_LIFECYCLE.md),
[reviewed catalog deletion](REVIEWED_CATALOG_DELETION.md), [integration tasks](PRODUCT_INTEGRATION_TASKS.md),
[historical reactivation (standard protocol)](HISTORICAL_STANDARD_REACTIVATION.md),
[TEST products](NATIVE_TEST_PRODUCTS.md).

## Magento integration

| Guide | Scope |
| --- | --- |
| [Magento integration](MAGENTO_INTEGRATION.md) | Bindings, categories, successor/publication (H3a/H3b), option creation (H4), recovery. |
| [Automatic sync](MAGENTO_AUTOMATIC_SYNC.md) | Sync requests, jobs, worker, eligibility, test-product deletion. |
| [First-sync fields](MAGENTO_FIRST_SYNC_FIELDS.md) | First-sync projection, decisions, receipts, admissions. |
| [Magento attributes](MAGENTO_ATTRIBUTES.md) | Controlled attribute creation and set membership. |
| [Scoped option label adapter](MAGENTO_SCOPED_OPTION_LABEL_ADAPTER.md) | External label adapter contract. |

## First sync operations (current campaign)

Start with the **[first-sync runbook](FIRST_SYNC_RUNBOOK.md)**: order of work, CLI
index, publication side effects and traps. Per-tool details:

- [History admission batch](FIRST_SYNC_HISTORY_BATCH.md), [retained export disposition](RETAINED_EXPORT_DISPOSITION.md)
- [CH decisions and keep-local batch](FIRST_SYNC_CH_DECISIONS.md)
- [Temporary legacy SV retain_remote](FIRST_SYNC_RETAIN_REMOTE.md)
- [Name completion batch](NAME_COMPLETION_BATCH.md), [initial names](FIRST_SYNC_INITIAL_NAMES.md), [campaign names adapter](FIRST_SYNC_CAMPAIGN_NAMES.md)
- [Local discovery](FIRST_SYNC_LOCAL_DISCOVERY.md), [local authority batch](FIRST_SYNC_LOCAL_BATCH.md), [exact-SKU campaign](FIRST_SYNC_CAMPAIGN.md)
- [SV classification](FIRST_SYNC_LOCAL_CLASSIFY.md), [SV campaign](SV_CAMPAIGN.md)

## Other runbooks

- [Operator CLI index](CLI_SCRIPTS.md): tracked entry points, modes and per-tool safeguards.
- [Reviewed canonical weight repair](CANONICAL_WEIGHT_REPAIR.md)
- [Reviewed bulk correction requests](CORRECTION_REQUEST_BATCH.md)
- [Full-product cutover](FULL_PRODUCT_CUTOVER_RUNBOOK.md): only for installations not yet cut over; production is done.

Technical references: [client development](../client/README.md),
[serialized PostgreSQL tests](../server/integration-test/README.md),
[synthetic Magento fixtures](../server/test/fixtures/magento-v1/README.md).

## Open work

- Finish the first sync per category (SV, CH, KL, BR, NM, then silver); see the runbook.
- Remove legacy SKU dependencies after the mass sync ([retain remote](FIRST_SYNC_RETAIN_REMOTE.md)).
- Account-onboarding invitations are not implemented ([RBAC](AUTH_RBAC.md#correction-ownership-and-remaining-gap)).
- Magento attribute/set mutation, complex option types and `url_key` generation remain deferred ([integration](MAGENTO_INTEGRATION.md)).
- Infrastructure policy (DB exposure, image upgrades, non-root containers, backup schedule/retention/encryption) remains separate operational work ([operations](OPERATIONS.md)).
- Manual UX evidence for 200% zoom and second-account collaboration ([audit](archive/ux/EXPORT_UX_ACCEPTANCE_AUDIT_POST_UX5_2026-09-26.md#що-ще-потребує-оператора)).

## Historical archive

[Archive index](archive/README.md): plans, audits, investigations, rehearsals and
dated review records. Do not execute an archived runbook as a current procedure.
