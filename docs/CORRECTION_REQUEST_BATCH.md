# Reviewed bulk correction requests

This local server CLI processes a frozen, reviewed subset of existing requests.
It is implemented in the repository; no production batch has been run. Deploy
and test the tool and forward migration **058** before generating a fresh plan
in the intended environment. This guide does not authorize a deployment or run.

The workflow is read-only preflight → immutable plan → explicit ID selection →
sequential apply → durable phase receipts and an atomic local summary. It uses
the existing claim, authoritative refresh and completion services. Recounts use
`applyProductRecount`; price changes use the transactional in-place price-change
primitive. No direct request-status completion, correction-history insertion,
product write, force-release, lifecycle reconciliation or Magento dispatch is
performed by the orchestrator.

## Commands and review

Run from `server/`. Set `DATABASE_URL` explicitly in the shell for preflight/apply
using the intended deployment's normal secret-handling process. The CLI rejects
an absent URL before configuration can load a default `.env` connection. Never
put credentials in ID files, plans, receipts or committed commands.

```text
npm run corrections:batch -- preflight --expected-database NAME --actor-user-id ID --all-active --limit 100 --output NEW_PLAN.json
npm run corrections:batch -- preflight --expected-database NAME --actor-user-id ID --ids-file REQUEST_IDS.json --output NEW_PLAN.json
npm run corrections:batch -- select --plan NEW_PLAN.json --expected-hash PLAN_HASH --ids-file SELECTED_IDS.json --output NEW_SELECTION.json
npm run corrections:batch -- select --plan NEW_PLAN.json --expected-hash PLAN_HASH --ids-file SELECTED_IDS.json --post-delivery-review-ids-file HELD_IDS.json --output NEW_SELECTION.json
npm run corrections:batch -- apply --expected-database NAME --actor-user-id ID --plan NEW_PLAN.json --expected-hash PLAN_HASH --selection NEW_SELECTION.json --expected-selection-hash SELECTION_HASH --output NEW_RECEIPT_DIRECTORY
```

Every ID file is a JSON array of distinct positive integer request IDs, for
example `[12, 19]`. Scope is limited to 1–1000 requests. All-active preflight
fails if the current scope exceeds its explicit bound; it never silently takes
the first page. An empty scope is rejected. `select` is offline and never opens
a database connection. Output paths must be new: artifacts are not overwritten.

Inspect the plan's counts and each entry's public article, type, reason, stored
intent, hypothetical refreshed result, pricing results, permissions and delivery.
Only explicitly selected `SAFE_TO_COMPLETE` or `REFRESH_SAME_INTENT` entries
can apply. Held recounts must also appear in the separate held-ID file, exactly
matching the selected entries that require post-delivery review. Review both
hashes and retain the exact plan and selection. Selecting safe scope is human
approval; the tool does not auto-select every eligible entry.

## Classification and unchanged intent

| Classification | Meaning |
| --- | --- |
| `SAFE_TO_COMPLETE` | Complete stored review proof agrees with current authoritative derivation and current signature/version. |
| `REFRESH_SAME_INTENT` | Freshness/signature format must refresh, but all provable reviewed outcomes remain equal. |
| `REVIEW_REQUIRED` | Results changed or historical target/name/delivery review proof is insufficient. Use individual review and a new plan. |
| `STALE_OR_OBSOLETE` | Source is no longer current, request is terminal, or a price change is already a no-op. |
| `OWNERSHIP_BLOCKED` | Another application user owns the claim, or a token-only legacy claim needs the existing adoption workflow. |
| `INVALID_OR_BLOCKED` | Ordinary target/pricing validation, identity, deletion fence, lifecycle prerequisites or required permissions block completion. |

`postDeliveryReviewRequired` is separate from those exclusive classes. A safe
recount with a held successor may be selected with explicit held-ID approval;
its hold is retained after completion.

Recount comparison uses semantic `value_id` answers and calibration state,
category/schema, weight, internal/public SKU allocation, exact effective names,
inheritance and delivery. It compares every persisted calculated/automatic/manual
price result, USD totals, per-gram values, rate and pricing basis. Even a manual
UAH request requires review if its automatic baseline or derived USD result
changes. Stored pricing modes and their explicit parameters are preserved.
Price-only requests compare the stored decision and entire resulting pricing
evidence, including the current source signature. A technically successful
completion is insufficient proof of safety.

The only allowed answer removal is normal target-validator cleanup of an
inherited, unchanged hidden answer. Removal of an explicitly changed answer
requires review. Ordinary new-product validation is unchanged. Version upgrades
and dependency fingerprints can differ at preflight only when these reviewed
results remain equal and historical name/delivery proof exists. No missing
legacy evidence is manufactured. Internal allocator drift requires review.

After selection, all sealed dependency/result fingerprints must still agree.
The only ignored comparison fields are observation timestamps/age and pricing
explanation text (`fetchedAt`, `uahRateFetchedAt`, `uahRateAgeMs`, `ageMs`,
`logMessage`). The original full rate observation is nevertheless sealed in the
plan. Apply observes rates anew before transactions and requires the same rate,
quote date, provider source and stale/fallback state. Fallback age limits are
rechecked when the rate is used. Preflight cannot write `exchange_rate_cache`:
its independent normal-semantics provider has no persistence callback, and the
CLI connection and snapshot are read-only. No batch business transaction spans
the NBU request. A rate change requires a new plan; the old observed rate is
not a permanent rate override.

