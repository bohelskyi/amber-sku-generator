# Resumable exact SV campaign

This workflow advances an operator-owned exact SV cohort through existing
canonical history admission, initial names, first-sync decisions and ordinary
outbound delivery. Repository implementation and synthetic tests are not evidence
of deployment, Magento readiness or completed delivery. The operator runs the
commands in the configured installation; private production artifacts stay there.

The standalone package has eight sibling scripts from the same reviewed
checkout:

- `sv-campaign.js`
- `sv-campaign-journal.js`
- `sv-campaign-stages.js`
- `sv-campaign-outbound.js`
- `sv-campaign-policy.js`
- `first-sync-local-classify.js`
- `first-sync-local-discovery.js`
- `first-sync-initial-name-plan.js`

The helpers load canonical first-sync names/history/campaign scripts
from `--server-root/scripts` and services from that configured installation.
They do not start the application, load `.env`, migrate or install a new worker.
The installed runtime must include the reviewed updates to
`src/services/magento/binding-controlled-actions.js`,
`scripts/first-sync-initial-names.js` and
`scripts/first-sync-initial-name-plan.js`. The controlled-action update checks
outstanding handoffs atomically before creating another handoff. The names update
provides the explicitly opted-in pristine-first contract described below.
Deployment of PR79 alone is insufficient; copying the standalone package does
not install these runtime changes. The existing validation boundary used by
`first.applyWithPreparedValidation` is also required. Missing capability blocks
startup before product processing; the campaign does not fall back to a weaker
path. Capability failures are `SV_CAMPAIGN_PREPARED_VALIDATOR_REQUIRED`,
`SV_CAMPAIGN_ATOMIC_HANDOFF_GUARD_REQUIRED` or
`SV_CAMPAIGN_PRISTINE_NAMES_CONTRACT_REQUIRED`. The latter two require
`controlled.handoffExclusivityVersion === 1` and
`initialNames.pristineFirstVersion === 1` respectively.

## Fixed scope and authority

Start from a successfully sealed
[read-only classification](FIRST_SYNC_LOCAL_CLASSIFY.md). Preserve its original
input bytes, result rows, manifest and hashes. The campaign is not a new category
scan and does not rebuild its membership from current request counts or routes.
Its original classification remains immutable as individual products advance.
Use a complete classification of the whole input: no `incomplete` marker,
`manifest.complete: true`, `globalFailure: null` and `remainingInput: 0`.
Keep all sealed files together; do not concatenate independently produced slices
or replace individual rows with newer field evidence.

For the reviewed October 2026 cohort, the original accounting scope is 801 active
SV products. The campaign scope is the 746 normal singletons; the 51 held products
and four additional lineage exceptions remain outside it. These are operational
scope decisions, not hard-coded counts or an override of current lifecycle
checks. Category `SV` defines membership, including stone products and public
`AG-*` identities. A SKU prefix does not define the category. The 260 previously
submitted paintings are outside this campaign.

An input remote ID and a freshly observed remote ID are separate facts. A null
input ID means unknown. It does not mean absent and does not authorize CREATE.
Changed identity, hold, protected work, other-origin history, unresolved lineage
or incomplete reads require review. The campaign does not release holds, repair
identity, manufacture history admission or adopt uncertain work.

An active Administrator, expected database, installation, current publication and
exact binding/definition remain preconditions. An old ACK, completed first-sync
session or stored baseline does not prove current Magento equality. History
admission only opens first-sync review; it does not acknowledge an export or
authorize an outbound job.

## Operator commands

Use the original classifier input, not a route subset. Its exact schema remains:

```json
{
  "bindingRevisionId": "11111111-1111-4111-8111-111111111111",
  "expectedDefinitionHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "items": [
    {"sku":"AG-SYNTHETIC","productId":123,"category":"SV","remoteProductId":null}
  ]
}
```

This example is synthetic. All four item keys are required. The known remote ID
is a positive integer or null; no values, policy choices or tokens are supplied.
`--expected-count` must equal the exact original input length, at most 2000. Use
746 for this reviewed scope. The input limit is 4 MiB.

After reviewing the helper changes, keep those eight files together in the
private operator checkout and deploy the required runtime changes above before
starting a write run. Use the already configured runtime
environment and the same actor, database and installation as classification.
Compute hashes from the original file bytes, without reformatting JSON:

