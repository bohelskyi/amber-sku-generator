# Server CLI index

Inventory of all **61 JavaScript files in `server/scripts/`: 50 executable entry
points and 11 support modules**. The linked parsers and services define the exact
arguments and checks. This index describes this checkout, not which commit is
installed in an operator's container. Read the linked domain procedure before a
mutation; the presence of a command is not approval to run it.

## Invocation and evidence

Run from `server/` as `node scripts/NAME.js ...`. A matching `npm run` alias, when
present, is listed in [server/package.json](../server/package.json); put arguments
after `--`. In a matching server image the path is `/app/scripts/NAME.js`.
[Dockerfile](../server/Dockerfile) copies the server build context, and
[.dockerignore](../server/.dockerignore) does not exclude `scripts/`. Repository
scripts therefore ship with that image; host-only scripts do not.

The interfaces are not uniform: a positional `preflight`, `--mode preview` and
absence of `--apply` have different meanings. Likewise, `--actor-id` and
`--actor-user-id`, `--expected-hash`, `--plan-hash`, `--plan-sha256` and
`--confirm-plan-hash` are not interchangeable. Tables identify the mode and key
inputs, not a complete copy-paste command. Use the linked parser for all required
flags. Actor IDs name local application users; a token/hash does not replace the
service's current authority check. Some offline read tools require database
access without a local actor.

Read-only below means no business-data mutation; evidence files may still be
created, and Magento GETs may still access the configured remote installation.
Some canonical review paths use an ordinary pool to take locks. Do not assume
every preview uses a PostgreSQL read-only pool, every apply is token-based, or
every tool has an `--expected-database` flag. Verify the configured database and
Magento target before use. Do not use `--help` as a universal safe probe:
`audit-data-integrity.js`, for example, runs its audit and only recognizes
`--json`. This inventory was checked by reading code, without executing commands.

Keep inputs, reviewed plans and journals outside the repository and on persistent
storage. New-output and resume rules are command-specific; stdout output is not
automatically a durable journal. Container `/tmp` is not retained across container
replacement. An uncertain write needs receipt reconciliation, not blind replay.

## Reviewed recovery, names, scope and resync

These four wrappers share `--mode preview|apply --input FILE --output NEWFILE
--expected-database NAME --actor-id ID`. Apply additionally requires `--plan-hash
SHA256` and the saved preview as input; preview rejects that flag. Every wrapper
requires an active Administrator plus the permissions below. Preview uses a
read-only PostgreSQL pool; any Magento access is GET-only in both modes. Scope
never accesses Magento. Outputs are new files, not overwritten or resumed.

| Entry point | Preview input / permission | Scope and apply effect |
| --- | --- | --- |
| [recover-skus.js](../server/scripts/recover-skus.js) | `{"skus":["EXACT_PUBLIC_SKU"],"reason":"Reviewed recovery"}`; `exports.reconcile` | 1–50 exact current public SKUs; original UI `stable_recount_exposure` reviews/hashes. Apply processes eligible rows, preserves blocked/unavailable/error rows, and can record a local handoff; no direct Magento write. |
| [names-batch.js](../server/scripts/names-batch.js) | `{"items":[{"sku":"EXACT_PUBLIC_SKU","productId":123}]}` or recovery preview / legacy `.jsonl`; `exports.create` | 1–50 exact pairs. Recovery inputs select only blocked `DURABLE_REMOTE_ID_REQUIRED` rows. Equal name pairs retain Amber; otherwise the reviewed choice is Magento. Apply reuses each original token and can stage ordinary sync requests; this is not missing-name completion. |
| [scope-from-skus.js](../server/scripts/scope-from-skus.js) | `{"skus":["EXACT_PUBLIC_SKU"]}`; `export_templates.view` | 1–100 exact current public SKUs. Both modes use a read-only pool; apply rechecks identities and creates a JSON scope with `items` and an embedded completion `journal`. No Magento configuration or access. |
| [controlled-resync.js](../server/scripts/controlled-resync.js) | `{"reason":"Reviewed handoff","items":[{"sku":"EXACT_PUBLIC_SKU","productId":123}]}` or `reason` plus `scopeFiles`; `export_templates.manage`, `export_templates.publish`, `exports.view` | At most 100 distinct current products, from at most 100 scope files of 1 MiB each. Relative files resolve beside the input JSON. Apply uses the saved current-publication revision, exact scope, reason and token; blockers reject the whole action. Records local `broader_resync` handoff; the ordinary worker delivers separately. |