## Ownership, locking and recovery

The actor is an active local application user with `corrections.view` and
`corrections.complete`, plus `corrections.claim` when claiming an unowned row.
Override/direct-recount permissions are not substituted for the existing
completion permission path. Authorization and exact database identity are
rechecked at every write boundary under the existing access-administration and
lifecycle gates. Identity binds database name/OID, cluster identifier, schema,
migration checksums, receipt index/constraint definition and a credential-free
connection-target hash. The connection must be allowed to read
`pg_control_system()`; otherwise preflight fails closed. Apply also requires
the canonical code/dependency hash recorded by CLI preflight and the supported
tool/policy version. This works in the server image without a Git checkout.

Pending unowned rows and compatible historical in-progress rows without owner
or token use ordinary atomic claiming. Actor-owned in-progress rows retain
their owner and epoch. Other owners, including disabled users, are excluded.
Token-only claims must first be adopted through the existing capability-aware
UI, followed by a fresh plan. No force-release is automatic. Terminal requests
at apply time conflict unless this exact batch has a committed completion receipt.

A nonblocking per-request advisory lane serializes batch runners. Existing
business locks still govern UI/other writers: source product → SKU resources
(recount completion) → request → ascending lifecycle rows. The fingerprint and
reviewed result are checked again under those locks. Before claim/refresh the
eligible classification is also recomputed from the actual stored request;
editing a plan's class cannot waive changed original intent. Claim, refresh and complete
remain separate per-request transactions, preserving claim's existing
post-commit refresh/failed-refresh release behavior. No batch-wide transaction
is held. Prior successful requests survive a later business conflict.

Migration **058** adds a partial UNIQUE index on the immutable
`audit_events.subject_id` for `correction_batch.step_committed`, plus a strict
receipt-shape constraint. Deterministic entry identity hashes plan hash, actor
and request ID; phase identity appends `claimed`, `refreshed`, `released` or
`completed`. Each receipt is inserted in the same transaction as its business
mutation and normal audits. A duplicate rolls the whole phase back. Receipt
ordering uses numeric audit ID; actor, exact selection, entry hash, phase order
and after-request hash must match. Receipt uniqueness is enforced by PostgreSQL,
not just a read-before-write check or local file.

Resume uses the same plan, selection and hashes with a **new** receipt directory.
Only this batch's recorded claim/refresh transitions may advance its original
fingerprint. A completed phase returns `ALREADY_APPLIED` without another product
change or audit. A committed claim or refresh resumes from that phase. A recorded
failed-refresh release is terminal for that plan; generate a fresh preflight.
Unrecorded owner/request/source changes conflict. Lost local disk output after
commit is recovered from the database receipt; do not edit or delete receipts.

`summary.json` is written before work and atomically replaced after every row.
It includes completed/skipped/conflicted/failed/pending IDs, outcomes and
post-delivery candidates. Keep it on persistent storage outside the repository.
Business conflicts continue sequentially. Database/authorization/identity/build
or receipt-integrity failures stop the run; disk failures also stop immediately.
SIGINT/SIGTERM stops at the next request/phase boundary and closes pools.
Exit codes are `0` for success (including already applied), `2` for row conflicts
or remaining pending work, and `1` for fatal/command failures.

Recount's normal post-commit repricing-draft sync remains best effort and uses
the batch-bound database/rate. Failures are receipt warnings, never a reason to
double-complete. Process death after correction commit can leave that follow-up
unfinished; existing draft sync remains the recovery path.

## Delivery and eventual production procedure

Recount receipts record successor ID, stable public identity/article, internal
SKU, expected delivery, actual lifecycle route/counters, local automatic-sync
request state and final correction evidence. Price requests preserve one
product and advance the existing price-export stream without a successor.

Amber completion and Magento delivery remain separate. Holds are never released
here. `historical_ambiguity` successors are listed as candidates for the separate
reviewed `--stable-recount` reconciliation workflow. There is no remote read,
resend, reconciliation handoff or automatic override of `reconciliation_required`
or uncertain jobs in this feature. Normal business primitives may update their
existing local synchronization outbox; this CLI never runs a delivery worker.

The eventual production workflow is: deploy tested code/migration; generate a
fresh read-only plan; review its exact hash and explicitly select safe scope;
apply that exact plan; inspect persistent receipts; review held delivery and
Magento reconciliation separately. Do not use direct SQL mutation to prepare or
complete production requests.

Focused unit and PostgreSQL coverage lives in
`server/test/correction-request-batch.test.js` and
`server/integration-test/31-correction-request-batch.cases.js`: pricing modes,
legacy evidence/ownership, hidden cleanup, stale sources, state/epoch/allocator
races, independent phase uniqueness, process-crash and disk recovery, atomic
rollback, partial success, rate observation without transactions/cache writes,
stable public identity, protected holds and no remote dispatch. PostgreSQL tests
must use only the canonical disposable `postgres-test` described in
[AGENTS](../AGENTS.md). No production telemetry or request count is inferred.

Related contracts: [recount and correction requests](RECOUNT_CORRECTIONS.md),
[pricing](PRICING.md), [repricing](REPRICING.md),
[automatic sync and stable recount](MAGENTO_AUTOMATIC_SYNC.md),
[database migrations](DATABASE_MIGRATIONS.md), [RBAC](AUTH_RBAC.md).
