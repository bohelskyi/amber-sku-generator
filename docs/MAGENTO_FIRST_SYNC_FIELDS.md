# Magento first-sync field contract

This document describes the local server implementation for adopting mapped data
from one existing, exact Magento product on its first eligible synchronization.
It does not record production deployment, binding publication or live acceptance.
The ordinary delivery, historical recovery, lifecycle and authorization contracts
remain authoritative; see [Magento integration](MAGENTO_INTEGRATION.md),
[pricing](PRICING.md) and [manager workflows](MANAGER_PRODUCT_WORKFLOWS.md).

## Eligibility and actual delivery history

The server classifies the complete product/recount history before constructing a
field plan. It never identifies a first synchronization solely from an empty
`synced_at`, confirmed counter or UI label.

| Evidence | Classification |
| --- | --- |
| Remote item absent, complete history, no prior delivery, historical ambiguity or other-origin evidence | Existing create lane; no remote field adoption |
| Existing exact item, complete unambiguous history, no established delivery or protected work | First-sync field review |
| Incomplete first-sync session | Keep its field gate, including after an outward job succeeds |
| Completed session or acknowledged successful delivery for the same origin, public SKU and exact remote ID | Ordinary synchronization |
| Actual `externally_delivered_revision > 0` with a linked immutable exact origin/SKU/remote-ID receipt in the history | Ordinary lane after identity, history and origin checks |
| Snapshot membership, confirmed/cutover/CSV-retired counters or recount history without actual delivery proof | Historical review; these facts cannot initialize first-sync receipts |
| Changed remote identity, native ownership collision, incomplete/inconsistent history or other-origin evidence | Review blocker |
| Unfinished jobs, media/visibility/historical intents, protected reconciliation or test-deletion evidence | Protected work/recovery blocker |

The implementation uses `first-sync-eligibility.js` and the existing recovery-history
reader. Existing sessions and acknowledged IDs must match the observed Magento
item; another item with the same displayed label cannot confer ownership.
A positive external-delivery floor must reference the exact
`product.external_delivery_acknowledged` event for its own lineage product and
revision, with true delivery semantics and a valid plan hash. Every linked remote
receipt must match the current origin, public SKU and remote ID. Foreign origins,
changed/absent remote identities and malformed receipts remain explicit review
blockers; they cannot fall through to adoption or CREATE. Complete same-identity
predecessor history can carry the same exact receipt.
Native ownership uses the server loader's private proof. An allocated native SKU
without its own acknowledged remote identity remains a collision.

## Exact field projection

`first-sync-projection.js` consumes the original server-owned
`observation: { amber, raw, schema, domainEvidence }`, optional per-field receipts
and verified currency evidence. It requires the exact compiled published
definition and its approved published binding. A JSON copy of the compiled object
cannot replace the compiler's proof.

The local category remains unchanged. There must be one approved enabled route
for that category and the observed remote attribute-set ID. Ambiguous routes,
changed attribute IDs/metadata/requiredness, missing membership and stale option
identity produce precise blockers. Source reads and forward evaluation keep the
original product object so immutable historical-source proof survives.

Field projection and price-currency evidence select the same conditional route
from the product's known semantic answers before checking route uniqueness and
approval. Mutually exclusive routes may share a remote attribute-set ID. Missing
or malformed semantic answers never establish the negative branch.

A conditional field proven inactive in that route stays in the first-sync
manifest. It can receive an optional-empty receipt only with successful empty
forward evaluation, a confirmed empty remote value, unchanged optional attribute
metadata and unchanged membership in the selected pinned/current set. It needs
no business binding for an unreachable output. Active unapproved mappings,
unknown or populated remote values, evaluation failures, required fields and
schema drift remain blocked. This exception grants no import or outward authority
and cannot renew a previously completed field's one-time acceptance.

