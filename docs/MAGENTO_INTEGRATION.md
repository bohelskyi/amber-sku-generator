# Magento integration

## Category workspace

The category workspace shows the intended category/language/field edits and the
complete publication-package scope before review. A saved `reviewScope` projection
lists unresolved decisions in the current and other categories without another
binding read; unavailable scope is explicitly unknown. This snapshot does not
replace structural validation, product-impact review or final revalidation. The
sticky review/apply controls explain disabled actions and retain the global package
boundary. Checking saves an isolated draft and prepares an inactive rules version;
it is not a read-only action. No scoped apply bypasses unrelated package checks.

Product repair context includes the exact question and semantic value, including
zero. A uniquely attributable field opens directly; the exact value is highlighted
and moved into the first bounded mapping page without selection or approval.
Missing historical values are labelled as unknown local values with an ID. A safe
return link still opens the same Attention product after application; configuration
application alone never proves product delivery. Publication results remain visible
after application and reload of the saved binding/source address. Durable handoffs
distinguish pending enrollment, queued delivery and recorded Magento confirmation;
missing receipt timestamps remain unavailable.

Structural preparation explicitly offers an existing Magento resource or creation
of a missing resource through the existing controlled actions. Field ownership
explains its effect on existing products; generated names retain their separate
Administrator application and pinned-name rules. If the server advertises
`sources.nativeCharacteristicsUpgrade`, an explicit isolated-draft upgrade sends
the exact revision/hash and `targetContract: public-product-characteristics-v1`.
It neither publishes nor applies a binding until normal package review completes.

Identical initial/base category reads reuse one request. Different revision or
language/route contexts retain their original separate baseline read and fences.

Settings → **Інтеграція Magento** (`/admin/magento`) opens manager categories.
`?category=CODE` selects a category; `/categories/:categoryCode` also opens it.
The left navigation shows search and the number of current characteristics unused
in output rules. The centre separates characteristics from names/descriptions.
Unconnected fields stay in the main table; system and unsupported fields are
available through **Службові поля**. Counts distinguish connected, missing and
review-required fields.
Conditional routes have a readable set/condition selector. Search and all/unmapped/
review filters page at 30 rows. The selected field uses the shared lossless column
inspector beside the table, or a dialog on narrow screens.

The **Назва й описи** tab includes customer-facing text/textarea fields and UA/EN selection.
Known technical fields and observed native service attributes are disclosed separately;
weight and price remain characteristics even when Magento describes their input as text.
Standard name/description/SEO fields have Ukrainian labels. Optional literal-empty
outputs without a required binding say **Не заповнюємо**; they are omitted by the
existing transport, rather than treated as an unconfirmed mapping. Required empty
fields and actual unconfirmed bindings explain the exact next repair. **Що виправити**
opens that explanation; **Перевірити прив’язку цього поля** prepares an isolated
successor from the exact current source without requiring a dummy rule edit.
The initial review focuses on the selected field and its set; other unresolved
decisions remain explicitly reachable and still block publication.
**Категорії магазину** presents frozen category paths and their confirmation states
on the same screen. Attention repair links, including compatible placement URLs,
open this view and retain the exact product/return context. Resource creation stays
an explicitly opened advanced operation. The category links its operational count
to the category-filtered product problem queue.
The placement check appears above saved paths, explains confirmation and apply,
and distinguishes stored approvals from product readiness. A check opened from an
exact product problem passes that product's ID through both existing successor
prepare/apply requests, so its dynamic category outputs enter the review instead
of relying on the general sample. Reviewed carry still preserves unchanged bindings
of other products. Explicitly continuing a restored preparation also starts product
impact checking; restoring it alone remains read-only. After apply the retained
attention return directs the user to recheck the original product's remaining issues.
After confirming the focused placement, the review immediately exposes any remaining
fields in that category, then remaining decisions from other categories in the same
publication package. These rows name their manager category, including fields outside
the original placement focus; no extra disclosure is needed to reach the next blocker.
The preparation notice follows the current review step and the saved placement states
refresh after a decision. While the exact new draft counter is being read, the review
shows loading instead of reporting a false conflict. A genuinely different returned
counter still blocks decisions until the preparation is explicitly reread. Every
approval and final publication remains explicit; restoring work starts no automatic
product or remote checks.
Text editing opens directly, without codes, scope selection or an expression-mode
selector. Technical and advanced rules remain under **Розширені налаштування**.
Source insertion, shared-reference detachment and field-local mapping tables use
the existing template adapters. Guard-only reads and unused source declarations
do not count as transmitting a characteristic; text usage is labelled separately.
Exact option-label suggestions require confirmation; ambiguous labels never select
an identity automatically. Existing ownership is displayed in Ukrainian. Changed
ownership requires an explicit choice and reason in the prepared binding review.

Editing starts from the exact pinned publication. Saving creates a private template
family, preserving every other saved draft. Preparation validates and publishes an
immutable **inactive** template version, then creates a successor binding through
the existing proof/CAS procedure. Explicit option choices are saved with CAS into
that successor; approval, product examples and publication remain separate actions.
The main **Перевірити зміни** action saves and prepares the work. Once required
decisions are confirmed, it also requests the existing server product-impact preview
in the same session. Restoring a saved preparation does not auto-check products or
Magento; checking remains explicit after reload. Saving for later, structure refresh,
product examples and delivery-policy editing are secondary disclosures.
The review combines changed fields, unresolved decisions, server-calculated examples
and publication impact. **Застосувати зміни** uses the existing publication/handoff
boundary. Existing product names remain pinned. **Застосувати назви до чинних
товарів** opens the separate actual-Administrator workflow, filtered by category
on the server, with its existing exact selection, preview, confirmation and 100 limit.

Saved `ruleDraft`, `binding`, `source`, `route`, `language` and `field` URL identities
restore preparation after reload. Unsaved field input and category navigation are
guarded. A changed active publication or draft counter blocks stale writes without
replacing local input. Upgrading old template formats is an explicit existing command.

New authenticated, active-user-gated `export_templates.view` APIs:

- `GET /api/admin/magento-integration/categories/:categoryCode`
- `GET /api/admin/magento-integration/categories/:categoryCode/fields/:field`
- `POST /api/admin/magento-integration/categories/:categoryCode/observation`

The GETs accept only optional `bindingRevisionId`, `routeKey`, and `rowId` (`base`/
`english`), run in repeatable-read read-only transactions, and never evaluate products
or contact Magento. The category projection includes pinned rules, set membership,
sources, ownership/review states and observation date; option domains and review
entries are loaded only for the selected field. Explicit observation accepts the
same scope, performs bounded Magento GETs outside database transactions and verifies
the publication/draft identities again. It returns a live view without saving or
rewriting frozen bindings. Failed observation leaves the previous view/date intact.
The POST retains synchronizer-token CSRF. Resource creation and editing stay in the
existing advanced preparation and Administrator workflows.

## Self-service integration workspace (Wave 2)

**Стан доставки** (`/admin/magento/overview`) opens the attention-first
Overview. Automatic delivery enabled/disabled, recorded operational problems,
active publication, and available Magento structure observations are separate facts.
Enabled delivery is not a worker heartbeat or proof of successful delivery.
Observation age has no health threshold or color.

The default category list separates **Проблеми поточної доставки** from
**Підготовка перед використанням**. Unsupported categories say **Ще не підключено**;
reviewed refusals alone are not operational failures. **Усі категорії** opens full
browsing. Category details and mapping review mount only unresolved rows initially;
**Показати всі відповідності** opens collapsed source-question/target-attribute
groups, with search across question/option labels, source keys, and target Magento
attribute codes. At most 20 group headers and one expanded group of 50 values
mount per page; the default issue view still mounts at most 50 unresolved values.
Compatibility category details (`?tab=legacy`), placement and product tabs remain
available. Product readiness links carry an exact `?field=...` target into the
category field editor without making a decision or write.
Diagnostic evidence/history is
lazy-mounted. Repeated remote paths share one visual group without merging binding
decisions or exact action targets.

The workspace combines **Огляд**, categories/characteristics, **Правила товару**,
saved changes and history, with **Дії Адміністратора** separately controlled.
The rules editor now lives at `/admin/magento/rules/*`; old template URLs redirect
without changing publication semantics. Category detail reads the actual binding's
pinned template rather than inferring current rules from a newer publication or
legacy CSV selection. Preparation is a revisitable, task-specific workspace:
scope → necessary resources/rules → mappings → product checks → publication.
The active publication stays visible while a draft is inspected. Resource creation
does not refresh a frozen draft; prepare a fresh successor from the current published
source and re-review unpublished decisions not supported by existing carry rules.
Explicitly saved hypothetical CREATE examples retain their own inputs; publication
revalidates them. No article is allocated. Administrator label maintenance, generated
name application and broader resync are separate workflows.

`GET /api/admin/magento-integration/overview` adds a lightweight repeatable-read,
read-only local projection `{integration,categories}`. It makes no Magento call and
performs no sample product evaluation. Operational counts use distinct public product
identities from needs-attention requests and unfinished test deletions; they require
`products.view`, otherwise the projection reports unavailable rather than zero.
The structure timestamp identifies the latest available stored binding observation
for the configured origin/installation, or the current explicit discovery result in
the browser session. It is not persisted global discovery history. The active
publication's own observation remains available in technical details.

`GET .../creation-inputs?categoryCode=SV` uses the existing published product
configuration and creation requirements under `export_templates.manage` plus
`exports.view`. It does not grant ordinary product permissions or publish a schema.
The existing full integration/binding reads are loaded only by detail/configuration
workflows. No migration or server write-contract change accompanies these projections.

Normal visibility uses effective capabilities. Exact Administrator-only actions use
the existing authenticated immutable role key through the shared auth helper, with
all authoritative server checks retained. Delegated manage/publish users can open
read-only label comparison from category detail; it cannot attest or apply changes.

The existing authenticated `/api/admin/magento-integration` configuration read is a repeatable-read
local snapshot. Discovery is an explicit CSRF-protected GET-only remote operation
(`POST .../discovery`), bounded to 512 requests and 60 seconds per invocation;
limit/failure never produces a complete-success receipt. Attribute sets, membership,
attributes/options and full category paths are observations, not approved bindings.
Equal labels remain candidates and semantic `value_id` remains distinct from the
Magento option ID. Frozen observations retain their timestamps.

The full configuration read evaluates at most 100 current products and reports
the unchecked count separately; it does not claim remote sendability. Current-product
and prospective CREATE previews reuse the authoritative builder/evaluator/planner.
The hypothetical `AG-PREVIEW` identity never reserves a SKU, allocates an article,
saves a product or enqueues a job. Remote verification is sequential point-in-time
GET evidence, not an atomic Magento snapshot or a persistent reporting subsystem.

Read/discovery requires `export_templates.view`; product previews require both
`export_templates.manage` and `exports.view`. Existing role grants, auth, active-user,
CSRF and lifecycle boundaries are unchanged. The browser never calls Magento.

### Recorded product problems in the application workspace

**Потребує уваги** (`/attention`, compatible `/sync-problems`) opens recorded
product delivery problems directly. Historical correction requests are secondary
account-menu access, absent from this queue. Future configuration preparation is
not added to the operational problem count.

`GET /api/magento/problems/page` requires `products.view`, defaults to 30 rows,
caps at 100, and accepts `offset`, article search, exact category and reason-group
filters. `GET /api/magento/problems/:id` reads an exact selected product even when
it is off-page or no longer needs attention. Both use `products.view` and recorded
local sync/name/test-deletion evidence and returns `items` plus counted `pageInfo`;
it does not probe Magento or mutate a job. The original `/magento/problems` and
`/magento/summary` contracts remain available.

The client requests 20 rows, presents a compact queue and one selected detail,
and mounts name-conflict inspection only for the selected affected product.
Its `category`, `search`, `reason`, `offset` and `problem` parameters preserve context.
Visible-page polling remains non-overlapping; stale responses from another filter
cannot replace the current query. Failed reads retain an explicit unavailable or
last-known state. Opening a product additionally requires `products.decode`.
Technical diagnostics remain on demand, and uncertain writes retain their exact
domain reconciliation path without a generic resend action.
In the attention starting task, **Перевірити товар у Magento** explicitly reads the
original local recovery record and sequentially inspects its unfinished original job
or previews the server-recommended lifecycle decision. Mounting still makes neither
request. Inspection and recording/continuation remain separate confirmed actions.
History ambiguity is described as paused product synchronization, with the observed
Magento article and a concrete permitted decision. A successful job decision refreshes
local recovery context; it does not automatically preview another lifecycle decision.
The reviewed resync handoff opens inline for the exact product and category, retaining
the actual Administrator restriction and existing preview/apply protocol. The
controlled-products read accepts an optional parameterized positive `productId`
alongside `categoryCode`, so this view does not evaluate a page of unrelated products.

Historical recount recovery distinguishes changed public identities from stable
articles before recommending a decision. The bounded local recovery history reads
the actual connected correction component and same-identity users, not ancestor
hints. It returns at most 30 products and 30 correction records, with an explicit
incomplete flag. A missing lifecycle source-correction pointer is explained
separately from contradictory product links. Stable confirmation is not recommended
for changed identities, incomplete/inconsistent history, non-retired predecessors
or unresolved exclusion policies. Its existing preview/apply checks remain authoritative.

The separate `historical_recount_exposure` recipe handles a complete reciprocal
chain containing old public articles and migration-039 retired baseline rows.
Only those retired baseline rows may retain NULL source-correction pointers or
unknown business policies, with explicit operator attestation for the current
product. Contradictory links, modern missing pointers, independently excluded
ancestors, compatibility exclusions and non-retired predecessors remain blockers.
It does not rewrite any historical pointer, identity, SKU or exclusion policy.

Canonical cutover may have replaced a then-current migration baseline's evidence
with `origin: cutover` before a later recount retired it. Such a retired ancestor
qualifies only when its immutable approved cutover manifest and applied batch
receipt prove the exact migration-039 origin/coverage, unknown policy, NULL pointer,
internal SKU and unchanged cutover evidence. The active gate, manifest digest,
database, batch digest and exact product membership are verified; an origin label
alone is insufficient. These receipts are fingerprint-bound and re-read under the
existing apply locks. Failed proof remains `CUTOVER_BASELINE_UNVERIFIED`, exposed
in local recovery diagnostics and copied history reports. No historical row is repaired.

Its exact retained-evidence fingerprint uses the existing repair manifest/index,
including downloaded/generated/confirmed files. Every retained exact file needs
an explicit disposition and evidence. The operator also confirms that old versions
are retired, the current product has no independent exclusion, and old imports
have been resolved; the decision reason is retained as this attestation. A Magento
GET cannot prove that an old downloaded file will never be imported.

Preview verifies every distinct former public/internal/file SKU is absent and
the current public SKU exists at its durable Magento ID. A surviving old article
or failed GET blocks the decision and is shown by article. The full hypothetical
current UPDATE must be sendable under the current public-SKU-aware publication
after API/CSV cutover. Configuration blockers link to the exact category/field in
the new workspace and require a fresh preview after correction.

Apply rechecks actor authority, installation, the entire evidence fingerprint and
fresh GETs under deterministic identity/SKU lanes and ascending product/lifecycle
locks. It only changes current exposure certainty from `historical_ambiguity` to
`prior_exposure`, preserving the held CSV route and all acknowledgements. One
reviewed current-product handoff is recorded atomically for the existing worker;
apply itself writes nothing to Magento. The audit receipt binds the plan, reason
and attestations. Identical retries return that receipt without remote reads or
another handoff; changed attestations/reason conflict. Ordinary and stable exposure
recipes retain their stricter lineage requirements.

For an unsupported historical recount, the explicit guided check inspects the
listed public articles using GETs only and shows each previous/current version,
found/missing/unavailable Magento evidence, exact history problems and a copyable
or downloadable report. There is no automatic historical identity repair or hold
release. The report states the required history-repair handoff; old replacement
recipes remain unavailable after CSV cutover. Optional product-history links retain
a validated return to the attention case. An exclusion decision on a held product
returns a separate history-review step, rather than prematurely offering resync.

### Controlled product recovery

The separate `/api/admin/magento-recovery` router preserves the authenticated
active-user and synchronizer-token CSRF boundaries. No browser calls Magento.
No migration, role grant or replacement of durable jobs is introduced.

| Endpoint | Authority and effect |
| --- | --- |
| GET `/products/:id` | Either `export_templates.publish` or `exports.reconcile`; local original-job/lifecycle context with capability-filtered actions. |
| GET `/jobs/:id` | `export_templates.publish`; exact original job and step states. |
| POST `/jobs/:id/inspect` | Same capability; bounded remote GET evidence only, no dispatch or acknowledgement. |
| POST `/jobs/:id/reconcile` | Same capability; rechecks reviewed local/remote fingerprints and records only verified results, with an audit receipt; no remote mutation. |
| POST `/jobs/:id/continue` | Same capability; separate explicit reviewed continuation of remaining original steps through the existing guarded job executor. |
| POST `/products/:id/lifecycle-preview`, `/lifecycle-apply` | `exports.reconcile`; exact exposure/stable-recount, explicitly reviewed historical recount, or eligible compatibility reconciliation, never a blanket hold release. |
| POST `/products/:id/history-inspect` | `exports.reconcile`; bounded GET-only observations of the exact public articles in local correction history; no repair token, job, acknowledgement or mutation. |

History inspection rechecks the active actor before and after remote reads, outside
product/access/publication transactions. One request has a shared 60-second/30-GET
budget. Local history changes mark observations stale; Magento errors remain
unavailable evidence and cannot be interpreted as absence. Local versions and the
report remain available when observation fails. This evidence never authorizes an
apply and does not acknowledge old files or predecessor delivery.

Inspection is not a generic retry. Dispatched but unverified steps must match exact
GET evidence before acknowledgement. A partially reconciled job stays uncertain,
preventing the automatic worker from sending remaining steps without a separate
reviewed continuation. Current publication, product snapshot, actor, installation,
plan integrity and session locks remain checked. Stale evidence requires a new
inspection; changed or mismatched remote evidence never permits blind resend.
GET-only inspection releases product/access/publication transaction locks before
remote reads, retaining the SKU session lock and binding its result to the local
snapshot. It exposes a bounded before/after review of remaining original changes.
Acknowledgement and continuation preserve the existing manual executor's final
transaction checks; they are not claimed to be lock-free remote operations.