```sh
INPUT_SHA256="$(sha256sum /private/sv-746-identities.json | awk '{print $1}')"
CLASSIFICATION_SHA256="$(sha256sum /private/sv-classification-01/manifest.json | awk '{print $1}')"

node /private/reviewed-checkout/server/scripts/sv-campaign.js \
  --mode run \
  --server-root /installation/server \
  --input /private/sv-746-identities.json --input-sha256 "$INPUT_SHA256" \
  --classification /private/sv-classification-01 \
  --classification-sha256 "$CLASSIFICATION_SHA256" \
  --expected-count 746 --output /private/sv-campaign-01 \
  --expected-database amber --actor-id 1 --installation-key amber
```

Paths are placeholders. The output directory must be new and its parent must
exist. `run` is a business-write command: it may commit local history/name/field
state and authorize automatic full-product delivery. Its own Magento transport
accepts GET only. There is no campaign preview mode; the separate classifier is
the read-only command.

Resume a clean interrupted checkpoint with the original files, hashes, runtime,
actor, policy and output directory. Change only the mode:

```sh
node /private/reviewed-checkout/server/scripts/sv-campaign.js \
  --mode resume \
  --server-root /installation/server \
  --input /private/sv-746-identities.json --input-sha256 "$INPUT_SHA256" \
  --classification /private/sv-classification-01 \
  --classification-sha256 "$CLASSIFICATION_SHA256" \
  --expected-count 746 --output /private/sv-campaign-01 \
  --expected-database amber --actor-id 1 --installation-key amber
```

There is no force flag and no automatic replay of an unconfirmed intent. Resume
does not retry terminal review/uncertain products or expand membership. A later
separately reviewed operation must retain their original evidence.

The run directory contains `scope.json`, `classifier-manifest.json`,
`journal.jsonl` and an exclusive `run.lock` while open. The journal start record
pins the raw input and classifier manifest hashes, classifier journal hash,
publication, actor, database, installation, expected count, policy version and
implementation hash. Every JSONL envelope has `seq`, `previousHash`, `record` and
`hash`; every write is fsynced. Maximum journal size is 64 MiB and maximum record
size is 4 MiB. POSIX also fsyncs directory entries. Windows does not provide that
directory-fsync guarantee here.

The hash chain checks internal consistency: changed records without matching
hashes, missing or reordered interior records, and incomplete trailing records.
It does not authenticate the operator files or detect rollback to an intact
valid journal prefix; there is no independently stored committed head. Keep
these files under trusted operator control. Hashes and fsync are not an
anti-tampering or rollback-prevention guarantee.

Each processed terminal outcome prints one progress object:

```json
{"sku":"AG-SYNTHETIC","status":"review","inputIndex":0,"checked":1,"total":746,"resumed":false}
```

`checked` starts at zero for each invocation. It advances once after a durable
terminal outcome, or after verifying all saved receipts for an already terminal
product on resume. It includes `queued`, `already_pending`, `review` and
`uncertain` outcomes. `total` is the original input length and `inputIndex` is
zero-based. `resumed` means that product already had terminal, receipt or pending
evidence when this invocation began; it is not merely a copy of the CLI mode.
The line is emitted after releasing the product lane. A failed verifier, failed
durability step or global stop does not count as completed progress.

Final summaries retain `queued`, `already_pending`, `review`, `uncertain` and
`notChecked` counts. `complete` means all scoped identities have a terminal local
outcome with no global failure; it can include review/uncertain cases. It never
means delivery was confirmed. Exit 0 means complete without review/uncertain;
exit 2 means review, uncertainty or incomplete processing; exit 1 means setup,
execution or cleanup failure, even if a summary was already printed. Keep any
`run.lock` left by a crash/output failure until its
cause and journal have been reconciled; do not delete it to force a write retry.
Publication/authority failures stop the remaining tail. Per-product review or
uncertainty is recorded separately so other scoped identities can progress.

## SV policy

The internal policy is `sv-manager-v1`; the operator does not provide arbitrary
field choices or a replacement payload. Manager's saved `total_price_uah` is the
price authority. The workflow does not reprice products or import remote prices.