Receipt identity is `target + scope`; `mappingHash` is mapping evidence, not a new
receipt key. Metadata records persistence kind, canonical source key/field,
binding revision, definition hash, route, outward policy and required runtime
validation. Publication or mapping changes cannot silently make an already
received field eligible for another import.

| Local value | Fresh remote value | Decision before persistence |
| --- | --- | --- |
| Empty | Valid populated value with proven inverse and supported setter | Import into the canonical local source |
| Populated | Exactly equal normalized value | Equal; persist receipt without restoring old local data |
| Populated | Different populated value | Conflict requiring an exact administrator field decision |
| Populated | Empty | Pending guarded outward confirmation, only with authoritative outward policy |
| Empty | Empty, optional | Optional-empty receipt |
| Empty | Empty, required locally or by pinned/fresh Magento metadata | Required-field review |
| Unknown or invalid evidence | Any | Unknown/review; failed reads never become empty |

Zero and false are populated data. Type validation can still reject them for a
particular field, such as positive physical weight or price. Decimal comparison
normalizes comma/dot and trailing zeros exactly at the declared scale and unit;
it uses no tolerance, rounding or inferred unit conversion.

For an explicitly active product's recognized stored `SV.weight` informational source, a comma-decimal
mirror can be read by its direct numeric weight expression as dot-decimal grams
only when whole positive plain decimals
at scale three agree with the independently stored physical weight. The bounded
NUMERIC(14,3) range, original alias checks and missing/invalid observations remain
guarded. This read projection changes neither stored answer nor physical weight,
price, SKU, publication/hash or historical receipt. No physical weight is inferred
from a mirror; conflicting, unavailable, grouped or unit-bearing comma inputs
remain invalid. The existing derived fraction consumes these same proven grams,
including sub-gram values. Text reads and captured catalog conditions retain the
original raw source value. Historical first-sync admission remains a separate gate.
Archived products retain their separate reviewed weight-format repair; missing,
unknown and other lifecycle states cannot establish the active compatibility read.
The object-owned historical prospective projection also retains its original
numeric diagnostics when it presents an archived row as active for review; this
presentation cannot opt into the compatibility read or imply stored activation.
The existing explicit active-product format repair also retains its original
before/after diagnostics, reviewed plan, concurrency checks and audit receipt.

`FIRST_SYNC_FIELD_CONFLICT` is the normal unresolved-field blocker for different
populated values. The UI explains it as an administrator decision; its translation
does not remove the blocker, choose a value or authorize delivery. Unknown codes
retain their technical-detail fallback.

Direct reverse mapping is limited to proven one-source expressions and approved
wrappers. The exact same-source presence guard with an empty/error fallback is
supported. Arbitrary conditionals, first-present selection, bands, joins and other
composites are evaluated forward; their outputs never reconstruct canonical inputs.
A missing input needed by that forward evaluation remains review.

For derived fields the preview's local value is the verified current forward
output used in comparison, including approved option-ID conversion. Failed
evaluation is shown as unknown. This observation is not a reversible canonical
input and cannot authorize an import. The UI's completed-field badge describes
completion of the first phase, which includes equality and optional-empty
receipts; it does not claim that a value was imported.

Approved semantic option identities come from binding source keys and native option
IDs, not remote labels. A populated local semantic value can establish equality
through its proven forward option even for many-to-one mappings. An empty local
value requires a unique inverse; that does not authorize mutation of historical
identity or immutable characteristic versions.

## Names are received once per language

The base `all`/main name and `en` name have independent receipts. On first receipt,
a valid populated remote full name is authoritative even when the known prior
local full name is different or invalid. The bounded original local evidence is
retained for compare-and-swap. This adopts full-name overrides, not subject fields,
SKU components or an inferred translation.

Null or empty remote names preserve local names for the normal guarded outward
path. EN is known only from a fresh exact product ID/SKU observation in the active
pinned/current EN scope with no scoped read failure. Missing EN identity or a failed
read leaves EN unknown while the base field keeps its own state.