Lifecycle preview exposes the actual supported action and required evidence.
Legacy replacement/first-delivery recipes remain unavailable after product-CSV
cutover, checked again transactionally. Ordinary exposure can leave a held or
parked product and therefore returns a separate reviewed-resync handoff; that
action retains its actual Administrator-only contract. Stable recount uses its
existing atomic `broader_resync` handoff. A local receipt never asserts successful
Magento delivery. Unsupported or incomplete evidence stays blocked with a reason.

### Reviewed category creation (H2)

The integration workspace can preview and explicitly create one missing category
path already required by a selected draft binding, under its exact uniquely observed
parent ID/full path. The server derives the name from that requirement; no arbitrary
Magento URL, menu placement, tree recursion, move, rename or delete is exposed.
Defaults are fixed: `is_active=true`, `include_in_menu=false`. Storefront menu enabling
remains a deliberate manual Magento Admin action.

Migration `052_magento_configuration_actions.sql` stores a permanent single-action
receipt: sealed intent → committed dispatched marker → exact returned remote ID →
GET-verified identity, hierarchy and flags. Independent Amber callers share one
origin/resource reservation. Remote I/O never spans business locks/transactions.
Manage **and** publish permissions are rechecked at every local mutation boundary.
Creation does not change the draft or approve any binding; the UI shows
**Створено, зв’язок ще не підтверджено**.

`POST .../categories/preview`, `/apply` and `/reconcile` are authenticated and
CSRF-protected; reconciliation performs only remote GETs. `/actions` and
`/actions/:id` expose bounded safe receipts after reload. If the exact returned ID
is durable, failed verification can resume with GET. If the response/ID was lost,
equal-label/path discovery is insufficient attribution: the action remains explicitly
uncertain and no automatic POST retry is available. This new workflow leaves the
historical two-path CLI behavior unchanged.

Migration 056 adds reviewed recovery for a committed **sealed, undispatched**
action. Repeat the normal fresh preview and explicit apply; a changed review seals
a linked successor and marks the old intent superseded in the same transaction.
Intent, actor, observation and attestation history are never rewritten. One active
origin/kind/resource reservation and the existing access lock serialize replacement
against dispatch. A superseded intent cannot dispatch. Dispatched/returned/verified
reservations can never be replaced, even if later GETs show the target absent.

### Reviewed option creation (H4)

The separate [controlled attribute workflow](MAGENTO_ATTRIBUTES.md) creates ordinary
text/single-select attributes and explicitly connects them to an existing set.
It uses the migration-059 extension of the permanent configuration-action ledger;
option creation below retains its existing separate Administrator attestation.

Option creation is bounded to one existing user-defined select/multiselect with
ordinary standard-table source metadata. System, custom-source, unknown and
explicitly observed swatch types fail closed. REST absence of swatch metadata is
never proof that the attribute is ordinary. Migration
`053_magento_option_attestations.sql` records an actual Administrator's reviewed
capability attestation for the exact origin/installation, attribute ID/code and
fingerprint of all bounded observable non-option metadata.

Attestations are immutable, action-specific, actor-bound, valid for ten minutes
and consumed by one sealed intent. Every option action requires renewed manual
classification review, including acknowledgment that hidden swatch changes may
have no visible REST signal. Observable identity/metadata drift invalidates review.
This is an explicit reviewed risk boundary, not permanent non-swatch certification.

The global label is the exact non-archived Amber `options.label`; optional authoritative
English display metadata is `options.label_en` (migration 057). Catalog create/edit
owns both labels. Historical EN remains null: no translation or UA fallback is
invented. SKU values must already exist in the active published SKU schema. The
server always discovers store views. If `en` is active, a nonblank Amber EN label
is required before CREATE; the operator must complete it in the Amber catalog.
Conflicting UA/EN labels across matching authoritative source rows fail closed;
identical contextual labels remain valid. The preview captures both PostgreSQL
labels and the exact active EN store ID, or explicit absence. A later scope change
invalidates review or blocks GET verification; historical immutable intents are
not rewritten.
Client-authored `englishLabel`/`englishAuthoritative` are rejected. Catalog edits
alone perform no remote write, product enrollment or SKU schema publication.

Typed `POST .../options/inspect`, `/attest`, `/preview`, `/apply` and
`/reconcile` retain manage+publish, authentication and CSRF. Attestation/apply
also require the actual immutable Administrator role. Metadata/options and local
source/revision are rechecked before committed dispatch. POST uses only the closed
option route, initializes no default, and persists the exact returned option ID
before exact GET verification in global and every applicable EN scope. A lost response remains
uncertain; equal labels cannot recover attribution or authorize another POST.
Creation never approves a semantic binding. Returned-ID recovery remains GET-only.
For the first non-default option only, Magento may add `default_value: ""` to
previously absent metadata. Verification accepts this representation change only
when removing that empty field reproduces the exact sealed metadata fingerprint
and the sealed prior options contain at most the empty placeholder. The receipt
records both fingerprints and the preimage mode; the intent and attestation stay
immutable. A real default, other metadata drift, existing nonempty options or a
default-setting action still fail closed. Exact returned-ID, global/EN labels,
prior options and EN scope checks remain mandatory; recovery never resends POST.
An expired attestation on still-sealed work requires a fresh Administrator
classification attestation, preview and explicit apply; 056 retains both attestations
and intents. Expiry never permits replacement of previously dispatched work.

### Reviewed existing-option label updates

Select the **current published binding**, the Amber semantic value and its exact
approved attribute. Amber derives the option ID from that publication; unapproved,
ambiguous, wrong-attribute and superseded selections fail closed. `/option-labels/inspect`,
`/attest`, `/preview`, `/apply` and `/reconcile` retain the existing manage/publish,
Administrator attestation, active-user and CSRF boundaries. Review shows exact
current global/EN labels and proposed PostgreSQL labels. Explicit apply seals an
immutable `option_label` intent before dispatch, rechecks fresh metadata, authoritative
labels, current publication and adapter revision, then performs one typed PUT.
No binding is approved, modified or published by this action.

**A scoped-label adapter is required for writes. Stock Magento option PUT is never a fallback.**
Magento 2.4.6's [option save](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Eav/Model/Entity/Attribute/OptionManagement.php)
and [resource persistence](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Eav/Model/ResourceModel/Entity/Attribute.php)
replace option store-label rows and reset omitted sort order. Effective-label GETs
cannot prove the stored translation/fallback distinction. The accepted bounded
release therefore blocks attest/preview/apply/reconciliation with
`MAGENTO_OPTION_LABEL_ADAPTER_REQUIRED` if the
configured installation does not implement the [typed adapter contract](MAGENTO_SCOPED_OPTION_LABEL_ADAPTER.md).
Read-only inspection may still compare authoritative Amber labels with standard
GET labels for the exact approved option ID. The UI identifies these as effective
labels (EN may be inherited), not proof of stored overrides, and exposes no write
controls. Adapter-backed inspection continues to use its exact stored labels.
This repository defines and tests the Amber client/service contract with fixtures;
it does **not** claim that the adapter exists or has been deployed in real Magento.
Installing/accepting that Magento-side adapter is separate deployment work.

After a lost PUT response, the exact pre-known option ID permits GET-only
reconciliation. A mismatch remains dispatched/uncertain and blocks every new PUT
for that resource. Only exact adapter/global/EN verification advances the immutable
receipt. Once verified, a later catalog edit may receive a new separately attested
and reviewed label action; historical evidence stays immutable. Sealed, undispatched
work retains migration-056 reviewed recovery. No blind retry, order management,
other-scope replacement or generic Magento request surface is exposed.

As reported by the production operator on 2026-10-01, Wave 1 is deployed at PR #19 / `daf627fc2458e5215cbf52735a8f186a3777361f`, with migrations through `050_test_product_deletion.sql`. Stable public `AG-*` identities, the reviewed production binding and automatic Amber → Magento synchronization are active. Magento product CSV delivery is retired; the separate price-export stream and immutable historical evidence remain supported. Historical delivery/collision cutover is complete and the operational freeze has been lifted. This documentation update did not query production or Magento.

## Stable public SKU boundary

Migration 046 separates the externally addressed Magento article from the encoded configuration/history SKU. Exact product GET, CREATE/UPDATE payload `sku`, category, website, inventory and store-view operations, read-after-write verification, durable job remote identity and generated `Art: {sku}` names use `public_sku`. The exact product revision remains captured by product ID, internal `full_sku`, lifecycle state and job hash. Existing legacy products backfill `public_sku = full_sku`, so no Magento rename is implied. Installing the migration alone retains legacy recount identity; after the separately audited stable-public-SKU activation, recount successors inherit the same public identity and are delivered as UPDATEs of that remote product.

The schema-045 legacy collision repair does not call Magento, rename a legacy remote product, publish a binding, create a job or activate delivery. For an explicitly staged `split_public_identity` group, the keeper retains the legacy public SKU and therefore the existing remote Magento article. Migration 047 restores the same separate local product row under a new `AG-` public SKU and records that it needs a separately reviewed post-cutover Magento CREATE/requeue. That later operation is not authorized by staging or migration installation.

Generic API fields named `sku`, `fullSku` or `full_sku` retain their prior encoded/internal meaning. New response fields explicitly expose `publicSku` and `internalSku`; only contracts whose purpose is Magento/product article identity switch their value to public SKU.

The fixed code-backed mapper consumes public SKU directly. Immutable template publications are not reinterpreted: `full_sku` remains internal in evaluator versions 1 and 2. Evaluator `magento-declarative-3` with source contract `public-product-identity-v1` adds the distinct `public_sku` source for an explicitly reviewed successor publication. No existing publication or binding is mutated automatically.

The historical migration-046 successor review recorded the post-publication Magento option `rozmir_kartyny`: label `15×15`, option ID `6060`, Amber semantic `AR.size` value `28`. That dated discovery was candidate evidence only; migration 046 did not approve, publish or bind it. It is not a claim about current production coverage.

The [automatic product workflow](MAGENTO_AUTOMATIC_SYNC.md) is implemented behind
migration 044's default-disabled gate. It reuses the durable jobs below, adds local
transactional requests and product-history status, and does not retire CSV. Dated
manual receipts and remaining-group observations below retain their original scope.

The product sync preview and discovery client remain GET-only. Separate explicit
commands handle single-category creation and durable product sync APPLY.

New sync intents use one durable operation per changed category membership. Under
reviewed authoritative ownership, the planner removes stale links with Magento's
`DELETE /V1/categories/:categoryId/products/:sku`, then saves missing links or
reviewed position changes with `POST /V1/categories/:categoryId/products`. Each
write has its own dispatched marker and exact read-after-write category-link
verification. Preserve ownership retains Magento-only links; an already exact
assignment needs no category write. CREATE verifies the disabled core product
before adding category links. Earlier version-1 jobs retain their immutable
product-POST category intent for reconciliation; they are not converted or reset.

