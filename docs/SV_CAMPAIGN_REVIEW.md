# SV campaign review evidence

This note records the implementation review and bounded synthetic verification
of the workflow in [SV_CAMPAIGN.md](SV_CAMPAIGN.md). It contains no production
observations, identities or artifacts. Source inspection and disposable local
PostgreSQL tests establish implementation behavior; they do not establish
deployment, live Magento readiness or delivery.

## Review fixes and retained boundaries

| Finding | Reviewed behavior | Main code paths |
| --- | --- | --- |
| A helper-only outstanding-work check could race another reviewed handoff. | Canonical controlled preview reports `EXISTING_HANDOFF` for a pending/protected item matching either product or public identity. Apply repeats this check under its existing transaction locks before recording a handoff. Different stale commands fail; replay of the same committed preview returns its prior receipt. | [`binding-controlled-actions.js`](../server/src/services/magento/binding-controlled-actions.js): `inspect`, `apply`; [`sv-campaign-outbound.js`](../server/scripts/sv-campaign-outbound.js): `handoff`. |
| Initial-name selection previously required history admission even for a genuinely pristine canonical first-sync product. | An explicit `allowPristineFirst: true` option admits only canonical `first`/`first` with strictly null progress and history admission and both admission guards false. The history root remains null. Existing complete-manifest validation and canonical commit remain in use. | [`first-sync-initial-name-plan.js`](../server/scripts/first-sync-initial-name-plan.js): `selectionFor`; [`first-sync-initial-names.js`](../server/scripts/first-sync-initial-names.js): `previewItem`, `runItem`; [`sv-campaign-stages.js`](../server/scripts/sv-campaign-stages.js): names branch. |
| A names commit persists unresolved field evidence as well as name receipts. Treating every identical prior record as settled skipped later price/weight choices. | `selectChoices` only skips an identical prior row when it is canonically received or remains pending outward confirmation. Persisted conflict/review/unknown rows are reconsidered using the unchanged allowlist, availability and rounding checks. An unrelated persisted size conflict still fails. | [`sv-campaign-policy.js`](../server/scripts/sv-campaign-policy.js): `selectChoices`; [`sv-campaign-policy.test.js`](../server/test/sv-campaign-policy.test.js): full names-manifest regression and unrelated-conflict regression. |
| Progress omitted early review/uncertain outcomes and verified terminal resume skips. | Every durably processed terminal outcome uses the same progress emission after lane release. Verified terminal resume skips count once. Failed verification or durability does not create successful progress. | [`sv-campaign.js`](../server/scripts/sv-campaign.js): `runProducts`; [`sv-campaign.test.js`](../server/test/sv-campaign.test.js). |

The local decision policy remains fixed: saved positive Manager price, verified
UAH for a price change, coherent positive physical weight and only the canonical
rounding difference for `decor_weight`. New explicit first-sync choices are
`price/all` and `decor_weight/all`, both `keep_local`. The names validator owns
initial name imports. Other new local imports remain denied.

Approved published values can fill an absent remote bound field through the
canonical automatic-pending plan. Its source, `productId`, mapping, manifest,
local/remote evidence and unchanged record must match. The full outbound plan
still uses normal canonical categories, websites, inventory and controls. This
does not establish a new price-only worker protocol. Populated unrelated field
conflicts, native identity changes, unsupported shipping-weight changes and SEO
payload keys remain review cases.

## Runtime deployment and opt-in contract

The standalone scripts load canonical services and helper scripts from
`--server-root`. Copying the standalone package is insufficient. The installed
runtime must include the reviewed controlled-action update and both updated
initial-name helper files. PR79's prepared-validator support alone is
insufficient.

| Required installed capability | Startup failure |
| --- | --- |
| `first.applyWithPreparedValidation` is a function | `SV_CAMPAIGN_PREPARED_VALIDATOR_REQUIRED` |
| `controlled.handoffExclusivityVersion === 1` | `SV_CAMPAIGN_ATOMIC_HANDOFF_GUARD_REQUIRED` |
| `initialNames.pristineFirstVersion === 1` | `SV_CAMPAIGN_PRISTINE_NAMES_CONTRACT_REQUIRED` |

[`sv-campaign.js`](../server/scripts/sv-campaign.js), `main`, checks these before
product processing. Exported outbound `handoff` independently checks the atomic
handoff capability. The update adds no database migration, persistent campaign
claim or replacement worker policy.

The campaign passes `{ allowPristineFirst: true }` as the eighth argument to
initial-name `previewItem` and in `runItem` options. It is not a new operator CLI
flag. The original initial-names CLI and read-only classifier keep their
admitted-only defaults. The admitted path still checks the opaque admission for
the exact observation, a positive history root and the matching progress root.
An existing session without admission does not become pristine.