After `name_received`, retries preserve later manager edits. They delegate to
ordinary name reconciliation and cannot reimport the former remote name. Partial
language receipts do not initialize unresolved languages. Persistence still needs
the existing generated-name anchor and a valid saved pair; inability to build that
pair is an explicit setter blocker. Information/price changes retain accepted or
manual names while reanchoring them to the resulting generated pair.

## Canonical setters and unsupported coverage

| Mapping | Current persistence support |
| --- | --- |
| Full names in `all` and `en` | Existing name-state/override path with generation, pair, source and exact remote checks |
| Direct information `BR.braclet_size`, `NM.neckle_size`, `KL.exact_size`, `CH.bead_length`, `CH.bead_width`, `CH.rosary_length`, `SV.size` | Existing information validator/setter; category, catalog dependencies, active-product state and canonical normalization must pass |
| Direct final price from `product.total_price_uah` | Existing guarded in-place Manual UAH price command, when currency, rate and automatic baseline are proven |
| Custom gram targets `decor_weight`/`vaha_vyrobu` from the recognized physical/SV weight source | Native existing-version import with exact gram/scale-three, physical-answer coherence and coherent pricing; legacy encoded imports remain review |
| Generic semantic characteristics | Native values admitted by existing immutable version and current rules can be imported with unique approved inverse and forward validation; legacy encoded changes remain review |
| Direct English canonical fields other than names | Reverse import unsupported; fresh proven derived forward comparisons remain available |
| Native Magento `weight` | Ignored transport coverage; never a source for adopting local grams |
| Derived outputs | Forward comparison/outward planning only; no canonical import |
| Photos | Explicit unsupported URL-import coverage; no remote photo adoption |
| Identity, archive/visibility, inventory and other transport controls | Outside canonical field adoption |

The static information allowlist is not setter authority. The runtime information
service rejects fields with unsafe catalog, pricing, visibility, option-rule or
identity dependencies. Unchanged unsupported fields may be verified equal; an
attempted unsupported import remains review.

The direct price helper reads store configuration through the closed GET-only
Magento client before database locks. It proves one approved bound website, the
pinned/current website default group and active default UA store, and the active
pinned/current EN store on that website. Store-config IDs, codes, websites,
UA/EN locales and both `base_currency_code: UAH` must agree. Incomplete topology,
unreadable configuration or another currency leaves price unverified. Its
object-owned proof cannot be recreated by copying `{verified:true,currency:'UAH'}`.
The proof also binds the selected conditional route; changing the product to
another route invalidates that evidence before the price command can run.

Rate evidence is captured outside the business transaction. Price preparation and
apply perform no network requests: they use the caller's queryable transaction,
the captured current rate observation and the existing price preview/apply command.
The decision is `manual_uah` with marketing rounding disabled. The remote decimal
must match the authoritative result exactly at scale two, including the existing
numeric conversion boundary. A positive coherent automatic baseline, usable rate,
exact current local state and preview token are mandatory. Manual/final UAH and
calculated/automatic baseline fields remain separate; no custom USD/gram basis,
rate or matrix result is fabricated. The existing price command owns pricing
audit and export-revision changes.

A derived native `price`, including literal or numeric-wrapper outputs, compares
forward as positive scale-two UAH only when pinned/current native price metadata
and verified UAH evidence prove that contract. REST number `42`, output `"42"`
and `"42.000"` can then be equal. It remains `kind: derived`/
`persistence: derived` and never writes `total_price_uah`. Arbitrary numeric text
or dimensions have no guessed unit contract.

## Durable receipts, decisions and replay

Migration [073](../server/migrations/073_magento_first_sync_ledger.sql) adds the
permanent session/progress/field ledger. A session is keyed by Magento origin hash
and stable public product identity, with unique remote identity in that origin.
It records installation, public SKU, initial product/binding and exact remote ID;
a successor product or mapping hash cannot become a fresh receipt identity.

