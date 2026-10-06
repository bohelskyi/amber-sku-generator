# Manager product workflows and native characteristics

This guide describes the local implementation added in October 2026. Repository
code, successful local tests and container health are separate from acceptance
against a real Magento installation. Existing dated production receipts remain
historical evidence.

## New products and recount

When the existing public-identity activation gate is enabled, new products and
recount successors use immutable public identity and a category-scoped immutable
characteristic version. They do not allocate an encoded full/base SKU, variation
sequence or SKU schema version. Existing encoded products, SKU reservations,
public identities and historical publications retain their original meaning.
Gate-disabled installations continue to use the existing encoded workflow.

The server preview signs current catalog configuration, normalized answers,
canonical weight, initial pricing decision and ordered photo intent. Saving
rechecks that evidence and records the semantic snapshot in the same transaction
as the product, public identity, lifecycle, audit and creation receipt. Recounts
preserve the same public identity through successive revisions. An ambiguous
initial-save response retains its original exact request and UUID; an explicit
same-attempt retry recovers the original result. Changed content under that UUID
fails closed. Current authorization is checked again before receipt recovery.

Initial pricing uses the existing products.create capability. System pricing,
exact manual UAH and USD per gram are separate server-owned decisions. USD pricing
uses the checked canonical weight and server rate; marketing rounding is explicit.
Manual initial pricing can succeed without a matrix and does not manufacture
automatic price evidence. Existing-product price permissions remain separate.

There is one canonical Manager weight input. Conflicting stored physical and
answer weights are displayed with both sources and require an explicit recount
decision. Existing data is not silently rewritten. An archived weight answer
that cannot legally be changed remains a field error rather than being replaced.

Frozen evaluators 1–4 retain historical source behavior. Compatible BR/KL/CH/SV
products continue to use their reviewed contracts. Nonempty native NM extra or
AR size requires an explicitly reviewed evaluator-5 successor using
public-product-characteristics-v1. A draft upgrade does not publish a template,
replace a binding or approve remote delivery. Absent native answers do not become
historical zero placeholders. See [export templates](EXPORT_TEMPLATES.md).

## Catalog values and archival

Catalog questions can specify integer/decimal kind, unit, inclusive bounds and
precision. Numeric inputs accept canonical comma or dot decimals and reject
ambiguous separators, fractional integers and out-of-range values before pricing,
save, recount or Magento mapping. Ordinary text remains text. Semantic option
values, including zero, are separate from database IDs and encoded option codes.

Local archival of a whole question or a single option preserves existing product
answers and historical semantic IDs. Archived choices cannot be silently reused
for a new product. Restoration keeps the same IDs. Product and catalog mutations
use authoritative transaction fences against concurrent archival.

Removing a characteristic or option from both Manager and Magento is a separate
[reviewed Administrator workflow](REVIEWED_CATALOG_DELETION.md). It requires a
fresh exact target, dependency checks and durable dispatch/read-verification
evidence. Uncertain DELETE results are reconciled with GET; they are never retried
by resetting a marker. Referenced or ambiguous targets remain blocked.

## Photos, archive and restore

[Original product photographs](PRODUCT_PHOTOS.md) are immutable JPEG/PNG bytes,
with ordered gallery membership and explicit primary-image roles. Native CREATE
remains hidden. Enabling requires explicit intent and successful verification of
every original, order and role after native acknowledgement. HTTP success alone
does not prove gallery delivery. Existing photos use the recount capability;
initial staging uses creation capability. Recount and correction completion
inherit the exact ordered gallery and enable intent without moving original
assets from their predecessor. Started media delivery blocks native input and
generation changes until delivery is completed or reconciled. An unstarted
obligation can become terminal only with a permanent proved successor job;
successor delivery verifies existing originals before enabling. Correction
completion authority preserves this inherited set without granting arbitrary
photo editing. The dedicated large staging parser is
behind session, active-user, CSRF and permission checks.

[Product archive and restoration](PRODUCT_LIFECYCLE.md) use durable explicit
intents. Future deliberate archives capture prior evidence and can request a
status-only remote hide. Existing archived history is not enrolled on startup. Unfinished photo delivery
blocks new archive and restore decisions until it is completed or reconciled;
queued/dispatched visibility blocks a competing new photo-set decision. These
transaction fences preserve permanent evidence and prevent stale status intents
from overriding newer photo intent.
Reviewed batch restoration preserves SKU, names, answers, photos and prices,
checks lineage, and queues ordinary guarded native delivery. Visibility can be
restored only from a verified prior hide and its captured actual status; enabling
also requires current explicit gallery proof and fresh original-byte checks.

The product register exposes restoration only with view/archive capabilities and
server availability. Opening a dialog performs no restore or sync. Dirty photo
drafts, uploads and unresolved save/restore attempts use the shared navigation
guard. Staying returns to the original creation recovery form; an in-progress
save inside the guard cannot be discarded or navigated away from.

## Attention and confirmation

Creation configuration blockers can become explicit [durable Administrator tasks](PRODUCT_INTEGRATION_TASKS.md), with owner-scoped input/photo recovery and a separate current local resolution. They allocate no product or SKU and confirm no delivery.

Attention presents the primary blocker, relevant facts and an available repair,
including why an unavailable action is disabled. Catalog repair links preserve
the exact field/option/value and return to the current product after a successful
save. Identity mismatches retain read-only identity evidence and a support handoff.
Full technical diagnostics remain in one support disclosure.

Saved, queued and Magento-confirmed are different states. Confirmation timestamps
require a succeeded acknowledged job for the exact current product, public
identity, origin, desired generation and publication. Unrelated observation
timestamps, older jobs and incomplete deletion do not count as confirmation.
Archive visibility has its own verified hide receipt; local archive success alone
does not claim a remote hide.

Fresh discovery reads independent pages with bounded parallelism while retaining
sequential topology dependencies and existing proof checks. Workers poll busy
work without adding a fixed sleep after each completed operation. Phase timings
support later measurements; mock speed comparisons are not real-store benchmarks.

## Installation and acceptance boundary

Forward migrations 060–067 preserve applied migration history. Installation
allocates no identity, publishes no binding, grants no role permission and enrolls
no historical archive/photo work. Startup starts the existing automatic lane and
the independent media/visibility and explicit historical-reactivation lanes only after migrations and initialization.
Shutdown drains each lane before its owned pool is closed.

Local tests use mocks or uniquely owned disposable PostgreSQL databases on the
canonical loopback test instance. They do not contact real Magento. Real-store
acceptance still needs controlled operator scenarios, including deployed Magento
gallery semantics and original-file access on its configured origin. A CDN-only
original URL fails closed. Local HTTP health and rendered tests do not substitute
for authenticated browser acceptance or evidence of real business writes.