`readFirstSyncEligibility` in
[`first-sync-eligibility.js`](../server/src/services/magento/first-sync-eligibility.js)
has one final runtime return which always includes `admissionGuards`, sourced
from SQL `EXISTS` facts. Its internal classifier's early ordinary/first/review/
create returns do not bypass that wrapper. Every return from
[`first-sync.service.js`](../server/src/services/magento/first-sync.service.js),
`inspect`, retains that `first` object. Requiring both guard values to be exactly
false is therefore supported for ordinary, historical and pristine lanes.

## Source lock and connection audit

This budget assumes sequential SKU processing and the supplied canonical runtime
factory. [`first-sync-campaign-preview.js`](../server/scripts/first-sync-campaign-preview.js),
`createRuntime`, creates a pool with `max: 4`, connection timeout 5 seconds,
statement timeout 10 seconds and query timeout 12 seconds. Those limits are not
a deadline for an entire product stage or a session advisory lock.

| Connection | Ownership and lifetime |
| --- | --- |
| A | `sv-campaign-outbound.acquireLane` retains the public-identity session lock from before local stages through outbound handoff. Its key is `amber_magento_public_identity:<id>` and acquisition is nonblocking. |
| B | Canonical `sync-job.service.guard` retains the distinct SKU session lock, `amber_magento_sync:<origin>:<sku>`, for one guarded helper action. It commits its initial short transaction before invoking the action, releasing authority/publication/product transaction locks while retaining the SKU lane. |
| C | Reads, validation, canonical commit and verification borrow one additional client sequentially. `first-sync-name-commit.runNameCommit` lends this same physical client to `first.commit` through its single-borrow proxy; it does not allocate a fourth connection. |

The source-audited peak is three physical helper-pool clients. Controlled handoff
apply and receipt verification outside the SKU guard use at most two including
A. The following call chains support that bound:

- History: [`first-sync-history-batch.js`](../server/scripts/first-sync-history-batch.js),
  `runItem`, finishes `first.review` before calling admission apply. The
  [`first-sync-cutover-admission.js`](../server/src/services/magento/first-sync-cutover-admission.js)
  boundary owns B; authority, inspection and transaction use C sequentially.
- Names: `first-sync-initial-names.runItem` owns the canonical guard, then calls
  [`first-sync-name-commit.js`](../server/scripts/first-sync-name-commit.js),
  `runNameCommit`. Its Administrator session lock and the canonical transaction's
  Administrator lock use the same C connection.
- Fields: `first-sync.service.applyWithPreparedValidation` uses one guard;
  administrator checks, inspection, `prepareDecision` and `commit` borrow C in
  sequence. Inside `inspect`, the eligibility client is released before the
  validation client is borrowed.
- Equal receipts: the `sv-campaign-stages` equal branch owns one guard and uses
  the same name-commit adapter with an empty name-import list.
- Canonical local mutation: `first.commit` passes its transaction client through
  ledger and local-apply callbacks. These callbacks do not borrow another pool
  client for the local name/field updates.

[`sync-job-transaction.js`](../server/src/services/magento/sync-job-transaction.js),
`readState`, acquires Administrator authority, shared lifecycle gate, binding
lock and product/lifecycle rows in that order. Controlled handoff apply uses
[`access-admin-transaction.js`](../server/src/services/access-admin-transaction.js)
for Administrator/shared lifecycle locks, then binding and product/name-row
locks before repeating inspection and recording the handoff.

No called stage helper reacquires A's public-identity advisory key. First-sync
ledger locking uses a separate `amber_magento_first_sync:<origin>:<identity>`
key. The automatic worker's
[`automatic-sync-worker.js`](../server/src/services/magento/automatic-sync-worker.js)
uses `pg_try_advisory_lock` for A's key and skips a locked product. The lane is
not a durable claim or global worker pause. Handoff exclusivity covers concurrent
submissions through the canonical controlled-action transaction; it does not
fence arbitrary database writes.

## Progress and durable evidence

Progress records contain exactly `sku`, `status`, `inputIndex`, `checked`,
`total` and `resumed`. `checked` starts at zero for each invocation and advances
once for every durable terminal outcome or successfully verified prior terminal
outcome. It includes queued, already-pending, review and uncertain outcomes.
`total` is the original input count; `inputIndex` is zero-based. `resumed` means
prior terminal, receipt or pending evidence existed for that SKU, not merely
that the command used resume mode. Emission occurs after releasing the lane.
Verification failure, global stop and failed journal durability do not count as
completed progress. Summary counts and journal meanings remain unchanged.