Fields are bounded server-derived evidence, including local-before, fresh remote,
accepted-after, source provenance and mapping hash. The complete mapped manifest
is server-owned; a caller cannot finalize an arbitrary subset. Progress uses an
expected session revision, exact preview/command hashes, transaction locks and an
immutable audit receipt. Local setter changes and new field receipts commit in the
same transaction. Terminal field receipts are permanent.

Only newly accepted `imported`/`name_received` transitions enter local setters.
Received, equal, unresolved and outward-only fields cannot restore old local values.
Exact retry returns the recorded result without applying the same local mutation
again. Changed preview evidence, a conflicting command at the same receipt,
changed origin/identity or a stale session revision fails closed.

The first-sync routes are:

- `POST /api/admin/magento-integration/first-sync/preview`: exact SKU and published binding revision;
- `POST /api/admin/magento-integration/first-sync/apply`: the same identity, current preview token, exact target/scope and `keep_local` or `accept_remote`.

Both retain authenticated active-user, CSRF and the existing manage/publish/export
permission checks. Apply additionally requires and revalidates Administrator
authority. `accept_remote` is available only for a valid conflict with a supported
canonical setter. `keep_local` requires the approved authoritative outward policy;
it records pending outward confirmation and does not prove delivery.

In **Потребує уваги**, an active Administrator with `export_templates.view`,
`export_templates.manage`, `export_templates.publish` and `exports.view` can open
**Перше отримання полів** for the exact article regardless of its stored diagnostic,
including older `PRODUCT_EVALUATION_NOT_READY` or `NAME_READ_UNAVAILABLE` problems.
Opening the product starts no request. **Перевірити актуальні поля** first reads
`GET /api/admin/magento-integration` and uses its `currentPublishedId` for the
read-only first-sync preview. Each explicit recheck resolves the publication again;
the recorded problem's binding is never substituted. Missing publication or denied
access stops the check. The preview creates no field receipt, local adoption,
sync obligation or Magento write. A field decision remains separately confirmed
and bound to the publication/token actually reviewed, with server revalidation.
Changing the selected product or recorded context, leaving the detail, or losing
access discards pending responses and previous decisions. Existing blockers remain
authoritative: this entry point does not repair populated physical weight or prove
first-sync completion or delivery.

## Durable initial name authority and recovery

For a reviewed initial write into an empty name scope, enqueue stores
`baseline.firstSyncNames: {sessionId, revision, scopes}` in the job's immutable
baseline. These are the exact originating ledger session, receipt revision and
pending language scopes, not a later UI decision or a newly issued first-sync
permission.

On restart, APPLY and recovery reconstruct that narrow authority from the
referenced immutable progress command and validate it against the latest session
and field receipts. The checks bind product/public identity, origin, installation,
SKU, exact remote ID, binding/definition, sent full names, initial empty remote
evidence, source route and mapping hashes to the same immutable job. A received
language may no longer differ from the current remote name; receipt progression
never reauthorizes an ordinary received-name conflict. Missing, altered or
mismatched references block with name-receipt review.

Recovery inspection is read-only: it observes the exact job/product, loads the
durable name proof and computes recovery checks. It does not invoke field imports
or enroll a first-sync session. Uncertain/dispatched steps keep the existing
reviewed recovery process.

A reviewed continuation/reconciliation gets an opaque, request-owned
`reviewedRecovery` proof bound to the exact job, plan/step fingerprints, remote
observation, identity, origin, installation and binding. Only that proof permits
the eligibility reader's narrow exception for a `reconciliation_required`
request whose `active_job_id` is this same job. Other jobs, different active-job
requests and unrelated protected work remain blocked.

Completed reconciliation first verifies all observed operation results and enforces
the first-sync field gate. Before recording job success, its existing transaction
revalidates actor, product/binding context and the exact latest first-sync receipt
revision/manifest. A concurrent receipt change prevents acknowledgment. The
reconciliation path records already observed results and has no dispatch path.