Treat any deployment between preview and apply as invalidating the plan: create
and review a new preview. Changed implementation bytes, database target or Magento
origin are rejected automatically with `OPERATOR_CONTEXT_CHANGED`; an identical
redeploy is not a separately tracked event. Do not run apply while another mass
operation is in progress. This is an operator coordination rule, not a global
concurrency gate in the wrappers. See the [reviewed-wrapper procedure](FIRST_SYNC_RUNBOOK.md#reviewed-operator-wrappers)
for authority, review, journals, drift and uncertain outcomes.

## Diagnosis and read-only inventory

| Entry point | Interface / key inputs | Behavior |
| --- | --- | --- |
| [audit-data-integrity.js](../server/scripts/audit-data-integrity.js) | Optional `--json` | Local duplicate/missing SKU and saved-price audit; configured pool, stdout; no target-name flag or preview/apply modes. |
| [inventory-correction-exposure.js](../server/scripts/inventory-correction-exposure.js) | `--database-name NAME` | Read-only correction/exposure manifest to stdout; checks the exact database name. |
| [inventory-recount-repair.js](../server/scripts/inventory-recount-repair.js) | `--database-name NAME` | Read-only recount repair manifest to stdout; no repair is applied. |
| [magento-auto-status.js](../server/scripts/magento-auto-status.js) | `--expected-database NAME`, optional `--expect-disabled` | Local read-only activation/request/publication status; explicit `DATABASE_URL`, no `.env` loading, HTTP or worker startup. |
| [magento-first-sync-optional-audit.js](../server/scripts/magento-first-sync-optional-audit.js) | Optional `--limit 1..500`, either `--session UUID` or `--after-session UUID` | Local saved-receipt audit; explicit `DATABASE_URL`, bounded read-only snapshot. Exit 2: blockers; 3: truncated without blockers; empty exact-session output is not delivery acceptance. |
| [magento-probe.js](../server/scripts/magento-probe.js) | Optional `--sku`, `--store-code`, repeated `--attribute-set` / `--attribute` (up to 20 each) | Magento GET-only transport/metadata probe; no raw response dump. |
| [magento-schema-audit.js](../server/scripts/magento-schema-audit.js) | Optional `--store-code`, `--output` | Magento GET-only schema discovery; no product/DB access; exclusive new JSON artifact. |
| [magento-binding-evidence-audit.js](../server/scripts/magento-binding-evidence-audit.js) | Optional `--mode compatibility`, `--template-version selected\|ID`, `--output` | Read-only PostgreSQL plus bounded Magento GET sampling; new artifact. Also exports shared read-only-pool helpers. |
| [magento-sync-preview.js](../server/scripts/magento-sync-preview.js) | Exactly one of `--sku` / `--product-id`; optional `--binding-revision`, `--template-version`, `--store-code` | Read-only Amber snapshot and Magento GETs; new `.artifacts/magento/` report; no apply mode. A completed blocked preview can exit 0: inspect `sendable` and blockers. |

See [Operations](OPERATIONS.md), [Magento integration](MAGENTO_INTEGRATION.md) and
[first-sync fields](MAGENTO_FIRST_SYNC_FIELDS.md) for the corresponding contracts.

## Bindings, templates and explicit category creation

| Entry point | Commands / key inputs | Mutation boundary |
| --- | --- | --- |
| [magento-bindings.js](../server/scripts/magento-bindings.js) | `bootstrap`, `clone`, `extend`, `review`, `approve-exact`, `approve`, `block`, `validate`, `publish`; action-specific `--revision`, `--expected-revision`, `--actor-user-id`; optional `--json` | Review/validate read; other actions change local bindings/templates through services. Magento stays GET-only. `publish` is not a substitute for reviewed successor publication: a new successor requires the H3b workflow below. |
| [magento-binding-transfer.js](../server/scripts/magento-binding-transfer.js) | `export`, `import`, `verify`; `--expected-database`; import uses `--artifact`, `--expected-hash`, `--installation`, `--actor-user-id` | Export/verify do not mutate business data. Import creates/reuses a local template publication and a new binding draft, with GET drift checks; it does not publish the binding. Optional import-only `--reconcile-target-source-support` is demotion-only. |
| [magento-binding-carry-forward.js](../server/scripts/magento-binding-carry-forward.js) | `preflight` / `apply`; database and `--actor-user-id`; source/target revisions for preflight; `--plan` / `--expected-hash` for apply | Reviewed decisions into the target draft only; bounded Magento GET verification; no publication or activation. |
| [magento-successor-prepare.js](../server/scripts/magento-successor-prepare.js) | `--mode preview\|apply`; database, `--actor-id`, `--source`, `--template-version`; category/per-group sample or exclusive `--skus` (up to 100); apply `--preview-token` | Previews then creates an unpublished successor draft. Default category sample is SV, 12 per group; explicit SKU scope replaces it. No direct delivery. |
| [magento-carry-unchanged-reviews.js](../server/scripts/magento-carry-unchanged-reviews.js) | `--mode preview\|apply`; database, `--actor-id`, `--source`, `--draft`, `--group`, `--targets`, `--reason` | Re-approves only identical eligible decisions, sequentially, with current draft CAS. No plan-token flag; no publication/handoff or Magento writes. |
| [magento-publication.js](../server/scripts/magento-publication.js) | `--mode preview\|apply`; database, `--actor-id`, `--draft`; apply `--preview-token`; loss requires `--ack-coverage-loss REASON` | H3b review then atomic binding publication **and exact handoff**. Remote review is GET-only; an enabled ordinary worker can subsequently deliver products. |
| [magento-category.js](../server/scripts/magento-category.js) | Default preview: `--revision`, allowlisted `--path`; apply adds `--apply`, `--expected-revision`, `--actor-user-id` | Explicit bounded Magento category creation and local binding; can perform a remote write. No recursive creation, product write or publication. |
| [sv-optional-characteristics.js](../server/scripts/sv-optional-characteristics.js) | `--mode preview\|apply`; database, `--actor-id`, `--binding-revision`, `--expected-definition-hash` | Narrow reviewed SV optional-output transformation; preview compares active SV outputs, apply publishes a local template version. Binding successor/publication remains separate. This is not a general template editor. |

These commands have distinct review and authority contracts; see
[Magento integration](MAGENTO_INTEGRATION.md), [export templates](EXPORT_TEMPLATES.md)
and [first-sync binding changes](FIRST_SYNC_RUNBOOK.md#changing-bindings-or-the-template).

## Delivery and historical evidence

| Entry point | Commands / key inputs | Mutation boundary |
| --- | --- | --- |
| [magento-sync.js](../server/scripts/magento-sync.js) | `--sku`, `--binding-revision`, `--actor-user-id`; optional `--apply`; existing job: `--job UUID --actor-user-id ID --apply` | **Without `--apply`, still creates a local durable queued job.** With apply, can write Magento and verifies readback. Use `magento-sync-preview.js` for a read-only product review; no force/reset flag. |
| [magento-reconcile-exposure.js](../server/scripts/magento-reconcile-exposure.js) | Default preview / `--apply`; database and `--output`; single `--sku` or `--bulk --candidates`; apply `--plan`, `--expected-hash`, `--actor-user-id`; optional single-only `--stable-recount` | GET-only remote evidence; apply changes local reviewed exposure. Stable recount also records handoff. Bulk input bound is 5000; resume the same reviewed plan into a new receipt directory. |
| [magento-external-delivery.js](../server/scripts/magento-external-delivery.js) | Positional `preview` / `apply`; database/output; preview `--candidates`; apply `--plan`, `--expected-hash`, `--actor-user-id` | Exact Magento GET evidence, then local normal/replacement acknowledgment before API delivery cutover; no snapshot creation/confirmation or remote write. |
| [magento-delivery-cutover.js](../server/scripts/magento-delivery-cutover.js) | `preflight`, `apply`, `disable`; database and `--actor-user-id`; preflight/apply `--installation`; apply `--plan` / `--expected-hash`; disable `--reason` | Local activation and permanent retirement of new Magento product CSV; disable stops automatic dispatch but does not restore CSV. No direct Magento writes; activation permits later worker delivery. |
| [retained-export-disposition.js](../server/scripts/retained-export-disposition.js) | `--mode preview\|apply`, `--snapshot-id`, database; apply adds `--actor-user-id`, `--preview-token`, `--reason` | GET-only readback; records reviewed retained-file disposition and audit locally; JSON stdout. |

See [export lifecycle](EXPORTS.md), [automatic sync](MAGENTO_AUTOMATIC_SYNC.md)
and [retained export disposition](RETAINED_EXPORT_DISPOSITION.md). Local
acknowledgment is not a new Magento import.

## First-sync batches and campaigns

All commands in this table use `--expected-database` and `--actor-id`.
`--server-root` selects the installed server used by portable adapters where
supported; it is required by some parsers and defaults to the adjacent server in
others. Each linked guide defines the input JSON and journal/resume contract.
Magento transport is GET-only here, but local mutations may stage ordinary
automatic requests or explicit handoff; an independently running worker can
then write Magento.

| Entry point | Modes / distinguishing inputs | Scope and effect |
| --- | --- | --- |
| [first-sync-history-batch.js](../server/scripts/first-sync-history-batch.js) | `--mode preview\|apply`, `--input`, `--scope-sha256`, new `--output`; optional preview-only `--preview-all` and `--schema-cache-seconds` | 1–50 exact items; scoped history-admission audit, **no handoff/enqueue**. No automatic retry/resume. [Guide](FIRST_SYNC_HISTORY_BATCH.md). |
| [first-sync-campaign-history.js](../server/scripts/first-sync-campaign-history.js) | `--mode preview\|apply\|resume`, input/scope hash/output directory | 1–2000 candidates through the same admission adapter; retained per-SKU exceptions and receipt-aware resume, no direct enqueue. [Campaign](FIRST_SYNC_CAMPAIGN.md). |
| [first-sync-keep-local.js](../server/scripts/first-sync-keep-local.js) | `--mode preview\|apply`, input/output, `--server-root`, `--installation-key`, explicit `--targets`; apply-only `--allow-imports`; optional schema cache | Approved Amber-wins field choices. Fresh plans containing imports require the separate flag; no direct Magento writes. [Guide](FIRST_SYNC_CH_DECISIONS.md). |
| [first-sync-retain-remote.js](../server/scripts/first-sync-retain-remote.js) | `--mode preview\|apply`, input/output, `--server-root`, `--installation-key`; apply-only `--allow-imports`; optional schema cache | Narrow legacy SV retain-remote decisions; not a general conflict override. [Guide](FIRST_SYNC_RETAIN_REMOTE.md). |
| [name-completion-batch.js](../server/scripts/name-completion-batch.js) | `--mode preview\|apply\|resume\|status`; preview/apply require `--input` and new `--output`; resume/status reuse run directory | Completes missing paired Amber names from verified Magento names. Preview/status read; apply/resume may update local source and ordinary sync request. [Guide](NAME_COMPLETION_BATCH.md). |
| [first-sync-initial-names.js](../server/scripts/first-sync-initial-names.js) | `--mode preview`: input/scope hash; `apply` / `resume`: `--review` / `--review-sha256`; output directory | Sealed initial-name receipts with existing history admission. Canonical source changes may stage automatic requests. [Guide](FIRST_SYNC_INITIAL_NAMES.md). |
| [first-sync-local-discovery.js](../server/scripts/first-sync-local-discovery.js) | No mode flag; input, `--output-dir`, `--installation-key`; optional `--offset` / `--limit` | Read-only exact-SKU discovery; default 10, maximum 2000 per invocation; packets of at most 10. [Guide](FIRST_SYNC_LOCAL_DISCOVERY.md). |
| [first-sync-local-classify.js](../server/scripts/first-sync-local-classify.js) | No mode flag; input, `--output-dir`, `--installation-key`; optional `--offset` / `--limit` | Read-only exact SV classification, not delivery approval. [Guide](FIRST_SYNC_LOCAL_CLASSIFY.md). |
| [first-sync-local-batch.js](../server/scripts/first-sync-local-batch.js) | `--mode preview\|apply`, input/output; apply requires `--plan-sha256` and preview file as input | One packet of 1–10 products; canonical local choices and reviewed initial imports; imports may stage automatic requests. [Guide](FIRST_SYNC_LOCAL_BATCH.md). |
| [first-sync-campaign-preview.js](../server/scripts/first-sync-campaign-preview.js) | No mode flag; input/scope hash, `--discovery-manifest`, `--output-dir`, `--installation-key` | Read-only sealed review of completed discovery packets; no apply or enqueue. [Guide](FIRST_SYNC_CAMPAIGN.md). |
| [first-sync-campaign-names.js](../server/scripts/first-sync-campaign-names.js) | `--mode preview\|apply\|resume`, `--review`, `--review-sha256`, output, `--installation-key` | Only sealed name-only selections; no direct enqueue; source changes can stage ordinary automatic requests. [Guide](FIRST_SYNC_CAMPAIGN_NAMES.md). |
| [first-sync-campaign.js](../server/scripts/first-sync-campaign.js) | Default runner: `--mode apply\|resume`, review/hash/output/installation. Leading `--stage discovery\|history\|review\|choices` delegates to the matching adapter | Exact canonical local choices; no imports or direct handoff. Delegated stage accepts that adapter's arguments, not a common mode set. [Guide](FIRST_SYNC_CAMPAIGN.md). |
| [sv-campaign.js](../server/scripts/sv-campaign.js) | `--mode run\|resume`; input and `--input-sha256`; `--classification`, `--classification-sha256`, `--expected-count`, output/server root/installation; optional `--classifier-blocked-policy skip-known-v1` | Up to 2000 exact items; history, names, fields and **controlled outbound handoff**. Local writes and subsequent automatic delivery are possible; no preview mode. [Guide](SV_CAMPAIGN.md). |
| [legacy-answer-recount-batch.js](../server/scripts/legacy-answer-recount-batch.js) | `--mode preview\|apply`, input/new output; apply `--plan-hash` | Up to 50 SKUs; UI recount followed by stable-recount exposure/handoff. Stops on first error. [Guide](RECOUNT_CORRECTIONS.md#reviewed-legacy-answer-recount-batch). |

Use the [first-sync runbook](FIRST_SYNC_RUNBOOK.md) for the order of work; do not
infer a delivery authorization from a classification or history receipt.

## Local repair, bootstrap, cutover and import

| Entry point | Commands / key inputs | Scope and effect |
| --- | --- | --- |
| [bootstrap-admin.js](../server/scripts/bootstrap-admin.js) | `--user-id ID` | Offline, permanently one-use first-Administrator bootstrap for a verified local identity; local mutation, no preview mode. [RBAC](AUTH_RBAC.md#first-administrator-bootstrap). |
| [canonical-weight-repair.js](../server/scripts/canonical-weight-repair.js) | `--mode preview` (default), `rollback-preview`, `apply`; database/installation/binding/`--actor-user-id`/output; apply `--plan`, `--confirm-plan-hash`, `--product-ids`; rollback-preview `--receipt-ids` | Reviewed weight repair or rollback plan. Preview source is `recorded-answer` or `magento-readback`; the latter uses Magento GET review and an ordinary pool for canonical locks. Apply writes locally. [Guide](CANONICAL_WEIGHT_REPAIR.md). |
| [sv-readiness-repair.js](../server/scripts/sv-readiness-repair.js) | Default preview: database, binding, output; `--apply`: database, plan, `--expected-hash`, `--actor-user-id`, new receipt directory | Local reviewed historical SV readiness repair; no `--mode` option. [Guide](RECOUNT_CORRECTIONS.md). |
| [correction-request-batch.js](../server/scripts/correction-request-batch.js) | `preflight`, `select`, `apply`; explicit scope or `--all-active --limit`; apply uses plan/hash **and** selection/hash | Read-only preflight, offline selection, sequential existing claim/refresh/complete. Resume same evidence into a new receipt directory. [Guide](CORRECTION_REQUEST_BATCH.md). |
| [public-sku-activation.js](../server/scripts/public-sku-activation.js) | `preflight` / `apply`; database, `--actor-user-id`; preflight output; apply plan/`--expected-hash` | Reviewed local stable-public-identity activation; not an ordinary deployment step. [Catalog](SKU_CATALOG.md). |
| [legacy-sku-repair.js](../server/scripts/legacy-sku-repair.js) | `preflight` / `stage`; database, `--actor-user-id`; preflight decisions/output; stage plan/`--expected-hash` | Historical schema-045 checkpoint **before 046**; stages only reviewed duplicates/split identities. Not a current-schema general repair command. |
| [full-product-cutover.js](../server/scripts/full-product-cutover.js) | Two positional files: `command.json result.json`; explicit `DATABASE_URL`; JSON `action`, `expectedDatabase`, `actorUserId` | Actions: `prepare`, `index-manifest`, `cutover-manifest`, `amendment-manifest`, `index`, `approve`, `batch`, `validate`, `activate`, `status`, `review`, `resolve`, `business-exclusion`. Mutating actions require the existing reviewed procedure; exclusive new result file. [Guide](FULL_PRODUCT_CUTOVER_RUNBOOK.md). |
| [migrate-sqlite-config-to-postgres.js](../server/scripts/migrate-sqlite-config-to-postgres.js) | `--sqlite=PATH`, optional `--pg=URL` (otherwise `DATABASE_URL`), explicit `--replace` | Imports configuration/pricing and schema snapshots, not product history; writes PostgreSQL. Refuses implicit replacement and replacement with products. Requires `sqlite3`, a dev dependency absent from the normal `npm ci --omit=dev` image. Run from a prepared operator checkout. [Operations](OPERATIONS.md#integrity-audit-and-sqlite-import). |

## Disposable-only historical measurement tools

These are not ordinary operator procedures. Their fixed fixtures/checkpoints
must not be generalized to a live installation.

| Entry point | Interface / exact scope | Behavior |
| --- | --- | --- |
| [benchmark-magento-publication.js](../server/scripts/benchmark-magento-publication.js) | Optional positional headroom `0` or `4096`; `DATABASE_URL` must target `127.0.0.1:55432/amber_wave2_scale_test` | Creates synthetic local actor/draft and optionally products; measures publication paths with fake Magento transport. No real HTTP. |
| [rehearse-full-product-cutover.js](../server/scripts/rehearse-full-product-cutover.js) | One positional new output directory; explicit `DATABASE_URL`, database name ending `_test`, restored migration-038 checkpoint | Runs the current migration runner, simulated cutover and fixed historical product assertions. Mutates the disposable database; simulated attestations are not operator approvals. |

## Support modules — not standalone commands

| Module | Used for |
| --- | --- |
| [operator-cli.js](../server/scripts/operator-cli.js) | Shared strict argument parsing, bounded input, read-only/GET-only runtime, actor/target/implementation-bound review hashes, exclusive output and flushed journals; no standalone CLI. |
| [operator-authority.js](../server/scripts/operator-authority.js) | Active-Administrator and permission checks through the UI services, rechecked at their existing authority-lock boundary; no global mass-operation lock. |
| [operator-scope.js](../server/scripts/operator-scope.js) | Exact public-SKU/current-product resolution and identity revalidation with strict scope bounds; rejects missing, duplicate, ambiguous and changed identities. |
| [exposure-bulk-receipt.js](../server/scripts/exposure-bulk-receipt.js) | Fresh-directory, fsynced receipt summaries for reviewed bulk operations. |
| [first-sync-initial-name-plan.js](../server/scripts/first-sync-initial-name-plan.js) | Exact initial-name scope and selection validation. |
| [first-sync-name-commit.js](../server/scripts/first-sync-name-commit.js) | Shared guarded canonical name-commit execution. |
| [magento-schema-read-cache.js](../server/scripts/magento-schema-read-cache.js) | Bounded cache for eligible schema GETs and TTL parsing; other requests pass through unchanged. |
| [sv-campaign-journal.js](../server/scripts/sv-campaign-journal.js) | Durable campaign journal, lock and resume validation. |
| [sv-campaign-outbound.js](../server/scripts/sv-campaign-outbound.js) | Exact local controlled handoff and receipt verification; the worker owns delivery. |
| [sv-campaign-policy.js](../server/scripts/sv-campaign-policy.js) | Campaign evidence/choice policy. |
| [sv-campaign-stages.js](../server/scripts/sv-campaign-stages.js) | Shared campaign runtime, stage execution and verification. |

Support modules are part of the reviewed tool implementation. Copying only the
entry point without its required companions is not an equivalent tool version.