Physical weight must be positive and coherent between `p.weight` and
`details.answers.weight`, with canonical projection provenance. The published SV
mapping may obtain `decor_weight` from the answer. A zero `p.weight`, nonpositive
answer or disagreement between them is retained for review. A local weight choice
is limited to the proven integer-rounding difference accepted by the existing
canonical validator; the workflow does not fill or reconcile these fields.

Initial names use the exact Magento-name receipt path after current opaque
history admission, or the narrowly opted-in pristine-first path below. Both use
the existing canonical commit and preserve the whole prepared manifest.
New non-name imports, unrelated field conflicts and unsupported provenance are
review cases. The only newly selected first-sync local choices are
`price/all` and `decor_weight/all` with `choice: "keep_local"`.

The canonical planner can also prove an automatic fill of an empty remote bound
field from its already approved authoritative local value. The workflow retains
that exact prepared decision without adding a choice. It requires known remote
absence, exact local/source/mapping evidence and the approved current binding;
it does not overwrite a nonempty unrelated value or extend this permission to
names or SEO.

The SV publication in this operation does not produce `meta_title` or
`meta_description`. The workflow neither invents nor clears those fields.
Outbound authorization covers the normal canonical full-product update, including
its approved category, website, inventory and control behavior. This is broader
than a two-field patch. Existing planner, publication, ownership and dispatch
guards continue to apply.

## Per-product progression

Classification is an initial route, not a frozen apply plan. Each product is
inspected again against the canonical current state. The helper holds the same
public-identity session advisory lock as the automatic worker for the entire
product's local stages and outbound handoff. It acquires that lane before names
because a canonical name commit can update an automatic request through existing
triggers. The lock is released on completion, failure or connection loss; it is
not a durable campaign claim or a global worker pause. It covers normal worker
product processing. The separately required canonical controlled-action guard
serializes reviewed handoff creation and rejects outstanding pending/protected
handoffs inside the creating transaction, including concurrent submissions
through that same canonical API. The session lane alone does not provide that
guarantee, and neither mechanism fences arbitrary database writes. Canonical
source and preview guards still apply at each action boundary.

The campaign processes one product at a time. Its helper pool is configured for
four connections. The source-audited peak for this sequential workflow and its
canonical runtime factory is three: one retained public-identity lane
connection, one retained canonical SKU-guard connection, and one sequential
read/commit/verification connection. Controlled handoff apply and receipt checks
outside the SKU guard need at most two including the retained lane. The helpers
do not reacquire the public-identity lock, and the SKU lock uses a distinct key.
The name-commit adapter passes its already borrowed third client into
`first.commit`; it does not borrow a fourth one. The SKU guard commits its short
transaction before calling the stage while retaining its session advisory lock.
The automatic worker uses a nonblocking try-lock for the public-identity lane and
skips the product while this lane is held.

Canonical handoff apply keeps its existing Administrator, shared lifecycle,
binding and product/name-row lock order, then repeats the outstanding-handoff
check before inserting. Its preview reports `EXISTING_HANDOFF`; stale apply
rejects with `MAGENTO_CONTROLLED_ACTION_STALE`. A retry with the same already
committed preview token can still return its immutable prior receipt. This does
not authorize a new handoff for a different preview while old work remains.

The helper pool uses a 5-second connection timeout, 10-second statement timeout
and 12-second query timeout. These bound individual waits/queries, not the whole
product stage or the lifetime of a session advisory lock. Network reads and
local evidence writes also occur while a lane is held; do not treat a timeout as
proof that a preceding commit did not happen.

The supported progression is history admission when required, initial names when
required, first-sync local choices or zero-choice progress recording when required, then
the ordinary outbound handoff. Already completed stages are verified rather than
repeated. CREATE, held/protected work and unsupported conflicts remain review
cases. No per-product shell loop or replacement bulk coordinator is needed from
the operator.

A pristine product can be canonically in `first` mode without history admission.
For its initial names, this campaign explicitly opts into the installed
`initialNames.pristineFirstVersion === 1` capability with
`allowPristineFirst: true` on both preview and apply. This is an internal adapter
option, not an additional operator CLI flag. The
[`selectionFor` validator](../server/scripts/first-sync-initial-name-plan.js)
admits that branch only when both canonical modes are `first`,
`first.progress === null`, `first.historyAdmission === null` and both
`admissionGuards.protectedWork` and `admissionGuards.otherOrigin` are exactly
false. Its history root is null; no history admission is fabricated or persisted.
The complete existing identity, publication, prepared-manifest, name provenance,
evaluation and lifecycle checks still apply, followed by the existing canonical
first-sync commit.