## Readiness, completion and ordinary delivery

`readyForOutbound` allows pending outward fields so local-populated/remote-empty
products can use the ordinary guarded delivery path. It still requires every mapped
field to be accounted for, no conflict/unknown/review blocker and validated local
setter work. It grants no independent Magento-write authority.

`complete` requires terminal receipts for every target/scope in the server manifest. Pending
outward fields remain incomplete until verified exact readback becomes
`outward_verified`. Historical completion is not erased by a failed later read,
but current read failures still block current first-sync readiness.

The runtime gate runs during enqueue/APPLY and before dispatch/final
acknowledgment. It checks the current session revision and full manifest against
the exact job/identity/binding context. Reviewed recovery proofs remain tied to
that exact job and observation; ordinary recovery/uncertain-write protections are
preserved. A product created by its own verified CREATE step continues through its
existing create lane rather than adopting a foreign item.

Accepted information, price, weight or characteristic changes require a new local snapshot/forward review
before outward transmission. Non-name equality/empty receipts based on old
canonical inputs are deferred until that recheck. This prevents unchanged-looking
derived fields from being initialized against inputs that have just changed.
Unknown or unsupported fields remain visible; a partial successful receipt never
globally marks the product initialized. Completion covers the mapped adoption
manifest and does not claim photo URL import or replace independent media checks.

Relevant implementation is under
[the Magento services](../server/src/services/magento/first-sync.service.js):
`first-sync-field-plan`, `first-sync-projection`, `first-sync-progress-plan`,
`first-sync-eligibility`, `first-sync-ledger`, `first-sync-local-apply`,
`first-sync-price` and `first-sync-runtime`. Focused unit and disposable PostgreSQL
regressions are repository verification; they are not real-store acceptance.

## Reviewed historical lanes

Stable and mixed-history recount exposure reconciliation can admit first-field
review through an opaque proof backed by the exact immutable audit, paired
broader-resync handoff and enrolled item. The proof binds origin, installation,
public identity, SKU, remote ID, current published binding, structural lineage
and retained export history. Its scope is `first_sync_review_only`; the original
`doesNotAcknowledgeExport` flag stays true. It never proves completed delivery.
Receipts predating this explicit envelope require another reviewed decision;
startup does not backfill authority into historical receipts.

Field commit, dispatch and acknowledgment reread this proof under short local
NOWAIT lineage/export locks. New retained files, lineage changes, binding or
identity drift invalidate it. Canonical field imports and increasing obligation
generations do not rewrite its immutable historical evidence. Actual field
decisions and terminal verified readback remain necessary for completion.

An already-confirmed historical standard UPDATE or atomic `awaiting_native`
UPDATE uses a separate opaque execution capability for its exact immutable
delivery plan. Each dispatch/ack transaction rereads the active intent and job,
original actor, product/binding CAS, generation, remote identity provenance and
protected work. Incomplete first-sync sessions or a foreign identity claiming
the same origin/remote ID block execution. This lane grants no field/name
imports, first-sync receipts or completion, and retains sticky uncertain-write
and ordinary precondition/recovery protections. Explicit standard CREATE keeps
its existing separate create path.

Derived English text fields can compare a proven fresh forward output against
the exact store-scoped remote value without a reverse setter: equality is a
comparison receipt; empty remote plus authoritative policy is pending guarded
outward delivery. Populated mismatch remains review. Direct English canonical
imports remain unsupported, and missing store/remote evidence stays unknown.

Repeated lifecycle revalidation on one client reuses its already-held session
lock while rereading the writer/gate contract; it preserves shared/exclusive
ownership so the final transaction release remains balanced.


## Narrow native weight and characteristic imports