Migration 048 and `magento:external-delivery` provide a separate operator-only
acknowledgement for an exact pending Amber revision known to have been delivered to
an exact Magento SKU outside Amber before API delivery cutover. It uses GET-only
remote verification and never calls the Magento writer. This evidence is not a sync
job receipt, snapshot confirmation or payload-equality proof. See the
[cutover workflow](FULL_PRODUCT_CUTOVER_RUNBOOK.md#pre-api-external-delivery-acknowledgement).

## Test-product deletion

Migration 050 adds a separate Administrator-only test-product DELETE ledger and
closed `AG-` transport. Normal archive and CREATE/UPDATE sync jobs retain their
contracts. Every DELETE has committed intent/dispatch evidence and exact GET
absence verification; uncertain DELETE is never blindly resent. See
[test-product deletion](MAGENTO_AUTOMATIC_SYNC.md#test-product-deletion).

## Achieved state 2026-09-28

The first real direct **Amber → Magento product UPDATE without CSV** succeeded.
The final GET-only/read-only review confirmed these local durable receipts:

| Evidence | Recorded state |
| --- | --- |
| Migrations | `041_magento_binding_revisions.sql` installed at `2026-09-27T20:13:49.840Z`; `042_magento_sync_jobs.sql` at `2026-09-27T22:52:43.558Z`, through the normal local migration path. |
| First publication | Installation `amber`, revision `4d563554-bfe3-4d01-9df5-225aa5b61d48`, version **1**, counter **37**, published from counter 36 at `2026-09-27T22:53:17.025Z`. KL is enabled; remaining groups are not approved. |
| Successful product/job | `KL3/11131351005` / `f2253960-527a-40e9-b879-9041bb036453`; Magento product `5509`; state `succeeded`, attempts `2`. |
| Operations | `coreProduct → categories → storeViews`; all three durable steps are `verified`. Last step verified at `2026-09-27T23:50:45.316Z`; acknowledgement at `2026-09-27T23:50:46.739Z` followed final read-after-write verification. These UTC receipts fall on September 28 in Europe/Kiev. |
| Applied differences | `rozmir_iuvelirnoho_vyrobu`: `3,2/2` → `3.2/2.2`; `decor_weight`: `5` → `4.7`; `kulony_dodatkovo`: option `6047`; category `649` added; EN `meta_title` updated. |

The first attempt stopped before dispatch because fresh revalidation had lost native
timestamp evidence in its minimized baseline. The timestamp fix documented under
durable jobs allowed the **same immutable job** to succeed on its second attempt;
its intent/baseline were not rewritten and no replacement job was needed.

Current published KL ownership is explicit: Amber owns SKU identity (no rename),
name, price, type/set, visibility, produced characteristics, `old_product`,
`is_ownproduction`, base SEO and category intent. Empty/unproduced descriptions,
media and unmanaged Magento fields are preserved. Status is `initialize_create_only`
with **CREATE status 2 (disabled)**; UPDATE omits status. This means disabled product
status on CREATE, not that the implementation lacks a CREATE operation. Inventory
quantity/stock are also create-only initialization; UPDATE preserves existing source
items, including zero stock. Websites are individual additive memberships, retaining
existing extras. EN sends only approved nonempty scoped values (`name`, `meta_title`
for KL); EN identity controls, descriptions and unproduced SEO are preserved. The
successful UPDATE needed no inventory or website write. These decisions do not
automatically approve ownership for another group.

The existing `magento:category` flow previews an exact missing path, requires explicit
single-category APPLY under a resolved parent, then re-reads and verifies identity
before saving its draft binding decision. `649 / Default/Кулони/З інклюзом` completed
that flow before publication and was included in the successful product update.
Category creation, category assignment and binding publication remain separate actions.

Historical 2026-09-28 state: legacy CSV export was planned for retirement. Current production has since completed product-CSV retirement; price export remains supported.
Reconcile existing product/price queues, generated/downloaded unconfirmed files and
held/replacement work before cutover. Sync success does not confirm CSV snapshots or
advance export revision/cursor state; see [export retirement](EXPORTS.md#product-csv-retirement).
At that date, next work was BR/NM/CH/AR/SV bindings, followed by automatic sync/UI and product-CSV cutover. Those Wave 1 stages have since completed in production; the old immutable KL publication remains historical evidence.

The binding review CLI supports an explicit disabled-on-create status policy:
`approve --revision UUID --expected-revision N --actor-user-id ID --binding POLICY_REVIEW_ID --accept-review --reason "Create disabled; preserve update status" --policy initialize_create_only --create-value 2`.
This option is restricted to the base `product_online` ownership policy and is
stored in migration 041's existing policy evidence. Approved previews use native
status `2` on CREATE and omit status on UPDATE, preserving Magento's current value.
It does not approve inventory, websites, English store views or publish the draft.
Individual known label differences require explicit binding approval with a reason;
they never introduce a fuzzy mapping rule. SKU lookup remains exact; rename is unsupported.

Phase 1A provides an isolated **GET-only** connection and discovery layer for
Magento 2.4.6. It creates no HTTP routes, browser integration, outbox, schema cache,
or database migrations. Neither the client nor the probe imports PostgreSQL or
the existing product/export services. It performs no remote writes and does not
change save, recount, repricing, snapshots, acknowledgment, queues, or Held products.

## Server configuration

Set these only in the server process environment or the ignored root `.env`:

| Variable | Meaning |
| --- | --- |
| `MAGENTO_BASE_URL` | Store origin, e.g. `https://ambergalbin.store`; never `/admin/`, `/rest/`, a query, fragment, or embedded credentials. |
| `MAGENTO_CONSUMER_KEY` | Existing integration consumer key. |
| `MAGENTO_CONSUMER_SECRET` | Existing integration consumer secret. |
| `MAGENTO_ACCESS_TOKEN` | Existing integration access token. |
| `MAGENTO_ACCESS_TOKEN_SECRET` | Existing integration access token secret. |

All five absent/blank means `config.magento.configured === false`; application
startup remains valid. Any partial configuration fails closed. HTTPS is required;
explicit `localhost`, `127.0.0.1`, or `[::1]` HTTP origins are accepted only outside
`NODE_ENV=production`. Paths and URL normalization tricks are rejected.

Compose forwards these optional variables only to the server. Empty placeholders
are in [`.env.example`](../.env.example). Keep real credentials outside Git,
browser assets, `VITE_*`, command-line arguments, tickets, and captured logs.
The probe never needs credentials pasted into its command.

Authentication uses all four credentials with OAuth 1.0a, version `1.0`,
HMAC-SHA256, a fresh cryptographic nonce, and Unix seconds. It does not use a
standalone Bearer token. The signer applies RFC3986 encoding, sorts encoded
key/value pairs (including duplicate query parameters), and separates the signing
base URL from the query. See [Adobe OAuth authentication](https://developer.adobe.com/commerce/webapi/get-started/authentication/gs-authentication-oauth).

## Read interface

[`createMagentoClient`](../server/src/services/magento/client.js) takes parsed
server configuration, with optional `storeCode`, injected `fetchImpl`, and
`timeoutMs` (10 seconds by default, maximum 60 seconds). The centralized prefix is
`{origin}/rest/{storeCode}/V1/`; `all` is Magento's reserved global scope, not an
assumption about an installed store-view code. An operator may select a known
store-view code explicitly. No website, attribute-set, attribute, or option IDs
are hard-coded.

| Method | GET resource below `/V1/` |
| --- | --- |
| `getWebsites()` | `store/websites` |
| `getStoreGroups()` | `store/storeGroups` |
| `getStoreViews()` | `store/storeViews` |
| `getStoreConfigs()` | `store/storeConfigs` |
| `getCategoryTree(rootCategoryId)` | `categories?rootCategoryId=...` |
| `listAttributeSets(page = 1)` | `products/attribute-sets/sets/list` |
| `getAttributeSet(id)` | `products/attribute-sets/{id}` |
| `getAttributeSetAttributes(id)` | `products/attribute-sets/{id}/attributes` |
| `listProductAttributes(page = 1)` | `products/attributes` |
| `getProductAttribute(code)` | `products/attributes/{code}` |
| `getProductAttributeOptions(code)` | `products/attributes/{code}/options` |
| `findProductBySku(sku)` | `products` with an exact `sku` search filter |
| `getProductBySkuPathDiagnostic(sku)` | `products/{encodedSku}`; path behavior characterization only |

These resources follow the Magento 2.4.6
[Catalog routes](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Catalog/etc/webapi.xml)
and [Store routes](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Store/etc/webapi.xml).
List methods send `searchCriteria[pageSize]=100` and an explicit current page.
They return the actual JSON metadata for future server-side discovery/binding
work; they do not persist it or reinterpret Amber semantic `value_id` values.
The supported product lookup sends one `searchCriteria[filter_groups][0][filters][0]`
filter with `field=sku`, the unmodified requested SKU as `value`, and
`condition_type=eq`, plus `pageSize=2` and `currentPage=1`. It returns one
product only when the response has `total_count=1` and its sole item has the
exact requested SKU. Zero results return `MAGENTO_PRODUCT_NOT_FOUND`; multiple
exact results return `MAGENTO_PRODUCT_AMBIGUOUS`; mismatched or inconsistent
responses fail closed.
The existing template evaluator and Magento v1 CSV mapper remain unchanged.
Future bindings and a REST payload adapter must stay separate from those semantic
identities; future synchronization still requires a local transaction, durable
outbox, worker, read-after-write verification, and exact acknowledgment.

Only named GET methods are exposed. There is no public arbitrary URL/request
method, request body, or mutation method. Redirects are rejected without following
them; there are no automatic retries. AbortController bounds headers and body
reads, JSON content type/parsing is explicit, and each response is limited to
8 MiB. Integration errors expose fixed `MAGENTO_*` codes/messages and, when
available, a numeric HTTP status. Raw bodies, remote messages, underlying errors,
URLs, headers, OAuth signatures, and credentials are not included in errors/logs.

## Operator probe

After code review and deployment, run inside the server environment:

```sh
docker compose exec server npm run magento:probe
docker compose exec server npm run magento:probe -- --sku "KL3/11131351005"
```

For a direct server checkout, run the same npm commands from `server/` without
the `docker compose exec server` prefix. `npm run magento:probe -- --help` lists
options without connecting. The probe loads root `.env` without overriding the
process environment and requires no database/OIDC configuration.

Default output uses the existing structured JSON logger: configured yes/no,
website/group/view/config counts, attribute-set count (up to 20 numeric IDs), and
total product-attribute count. It paginates lists up to 100 pages/10,000 records,
rejecting inconsistent totals, duplicate identities, or premature empty pages.
It does not dump raw records. Unconfigured is a successful diagnostic with
`configured: false`; invalid config, failed requests, unexpected response shapes,
or exceeded bounds exit nonzero.

Optional `--attribute-set ID` reads that set's assigned attribute count.
Optional `--attribute CODE` reads metadata and option count. Each flag may repeat
up to 20 times; use discovered IDs/codes, not assumed mapper IDs. Option counts
include any empty-choice entries Magento returns. `--store-code CODE` chooses
scope. No options or sets are modified.

Only an explicit `--sku` triggers one product lookup, after discovery. Its output
contains the requested SKU, exact returned-SKU match, numeric product ID,
attribute-set ID, and status. A mismatching returned SKU fails the probe. Remote
names, labels, custom attributes, headers, and raw responses are never printed;
there is no `--json` raw-dump mode. Failure output is fixed and sanitized.

The first production probe found that ordinary SKU `SV112423003` succeeds through
`GET /V1/products/:sku`, while the encoded path
`GET /V1/products/KL3%2F11131351005` returns HTTP 401 during Magento 2.4.6
OAuth signature validation. The supported lookup therefore uses
`GET /V1/products` with an exact SKU query filter. The slash stays in the Amber
SKU and travels only in the query value. This is a Magento compatibility
workaround, not an Amber SKU rewrite; SKU rename/update is not implemented.

The path-specific diagnostic method still characterizes URL encoding:
`KL3/11131351005` becomes one path segment `KL3%2F11131351005`. The signer
remains unchanged. For both routes, the exact serialized URL is signed and
passed to fetch.

### Verified live Phase 1A evidence

The operator's completed read-only probe of Magento 2.4.6 reported 2 websites,
2 store groups, 4 store views, 3 store configs, 10 product attribute sets and
141 product attributes. Discovered attribute-set IDs were
`141, 4, 142, 154, 152, 144, 143, 145, 151, 150`; these numbers alone do not
establish any Amber category correspondence.

Normal SKU `SV112423003` resolved to product ID `3085`, attribute-set ID `151`,
status `1`. Slash SKU `KL3/11131351005` successfully resolved through the exact
query-based lookup to product ID `5509`, attribute-set ID `144`, status `1`.
The path-based route remains diagnostic only. This is operator-supplied live
evidence, not a production call made by the automated tests or schema-audit
implementation work. Unit tests continue to use synthetic credentials and
injected fetch only. Neither SKU rewriting nor signer changes are needed.

## Read-only schema audit

With the same five Magento environment variables configured, run from `server/`:

```sh
npm run magento:schema-audit
npm run magento:schema-audit -- --store-code en --output /secure/evidence/schema-audit.json
```

Use `en` only if discovery establishes it is the intended live store-view code;
the default scope is Magento's reserved `all`. The audit does not infer which
view is Main or EN. `--help` makes no network requests. In the deployed server:

```sh
docker compose exec server npm run magento:schema-audit
```

The default artifact is repository-root
`.artifacts/magento/schema-audit-<UTC timestamp>.json`, already ignored by Git.
In a container this path is inside the container; copy it to durable operational
storage before replacing the container, or use an explicit mounted output path.
`--output` accepts an explicit path (relative paths resolve from the working
directory). Parent directories are created; existing files are never overwritten.
Only a successfully completed audit is written. The concise structured console
summary includes the path, schema counts, exact set-match count and diagnostic
counts, not schema labels or options. No artifact is automatically committed.
These files are **operational evidence, not repository configuration**; keep
explicit output paths outside tracked source files.

[`schema-audit.js`](../server/src/services/magento/schema-audit.js) owns discovery,
normalization, consistency checks and comparison. The CLI only handles arguments,
configuration, artifact writing and summary/error logging. It reuses the Phase 1A
named GET-only client and never requests product records, imports PostgreSQL,
persists bindings, or modifies Magento. There are no migrations, outbox, rename,
save/recount/repricing/export changes or evaluator business-rule changes.

The report contains:

- `storeTopology`: website IDs/codes/names/default groups, group website/root
  category/default store/name/code, and view website/group/code/name/active state
  where exposed. No raw store configs or URLs are retained.
- `attributeSets`: actual IDs and exact names, optional sort/entity metadata, and
  assigned attribute codes for every set.
- `attributes`: allowlisted identity, label, input/backend type, scope,
  required/unique/user-defined/visible/search/filter flags where exposed. Every
  select/multiselect has its actual options and option count (including the empty
  choice), with opaque string `value`, exact `label`, `isEmpty`, and optional sort
  order/default flag. Only value `""` is empty; numeric/string zero remains data.
  Boolean attributes and every existing mapper target also have their options
  queried, including custom sources; empty lists on text fields are not label
  mismatches. Magento core internal EAV attributes can legitimately return
  `frontend_input: null` (for example, the 2.4.6
  [Downloadable attribute setup](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Downloadable/Setup/Patch/Data/InstallDownloadableAttributes.php)
  defines an empty input). The audit retains that `null` in the normalized schema.

  Product metadata follows the Magento 2.4.6 service-contract return types:
  `is_filterable`, `is_filterable_in_search`, `is_visible`, and `is_user_defined`
  accept JSON booleans or contract-permitted `null`; `is_required` accepts only a
  JSON boolean when present. Fields such as `is_unique`, `is_searchable`, and
  `is_visible_on_front` are `string|null` in those interfaces and remain strings
  here. Contract-permitted nulls are omitted from the bounded report. See
  [Catalog EAV attribute](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Catalog/Api/Data/EavAttributeInterface.php)
  and [EAV attribute](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Eav/Api/Data/AttributeInterface.php).
- `mapperSources` and `mapperAttributes`: code-backed source question keys/product
  fields, every target column, group/row use, existence by exact attribute code,
  input type, option availability, set membership, dictionary output evidence and
  source IDs. Headers and values come from the existing materialized system
  definition; no second long target/dictionary list is maintained.
- `mapperAttributeSetComparison`: BR/NM/KL/CH/AR/SV and SV's conditional Камінь
  output names matched **exactly** to actual Magento set names. Zero/multiple
  matches remain missing/ambiguous; numeric IDs and fuzzy names are never guessed.
- `optionComparisons`: exact output-label candidates, separate Amber `amberValueId`
  and Magento `candidateOptionIds`, duplicate labels, unmatched mapper values,
  extra Magento options and explicit empty choices. Options themselves are stored
  once in `attributes`. Literal and numeric-band labels are also inspected.
- `unmappedMagentoAttributes` and `diagnostics`: unused attribute codes and stable
  review codes `ATTRIBUTE_SET_NOT_FOUND`, `ATTRIBUTE_SET_AMBIGUOUS`,
  `ATTRIBUTE_NOT_FOUND`, `ATTRIBUTE_FRONTEND_INPUT_MISSING`,
  `ATTRIBUTE_NOT_IN_EXPECTED_SET`,
  `OPTION_LABEL_AMBIGUOUS`, `MAPPER_VALUE_NOT_IN_MAGENTO`,
  `MAGENTO_OPTION_UNMAPPED`.

An attribute can be valid schema while lacking metadata needed to assess an Amber
mapper target. `ATTRIBUTE_FRONTEND_INPUT_MISSING` flags an existing mapper target
with null input metadata for review; unrelated internal attributes do not cause
that finding or abort discovery.

Differences have severity `review`, not an automatic error classification. CSV
control fields (routing, website, product status/type and inventory columns) are
included by literal name but their absence does not assert a missing EAV
attribute; this is not a CSV-to-REST field adapter. Exact matching does not trim,
translate or case-fold labels. Blank mapper output never binds to an empty option.
Duplicate labels retain all candidate option IDs. Dynamic text is marked and is
not enumerated: “unmapped” means absent from the code-backed finite output values,
not proof that no product could emit it. All possible output branches are
inspected without running business conditions; membership findings, particularly
SV versus Камінь, need operator review.

Label matches are **proposals/evidence, never semantic bindings**. Amber remains
authoritative for question/value meaning. The future boundary is Amber semantic
question/value → explicit Magento binding → installation-specific attribute code
and option ID; the template evaluator retains business transformations. This audit
reads no deployed Amber catalog, saved draft or publication. Its empty-catalog
materialization inspects code syntax only and makes no claim that dictionary IDs
are approved current/historical Amber values. Persistent-binding design still needs
that source evidence, the actual intended template/publication, operator-confirmed
store roles/locales, and decisions for missing/duplicate labels and set membership.

Ordering is deterministic and schema strings are preserved. The artifact omits
raw responses/headers, credentials and unrelated customer/product data. Reflected
OAuth credentials or Authorization text in allowed schema strings fail closed
instead of being redacted into misleading evidence. Malformed shapes, conflicting
attribute identities/metadata, duplicate IDs or inconsistent pagination fail the
audit with sanitized errors and no new artifact. Lists are bounded to 100 pages
of 100 records, options to 10,000 per attribute, aggregate options and memberships
to 100,000 each, and compact report JSON to 64 MiB (pretty-printed files are larger).
Failure logs now identify the audit `stage` and `entityType`, with a safe numeric
`entityId`, strict `entityCode`, parent `attributeSetId` or bounded `index` when
available. Attribute metadata validation can add a fixed `field` name and a
`valueShape` category (`missing`, `null`, `string`, `number`, `boolean`, `array` or
`object`). Nullable optional Magento fields remain optional; the audit does not
substitute an attribute-detail response for the global list. These fields
localize a malformed response without accepting it or
printing Magento labels, names, messages, payloads, URLs or OAuth data. The log
does not contain a partial audit artifact; a failure still exits nonzero.
Remote schema changes during sequential GETs cannot be made into an atomic
snapshot; repeat the audit during a stable configuration window if needed.

Production cutover through 039/040 and selector v1 activation are already complete
according to the Phase 1A brief. This probe performs no cutover, PostgreSQL writes,
queue draining, export confirmation, or Held-product actions. Do not rerun cutover
as part of deploying or probing this integration.

## Read-only binding evidence audit

After reviewing/deploying the implementation, run manually from `server/` in the
configured server environment (existing database configuration plus the five
Magento variables above):

```sh
npm run magento:binding-evidence-audit
npm run magento:binding-evidence-audit -- --template-version selected
npm run magento:binding-evidence-audit -- --template-version 12 --output /secure/evidence/binding-evidence.json
```

The default audits the code-backed system mapper against the current database
catalog, matching default export dispatch. `--template-version selected` audits
the selected immutable publication; a numeric ID explicitly chooses a publication.
Its stored hash/evaluator/output identity is verified before use. The report also
records activation metadata: selection alone does not switch the default exporter.
Drafts are not treated as publications. `--help` connects to neither service.

The CLI writes a new repository-root
`.artifacts/magento/binding-evidence-audit-<UTC timestamp>.json`, never overwrites,
and prints only a bounded count summary and artifact path. Artifacts are ignored
operational evidence, not configuration or fixtures to commit. The existing live
schema-audit artifact is useful for operator review but is not an implementation
input; each binding audit discovers the live schema again.

The dedicated `binding-evidence-*` services read current `questions`/`options`,
published `sku_schema_versions`/questions/options, export-template activation and
an explicitly requested publication, stored product answers, and prior export
exposure used only to prioritize samples. Local reads use one repeatable-read
`READ ONLY` transaction; the CLI connection also defaults to read-only. No startup,
migration, seed, lifecycle mutation or advisory-lock path runs. The transaction
finishes before remote reads. Current/published presence, option archive and
visibility rules, question kind and version evidence stay separate. Presence does
not mean that a conditionally visible value is available for every product.

Semantic `value_id`, encoded `sku_code`, Amber labels, evaluated output strings,
and Magento option IDs/labels are retained as distinct evidence. Actual product
outputs use the existing compiled evaluator and source-support projection.
Definitions and dictionaries are introspected, not copied into an alternate
mapper. `templateReachability` distinguishes blocked entries from conditional
possibilities; it is not a claim that every dictionary entry occurs in a product.

Mapping strategies distinguish:

- `semantic_option`: finite semantic dictionary outputs with exact option
  candidates and current/historical semantic provenance;
- `dynamic_exact_label_option`: information/product data needs a future dynamic
  option resolver; a finite semantic binding table cannot represent its domain;
- `numeric_band_option`: the evaluator generates a range label before option
  resolution, including its existing outside-range behavior;
- `scalar`: text/number output needs no option binding;
- `constant_option`: an enumerated option output has no Amber semantic identity;
- `transport_control`: CSV routing/inventory fields, visibility, and native
  boolean metadata require a future REST translation. These do not produce
  ordinary missing-EAV/semantic-option diagnostics merely because their CSV
  spelling differs. The report describes translation requirements without
  implementing a write adapter.

Route analysis follows the actual `attribute_set_code` expression, including the
SV stone decision, plus captured question visibility and output conditions. It
conservatively distinguishes provably inapplicable targets from possible outputs.
Unknown conditions remain possible. Only evaluated populated sample fields produce
`ATTRIBUTE_NOT_IN_SELECTED_SET`; failed product evaluations are explicitly
provisional. Neither the five SV fields of interest nor any attribute-set ID is
assumed to require membership.

Up to three deterministic active local candidates per template route are tried,
preferring prior export exposure, uncorrected and exportable products. Exposure
does not prove Magento import. The audit uses exact query-based SKU GETs and
stops at the first found counterpart per route. No Magento product enumeration
occurs. Samples retain local identity, predicted/actual set, status/visibility,
only relevant native values, resolved option labels and evaluator output. Two
found products from distinct categories at most also receive GETs under active
`ua`/`en`; inactive `ru` is not sampled. Scope differences are review evidence;
equal `all`/`ua` values do not prove that a blank CSV store-view row targets `ua`.

`knownCases` explicitly inspects `KL.addit=1`, `AR.size=28`, and `CH.count=9`
using fresh catalog/schema/mapper/option observations and total/current stored
answer usage counts. KL's operator-reported option `6047` is reread as evidence,
never installed as a binding. Exact matches remain proposals. Single-edit or
adjacent-letter spelling candidates are review-only; different measurements or
counts are not spelling drift. No label or `?` value is corrected or reinterpreted.

Stable review diagnostics include `AMBER_CURRENT_VALUE_NOT_IN_MAGENTO`,
`AMBER_HISTORICAL_VALUE_NOT_IN_MAGENTO`, `LABEL_DRIFT_REVIEW_REQUIRED`,
`MAGENTO_OPTION_WITHOUT_AMBER_SEMANTIC`, `DYNAMIC_OPTION_RESOLVER_REQUIRED`,
`ATTRIBUTE_NOT_IN_SELECTED_SET`, `ATTRIBUTE_NOT_APPLICABLE_TO_SELECTED_SET`,
`PRODUCT_ATTRIBUTE_SET_MISMATCH`, `MAGENTO_PRODUCT_NOT_FOUND`,
`STORE_SCOPE_VALUE_MISMATCH`, and `SEMANTIC_IDENTITY_AMBIGUOUS`. Additional codes
identify missing local samples/scopes, unavailable attribute/set metadata,
unevaluable products, product value differences, and Amber values without an
enumerated mapper output. Magento-only options on dynamic targets are marked
`dynamic_coverage_unknown`, not asserted to be broken mappings.

The snapshot limits current/historical joined metadata and schema-version reads
to 50,000 rows each, route plans to 24, and the complete compact JSON to 64 MiB.
Existing Magento schema limits still apply. Malformed remote product shapes and
reflected credentials/OAuth data fail closed, with fixed sanitized errors and no
artifact. Usage counts inspect stored semantic answers; they do not infer IDs
from SKU digits or claim decoded historical equivalence. Remote observations are
sequential and cannot provide a cross-system atomic snapshot.

No PostgreSQL or Magento mutation, binding persistence, migration, export change,
sync/outbox, rename, retry worker or UI is introduced. Persistent bindings and any
migration 041 require a later review of the generated evidence, chosen template,
store-role semantics, dynamic resolution policies, historical identity cases,
label drift/missing options and genuinely populated SV membership gaps.

### Bounded compatibility evidence mode

After reviewing binding evidence, operators can investigate the six observed
compatibility questions without creating bindings or choosing write policies:

```sh
cd server
npm run magento:compatibility-evidence-audit
# Same entrypoint; publication/output options remain available:
npm run magento:binding-evidence-audit -- --mode compatibility
npm run magento:compatibility-evidence-audit -- --template-version selected
```

This mode reuses the binding audit's database snapshot, catalog/publication
evidence, compiled evaluator, fresh schema discovery, exact query-based SKU GET
client, redaction checks and exclusive artifact writer. Its ignored, immutable
output is `.artifacts/magento/compatibility-evidence-audit-<UTC timestamp>.json`
at repository root. It is operational evidence, never repository configuration.
`--help` performs no external reads. Do not run the live audit as an automated test.

Candidates are ordered by ascending local product ID. Current means `active`
with no correction successor and a nonblank SKU, following the existing
product-information meaning of active/uncorrected. Limits
are fixed in code and cannot be raised through CLI arguments:

| Investigation | Local candidate cap | Exact SKU attempt cap | Found cap |
| --- | ---: | ---: | ---: |
| SV stored `souvenir=5` | 40 | 40 | 20 |
| CH with both stored bead dimensions | 40 | 40 | 10 |
| AR stored `size=28` | 40 | 40 | 40 |
| AR stored `size=29`, `30`, `31`, each | 3 | 3 | 3 |
| KL stored `addit=1` | 40 | 40 | 10 |
| SV subtype, requiring both actual evaluated outputs and ready evaluation | 100 | 40 | 10 |
| Store ownership, each of BR/NM/KL/CH/AR | 10 | 10 | 2 |

At most 319 candidate rows are loaded. There are at most 259 all-scope product
lookup attempts plus 20 `ua`/`en` GETs (279 product GETs total before cache reuse).
Found and not-found lookups are cached across investigations. Existing schema
GET limits are separate. Magento is never remotely enumerated. Each investigation
reports eligible local counts, examined/skipped candidates, attempts, found and
not-found counts, unexamined counts and its stopping reason. AR usage counts
include all stored products and current products separately, independent of the
bounded witness sample. A cap or missing sample limits the conclusion; it does
not establish absence across the full catalog.

The report records SV predicted sets from actual evaluation, actual set
distribution (including observed 151/154/other IDs), eight selected field values,
resolved option labels, membership in both sets, and field-presence patterns.
Those reported IDs are observations to investigate, never route rules. CH
comparisons distinguish `exact`, `numeric_equivalent`, `rounded`, `different`,
and unavailable/non-numeric evidence. Rounding means only that the observed
number equals the nearest integer of the local number; no rounding policy is
approved. Direct/reversed dimension orientation is separate from size-text
orientation; equal axes remain ambiguous.

AR sizes 28–31 retain semantic IDs, current/published `sku_code` and labels,
usage counts, enumerated mapper outputs/reachability, actual evaluated witnesses
and live options. Current-label candidates without enumerated mapper output are
explicitly distinct evidence, not invented output. Alternative size observations
search only `name`, `meta_title`, `description` and `short_description` for the
enumerated size text (normalizing multiplication separators), retaining matching
field names rather than dumping those texts. No match is not proof that no other
representation exists. KL reports agreement/exceptions to the operator-reported
6047/`Інзклюз` convention. SV subtype aggregates exact, mismatch and unresolved
comparisons; branch eligibility is evaluated, not reimplemented.

Store observations retain only `name`, `meta_title`, `meta_description`,
`description` and `short_description` under `all` and active `ua`/`en`. Equality,
English differences, template matches and nonempty Magento values differing
from template output are `field_ownership_evidence`, not automatic errors.
REST GET equality cannot prove whether a store-view value is an explicit
override or inherited from global scope. Non-ready evaluator outputs remain
provisional. Unknown option IDs and ambiguous set names do not become matches.

No database/Magento writes, mapper changes, persistence or migration 041 are
introduced. Attribute-set convention, dimension orientation, missing sizes,
label drift, subtype repairs, store-field ownership and persistent binding design
remain decisions for a later review of this evidence.

## Phase 1B.2a: persistent binding foundation

Migration [`041_magento_binding_revisions.sql`](../server/migrations/041_magento_binding_revisions.sql)
adds installation-specific, versioned bindings. It contains schema only: no live
IDs, credentials, template seeds, default policies or approved decisions. Nothing
contacts Magento during migration/startup. The earlier audit descriptions above
describe their read-only phases; their artifacts remain evidence, not configuration.
**No Magento write path, product synchronization, outbox, retry worker or client UI
exists in this foundation.** Exports, evaluator output, SKU allocation, pricing,
recount and repricing do not read the binding tables.

### Persistence and immutable identity

| Table | Responsibility |
| --- | --- |
| `magento_binding_revisions` | Installation key and SHA-256 origin identity; exact immutable template publication identity; schema/topology fingerprints and observation time/scope; draft counter, publication version, local-user attribution and timestamps. |
| `magento_binding_schema_sets` | Observed installation set ID and display name. |
| `magento_binding_schema_attributes` | Observed code, installation attribute ID and allowlisted metadata. |
| `magento_binding_schema_options` | Observed option ID and label, scoped to its attribute. Empty-choice observations are retained but cannot be bound. |
| `magento_binding_schema_members` | Observed set/attribute membership. |
| `magento_binding_schema_stores` | Normalized website/group/view topology; no configs, URLs or credentials. |
| `magento_binding_routes` | Stable Amber semantic predicates/key, evaluator-predicted set name as evidence, explicit enabled scope, independently chosen set ID, review state and bounded evidence. |
| `magento_binding_attributes` | Route/row/evaluator target, strategy, EAV attribute code or distinct native transport target, and review state. |
| `magento_binding_options` | Explicit semantic or evaluated-output source identity, chosen option ID and review state. |
| `magento_binding_field_policies` | Separate ownership decision and review state; global scope or a foreign key to the observed store-view ID/code. |

Composite foreign keys pin the complete template ID/version/hash/evaluator/output/
format tuple to one `export_template_versions` row. Creation requires an existing
publication; implicit capture of today's system mapper is deliberately unsupported.
An operator must explicitly prepare/review/publish a template first. The definition
is reused from that immutable publication, never reconstructed from labels.

The service accepts an explicit normalized GET-schema observation and records its
time, scope, deterministic fingerprint and detached normalized rows. It verifies
the stored observation fingerprint again on read/publication. A changed observation
or template requires a new draft; draft binding updates cannot replace either.
The caller supplies a stable installation key and a validated origin; only its hash
is retained, and a key cannot be reused for another origin through the service.
Moving an installation's origin needs a later explicit migration/identity decision.

All binding children have revision-scoped primary/unique keys and restrictive
foreign keys. Option source-kind checks require semantic group/question/integer
`value_id` **or** evaluated domain/output identity. Cross-revision parents and
wrong-attribute option IDs are rejected by composite foreign keys. Duplicate
semantic identities, evaluated identities, target use within a route/row, and
effective field-policy scope are rejected. Nullable candidate IDs do not weaken
source uniqueness: semantic and evaluated source shapes have exhaustive checks and
separate partial unique indexes. An option's nullable attribute must still equal
its parent's attribute. Nonnullable generated reference columns close the composite-FK
NULL escape in both directions, including later draft-parent changes; their empty
sentinel cannot be an observed attribute code.

**Intentional semantic many-to-one is supported.** Within the same attribute binding
(pinned revision/template, route, evaluator row and target), multiple semantic IDs
may explicitly select the same Magento option only when the frozen evaluator proves
the same exact evaluated output for each. Each source retains its own row and
provenance. Remote-label coincidence proves nothing. Database guards reject shared
option IDs for different outputs or nonsemantic sources, and reject one evaluated
output selecting conflicting options. Source uniqueness independently rejects one
semantic identity selecting two options. Cross-row mappings cannot acquire conflicting
policies for the same effective route/target/store scope.

### Lifecycle and service contract

[`binding.service.js`](../server/src/services/magento/binding.service.js) exposes:

| Operation | Contract |
| --- | --- |
| `createDraft(input, options)` | `{installationKey, origin, templateVersionId, observedAt, schema}`. Creates a new UUID, draft counter `1`, observed schema and all derived routes disabled/review-required, with no chosen set, attribute, option or ownership policy. No network calls. |
| `clonePublished(id, input, options)` | `{expectedRevision}`. Copies the current installation publication into a new draft at counter `1`, preserving all stored identities, observations, decisions and review evidence exactly. Rejects draft, stale-counter and superseded sources. No network calls. |
| `getRevision(id, options)` | Coherent repeatable-read view of identity, bindings and detached schema observation. |
| `updateDraft(id, input, options)` | `{expectedRevision, bindings}` atomically replaces the four decision collections (`routes`, `attributes`, `options`, `policies`), advances the draft counter and audits. Incomplete/review-required decisions may be saved; malformed identities cannot. |
| `validateDraft(id, options)` | Read-only structural/publication diagnostics plus server-derived route/attribute/option requirements and the checked draft counter. Works for stored publications too. |
| `publishDraft(id, input, options)` | `{expectedRevision, expectedCurrentId}`; use explicit `null` when no current publication exists. Validates the locked draft and creates its immutable publication state atomically. |
| `getCurrentPublished(installationKey, options)` | Highest published version for that installation, or `null`. This is binding metadata, not activation of a synchronizer or exporter. |
| `listRevisions(installationKey, options)` | History with derived `superseded` lifecycle for older publications. |

Counters are decimal strings. Mutations require `options.mutationContext` with the
local application-user ID and optional request ID. Following existing template
conventions, create/update recheck `export_templates.manage` and publication rechecks
`export_templates.publish` using the existing access-admin transaction boundary.
These internal methods are not HTTP endpoints. Read methods require a trusted
server caller; any future routes must add view authorization, active-user and CSRF
boundaries. `databasePool` is an optional server/test dependency, never client input.

The lifecycle is **draft → published → superseded by a later publication**.
Supersession is computed from version order, without updating the earlier row.
Changes use a new draft (explicit creation with the intended observation/template,
or an exact clone of the current publication). Publication increments the
draft counter once, allocates the next per-installation version and retains all
reviewed decisions and observations unchanged.

Lock order is the existing access-admin advisory lock → active actor/permission
recheck → shared lifecycle gate → installation advisory lock for create/publish →
revision row lock. Updates take the same access boundary then the revision lock.
The installation key is hashed deterministically from
`amber_magento_binding:<installationKey>`. Hash collisions only serialize unrelated
installations. No binding operation takes an installation lock after a revision lock;
each mutation locks at most one revision. Versions are installation-wide complete
snapshots, not separate concurrent publications per route/store. The unique
installation/version constraint backs allocation; the greatest published version is
the sole current publication, with no mutable current flag.
Clone takes the same access/lifecycle → installation → revision lock order and
rechecks the source is current after acquiring the locks. Its transaction copies
all nine child tables without candidate resolution and records one
`magento_binding.cloned` event with source ID/counter/version, copied binding hash,
template ID and schema fingerprint. Audit/receipt failure rolls everything back.
The clone has new creation attribution and no publication attribution; the source
keeps its original attribution and immutable content. Clone is explicit creation,
not an idempotent retry: inspect revision history after an uncertain result before
invoking it again. Ordinary draft CAS and current-publication CAS still govern
subsequent updates and publication.

To extend an installation without dropping approved groups:

```sh
npm run magento:bindings -- clone --revision PUBLISHED_UUID --expected-revision N --actor-user-id ID
npm run magento:bindings -- extend --revision NEW_DRAFT_UUID --expected-revision 1 --actor-user-id ID --group BR
```

### Portable reviewed-binding promotion

The ordinary `clone` command remains database-local. For a frozen production dump,
use the portable transfer command. Export is deterministic and read-only. The
artifact includes the exact frozen template definition/publication identity, schema
observation and reviewed binding decisions; it excludes credentials, local users,
jobs, products, automatic requests and other operational state.

```powershell
# Rehearsal/source database
cd server
$env:DATABASE_URL = '<secret rehearsal URL>'
npm run magento:binding-transfer -- export --revision 2b1ad531-9ff0-4ad3-85d1-c3a684742aca --expected-revision 255 --expected-database <REHEARSAL_DB> --output <NEW_SECURE_ARTIFACT_JSON>

# Fresh frozen target database, with the production Magento environment configured
$env:DATABASE_URL = '<secret production URL>'
npm run magento:binding-transfer -- import --artifact <ARTIFACT_JSON> --expected-hash <ARTIFACT_HASH> --expected-database <PRODUCTION_DB> --installation <INSTALLATION_KEY> --actor-user-id <LOCAL_USER_ID>
npm run magento:binding-transfer -- verify --revision <IMPORTED_DRAFT_UUID> --expected-database <PRODUCTION_DB>
npm run magento:bindings -- validate --revision <IMPORTED_DRAFT_UUID>
npm run magento:bindings -- publish --revision <IMPORTED_DRAFT_UUID> --expected-revision 1 --expected-current none --actor-user-id <LOCAL_USER_ID>
```

Import uses the target actor/audit boundary, creates or reuses an exact audited
template publication, and creates a **new binding draft only**. It never publishes
the binding. Before mutation it GET-verifies the configured origin, relevant live
schema/topology, approved attribute/option IDs and approved category path/IDs.
Target catalog/source validation then runs inside the import transaction. Relevant
remote drift or target semantic drift fails closed and rolls back the import; an
unrelated schema addition that changes only the global fingerprint is not presented
as approval drift. IDs are never remapped by label.

### Reviewed decisions into a public-SKU draft

When the current published binding and a separately bootstrapped
`magento-declarative-3` / `public-product-identity-v1` draft describe the same
installation, carry reviewed decisions forward with an immutable preflight plan. The CLI uses
the application's configured `DATABASE_URL` or `PG*` / `POSTGRES_*` settings, SSL
and database timeouts; no connection URL needs to be constructed or exported.
Preflight's pool defaults to read-only transactions; apply retains its normal
write transaction and actor/revision/hash guards.

```powershell
cd server
npm run magento:binding-carry-forward -- preflight --expected-database <DATABASE_NAME> --actor-user-id <LOCAL_USER_ID> --source <CURRENT_PUBLISHED_UUID> --source-revision <N> --target <V3_DRAFT_UUID> --target-revision <N> --output <NEW_SECURE_PLAN_JSON>
npm run magento:binding-carry-forward -- apply --expected-database <DATABASE_NAME> --actor-user-id <LOCAL_USER_ID> --plan <PLAN_JSON> --expected-hash <PLAN_SHA256>
```

Preflight is read-only. It matches route, row, target, Amber semantic value or exact
evaluated output, store scope and stable Magento IDs; display labels are checked as
identity evidence rather than used for remapping. An approved source route may
replace a different unreviewed bootstrap set candidate only when that exact set ID
and set name remain present in both frozen observations. Template/domain/source
hashes remain those of the target v3 draft. Reviewed blocked decisions carry only
when the target represents the same unsupported case and diagnostics; a formerly
blocked value that now has a resolved candidate remains new review work.

When current ready samples omitted an approved historical category or dynamic
output, preflight uses bounded named Magento GETs only. A category is synthesized
only when the target still has the same category transport requirement and the live
full tree uniquely returns the approved normalized path and ID. A dynamic evaluated
option is synthesized only under the target requirement's domain identity when the
target observation and a fresh attribute/options GET uniquely retain its exact
output and option ID. Relevant GET evidence is part of the plan hash and is fetched
again before APPLY takes mutation locks. Missing, ambiguous or changed identities
remain blockers. A semantic candidate retaining its option ID but changing label
evidence remains `review_required` and is reported as skipped instead of inheriting
approval.

Apply locks and revalidates the current source publication, both revision counters,
both binding hashes and the complete planned target result before replacing the
target draft decisions. Its audit receipt reports carried approvals, blocks and
policies, deliberate skips and blockers. A retry of the same completed plan is
idempotent. The command does not mutate the published source, publish the draft,
activate public SKUs, create sync work or perform a Magento mutation.

The same reviewed command also accepts an explicit evaluator-5
`effective-product-names-v1` draft based on a public-identity publication. It uses
the successor's exact official names-upgrade equivalence before carrying unchanged
decisions. Existing approved target decisions, explicit blocks, changed selected IDs
and ownership choices remain in that exact draft; a changed route or attribute
identity also prevents inheriting its old child scope. Selecting the same already
approved source ID can inherit approval without another confirmation. The sealed
plan and audit receipt report preserved draft decisions and bind the original
target counter/hash, so a later manual edit stales the plan. There is no draft
regeneration, whole-package approval or publication. Unsaved browser fields are
outside database evidence and remain under the existing dirty-navigation guard.

`extend` uses the draft's pinned evaluator and existing bootstrap/resolver logic.
It GET-checks the live schema against the frozen fingerprint and rejects drift;
it never replaces observation rows or refreshes carried Magento IDs. Category
paths come from current GET evidence. Only selected disabled, unreviewed routes
with no existing attribute decisions can receive candidates; all other decisions
remain unchanged. No new candidate or ownership policy is automatically approved.
The final save uses the original draft counter, so a concurrent edit conflicts.
Dynamic outputs retain `unknownOutputPolicy=block`; approving one observed size
never approves other sizes. Review, explicit ownership decisions and GET-only
full preview follow separately. These commands do not publish or write Magento.
Publication revalidates source evidence and complete coverage while locked, checks
the caller's current-publication ID, and commits publication attribution and
`magento_binding.published` together. Audit failure rolls back the publication.
Concurrent publications of separate drafts based on the same current revision
produce one winner and a conflict; identical completed retries return the original
receipt without a second audit event, even after supersession. Competing updates
use the expected draft counter; stale work never overwrites the winner.

Database triggers reject UPDATE/DELETE of every published revision and child,
late child INSERTs, parent reassignment, revision counter regression, and TRUNCATE.
Child writers lock the parent row, serializing even direct SQL against publication.
Option decision writes require Read Committed isolation, as used by the mutation
boundary: after a parent-lock wait, the cardinality guard must see the preceding
writer's committed rows. Other isolation levels reject option writes instead of
checking an old snapshot. Read-only validation still uses Repeatable Read.
Schema observation UPDATE/DELETE is rejected in drafts too. There is no deletion
workflow; test teardown drops only disposable schemas. These protections do not
replace server-side semantic/coverage validation.

### Routes, option identities and ownership

Routes are derived from the pinned evaluator's semantic predicates, sorted into
stable keys such as `SV.souvenir=value_id:5` and
`SV.souvenir!=value_id:5`; an unconditional group uses `BR:all`.
The database recomputes the key from the group and canonical predicate conjunction;
predicate or template-array ordering cannot assign a different identity to that
same conjunction. The key survives read/update/publication unchanged.
The audit array index (`SV:5`) and CSV set name never participate in route identity.
Unsupported or duplicate route analysis fails closed. The chosen set ID is separate
from the recorded `evaluatorSetName` evidence (SQL `evaluator_set_name`), derived from
the pinned template's historical `attribute_set_code` output. The service verifies
that evidence but never requires it to name the chosen REST set. Binding creation
never changes export output. Set names and option labels are display evidence only.

An attribute binding identifies the stable route, evaluator row (`base`/`english`)
and target. Supported strategies are `scalar`, `semantic_option`,
`dynamic_exact_label_option`, `numeric_band_option`, `constant_option` and
`transport_control`, derived using existing mapper introspection and observed input
types. This phase preserves the evaluator target's attribute code; arbitrary EAV
target renaming is rejected. Native/CSV transport controls instead have a separate
`transportTarget`, with no EAV code or option binding. This declares a future adapter
decision; it does not translate or send a REST payload.

Semantic options use **Amber group + question key + `valueId`**. Optional
`skuCodeEvidence` is display evidence and never participates in identity or lookup.
The server checks authoritative current non-SKU or historical SKU semantic evidence
on publication. `optionId` is always a separate opaque Magento identity.

Evaluated options have `sourceKind: "evaluated"`, `domainKey`, `outputKey`, and
`evaluatedOutput`, with no Amber value fields. The domain hash binds the complete
frozen definition and route-group/row/target expression; the output key is the exact
evaluator output string. It is **not** a Magento label match. Numeric bands retain
the existing evaluator's intervals/outside behavior; dynamic sizes can explicitly
bind individual output strings. Every such mapping is ID-based and reviewable.
`unknownOutputPolicy: "block"` is mandatory: an open dynamic domain is never claimed
fully enumerated, and future consumers must block unlisted outputs without choosing
an option by label. Finite numeric-band outputs require a complete set of explicit
approved or blocked decisions.
An enabled dynamic binding requires at least one explicit output decision; this
reviewed list does not establish coverage of every current or future product.
Mixed/unknown semantic output domains cannot be approved; the whole attribute may
instead be explicitly blocked. Arbitrary target renaming and unprovable mixed-domain
transformations remain deferred. Neither restriction rejects a proven semantic
many-to-one collapse.

Ownership policies are separate from identity and do not execute updates:

- `authoritative_create_update`: proposed future Amber ownership on both operations;
- `initialize_create_only`: proposed initialization only;
- `magento_managed`: preserve the remotely managed value;
- `blocked`: an explicit decision that the field/scope is unsupported or unmanaged
  by this binding; future resolution must fail closed if it requires that field.

Every potentially populated enabled attribute/control requires an explicitly
reviewed policy and store scope. A final `blocked` policy uses review state `blocked`;
the other final policies use `approved`. Proposed/review-required policies remain
unresolved. `all` represents the explicit global context, not a wildcard over view
rows; it has no store ID. Other codes must identify an observed active store view,
with a composite FK pinning its ID/code/kind to this revision's observation. No
Main→UA or EN role is inferred. Multiple
policies may target distinct scopes; competing row writes to the same target/scope
are rejected by a database unique key as well as service validation. Policy changes
in a new draft never redefine semantic option identities. Policies are not
automatically approved, including merchandising fields.

### Review and fail-closed publication

Route, attribute, option and policy review states are `proposed`, `review_required`,
`approved` (in draft) and `blocked`. Evidence permits only bounded notes, diagnostic
codes, artifact hashes, sample counts and candidate IDs. Candidate labels, sample
agreement and supplied notes cannot approve a row or substitute for an ID.
`proposed` and `review_required` are undecided. `approved` authorizes an explicit
identity/policy in the snapshot. **`blocked` is a reviewed refusal, not an unresolved
candidate:** it can publish without inventing a missing Magento ID. Future product
resolution must reject a product requiring a blocked decision; this phase implements
no resolver, sync or writes. Nothing converts existing candidates to blocked or
approved automatically.

Publication derives potentially populated targets and finite output requirements
from the exact template and conservative route analysis. It does not trust a caller's
`required` flag. Missing rows, unresolved/review-required IDs or policies, incompatible
strategies, absent observed schema IDs, missing set membership and invalid source
identity all block. Optionality alone is not proof that a mapping is unreachable.
Disabled routes and descendants of an explicitly blocked route/attribute may retain
unresolved decisions because their entire ancestor scope is excluded. Other required
decisions must be approved or explicitly blocked. A blocked option does not exclude
other options or excuse their review. Existing template source
validation remains conservative across the full publication, even for disabled groups.

Unenumerated semantic values may be recorded as review-required with null
`evaluatedOutput` and null `optionId` (for example AR current-only sizes). They cannot
be approved, and review-required entries still prevent enabled-scope publication.
They may be explicitly blocked if the source belongs to the evaluator target and
the semantic ID exists in current or historical Amber evidence. Only such refusals
may use current-only SKU identity; approved SKU mappings still require historical
published identity. An arbitrary group/question/value claim or a known output hidden
behind a null placeholder is rejected. Dynamic sources cannot use these semantic
placeholders. The Phase 1B.2b CLI below derives these candidates without approving them.

### Explicit, read-only drift comparison

[`binding-drift.js`](../server/src/services/magento/binding-drift.js) provides pure
`compareSchema(revision, observation)` and explicit
`compareRevision(id, config, options)`. The latter reads a coherent stored revision,
checks the configured origin hash before any request, and runs the existing bounded
GET-only schema audit in the recorded observation scope. It requests no products,
writes no database rows and never revises an approval or a published snapshot.

Diagnostics include missing sets/attributes/options, changed attribute ID/type/scope,
lost set membership, changed set/attribute names, option-label drift, store-topology
drift and schema-fingerprint drift. Missing/replaced IDs have `missing_identity`
severity; fingerprint changes alone are review evidence, not identity replacement.
**Same attribute and option IDs + changed label means identity unchanged**;
the diagnostic preserves that ID and both observed labels. A replacement option with
the old label cannot repair a missing approved ID. A replaced attribute ID does not
lend its old option identities to its replacement. Fingerprints use normalized,
deterministically ordered observations and include option labels/topology. Sequential
GETs are not an atomic remote snapshot; this is explicit comparison, not monitoring.

### Compatibility findings constraining later phases

The table below preserves the earlier compatibility baseline. The bounded review
on 2026-09-28 later in this guide reran these cases; KL inclusion is now explicitly
approved in the published KL revision. Samples establish review evidence, not
universal catalog rules or approval:

| Case | Observed evidence and required decision |
| --- | --- |
| SV stone (`souvenir=5`) | The evaluator predicts `154 / Камінь`; all 20 found sampled products used `151 / Сувеніри`, none used 154. Fields included `decor_weight`, `rozmir_suveniriv`, `suveniry`, `kamin_obrobka`, `kamin_suvenirnyi`, `kolir`, `typy_obrobky_burshtynu`, `fraction`; several are absent from set 154. Production convention strongly favors 151 in this sample, but **neither set is approved**. Keep the route decision review-required. |
| CH dimensions | 10/10 sampled products reverse the current evaluator's `bead_length → dovzhyna_namystyny`, `bead_width → diametr_namystyny`. Preserve Amber meaning; historical remote reversal and malformed spreadsheet-like `rozmir_kameniu` values are legacy compatibility evidence, not transformations to imitate. Future corrections need a separate policy. |
| AR size 28 | Semantic `value_id=28`, label `15x15`, mapper output `15×15`; two current products, neither found remotely, and no option candidate. Keep unresolved. |
| AR sizes 29–31 | Current-only semantic values, zero current usage, no historical published presence, no enumerated mapper output and no remote candidate. Do not invent bindings. |
| KL inclusion | Amber `addit=1` means `Є інклюз`; output `Інклюз`; observed `kulony_dodatkovo` option `6047 / Інзклюз`. Yet all 10 sampled existing products had the field unset/null. 6047 remains candidate evidence requiring explicit review. |
| SV subtype | The bounded local scan found no ready witness. Mappings remain unresolved; absence of a witness proves no broader conclusion. |
| Store/merchandising | `all` and `ua` often agree, `en` has localized values; equality does not prove inheritance. Names often match BR/NM/KL/CH templates but not universally (notably AR). SEO and description fields often contain richer maintained remote content. Do not choose template overwrite policies from these observations. |

Live IDs above document one installation and are never migration seeds. The Phase
1B.2b CLI below discovers candidates from current GET evidence; explicit approvals,
blocked decisions and field/store ownership remain operator actions. Admin routes
remain deferred; explicit publication cloning and bounded draft extension are
documented in the lifecycle section above. The durable CLI synchronization writer is now
implemented below; its first real success is recorded at the top of this guide.
Automated implementation tests use synthetic bindings in disposable PostgreSQL.

## Single-product synchronization dry run

Sync eligibility is reported separately in `syncEligibility` and the CLI summary.
An active, current product with an exact existing Magento SKU may UPDATE despite
the legacy `hold/prior_exposure` route and its `unknown` business marker/projected
export flag. This exception never applies to CREATE. Archived/corrected products,
successor-linked predecessors, retired lifecycle rows, explicit business exclusion,
intentional-exclusion holds, persisted independent-exclusion evidence and recount
compatibility exclusions still block all operations. Other unresolved holds or
unexplained exclusions remain fail-closed. The preview reads the authoritative
typed lifecycle signals without changing them or the old export queue selectors;
the exact reason and unchanged legacy state remain in the artifact.

For `historical_ambiguity`, use the explicit
[exposure-only reconciliation command](FULL_PRODUCT_CUTOVER_RUNBOOK.md#exact-magento-sku-evidence-exposure-only-reconciliation).
An exact live SKU match can justify `hold/prior_exposure` for an otherwise
unexcluded ordinary current product. Preview is read-only, apply is single-plan
and audited, and neither operation acknowledges a legacy export. Correction
lineage, unknown exclusion provenance and conflicting reservations require their
own reconciliation and remain blocked.
The same CLI now supports bounded `--bulk --candidates FILE` planning and explicit
manifest/hash-bound `--bulk --apply`. It delegates every transition to the same
single-product transaction, checkpoints a durable per-ID summary and resumes
from immutable audit receipts. See the [bulk operator contract](FULL_PRODUCT_CUTOVER_RUNBOOK.md#bounded-bulk-exposure-planning-and-resumable-apply).

The next executable milestone is [`magento:sync-preview`](../server/scripts/magento-sync-preview.js).
It creates a concrete future ProductRepository-shaped payload and a readable report
for **one real Amber product**, using live GETs only. It does not create exports,
acknowledge delivery, change product/lifecycle state, approve bindings, run migrations,
or call any Magento mutation. There is no `--apply` flag. The earlier foundation's
no-resolver description refers to that historical phase; this command now consumes
its existing binding model without changing migration 041.

Run manually from the configured server checkout:

```sh
cd server
npm run magento:sync-preview -- --sku "KL3/11131351005"
# Alternatively select exactly one local ID:
npm run magento:sync-preview -- --product-id 1234
# Explicit draft or published binding, with its pinned template:
npm run magento:sync-preview -- --sku "KL3/11131351005" --binding-revision "<revision UUID>"
# Explicit immutable template, without a binding revision:
npm run magento:sync-preview -- --sku "KL3/11131351005" --template-version "<publication UUID>"
```

The same command can run through `docker compose exec server npm run ...`.
Default dispatch uses the existing system mapper; selection/activation metadata does
not silently choose a publication or binding. `--binding-revision` explicitly selects
a draft or publication, verifies installation origin and observation scope, and uses
its exact immutable template. If both revision and template are supplied, they must
agree. IDs are UUIDs. `--store-code CODE` selects the observed REST scope (default
`all`); it does not translate the evaluator's base row into an English row or approve
base/EN store ownership. `--help` connects to neither database nor Magento.

The cohesive pipeline is:

1. Select one Amber row by parameterized exact SKU or ID and reject duplicate SKUs.
   Read product answers, final stored price, catalog, historical support inputs,
   optional binding revision and pinned template in one repeatable-read **read-only**
   transaction. Finish that snapshot before remote reads. No startup/seed path runs.
2. Evaluate with the existing compiled template evaluator; introspect its sources,
   routes and Phase 1B.2a requirements. Evaluator failures become blockers while
   available values continue through the preview.
3. Discover the live bounded Magento schema, compare persisted observation drift,
   resolve route/attribute/option identities, and exact-query the unmodified SKU.
   One found counterpart means `UPDATE`; a verified zero result means `CREATE`.
4. GET the category tree for each distinct discovered store-group root. Resolve
   template paths and compare current native assignments. Build the REST-shaped
   candidate, semantic diff, preservation decisions, warnings and blockers.
5. Exclusively create repository-root
   `.artifacts/magento/sync-preview-<SKU-safe>-<UTC>.json`. Slash/unsafe filename
   characters become underscores; the actual SKU remains unchanged. Existing files
   are never overwritten. Artifacts are ignored operational evidence. In a container,
   copy the file out before replacing the container.

The terminal summary includes product, CREATE/UPDATE, set ID/name/authority, option
and category counts, preserved/changed fields, warnings, explicit blockers,
SENDABLE YES/NO and the artifact path. A successfully produced blocked preview exits
0; invalid selection, unsafe/malformed evidence, connectivity/schema failure or an
existing artifact exits 1 with a sanitized error. Category-tree access failures are
reported as blockers while the attribute preview continues. Raw product records,
unrelated attribute values, credentials, headers and tokens are not retained.

### Resolution and authority

Attribute sets are independent of catalog categories. The report includes Amber
group/semantic route, evaluator-predicted name, exact live set-name matches, persisted
decision, selected candidate and current product set. Without an approved route, an
exact matching set is only `candidate_only` and blocks sendability. For SV souvenir 5,
the earlier 20/20 set-151 observation is explicitly historical review evidence; it
never selects 151 or overrides today's evaluator/persisted route.

Persisted `approved`, `blocked`, `review_required` and `proposed` states are retained.
Live IDs must still exist; selected-route identity/metadata/label drift requires
review. A missing approved option is not repaired by a replacement label match.
Without approval, the existing exact-label/spelling-evidence resolver may populate
a candidate option ID, always labelled `candidate_only`. Empty/ambiguous/missing
options stay unresolved. Scalar, semantic, dynamic exact-label, numeric-band and
native transport strategies reuse the evaluator and binding contract. Semantic
`value_id`, `sku_code` evidence and Magento IDs remain separate.

Every base output field reports sources, evaluated value, strategy, attribute code/ID,
option ID/label, current value/resolved label, authority, set applicability and change
status. Blank outputs do not clear remote fields. KL inclusion typo evidence stays
candidate-only without persisted approval. AR unsupported sizes block sendability
without invented IDs. CH uses current Amber dimensions and size text; historical
reversal/malformed remote size is a legacy mismatch. Comparisons distinguish exact,
numeric-equivalent formatting, rounded legacy values and semantic differences.

### Taxonomy and safe preservation

#### Explicit KL inclusion category action

`magento:category` supports `Default/Кулони/З інклюзом`, with the reviewed
source `KL.addit=value_id:1`. It does not change the frozen export evaluator's
legacy presence expression. The product preview offers this action for value 1.
The six existing KL paths retain their individually approved identities.
The separate closed SV stone action is documented under
[literal SV identity and controlled stone category](#literal-sv-identity-and-controlled-stone-category).

Run from `server/` to inspect the live exact parent/child lookup and intended POST:

```powershell
npm run magento:category -- --revision 4d563554-bfe3-4d01-9df5-225aa5b61d48 --path "Default/Кулони/З інклюзом"
```

Without `--apply` this performs GETs only and changes no local binding. To explicitly
create/bind, add `--apply --expected-revision <current-counter> --actor-user-id <local-user-id>`.
It requires a draft for the configured origin/all scope, an approved KL route,
category ownership, and the approved full-path parent identity. Missing or ambiguous
parents/children fail closed; no leaf matching, arbitrary names or recursive trees.
The operation uses Magento's [category repository POST contract](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Catalog/etc/webapi.xml):
`{category:{parent_id:<live exact ID>,name:"З інклюзом",is_active:true,include_in_menu:false}}`.
It creates an active category outside navigation; it assigns no products.

Remote dispatch requires the existing `export_templates.publish` capability;
binding persistence uses `export_templates.manage`. An immutable
`magento_category.create_attempted` audit record commits before POST, keyed by
origin/full path and serialized by the existing access-admin database lock.
Concurrent callers sharing this database, even on different revisions, cannot
dispatch the operation twice. A second precheck precedes the sole POST. A fresh
GET of the complete hierarchy must verify the created/existing ID and parent before
the exact category binding is approved in migration 041's existing evidence.
Successful retries return the existing ID without another POST or binding update.

A timeout, crash, failed verification or local save failure never causes an automatic
POST retry. Rerun performs an exact GET lookup and can bind a verified existing child.
If a prior attempt exists but the child is still absent, it stops with
`MAGENTO_CATEGORY_PREVIOUS_ATTEMPT_UNRESOLVED`; there is no force/reset flag.
This favors preventing duplicate dispatch over retrying an uncertain write. Magento
does not supply a full-path conditional-create/idempotency contract; independent
admin tools or another Amber database are outside this lock. Do not concurrently
create this path through another writer. Ambiguous results always remain blocked.
No category deletion, product write, binding publication or export-state change occurs.

Category paths are compared by complete root-to-node hierarchy with per-segment
trim/NFC normalization, preserving case and spelling. There are no leaf-name matches,
guessed root aliases or category-to-attribute-set rules. Duplicate full paths stay
ambiguous; missing required paths block an authoritative taxonomy update without
discarding the remaining preview. IDs are Magento installation identities. The
category transport binding can now hold explicitly reviewed category-ID evidence
under migration 041's bounded JSON evidence contract. Approved paths become
authoritative only when the fresh full-path lookup remains unique with the same ID.
Changed or missing identities block the category operation. Ownership remains separate.

Current assignments use `extension_attributes.category_links` (IDs and positions),
with `custom_attributes.category_ids` as read evidence when links are absent. Missing
assignment evidence is unknown, not empty. Contradictory representations fail closed.
Positions follow Magento's [CategoryLinkInterface](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Catalog/Api/Data/CategoryLinkInterface.php)
`int|null` contract: negative ordering positions are valid and retained exactly.
Null/omitted positions remain unknown and block the category payload without aborting
the other preview domains. Category IDs still require positive identities.
The report shows requested/current paths, intersection, additions, hypothetical
full-ownership removals and Magento-only categories. By default those extras are
`preserve_by_safe_preview`; candidate links are the union, retaining their positions.
New links have provisional position 0. When positions/assignments are unknown, the
category payload is omitted. Only an approved persisted `authoritative_create_update`
policy for the category target allows a full replacement candidate; unresolved IDs
still block sending it.

Existing `description`, `short_description`, `meta_title` and `meta_description`
are omitted from the update payload unless an explicit approved field policy permits
Amber ownership. A different existing `name` is likewise preserved and produces
`ownership_review_required`; both values remain in the diff. Approved
`magento_managed` and update-time `initialize_create_only` policies preserve fields;
blocked policies never produce mutations. New products use the evaluated name and
show optional template merchandising content separately pending ownership. These
fallbacks are preview behavior only and are never persisted as approved policies.

### Candidate payload and sendability

`candidatePayload.product` is the exact currently constructible future REST-shaped
product object. It may contain candidate IDs or fields requiring review; its presence
is **not approval to send**. Required unresolved values are omitted and diagnosed.
`sendability` separately reports `{sendable, scope: "complete_sync_plan", blockers}`;
top-level `sendable`/`blockers` mirror it. Warnings describe preserved content,
formatting differences and legacy remote evidence, not approval failures.

`sendability.operations` contains `coreProduct`, `categories`, `inventory`, `websites`
and `storeViews`, each with its own `sendable` and `blockers`; `sendability.overall`
retains the complete-plan result. Blockers carry an `operation`. Product exclusion
and non-current-product blockers apply to `all` operations; category and transport
blockers do not affect core readiness. The core operation includes its
exact `candidatePayload` with category links omitted; the category operation reports
its separate `candidateLinks`. The top-level payload remains the combined inspection
candidate. These are planning results, not executable operations or approvals.

Required EAV fields use live `apply_to` metadata and the candidate product type:
an empty list applies to all types, and missing metadata never exempts a required
field. Downloadable/Bundle-only requirements therefore do not block a simple product.
The report includes `requiredAttributes` with applicability evidence. This follows
Magento's [product-type applicability contract](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Catalog/Model/Product/Type/AbstractType.php).
CREATE recognizes the built-in static `created_at` and `updated_at` date attributes
as Magento-generated only when live metadata also says non-user-defined and invisible.
The report records `valueSource: magento_generated_on_create`; no timestamp is sent.
Unknown metadata, other required attributes and UPDATE checks remain strict. See the
Magento [Created](https://github.com/magento/magento2/blob/2.4.7/app/code/Magento/Eav/Model/Entity/Attribute/Backend/Time/Created.php)
and [Updated](https://github.com/magento/magento2/blob/2.4.7/app/code/Magento/Eav/Model/Entity/Attribute/Backend/Time/Updated.php) backends.
Fixed mapper literals such as `old_product=No` and `is_ownproduction=Yes` use the
observed standard [Boolean source](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Eav/Model/Entity/Attribute/Source/Boolean.php)
and verified live option values `0`/`1`, independent of translated labels. This is
native control translation, not an Amber semantic option binding. Unknown sources,
missing native values, semantic answers and candidate-only options keep their review
boundaries; field ownership still applies to changed controls.

`AMBER_PRODUCT_EXCLUDED` includes the exact blocking predicate. `syncEligibility`
retains the product's persisted export state (business exclusion, route/hold reason
and recount compatibility), read in the same read-only Amber snapshot. An unknown
business marker remains visible even when the exact-SKU prior-exposure UPDATE
exception applies; no historical state or export eligibility is changed.

Native translations include attribute-set ID, simple `type_id`, numeric price/status,
and visibility (`Catalog, Search` → 4). Options use live Magento values. CSV routing,
website and stock columns never become fake custom attributes. Category links use
the native extension contract. See Magento 2.4.6's
[Catalog REST routes](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Catalog/etc/webapi.xml),
[product category/website extensions](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Catalog/etc/extension_attributes.xml)
and [stock extension](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/CatalogInventory/etc/extension_attributes.xml).

Inventory, websites and EN now have separate GET-only operation previews in
`transport` and `sendability.operations.<domain>.plan`. Missing evidence or unapproved
bindings/policies block that operation without hiding the core payload. The preview never writes; the separate durable CLI below requires a published binding
and explicit `--apply`. Sendability alone never dispatches a mutation.

- **Inventory:** approved `qty` and `is_in_stock` identities with
  `initialize_create_only` policies initialize CREATE with quantity 1 and in-stock
  status. UPDATE always preserves every current source quantity/status, including
  zero/out-of-stock; it has no inventory mutation payload. Reads use MSI
  `GET inventory/stock-resolver/website/base`,
  `GET inventory/get-sources-assigned-to-stock-ordered-by-priority/:stockId`, and
  exact-SKU `GET inventory/source-items` search criteria. The report distinguishes
  physical source inventory from reservation-adjusted salable quantity; no reservation
  is changed or inferred. CREATE needs one uniquely resolved enabled source, no orphan
  source items, and approved initialization policies. Ambiguous sources, truncated or
  malformed responses, and failed reads remain blockers. See the
  [MSI source contracts](https://github.com/magento/inventory/blob/1.2.6/InventoryApi/etc/webapi.xml)
  and [stock resolver](https://github.com/magento/inventory/blob/1.2.6/InventorySalesApi/etc/webapi.xml).
- **Websites:** approve `product_websites` and `authoritative_create_update` ownership.
  Live exact website codes must retain their IDs from the binding schema observation.
  Current assignments come from product `extension_attributes.website_ids`. The plan
  ensures required membership with individual `ProductWebsiteLinkRepositoryInterface.save`
  payloads for missing IDs, preserving every additional assignment. It never replaces
  the whole website list. An existing `base` membership produces no operation.
- **EN:** resolve the active exact `en` store view and verify its pinned ID and
  website/group identity. UPDATE reads the same exact SKU via `/rest/en/V1/products`
  search criteria and requires the same product ID. Only produced non-empty values
  with approved identities and `authoritative_create_update` ownership enter the
  scoped diff. Only live store-scoped text/textarea attributes in the selected set
  are supported; unknown/global scopes fail closed. Empty/undefined/whitespace values
  and unproduced fields are preserved. SKU, set, type and store code are identity/
  routing controls with `magento_managed` EN policies; global writes and rename are
  excluded from the EN payload. Unchanged fields are omitted. The current KL frozen
  template produces EN name and `meta_title`; it does not produce `meta_description`,
  so that Magento value remains untouched.

Use `magento:bindings approve-exact` with explicit group/row/targets for resolved
identities, then individual `approve --binding POLICY_REVIEW_ID --policy POLICY
--accept-review --reason "..."` decisions. These reuse migration 041 and the normal
actor/CAS/audit checks; no new revision or publication is required. Validate the same
draft and run `npm run magento:sync-preview -- --sku "KL3/11131351005"
--binding-revision <UUID>` from `server/`. The immutable artifact is still only a plan,
not a durable job, transaction, acknowledgment or cross-system atomic snapshot.

## Phase 1B.2b binding bootstrap and explicit review

Run these commands from `server/`. `magento:bindings` uses the existing migration 041
services, active local-user permission checks, transaction-coupled audit events,
optimistic revision checks and immutable publication guards. No migration or Magento
write API is added. CLI access is trusted local administration with database access;
`--actor-user-id` identifies the existing local application user, never an OIDC subject.
Mutations require `export_templates.manage`; publication requires
`export_templates.publish`. Freezing a system template requires both capabilities.

Bootstrap reads the current catalog, evaluator and bounded real product samples in
a read-only snapshot, discovers live Magento schema and category trees through named
GETs, derives candidates through the existing mapper/requirements/option evidence
logic, and creates a **new** draft with its candidate rows in one transaction.
`--sku` adds one exact product witness; it does not change eligibility or exclusion.
System mode freezes a dedicated immutable template publication because 041 requires
a publication FK. It uses the existing historical source-support policy for AR.size
29–31 and NM.extra numeric-zero placeholders; these are not promoted to supported
semantic identities. Catalog, source evidence and the exact SKU witness are captured
in one read-only snapshot. Normal publication source validation remains mandatory.
Template family/draft, publication, binding candidates and their audit events share
one authorized transaction and all roll back on any precommit failure. No template
activation or binding approval is performed. Existing revisions are never reused or
overwritten by bootstrap. Alternatively pass an existing template version UUID.
Migration 041 must already be installed through the normal migration runner;
bootstrap checks this before any remote request or local mutation and never applies DDL.

Exact set names, attribute codes and unique option labels become `proposed`.
Scalar and native-control identities are included. Missing options become `blocked`;
ambiguous/drift candidates remain `review_required`. KL inclusion stays review-required
even if a future schema label becomes exact. The known SV souvenir route conflict
also stays review-required. Forward migration 043 permits literal numeric Amber
question keys such as `SV.2`; install it before persisting those candidates.
The separate Magento attribute/store-code contract still requires a leading letter.
No Amber semantic ID is replaced by a Magento ID or inferred from `sku_code`.

Category decisions are typed `evidence.categories` entries on each category transport
binding. They contain complete requested/normalized paths, live candidate paths/IDs
and individual review states. They inherit draft CAS, attribution and publication
immutability. Unknown paths stay blocked; ambiguous paths stay review-required.
Category/dynamic output evidence covers evaluated ready product samples (three per
route plus an optional exact SKU), not every hypothetical product combination. An
unobserved category or dynamic output still fails closed in preview. Evidence exceeds
041's bounded JSON capacity only by failing explicitly, never truncating candidates.

Ownership policies are separate review-required preservation suggestions. Exact
batch approval never approves policies, including `product_online` ownership. An
explicit policy decision needs a policy, review acknowledgment and reason. Single
drift-candidate approval likewise needs `--accept-review --reason`; missing or
ambiguous identities cannot be approved without resolved evidence. `block` records
an explicit unsupported decision. An approved binding identity does not make an
excluded product, missing category, or deferred transport operation sendable.

Example PowerShell workflow (replace `$actor` with your active local user ID):

```powershell
$actor = <LOCAL_USER_ID>
$draft = npm run --silent magento:bindings -- bootstrap --installation amber --template-version system --group KL --sku "KL3/11131351005" --actor-user-id $actor --json | ConvertFrom-Json
npm run magento:bindings -- review --revision $draft.id --group KL

# Explicit bounded identity approval; no inclusion, category or ownership approval.
$draft = npm run --silent magento:bindings -- approve-exact --revision $draft.id --expected-revision $draft.revision --actor-user-id $actor --group KL --row base --targets "attribute_set_code,typy_obrobky_burshtynu,vyd_obrobky_kameniu,faktura_kulonu,kolir,vyd_kulonu,rozmir_iuvelirnoho_vyrobu,decor_weight" --json | ConvertFrom-Json

# Individual identity: use its opaque review ID, not a manually entered Magento ID.
# npm run magento:bindings -- approve --revision $draft.id --expected-revision $draft.revision --actor-user-id $actor --binding "<REVIEW_ID>"
# Explicit policy choice (never implied by identity approval):
# npm run magento:bindings -- approve --revision $draft.id --expected-revision $draft.revision --actor-user-id $actor --binding "<POLICY_REVIEW_ID>" --policy magento_managed --accept-review --reason "Preserve maintained Magento content"
# npm run magento:bindings -- block --revision $draft.id --expected-revision $draft.revision --actor-user-id $actor --binding "<REVIEW_ID>" --reason "Explicitly unsupported pending review"

npm run magento:bindings -- validate --revision $draft.id
# Publish only after validation succeeds and all enabled-route decisions are reviewed.
npm run magento:bindings -- publish --revision $draft.id --expected-revision $draft.revision --expected-current none --actor-user-id $actor
npm run magento:sync-preview -- --sku "KL3/11131351005" --binding-revision $draft.id
```

Use the returned revision counter after every edit. `review` prints it; `--json`
returns machine-readable receipts with `ok: true`. On failure stdout contains only
`{"ok":false}`, sanitized error codes/diagnostics go to stderr, and the process exits 1.
Check `$LASTEXITCODE` and `$draft.ok` before using the returned ID. `--expected-current none` asserts there is no
current binding publication; when replacing one, supply its explicit revision UUID.
`validate` exits 2 for incomplete drafts and lists diagnostics; publication fails
closed. The bounded KL approval above is intentionally partial: it does not resolve
other fields, English rows, inclusion, taxonomy or ownership. Sync preview accepts
the **draft immediately**; publication is not necessary for useful approved evidence.

Automated verification uses injected Magento responses and disposable PostgreSQL only.
It does not execute a live preview. No binding approval, production write or commit is
part of this milestone.


### Reviewed dictionary-only refusals

A blocked semantic option with an explicit review note can represent a refusal
without claiming an Amber identity when its exact source/output is enumerated by
the pinned evaluator, every matching frozen question contract excludes the value,
the source has no aliases, and neither current nor historical catalogs contain it.
Validation also reads current active-product usage in its own transaction; any use
keeps `SEMANTIC_IDENTITY_UNRESOLVED`. Missing contracts, conflicting catalogs,
unreviewed/approved mappings and reachable values cannot use this exception.
The existing `CH.texture=value_id:8` refusal is such a dictionary-only entry.
Its remote candidate is never approval. Runtime resolution remains blocked if a
product later supplies the value, including after publication. Known but unsupported
values (such as AR size 28) retain the ordinary explicit blocked-option contract.
No catalog identity, option, migration or evaluator output is manufactured.

AR glass uses the existing evaluated `constant_option` domain for its closed
optional lookup: `glass=1` emits `Зі склом`, while absent glass emits `Без скла`.
Both require separate exact option approvals. This classification requires a
literal absence branch, the same semantic source in the presence check and
question/lookup, error-on-unknown lookup behavior, and captured membership for
every dictionary key. Ordinary publication source validation remains required;
unknown values/outputs remain blocked. Absence never gets a fabricated value ID.

### Literal SV identity and controlled stone category

Migration `043_magento_literal_question_keys.sql` extends only the Amber question-key
grammar in option identities and canonical route predicates. `SV.2=value_id:2`
retains the literal question key `2`; no friendly alias, label-derived source or
frozen template/schema rewrite is involved. Existing source-proof checks, exact
option foreign keys, route membership, CAS/audit and publication immutability stay
in force. Apply through the normal migration runner; migration 041 is unchanged.

The reviewed installed convention uses set **151 / Сувеніри** for both SV routes,
including `SV.souvenir=value_id:5`. This is an explicit draft route decision, never
a new bootstrap default or evaluator change. Stone taxonomy remains under
`Default/Камінь`; set routing does not select category taxonomy.

The closed `magento:category` flow supports exactly the existing KL inclusion path
and **Default/Камінь/Камінь сувенірний** for the stone SV route. Preview is GET-only:

```sh
npm run magento:category -- --revision UUID --path "Default/Камінь/Камінь сувенірний"
# Explicit create/bind only after reviewing preview and current draft counter:
npm run magento:category -- --revision UUID --path "Default/Камінь/Камінь сувенірний" --apply --expected-revision N --actor-user-id ID
```

The route, category ownership and exact parent binding must already be approved.
Fresh full-hierarchy GETs verify parent ID/path and child uniqueness; no arbitrary
path, leaf match or recursive creation is accepted. Durable per-origin/path attempt
reservation precedes POST, and read-after-write verifies identity before the draft
CAS save. Existing exact children are bound without POST; uncertain attempts never
automatically repeat POST, including after a local save failure. No product write,
publication or export acknowledgment is part of this command.

Binding review does not waive SV product readiness. The frozen evaluator requires
saved UA/EN name subjects except for automatic keychains (`souvenir=6`), plus its
existing required characteristics. Missing legacy data stays a product blocker even
when every applicable binding is approved. Category-cell paths can be independently
reviewed against the exact live tree without claiming the whole product is ready.

## Durable product-sync jobs — migration 042

`magento:sync` is the first explicit apply worker. Install migration 042 through the
normal migration runner/startup before using it. It neither publishes bindings nor
runs runtime DDL. The existing `magento:sync-preview` remains GET-only.

From `server/`, with an active local user possessing `export_templates.publish`:

```powershell
# Requires this same UUID to have been explicitly published; a validated draft is rejected.
npm run magento:sync -- --sku "KL3/11131351005" --binding-revision 4d563554-bfe3-4d01-9df5-225aa5b61d48 --actor-user-id 1
# Explicit first apply (reuses the bound job):
npm run magento:sync -- --sku "KL3/11131351005" --binding-revision 4d563554-bfe3-4d01-9df5-225aa5b61d48 --actor-user-id 1 --apply
# Reconcile/resume one durable job without replacing its plan:
npm run magento:sync -- --job <JOB_UUID> --actor-user-id 1 --apply
```

Without `--apply`, the CLI performs live GET discovery/preview and persists the
reviewable exact operations (`--json` includes them). It performs no Magento mutation.
Both enqueue and apply require the installation's current published immutable binding;
a later publication makes an older pending job blocked. Actor checks use the existing
access-admin boundary. The CLI is trusted local administration, not a new HTTP API.

`magento_sync_jobs` stores the product/SKU, origin hash and installation key, exact
publication/hash, authoritative product/lifecycle state hash, immutable intended
operations/hash, minimized baseline and preservation hashes. It records actor,
attempt count, structured failure, remote product ID and final acknowledgement time.
`magento_sync_steps` records each operation's committed dispatch marker and verified
completion. Database triggers prohibit rewriting intent, deleting evidence, resetting
a dispatch or altering success. Audit events commit with queue/step/state transitions.
No credentials, authorization headers or full remote response bodies are persisted.

The planner is **the existing sync-preview evaluator and resolver**. Each attempt
rebuilds its intended operations using current Amber inputs, live schema/category
identities and the immutable original comparison baseline. This prevents our own
partial writes from changing the bound intent. A changed intended plan or loss of
sendability blocks apply. Fresh exact-SKU GETs check identity and each operation's
remote preconditions. Magento-managed fields are omitted and preservation hashes
are checked, including media, unknown attributes/extensions, update inventory and
unproduced scoped EN content. Final acknowledgement also verifies unchanged EN
values and required website memberships, not merely fields sent in the last request.

UPDATE revalidation restores native timestamp evidence omitted by the minimized
baseline: `created_at` must match its original preservation hash, while Magento-owned
`updated_at` is read fresh because saves can advance it. Neither enters a write payload.
Live required-field validation still rejects missing timestamps; changed creation time
still fails preservation. This also supports existing immutable jobs without rewriting
their baseline, intent or plan hash, including retries after verified partial writes.

Operations run in this order, skipping writes already verified as satisfied:

1. Core product repository save; CREATE must have native status 2. UPDATE may not
   contain status at all. SKU rename is unsupported.
2. The planner's exact category links/positions, via a separate product save.
3. MSI source initialization for CREATE only; UPDATE never resets inventory.
4. Individual additive website memberships; never a complete replacement list.
5. Nonempty EN scoped fields, with blanks and unproduced fields preserved.

Product saves use Magento 2.4.6's
[POST repository save](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Catalog/Model/ProductRepository.php)
contract, which resolves an existing SKU before merging data. This avoids encoded
slash product-update paths and preserves omitted status. Categories use its extension
contract; MSI and website operations use their named native endpoints. The writer
has no arbitrary URL/method or delete API, follows no redirect and never retries HTTP.

Enqueue is idempotent for installation/product/publication/Amber state, including
completed retries. A partial unique index prevents competing unfinished SKU jobs.
Apply uses a per-installation/SKU PostgreSQL session lock (duplicate apply returns
`MAGENTO_SYNC_BUSY`), access/lifecycle/publication coordination and product then
lifecycle row locks. These retain local state and publication through remote dispatch;
ledger commits use an independent connection so dispatch evidence survives crashes.
No export/cutover state or legacy queue cursor is advanced.

States are `queued -> running -> succeeded`, or `retryable`, `blocked`, `uncertain`.
A read failure before dispatch can retry safely. Every dispatch marker commits
**before** the HTTP mutation. A crash, timeout, rejected response or verification
mismatch leaves that marker in place. Rerun only reads to reconcile that step: if
its intended result is verified, it advances and can execute later unsent operations;
otherwise it remains unresolved and sends nothing again. There is no force/reset or
automatic uncertain-write retry. Unfinished stale/uncertain jobs require operator
review; the CLI does not discard them to enqueue a replacement. Success requires a
fresh final GET proving all authoritative intended state and preservation checks.

This is not a cross-system transaction: completed remote steps are not rolled back.
Magento's APIs do not provide conditional writes or a cross-client idempotency key.
PostgreSQL coordinates workers using this Amber database; independent Magento admin
writers or another database are outside that lock. Use an exclusive operator window
for the first apply. Read verification detects conflicts but cannot undo an external
race. Encoded-SKU website endpoints can still be rejected by an installation; such a
response is uncertain until exact membership is verified, never silently replayed.

## Remaining-group review 2026-09-28

This section records the earlier candidate-only audit. Its SV numeric-key and
set-routing blockers are superseded by migration 043 and the explicit set-151
decision documented above; its IDs remain evidence, not automatic approval.

This bounded review reused `readAmberEvidence`, `auditMagentoSchema`, the pure
`buildCandidates` bootstrap function, `resolveCategories` and the existing compatibility
audit. It did not call bootstrap persistence, enqueue, publish or APPLY. PostgreSQL
reads were read-only; a fetch guard allowed only GET. There were **180 Magento GETs**
(108 schema, one category tree, 71 bounded product/store-scope observations). Binding
revision rows compared equal before/after. The local ignored evidence is
`.artifacts/magento/remaining-groups-review-2026-09-28.json`.

All identities below are **candidates, not approved bindings**. Option counts count
source-to-option rows, not distinct remote IDs. All field/store ownership still needs
explicit review. Category coverage is the existing three local candidates per route,
not every possible category output. Dynamic sizes need a product-specific preview;
exact labels alone do not prove all numeric values are supported.

| Group / route | Set | Exact option rows | Review-required / missing / compatibility |
| --- | --- | --- | --- |
| BR:all | 142 / Браслети | 29 | No unresolved finite option candidate; dynamic bracelet length only observed as Безрозмірний → 5989. Seven sampled category paths exact. Ownership still undecided. |
| NM:all | 143 / Намиста | 35 | Archived `extra=0` (Не обрано) has no evaluated output/option; bootstrap leaves a blocked placeholder. Preview omits this field only for numeric zero proven by the frozen `numeric-zero-v1` contract and the product's own immutable schema, with empty evaluator output and null binding output/option. The emission decision stays blocked; failed reconstruction, genuine/string zero and emitted values are not exempt. Eleven sampled category paths exact. |
| CH:all | 150 / Чотки | 26 | `count=9` emits `?`, no Magento option. Seven sampled category paths exact. 10/10 remote samples reverse dimensions; 9/10 round weight, and malformed size text occurs. Preserve Amber semantics; historical reversal/rounding is not an approved transform. |
| AR:all | 152 / Картини | 38 | `size=28` → `15×15` missing; two current products, both absent remotely. Current-only `29=75/78`, `30=74x80`, `31=70х70` have no published historical identity, enumerated output or option candidate, and zero current usage. Four sampled category paths exact. |
| SV souvenir≠5 | 151 / Сувеніри | 41 | Numeric source `SV.2` cannot be represented by migration 041 semantic keys: `tematyka_vyrobu` blocked despite exact metadata/labels. Zero ready category witnesses among the three bootstrap samples. Existing provisional paths below match. |
| SV souvenir=5 (stone) | Mapper 154 / Камінь; observed 151 / Сувеніри | 38 label matches; only 17 also have set-154 membership | 20/20 remote samples use 151, none 154. Set choice remains review-required; nine target memberships fail at 154. Same numeric-key blocker. Missing provisional category `Default/Камінь/Камінь сувенірний`. |

**Decisions before approval:** choose field/store ownership per group; explicitly
resolve or refuse NM extra zero, CH count 9 and AR sizes 28–31 without inventing
Magento options. CH remains `bead_length → dovzhyna_namystyny`,
`bead_width → diametr_namystyny`; reviewing changes to legacy remote dimensions, size
format and weight is separate from choosing these meanings. For SV stone, choose
151 versus 154 explicitly: 151 matches all sampled existing products and their
fields, while 154 loses required memberships and conflicts with existing product
sets. No set migration or override is approved by this report. Changing that route
alone does not resolve the numeric semantic-key contract or missing category.
Normal SV also needs supported semantic identity and ready product/name/subtype
evidence: the compatibility scan examined 100 of 771 current candidates and found
no ready subtype witness (671 unexamined). The nine null SV souvenir option
placeholders belong to the opposite route (eight under stone, one under normal);
they are conservative bootstrap review entries, **not nine missing remote options**.

**Smallest next batch:** BR only, one exact existing SKU with observed attributes,
options and categories; explicitly review ownership and GET-only preview first.
When a new draft/publication is later authorized, retain the approved KL scope in
that installation snapshot. Publications are installation-wide: a BR-only successor
would supersede the current KL publication. Do not edit the immutable KL revision.
Proceed to NM, then CH/AR/SV decisions; workflow/UI and CSV cutover follow bindings.

### Exact attribute and option inventory

For each route, base attribute codes below are exact code/membership candidates
with Magento attribute IDs. Native transport controls are separate: set →
`product.attribute_set_id`, type → `product.type_id`, status → `product.status`,
visibility → `product.visibility`, categories → `extension_attributes.category_links`,
websites → `extension_attributes.website_ids`, quantity/stock → inventory; boolean
`old_product` / `is_ownproduction` map to their custom attributes. EN uses the same
identity controls plus its approved produced text, not a second base-row write.

Option notation is `Amber question=value_id → Magento option ID` (with evaluated
label in parentheses), or `evaluated label → ID` for dynamic/band values. An exact
option label under an unresolved/blocked attribute does **not** authorize that field.

#### BR:all

Exact base attributes: `sku` (74), `name` (73), `price` (77), `decor_weight` (1483), `dovzhyna_brasletu_diuimiv` (1479), `typy_obrobky_burshtynu` (1461), `vyd_obrobky_kameniu` (1458), `faktura_namystyn` (1509), `kolir` (1455), `forma_namystyn` (1511), `typ_vykonannia` (1510), `meta_title` (84), `meta_description` (86).

Produced EN text candidates: `name`.

| Target | Exact source/output → option ID candidates |
| --- | --- |
| `dovzhyna_brasletu_diuimiv` | `Безрозмірний` → `5989` |
| `typy_obrobky_burshtynu` | `raw_type=1` → `5693` (Натуральний); `raw_type=2` → `5694` (Формований) |
| `vyd_obrobky_kameniu` | `processing=1` → `5683` (Полірований); `processing=2` → `5682` (Шліфований) |
| `faktura_namystyn` | `texture=8` → `5945` (Змішана); `texture=3` → `5944` (Матова); `texture=6` → `5944` (Матова); `texture=2` → `5943` (Напівпрозора); `texture=5` → `5943` (Напівпрозора); `texture=7` → `5988` (Пейзажна); `texture=1` → `5942` (Прозора); `texture=4` → `5942` (Прозора) |
| `kolir` | `color=4` → `5747` (Комбінований); `color=3` → `5674` (Пейзажний); `color=1` → `5670` (Світлий); `color=2` → `5671` (Темний) |
| `forma_namystyn` | `shape=2` → `5950` (Бочка); `shape=5` → `5953` (Галька); `shape=6` → `5954` (Геометрія); `shape=7` → `5984` (Змішана); `shape=1` → `5949` (Куля); `shape=3` → `5951` (Оливка); `shape=4` → `5952` (Сегменти) |
| `typ_vykonannia` | `style=1` → `5947` (Класичний); `style=2` → `5948` (Комбінований); `style=3` → `5948` (Комбінований); `style=4` → `5948` (Комбінований); `style=5` → `6059` (Шамбала) |

Exact sampled category paths (three ready local witnesses):

- `Default/Браслети` → `3`.
- `Default/Браслети/Браслети з цільного каменю бурштину` → `288`.
- `Default/Браслети/Браслети з полірованими намистинами` → `289`.
- `Default/Браслети/Браслети з змішаною фактурою намистин` → `296`.
- `Default/Браслети/Браслети світлого кольору` → `291`.
- `Default/Браслети/Браслети з намистинами: змішана форма` → `298`.
- `Default/Браслети/Шамбала` → `647`.

#### NM:all

Exact base attributes: `sku` (74), `name` (73), `price` (77), `dovzhyna_namysta_tochna` (1521), `decor_weight` (1483), `dovzhyna_namysta` (1462), `typy_obrobky_burshtynu` (1461), `vyd_obrobky_kameniu` (1458), `faktura_namystyn` (1509), `kolir` (1455), `forma_namystyn` (1511), `typ_vykonannia` (1510), `dodatkovo_namysta` (1512), `meta_title` (84), `meta_description` (86).

Produced EN text candidates: `name`, `meta_title`, `meta_description`.

| Target | Exact source/output → option ID candidates |
| --- | --- |
| `dovzhyna_namysta` | `Колар (30-35 см)` → `5695`; `Матіне (50-63 см)` → `5698`; `Опера (66-91 см)` → `5699`; `Принцеса (43-48 см)` → `5697`; `Роуп (120-180 см)` → `5700`; `Чокер (35-40 см)` → `5696` |
| `typy_obrobky_burshtynu` | `raw_type=1` → `5693` (Натуральний); `raw_type=2` → `5694` (Формований) |
| `vyd_obrobky_kameniu` | `processing=1` → `5683` (Полірований); `processing=2` → `5682` (Шліфований) |
| `faktura_namystyn` | `texture=8` → `5945` (Змішана); `texture=3` → `5944` (Матова); `texture=6` → `5944` (Матова); `texture=2` → `5943` (Напівпрозора); `texture=5` → `5943` (Напівпрозора); `texture=7` → `5988` (Пейзажна); `texture=1` → `5942` (Прозора); `texture=4` → `5942` (Прозора) |
| `kolir` | `color=4` → `5747` (Комбінований); `color=3` → `5674` (Пейзажний); `color=1` → `5670` (Світлий); `color=2` → `5671` (Темний) |
| `forma_namystyn` | `shape=2` → `5950` (Бочка); `shape=5` → `5953` (Галька); `shape=6` → `5954` (Геометрія); `shape=7` → `5984` (Змішана); `shape=1` → `5949` (Куля); `shape=3` → `5951` (Оливка); `shape=4` → `5952` (Сегменти) |
| `typ_vykonannia` | `style=1` → `5947` (Класичний); `style=2` → `5948` (Комбінований); `style=3` → `5948` (Комбінований); `style=4` → `5948` (Комбінований) |
| `dodatkovo_namysta` | `extra=2` → `5990` (Дитяче); `extra=1` → `5955` (З підвісками) |

Exact sampled category paths (three ready local witnesses):

- `Default/Намиста` → `4`.
- `Default/Намиста/Намиста з цільного каменю бурштину` → `284`.
- `Default/Намиста/Намиста з шліфованими намистинами` → `264`.
- `Default/Намиста/Намиста з матовою фактурою намистин` → `263`.
- `Default/Намиста/Намиста комбінованого кольору` → `274`.
- `Default/Намиста/Намиста з намистинами: галька` → `279`.
- `Default/Намиста/Класичні намиста` → `282`.
- `Default/Намиста/Намиста темного кольору` → `270`.
- `Default/Намиста/Намиста з полірованими намистинами` → `64`.
- `Default/Намиста/Намиста з прозорою фактурою намистин` → `266`.
- `Default/Намиста/Намиста з підвісками` → `73`.

#### CH:all

Exact base attributes: `sku` (74), `name` (73), `price` (77), `dovzhyna_namystyny` (1503), `diametr_namystyny` (1504), `dovzhyna_vyrobu` (1505), `vaha_vyrobu` (1506), `rozmir_kameniu` (1513), `typy_obrobky_burshtynu` (1461), `faktura_namystyn` (1509), `kolir` (1455), `forma_namystyn` (1511), `relihiina_prynalezhnist` (1514), `kilkist_namystyn` (1507), `meta_title` (84), `meta_description` (86).

Produced EN text candidates: `name`.

| Target | Exact source/output → option ID candidates |
| --- | --- |
| `typy_obrobky_burshtynu` | `raw_type=1` → `5693` (Натуральний); `raw_type=2` → `5694` (Формований) |
| `faktura_namystyn` | `texture=8` → `5945` (Змішана); `texture=3` → `5944` (Матова); `texture=6` → `5944` (Матова); `texture=2` → `5943` (Напівпрозора); `texture=5` → `5943` (Напівпрозора); `texture=7` → `5988` (Пейзажна); `texture=1` → `5942` (Прозора); `texture=4` → `5942` (Прозора) |
| `kolir` | `color=3` → `5674` (Пейзажний); `color=1` → `5670` (Світлий); `color=2` → `5671` (Темний) |
| `forma_namystyn` | `shape=2` → `5950` (Бочка); `shape=1` → `5949` (Куля); `shape=3` → `5951` (Оливка) |
| `relihiina_prynalezhnist` | `religion=1` → `5956` (Мусульманські); `religion=2` → `5957` (Християнські) |
| `kilkist_namystyn` | `count=0` → `5913` (30); `count=1` → `5914` (33); `count=2` → `5917` (39); `count=3` → `5920` (45); `count=4` → `5924` (51); `count=5` → `5926` (66); `count=6` → `5928` (75); `count=7` → `5929` (99) |

Exact sampled category paths (three ready local witnesses):

- `Default/Чотки` → `7`.
- `Default/Чотки/Чотки з цільного каменю бурштину` → `82`.
- `Default/Чотки/Чотки з прозорими намистинами` → `256`.
- `Default/Чотки/Чотки світлого кольору` → `97`.
- `Default/Чотки/Чотки з намистинами у формі бочки` → `87`.
- `Default/Чотки/Християнські чотки` → `85`.
- `Default/Чотки/Чотки на 30 намистин` → `89`.

#### AR:all

Exact base attributes: `sku` (74), `name` (73), `price` (77), `kartynyy` (1470), `rozmir_kartyny` (1480), `sklo` (1501), `dodatkovo_kartyny` (1520), `kartyny_pidsvitka` (1532), `meta_title` (84), `meta_description` (86).

Produced EN text candidates: `name`.

| Target | Exact source/output → option ID candidates |
| --- | --- |
| `kartynyy` | `type=1` → `5721` (Ікони); `type=7` → `5725` (Мозаїка); `type=5` → `5727` (Натюрморти); `type=3` → `5724` (Панно); `type=2` → `5723` (Пейзажі); `type=6` → `5934` (Портрети); `type=4` → `5935` (Символіка) |
| `rozmir_kartyny` | `size=24` → `6033` (100×100); `size=1` → `5802` (10×15); `size=22` → `6030` (110×50); `size=27` → `6045` (110×60); `size=25` → `6035` (120×150); `size=26` → `6036` (120×180); `size=2` → `5804` (15×20); `size=3` → `5803` (15×40); `size=4` → `5805` (20×20); `size=5` → `5806` (20×30); `size=21` → `6021` (22×26); `size=6` → `5899` (30×30); `size=7` → `5940` (30×40); `size=8` → `5903` (30×50); `size=9` → `5941` (30×60); `size=23` → `6031` (40×100); `size=10` → `5907` (40×40); `size=11` → `5909` (40×60); `size=12` → `5911` (40×80); `size=13` → `5974` (50×50); `size=14` → `5975` (50×70); `size=15` → `5976` (60×80); `size=16` → `5977` (60×90); `size=18` → `5979` (70×100); `size=19` → `5980` (70×140); `size=20` → `5981` (80×120); `size=17` → `5978` (80×80) |
| `sklo` | `glass=1` → `5888` (Зі склом) |
| `dodatkovo_kartyny` | `additional=2` → `5983` (На бархаті); `additional=1` → `5982` (На полотні) |
| `kartyny_pidsvitka` | `backlight=1` → `6041` (З підсвіткою) |

Exact sampled category paths (three ready local witnesses):

- `Default/Картини` → `21`.
- `Default/Картини/Натюрморти` → `223`.
- `Default/Картини/Символіка` → `33`.
- `Default/Картини/Мозаїка` → `224`.

#### SV.souvenir=value_id:5

Exact base attributes: `sku` (74), `name` (73), `price` (77), `kamin_obrobka` (1531), `kolir` (1455), `fraction` (1534).

Produced EN text candidates: `name`.

Unresolved/blocked attributes: `decor_weight` (review_required), `rozmir_suveniriv` (review_required), `suveniry` (review_required), `tematyka_vyrobu` (blocked), `vyd_ptakha` (review_required), `vyd_roslyny` (review_required), `vyd_symvoliky` (review_required), `kamin_suvenirnyi` (review_required), `typy_obrobky_burshtynu` (review_required).

| Target | Exact source/output → option ID candidates |
| --- | --- |
| `suveniry` | `souvenir=5` → `5733` (Камінь сувенірний) |
| `vyd_ptakha` | `bird=6` → `6029` (Лелека); `bird=1` → `6024` (Орел); `bird=2` → `6025` (Пава); `bird=3` → `6026` (Сова); `bird=4` → `6027` (Сокіл); `bird=5` → `6028` (Фазан); `bird=7` → `6034` (Фенікс) |
| `vyd_roslyny` | `plants=3` → `5999` (Ікебана); `plants=1` → `5997` (Дерева); `plants=2` → `5998` (Квіти) |
| `vyd_symvoliky` | `symbolic_stat=2` → `6001` (Військова); `symbolic_stat=6` → `6005` (Корпоративна); `symbolic_stat=4` → `6002` (Професійна); `symbolic_stat=5` → `6004` (Релігійна); `symbolic_stat=3` → `6003` (Спортивна); `symbolic_stat=1` → `6000` (Українська) |
| `kamin_obrobka` | `stone_processing=0` → `6040` (Необроблений); `stone_processing=1` → `6039` (Полірований) |
| `kamin_suvenirnyi` | `additional_stone=1` → `6020` (З інклюзом); `additional_stone=2` → `6038` (На підставці) |
| `kolir` | `color=3` → `5747` (Комбінований); `color=4` → `5674` (Пейзажний); `color=1` → `5670` (Світлий); `color=2` → `5671` (Темний) |
| `typy_obrobky_burshtynu` | `material=1` → `5693` (Натуральний); `material=2` → `5694` (Формований) |
| `fraction` | `0-2` → `6048`; `10-20` → `6051`; `100-200` → `6054`; `1000+` → `6058`; `2-5` → `6049`; `20-50` → `6052`; `200-300` → `6055`; `300-500` → `6056`; `5-10` → `6050`; `50-100` → `6053`; `500-1000` → `6057` |

#### SV.souvenir!=value_id:5

Exact base attributes: `sku` (74), `name` (73), `price` (77), `decor_weight` (1483), `rozmir_suveniriv` (1530), `suveniry` (1471), `vyd_statuetky` (1526), `vyd_ptakha` (1529), `vyd_roslyny` (1524), `vyd_symvoliky` (1525), `nastlni_ihry` (1527), `kolir` (1455), `typy_obrobky_burshtynu` (1461).

Produced EN text candidates: `name`.

Unresolved/blocked attributes: `tematyka_vyrobu` (blocked).

| Target | Exact source/output → option ID candidates |
| --- | --- |
| `suveniry` | `souvenir=6` → `5736` (Брелоки); `souvenir=9` → `6037` (Годинники); `souvenir=7` → `6019` (Лампи); `souvenir=2` → `5732` (Настільні ігри); `souvenir=4` → `5734` (Письмові набори); `souvenir=3` → `5735` (Ручки); `souvenir=8` → `5738` (Скриньки); `souvenir=1` → `5729` (Статуетки) |
| `vyd_statuetky` | `statuette=7` → `6015` (Авто); `statuette=3` → `6011` (Військова техніка); `statuette=6` → `6013` (Вітрильники); `statuette=2` → `6010` (Дерева та квіти); `statuette=4` → `6014` (Зодіаки); `statuette=5` → `6012` (Символіка); `statuette=1` → `6009` (Тварини) |
| `vyd_ptakha` | `bird=6` → `6029` (Лелека); `bird=1` → `6024` (Орел); `bird=2` → `6025` (Пава); `bird=3` → `6026` (Сова); `bird=4` → `6027` (Сокіл); `bird=5` → `6028` (Фазан); `bird=7` → `6034` (Фенікс) |
| `vyd_roslyny` | `plants=3` → `5999` (Ікебана); `plants=1` → `5997` (Дерева); `plants=2` → `5998` (Квіти) |
| `vyd_symvoliky` | `symbolic_stat=2` → `6001` (Військова); `symbolic_stat=6` → `6005` (Корпоративна); `symbolic_stat=4` → `6002` (Професійна); `symbolic_stat=5` → `6004` (Релігійна); `symbolic_stat=3` → `6003` (Спортивна); `symbolic_stat=1` → `6000` (Українська) |
| `nastlni_ihry` | `table_games=3` → `6018` (Доміно); `table_games=2` → `6017` (Нарди); `table_games=1` → `6016` (Шахи); `table_games=4` → `6022` (Шашки/дама) |
| `kolir` | `color=3` → `5747` (Комбінований); `color=4` → `5674` (Пейзажний); `color=1` → `5670` (Світлий); `color=2` → `5671` (Темний) |
| `typy_obrobky_burshtynu` | `material=1` → `5693` (Натуральний); `material=2` → `5694` (Формований) |

`tematyka_vyrobu` label matches cannot become semantic bindings under the current
numeric source-key contract. Existing option identities: `Ссавці` → `5962`; `Птахи` → `5963`; `Риби` → `5964`; `Плазуни` → `5965`; `Земноводні` → `5966`; `Безхребетні` → `6023`.

### SV provisional category paths

All six bootstrap SV products fail overall evaluation, so these are exact tree
observations for provisional evaluator paths, not approved/sendable category plans.

| Route | Exact paths / IDs | Missing path |
| --- | --- | --- |
| Normal | `Default/Сувеніри` → 10; `Default/Сувеніри/Статуетки` → 38; `Default/Сувеніри/Статуетки/Тварини` → 39; `Default/Сувеніри/Статуетки/Символіка` → 610 | None among these provisional paths; other subtypes unexamined. |
| Stone | `Default/Камінь` → 380; `Default/Камінь/Полірований` → 640 | `Default/Камінь/Камінь сувенірний` |

## H3a successor preparation and review

Settings → Magento separates the immutable current publication, exact clone, and
successor preparation against a separately published template and fresh GET-only
schema/category observation. Preparation evaluates at most 100 selected/current
products and is not installation-wide publication safety or proof of sendability.
Literal category paths can be discovered without inventing a representative product;
dynamic paths require evaluator evidence. Existing CREATE/current-product previews
remain separate and allocate no identities or jobs.

Reviewed carry reuses the existing carry machinery only after checking transitive
expression/source/table/contracts, routing, attribute metadata, remote identities
and store policy scope. Changed cases remain unapproved. Equal labels are candidates.
Choosing a set, option or category is separate from approval; unresolved template
outputs must be fixed in the template, never by changing Amber semantic IDs.
Draft CAS and final local evidence revalidation protect preparation/review; remote
GETs finish before mutation transactions. Publication and handoff use the separate
H3b review below.

Legacy fixed-column eager checks are compared by output ownership, including
their transitive references and diagnostic fields. An SV size-only readiness
change therefore leaves unrelated SV mapping, option, route and ownership
decisions eligible for carry. Unknown checks remain global. Evaluator/output
contracts, referenced question visibility rules and source support, row/store
scope, chosen-set membership and attribute metadata still participate in the
proof; fresh remote identity checks remain mandatory. The target keeps its own
immutable option-domain hashes. Candidate `magento_managed` defaults do not
replace an unchanged reviewed ownership policy.

The official fixed-column → editable-column conversion can preserve those reviews
only when every existing row/column position is proven equivalent after
`upgradeColumns`. Existing order, definitions, source-support policy and readiness
ownership must remain unchanged; additions keep their own unapproved decisions.
Unprovable conversions retain the strict contract comparison. Fresh remote set,
attribute, option, store and ownership verification is still required.
Publication preview uses the same equivalence proof to classify existing routes;
conversion alone does not require new-route CREATE representatives.

For an explicitly scoped base-only field, `scopeBaseFieldToProductRoute` builds
the existing expression AST from an exact public SKU and the selected route's
semantic predicates, checking its observed set ID/name. A category/SKU condition
alone covers every possible set route in that category. For the controlled
`TEST-000001` SV field, the nonstone predicate confines requirements to set 151;
the stone route creates no set-154 requirement. This authoring helper performs no
persistence, publication or remote operation.

For the historical size-rule/column-conversion carry fix, leave any incorrectly
prepared draft unpublished and prepare a fresh successor from the **current
publication**, selecting the already published corrected template. Those drafts
are not refreshed by deployment. For an existing effective-name preparation with
saved manual decisions, use the reviewed carry-forward preflight/apply above on
its exact ID/counter instead of replacing the draft.
Review only the changed size mappings/policies and any independently changed
remote/source evidence, then use H3b preview/publication. Exact clone preserves
the original template pin and observation; it cannot switch template versions.
Neither deployment nor an abandoned draft changes current delivery. No data
migration or bulk approval is part of this workflow.

The normal template grid supports evaluators 1–4. A public-identity columns-v2 draft
can explicitly opt into v4 and add a category using reviewed UA/EN names, set name
and category path. Initial simple products are disabled and visible in Catalog/Search;
these rules remain a draft for review, not a Magento schema creation command.
Sources and columns use the existing form editor. Saving/publishing a template never
publishes a Magento binding or activates the exporter.

HTTP `/api/admin/magento-integration`: GET `bindings/:id`; POST
`bindings/:id/clone`, `bindings/:id/select`, `bindings/:id/decision`,
`successor/prepare`, `successor/apply`. Existing view/manage permissions apply with
normal active-user, authentication and CSRF boundaries; no RBAC changes.

### Reviewed publication and controlled handoff (H3b)

The workspace first previews structural validation, all current-product declared
delivery effects, exact lost routes/articles, and changed name-generation effects.
One repeatable-read PostgreSQL snapshot scans the complete selected scope by
ascending product ID in keyset pages of 128. A deterministic incremental SHA-256
digest binds every product, its complete public identity/lifecycle, relevant shared
name state, current name pin, immutable supporting schema and draft/current/source
validation evidence. No separate HTTP page claims to share this snapshot.

The measured release ceiling is **4096 products**, **2 MiB serialized returned review
evidence**, **8 MiB per input page**, **60 seconds for preview** and **15 seconds for
the final local publication boundary** (with a 5-second table-lock wait ceiling).
Oversized stored product/schema pages are checked before transfer. Any count, byte
or elapsed-runtime overflow raises `MAGENTO_PUBLICATION_LIMIT` with the exact bound;
there is no truncated success or publication. The client locally renders exact
affected/lost/name-impact results in 50-item pages from the single returned review.
See [the disposable scale measurement](archive/implementation/WAVE2_PUBLICATION_SCALE_2026-10-02.md).

Representative ready CREATE previews are required for newly
enabled routes or changed attribute-set rules/identities. Actual current-product
GET previews cover each affected route and optional explicitly selected products.
Those current previews load exact acknowledged native ownership receipts in the
same read-only product snapshot, even when reusing a paged product. A receipt remains
bound to its immutable public identity, SKU, Magento origin and remote ID; changing
the template or binding does not adopt a foreign counterpart. The immutable TEST
marker is retained, so an externally enabled TEST counterpart still blocks delivery.
Optional empty owned outputs are omitted from the declared delivery signature,
matching transport omission rather than enrolling an unchanged product. Populated
base/English outputs and zero values still contribute to publication impact.
Local projections are not a claim that every remote product has been inspected.
Remote reads reuse the existing evaluator/planner and the request-scoped 512-GET /
60-second bound; no persistent background-report engine is introduced.

`POST .../publication/preview` and `/apply` require manage + publish + exports.view.
Publication blockers retain the server's exact diagnostics in the client. The
category workspace shows the relevant category, field, language and source/value
with links preserving the exact draft and current-publication IDs. Source and
binding failures lead to the affected draft field, including dependencies in other
categories. Current-product previews blocked by draft configuration also lead to
that draft; product/lifecycle failures link to the exact product in Attention.
Missing CREATE evidence can be checked in place without creating a product. Unknown
diagnostics remain readable and copyable with the exact revision counters; they
never become a generic mapping notice or a link to the unfiltered product queue.
Confirming all mappings does not waive source validation or product preview blockers.
Apply repeats fresh GET checks and compares the exact preview hash. A short local
transaction prevents catalog/product/name-state phantoms, rechecks draft/current
CAS and source evidence, publishes the existing immutable binding and records the
exact handoff/name pins atomically. No remote write occurs in publication. Lost
coverage requires the actual Administrator role, explicit acknowledgement and an
explanation of the displayed exact loss. Changed inputs require another review.
The legacy binding CLI refuses new successor publication: use this reviewed
workspace. Initial bootstrap and completed immutable CLI receipts remain supported;
the trusted internal publication primitive retains historical CAS behavior.
Final revalidation recomputes the complete ordered digest under the existing access,
lifecycle and installation coordination, followed by product-before-full-state
locking and shared-name/deletion fences. Remote GETs finish before these locks.
Name pins and handoff items are inserted in bounded 128-item SQL batches inside the
one atomic publication transaction. No report table or background-report engine
is added. Request-owned planner preparation reuses only invariant analysis; every
product still runs the existing evaluator and planner, with unchanged semantics.

Publication does not mass-rename existing products. Migration 055 pins their exact
current effective UA/EN names to the new rule generation, including pins inherited
from an earlier publication. Intentional Amber/external edits take precedence using
the existing exact override. Subjects and the common baseline remain untouched.
Under **Контрольовані дії Адміністратора**, a separately selected, explained,
previewed `name_rule` action can apply the new generated names to at most 100
products. Conflicts, missing baselines, invalid names and unresolved dispatched work
block it. It saves an Amber override and normal sync obligation; the durable writer's
read verification alone confirms the new common baseline. No updated_at winner or
name reverse-parsing is introduced.

Default handoff contains only products actually unblocked or whose effective owned
delivery changes. The existing automatic worker settles at most 25 pending receipt
items per pass and then runs its ordinary generation/job pipeline. Unrelated synced
products are not enrolled. Manual unfinished jobs, dispatched evidence and sticky
reconciliation-required requests are protected, never reset or blindly retried.
Disabled activation keeps obligations pending; retired/test-deleted products are
skipped. Receipt/generation counters survive process/page restart.

GET `bindings/:id/handoffs` exposes the latest 20 receipts and real sync counts.
GET `bindings/:id/controlled-products?after=<productId>` uses ordered keyset
pagination (100 eligible current products plus one lookahead). Every later product
is reachable. Optional `search` filters public articles by case-insensitive literal
substring (at most 100 characters); the cursor contract remains `after`.
Each request is its own local snapshot, not a page of publication
review evidence. The UI retains exact selections between pages/searches, offers
explicit selection clearing, lists the selected articles in broader-resync
confirmation, and caps one
controlled action at 100 products; final preview/apply revalidates the whole selected
set together. No unexamined product is silently enrolled. A separately reviewed Administrator
`broader_resync` action can enroll an exact selection, without changing any bindings
or prices. POST `controlled/preview` and `/apply` use local evidence hashes, current
publication CAS, existing permissions and final authorization; applying name rules
also requires exports.create. No generic proxy, schema/set mutation or reconciliation
reset is exposed.


### General category authoring and retired cleanup resources (2026-10-06)

Web authoring is not restricted to the two historical CLI category paths. An administrator may create a Manager category with a unique local code in **Категорії → Нова категорія**, then use **Додати категорію до правил**. For an existing type, open its **Розміщення в магазині** field and **Додати підкатегорію тут**. Both journeys select an unambiguous existing parent from an explicit store observation, enter a new name, and require **Перевірити шлях і вплив** before adding the path to the local rules draft.

`POST /admin/magento-integration/categories/plan` is an authenticated authoring preview; it performs only read-only local SELECTs and bounded Magento GETs. The payload is exactly `{categoryCode,parentId,name}`. The Manager code must already exist; Magento category creation itself has a parent ID and name rather than that local code. Preview displays the exact normalized full path, parent ID, existing-versus-new status, one hidden active category creation or zero if it exists, zero product writes, and the current active-product count as an upper bound. It does not allocate a category, action, draft or SKU. Product and global binding effects are separately reviewed through the existing full publication preview.

Creation remains limited to an exact category requirement in a reviewed immutable binding draft. Its separate preview and explicit apply retain existing administrator checks, durable intent/dispatch audit, origin and scope validation, fresh parent/path revalidation, no redispatch after an unknown outcome, and GET reconciliation requiring the exact returned category ID. Planning is not authorization to dispatch. New categories become visible to subsequent drafts only through a fresh observation; neither creating a resource nor adding an expression publishes a binding.

Verified remote-only TEST cleanup is matched to actual enabled binding rows by exact Magento origin, attribute code and frozen attribute ID, and to an exact option ID for option cleanup. Unused frozen schema remains historical evidence. Referencing drafts are marked historical and publication is blocked server-side at preview and final apply context, even if an old successful preview is displayed. Their history and immutable versions remain readable; prepare a fresh draft from the current publication. No broad category/set/pricing block is introduced.

The minimal safe per-category/language workflow is a fresh draft based on the current publication, an isolated category/row change with `assertCategoryScope` protecting other rows, categories and transitive fields, followed by the existing complete global validation and atomic publication. Independent publication of one category or language requires a different version and shared-reference model; it is not implemented by weakening full-publication invariants. No global publication or remote category creation was performed for this follow-up.