The usual admitted branch still requires a current opaque admission accepted for
the exact observation, a positive root ID and matching progress admission root.
The standalone initial-names CLI and read-only classifier retain their existing
admitted-only defaults. This extension does not turn an arbitrary `first` result,
an existing session without admission or an unavailable history proposal into
authority. Missing runtime capability blocks startup. A genuinely unready
evaluator, including missing effective names that prevent evaluation, also
remains review; the extension does not bypass that separate guard.

Each transition refreshes the canonical state. In particular, history admission
does not supply the observation for names, and names do not supply the observation
for field choices or outbound. A fresh preview token is generated only for a new
stage after the preceding durable receipt has been confirmed. Source, publication
and identity changes never authorize silent reuse of an old token.

## Durable stage evidence

Before a stage can commit, its complete intent is fsynced to the campaign journal:

```text
prepared: {type, stage, sku, selection, prepared}
receipt:  {type, stage, sku, selection, prepared, receipt}
```

The nested objects retain the existing helper's exact selection, command/proof
and outer receipt. Do not reduce them to a boolean success, session ID or list of
changed fields. Names/equal evidence includes the command proof, expected session
revision and full result; fields retain the exact selected command and receipt;
history retains the prepared admission command when there was one.

Resume verifies saved successful stages through the existing canonical evidence
readers before skipping them:

| Stage | Existing verifier | Evidence checked |
| --- | --- | --- |
| history | `first-sync-campaign-history.verifyHistoricalReceipt` | Immutable cutover audit, exact identity/origin and prepared token where present. |
| names | `first-sync-campaign-names.verifyRecorded` | Progress/session/audit join, command hash, actor, identity, revision and exact name receipts. |
| equal | `first-sync-campaign-names.verifyRecorded` | The same complete progress proof with an empty initial-name import list, including exact approved automatic fills. |
| fields | `first-sync-campaign.verifyRecorded` | Exact progress revision, preview/command hashes, identity, actor and permitted local-choice states. |
| handoff | `sv-campaign-outbound.verifyReceipt` | Exact controlled handoff/item/audit evidence, or the existing automatic request identity and recorded generation. |

Handoff records omit `selection`; their `prepared` and `receipt` carry the exact
controlled command or existing automatic-request evidence. An `already_pending`
receipt does not have a separate prepared record because it creates no request.
Its verification establishes that the recorded request generation exists or has
advanced; it does not assert that an immutable delivery receipt exists.

These checks establish historical commits only. They do not establish live
admission, field readiness or remote delivery. After verification the workflow
rereads current state. If it still requires a stage already recorded for that
product, the product requires review; the workflow does not repeat that stage.
The journal stage named `equal` is a zero-choice canonical commit; it can leave
`readyForOutbound: true` with `complete: false` while approved outward work still
needs remote confirmation. It does not assert that every field is terminal.

An intent without a matching confirmed receipt is not safe to replay. A timeout,
lost response, malformed receipt or failed receipt fsync can leave the commit
outcome unknown. Preserve the journal and investigate through the
canonical ledger/recovery path. Do not delete evidence, replace tokens, edit the
sealed scope or start a fresh write run to work around an uncertain outcome.

The canonical outbound worker owns remote writes and read-after-write
acknowledgement. An enqueued job is not a successful delivery. A historical
successful job also does not prove that later source or Magento changes are
already synchronized.

An existing unfinished job or pending/protected binding handoff is a review case.
The campaign checks for it before local stages and again at handoff; it does not
adopt, supersede, resend or create duplicate enrollment for that work. An already
pending/syncing automatic request with neither a job nor a pending/protected
handoff uses the existing request; the helper records `already_pending` instead of creating
a duplicate broader-resync request. Otherwise handoff uses the existing
controlled `broader_resync` action for one exact SKU with durable intent and a
verified local receipt. This design adds no migration or persistent worker policy.