Native products may receive explicitly mapped gram sources (`decor_weight` or
`vaha_vyrobu`, positive exact scale three) and uniquely reversed approved semantic
options. Both the existing immutable characteristic version and current catalog
must admit the complete candidate answer set. Changed questions/options must be
visible and active; dependency changes cannot silently hide an existing answer.
Physical weight and a required/existing answer mirror are persisted atomically.
Identity, SKU, version reference and immutable historical records are preserved.

The command retains a coherently proven existing Manual UAH, system automatic or
custom USD/gram mode and recalculates its baseline against candidate inputs.
Custom USD provenance remains unchanged. A changed final UAH amount requires a
separate pricing decision; the import does not silently select Manual UAH.
Historical/legacy-zero or incomplete pricing evidence remains review. If NEW price
adoption is also pending, canonical input adoption waits for price resolution and
a fresh snapshot. Name anchors are evaluated after all candidate inputs/pricing.

Preview binds immutable/current configuration hashes, pricing context, existing
mode and exact candidate economics. Apply takes short NOWAIT SHARE locks on the
catalog/pricing tables, rereads those proofs and reproduces the preview hash before
writing inputs, baseline, names, audit and receipts in the caller's transaction.
Observation timestamp changes alone do not stale the economic proof; captured
rate freshness is still validated. No HTTP occurs under these locks.

Legacy encoded SKU-driving characteristic changes, calibration (`is_calibrated`) mirror
imports, new version pointers/overlays and direct English canonical imports other
than names remain unsupported. Native Magento transport `weight` does not prove
grams. Photo URLs do not represent original local media and are not imported.
Fresh dependent field confirmation is required after weight/characteristic imports.

Actual recount custom USD basis may omit `source`; that format requires matching stored correction lineage and the exact immutable `product.recounted` audit, with matching request ID when present. The original basis is retained byte-for-byte as data; no provenance string is fabricated.


## Missing legacy SV inputs

An active/current legacy SV may receive a strictly missing non-SKU semantic
answer. The pinned SKU publication must omit the key; the current catalog must
still classify it as non-SKU. Neither frozen nor current rules may connect the
changed key, directly or transitively, to SKU question/option visibility. Every
supported stored, ordinary and hidden-omission decode path must agree on one
interpretation, before and after the patch. A separate proof enumerates all full
and visible configured/compact paths with a 10,000-state budget; exhaustion
fails closed. Conditional rules must be well-formed integer comparisons against
earlier frozen keys. Unique digit-only codes may have different widths; ambiguous
parses, unknown/forward/self dependencies and populated-answer contradictions
require review. Real option zero remains distinct from an absent placeholder.
No decoded answer is inferred or stored. The exact reservation owner, pinned
schema hash and unchanged public identity remain part of validation.

The stored base SKU and safe nonnegative integer sequence must reconstruct the
complete stored SKU exactly, including marker and verified variation. They prove
the suffix boundary, not historical weight mode, and are bound into proof v2.

Missing gram weight additionally requires both physical and answer values to be
strictly absent. Zero, malformed or populated values require correction. Exact
positive scale-three weight must fit NUMERIC(14,3), round-trip through Number and
reproduce the entire stored SKU using rounded weight, including marker,
separators, padding and variation suffix. This proves compatibility under both
sequence and rounded-weight suffix interpretations; it does not recover the
historical requires_weight flag or claim the original weight. Today's category
flags alone never authorize this lane.

Current non-SKU validation, unique approved reverse mappings, exact forward
result, proven price mode and unchanged final UAH are still required. The
automatic baseline, physical/mirror inputs, retained names, audit and receipt
commit atomically; frozen schemas and historical snapshots are never changed.
Preview binds the legacy proof and revalidates it under short NOWAIT locks.

SKU-driving answers, calibration and unproven/mismatching suffixes remain explicit
Administrator correction/recount work. The UI links to the ordinary reviewed
workflow; it neither creates a successor nor chooses answers or changes a receipt
automatically. These repository tests do not establish production acceptance.

## Actual conditional SV acceptance coverage