[`sv-campaign-journal.js`](../server/scripts/sv-campaign-journal.js) fsyncs each
hash-chained record and validates sequence, previous hash and record hash. These
checks detect inconsistent edits, missing/reordered interior records and an
incomplete trailing record. They do not authenticate operator files or detect
rollback to an intact valid prefix: there is no external committed-head anchor.
Operator files must remain trusted. Recomputed hashes are not an anti-tampering
defense, and fsync is not rollback prevention. An intent without a confirmed
receipt remains uncertain; resume must not replay it automatically.

## Evaluation readiness limitation

The pristine extension does not relax `report.evaluation.ready === true` or
allow arbitrary preview blockers. Initial names still allow only
`NAME_BASELINE_REQUIRED` alongside otherwise ready canonical evaluation.

[`binding-evidence-products.js`](../server/src/services/magento/binding-evidence-products.js),
`evaluate`, temporarily suppresses the legacy `magento_name_review_required`
flag, restoring the original product afterward. That flag alone does not make
the preview evaluator unready. However,
[`export-templates/evaluate.js`](../server/src/services/export-templates/evaluate.js)
can produce `effective_names_required` or `effective_names_invalid`; missing
names may also fail the full-product row contract. `sync-preview.planPreview`
then emits `PRODUCT_EVALUATION_NOT_READY`.

Both `sv-campaign-policy.assertObservation` and the existing initial-name
`selectionFor` require ready evaluation. Genuine evaluator-unready names remain
review. Repairing that case requires a separately bounded reviewed name contract;
loosening the campaign policy alone would not satisfy the canonical validator.

## Verification evidence

The integration owner ran the following against disposable PostgreSQL with real
canonical services and SQL. Remote GET responses were synthetic. No production
database, live Magento reads or remote writes were involved.

| Verification | Observed result |
| --- | --- |
| [`sv-campaign-handoff-race.test.js`](../server/integration-test/sv-campaign-handoff-race.test.js) | Two independent pools/physical sessions reached an advisory-lock wait before the barrier was released. One different command committed; the other failed `MAGENTO_CONTROLLED_ACTION_STALE` with `EXISTING_HANDOFF`. There was one pending handoff item, one audit and zero Magento jobs. Replaying the winner's identical preview returned the same receipt with `alreadyApplied: true`. |
| [`sv-campaign-locks.test.js`](../server/integration-test/sv-campaign-locks.test.js), historical composition | Real history admission, names, Manager field choices and handoff completed while retaining the public-identity lane. |
| Same test, pristine composition | A synthetic AG-prefixed pristine identity followed names, Manager field choices and handoff with a null history-admission root. |
| Same test, resumed composition | Saved names progressed through the zero-choice equal commit into ordinary mode; repeated ordinary processing used the normal handoff path. |

The final combined PostgreSQL run reported 5/5 passing tests, including the
lock/composition parent test, in 21.37 seconds. Historical stage receipts were
also verified after subsequent fields, equal and ordinary-handoff commits.
The real factory remained at `max: 4`; observed peak active leases were three,
saturated waiting was zero, and final active/waiting counts were zero. A transient
one-entry acquisition queue while an idle PostgreSQL client was handed over on
the next event-loop turn was distinguished from pool saturation. This supports
the bounded sequential source audit; it is not an assertion about unrelated
future runtime changes or arbitrary concurrent workloads.

Focused regression coverage also exists in
[`magento-controlled-handoff-exclusivity.test.js`](../server/test/magento-controlled-handoff-exclusivity.test.js),
[`first-sync-initial-names.test.js`](../server/test/first-sync-initial-names.test.js),
[`sv-campaign-policy.test.js`](../server/test/sv-campaign-policy.test.js),
[`sv-campaign-stages.test.js`](../server/test/sv-campaign-stages.test.js) and
[`sv-campaign.test.js`](../server/test/sv-campaign.test.js).

The review package contains these final logs under `verification/`:

- `sv-campaign-v2-focused.tap`: 206 passed, zero failures.
- `sv-campaign-v2-pristine.tap`: 61 selected tests passed; 62 outside the selected
  contract patterns were skipped.
- `sv-campaign-v2-canonical.tap`: 90 adjacent canonical regressions passed.
- `sv-campaign-v2-postgresql.tap`: the five real PostgreSQL tests above passed.
- `sv-campaign-v2-lint.log`: scoped source ESLint exited successfully with no
  diagnostics; integration test files are excluded by repository lint config.

The full existing initial-names unit file reported 99 passed and 24 failures in
Windows directory-fsync `EPERM` paths. A direct directory-open/fsync probe
confirmed the platform limitation. This review did not change unrelated
durability handling. It does not claim a green full application suite.