Approved routes sharing one remote attribute set are selected by exactly one
matching published local predicate before enabled state, approval and the exact
remote set are checked. Missing or malformed semantic input cannot prove a
negative branch. Other field, schema, source-support and readiness guards remain.

The information allowlist supports a published scalar-v1 text trim wrapper only
for the exact category/source without aliases, in global scope, and only when
the received value is already trimmed text. Transformed numeric or generic text
expressions do not become setters. The existing catalog/price dependency validator
and canonical normalization check remain authoritative. Prospective evaluation on
the original proof-owned product must reproduce the raw received target exactly
without target/source errors; failure discards dependent candidates before writes
or receipts and restores the temporary product state.

Read-only local evidence on 2026-10-09 found 752 active/current SV rows pinned to
the actual 11-question conditional schema6: 503 physical zero weights, 249 positive
weights and no absent physical weight. Therefore none qualify for a missing-weight
import as captured. The bounded identity proof independently succeeds for 462
and remains unproven for 290; this is not a count of import-eligible products.
All SKU questions remain reviewed recount work. The only current active non-SKU
fields are weight and size; the TEST option question is archived and its unpublished
draft mapping grants no authority. Published size is absent in 226 rows, including
111 with positive weight. These are field-presence counts, not delivery eligibility.

Regression fixtures copy the real frozen questions/options/hash, current SV
catalog and complete published definition/detached mappings. Isolated PostgreSQL
acceptance copies SV116007 and SV17001: exact missing-size adoption preserves
identity, history and every price/weight field, advances one content revision and
writes one atomic receipt; replay is a no-op and interrupted work rolls back.
Zero weight remains unresolved. Controlled missing-weight variants are explicitly
separate from these unchanged actual product copies and do not establish live
Magento acceptance or permission to change the working database.

### Actual copied rows and administrator completion

Information-size adoption is independent of the canonical SKU/price lane. The
unchanged local copies1919/SV116007 (16.2g, automatic1150UAH) and782/SV17001
(0g, Manual40000UAH, legacy price flag true) both accept only missing size against
a controlled remote text fixture.782 still has unresolved weight/SKU readiness;
the information receipt does not mean complete first-sync or delivery acceptance.
The current local SV catalog has no size-dependent visibility/option/price rule
and no active correction request in the752-row set as of07:53UTC. The226 absent
sizes are local field candidates, not verified remote imports.

4042/SV11511058 already has physical2g, mirror2,6 and size. Its controlled positive
weight variant removes physical/mirror weight and receives58.125g. The actual
Manual600UAH is copied unchanged. This variant proves a bounded setter contract;
the actual populated row requires explicit review if its weight is to change.

1835/SV11510016 already has physical0g, mirror8,7, size4/3,5/1 and Manual950UAH
with legacy_uah_price_unset=true. Neither missing-only import nor a raw flag clear
is appropriate. Ordinary same-price change is rejected and does not clear this
marker. The existing Administrator recount path is
/products/open?article=SV11510016&action=recount: independently verify weight and
visible answers, enter the same confirmed physical/mirror weight, select Manual
UAH950, review a fresh preview and confirm. Do not infer weight from the mirror
or suffix016, or invent the absent optional additional_stone answer. If the old
decoder supplies its zero placeholder, explicitly choose the existing UI
"Не обрано" (null); an inherited or explicit nonexistent semantic0 is rejected.

An authorized recount with a real parameter change can retain950UAH. It creates
an active reviewed native successor, retaining the public identity, with the new
row's default legacy flag false. The original becomes corrected, linked and
excluded, with its original flag, price and history preserved. Existing lineage
holds/exclusions and delivery checks remain separate from local completion. Any
fixture weight used to verify this path is an explicit test decision, not a
claimed measurement or user acceptance of the real1835 product.

## Auditing previously recorded optional-empty fields

An active required semantic question cannot be received as `optional_empty` merely
because Magento marks the target attribute optional. A missing required local
answer with a confirmed empty remote value stays unresolved. A valid populated
remote value still follows the existing missing-local adoption checks; read errors,
malformed values, zero and false never become confirmed emptiness.

The read-only `first-sync-optional-receipt-audit` service checks saved
`optional_empty` receipts before they can release either an incomplete or completed
session into delivery. It resolves each receipt's original `bindingRevisionId`,
`definitionHash`, route and field against the immutable published template and
binding, including the pinned schema and mapping fingerprint. The originating
product must belong to the same public identity. Its current answers, current
publication and later terminal field values cannot establish historical requiredness.

New receipts can retain bounded `source.requirednessEvidence`: the original
definition/route/target/scope and the source observations used to decide a condition.
This evidence is part of the immutable progress command and receipt; it is not a
new permission or a client-supplied decision. Historical assessment checks its
identity, shape, values and agreement with the original route. Truly optional fields
and fields proven inactive by their original route or captured observations keep
their permanent receipts.

For older receipts without that proof, the audit can recover canonical `before`
observations from the immutable progress command of the receipt's exact original
session/revision. It verifies command hash, identity and receipt membership, plus
the original parent field's descriptor, route, manifest and mapping fingerprint.
It never uses remote/after values, later revisions or current answers. Changed
canonical imports, unknown/malformed observations, conflicting observations,
missing history and mismatched provenance fail closed. The recovered proof is
temporary; no receipt is amended. Reads are cached and capped at 32 original
commands, each at most 1 MiB/500 fields, with at most 64 proof sources.

Older receipts may still lack enough historical observations to establish inactivity.
For example, a route proving only `souvenir != 5` does not establish that a question
required for `souvenir = 1` was inactive when the receipt was created. An original
command proving `souvenir = 4` can establish that inactivity. Confirmed absent
condition inputs use the evaluator's exact scalar comparison; they are distinct
from unavailable reads, zero and false. Without that historical proof, the receipt
remains explicit review, even if today's answer makes that question inactive.
Missing publications, malformed provenance, inconsistent fingerprints, active
required fields and unresolved historical conditions return
`FIRST_SYNC_OPTIONAL_EMPTY_RECEIPT_REVIEW_REQUIRED`. A single assessment covers at
most 500 fields and 32 original publications; exceeding the bound also requires
review. The audit never deletes or rewrites a receipt, clears completion, imports
values, enqueues work or writes Magento.

An exact idempotent retry may still return its saved `alreadyApplied` response,
including historical readiness or completion. That response does not establish
current delivery authority; fresh runtime assessment and dispatch checks remain
mandatory.

Recovery workers can still finalize local state for an already succeeded and
acknowledged delivery, including the automatic request's `synced` generation or
the original historical reactivation's local activation. This preserves the prior
delivery acknowledgement; it does not repair or accept an unsafe optional receipt.
Any subsequent first-sync planning, enqueue or dispatch must pass the new audit.

With an explicitly configured `DATABASE_URL`, run from `server/`:

```sh
node scripts/magento-first-sync-optional-audit.js --limit 100
node scripts/magento-first-sync-optional-audit.js --session SESSION_UUID
node scripts/magento-first-sync-optional-audit.js --limit 100 --after-session SESSION_UUID
```

The CLI opens one bounded `REPEATABLE READ READ ONLY` snapshot and emits JSON with
session identifiers, per-field evidence, blockers, `evidenceHash`, `scopeComplete`,
`truncated` and `nextAfterSession`. The limit is 1–500 sessions, default 100.
Continue using `nextAfterSession` when the result is truncated; separate pages use
separate snapshots. Exit codes are `0` for a complete requested scope without
blockers, `2` when review blockers exist, `3` for a truncated page without blockers,
and `1` for an error. An exact-session query with no matching optional receipts
reports zero audited sessions; it does not establish product acceptance or delivery
authority. The command performs no application startup, migration or HTTP/Magento
request; its only external connection is the explicitly selected PostgreSQL database.
