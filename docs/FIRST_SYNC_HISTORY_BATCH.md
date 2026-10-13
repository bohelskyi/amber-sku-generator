# Scoped legacy history admission batch

`server/scripts/first-sync-history-batch.js` is a standalone adapter for the
canonical services already deployed in PR 68. Copy this single script alongside
the deployed server and pass `--server-root` pointing to its directory containing
`package.json`, `src/` and `scripts/`. No deployment, migration, dependency install,
application startup or worker startup is needed.

This operation requires explicit approval for the exact SKU list. Its only domain
mutation is the existing `product.magento_first_sync_cutover_reviewed` audit with
scope `first_sync_review_only`. It does not change prices, physical weights, SEO,
snapshot flags, historical counters, category mappings, field decisions, jobs or
automatic requests, and does not acknowledge Magento delivery. Magento transport
is GET-only.

## Exact scope and invocation

Use an existing privileged operator environment with the deployed server's normal
database and Magento environment variables. Do not put secrets into input files or
shell commands. Both modes require an active actual Administrator and an explicit
database-name match. Input is strict, has no tokens or field choices, and contains
1–50 distinct SKU/local-ID/remote-ID identities:

```json
{
  "bindingRevisionId": "11111111-1111-4111-8111-111111111111",
  "expectedDefinitionHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "installationKey": "verified-installation-key",
  "items": [
    { "sku": "EXACT_SKU", "productId": 123, "remoteProductId": 456 }
  ]
}
```

Use the verified current publication and definition hash from the completed
discovery manifest, and the installation key used for that discovery. Pin the
SHA256 of the exact input file bytes (including whitespace). Output must be a new
file in an existing private directory; it is created exclusively with mode 0600.

```sh
sha256sum /private/approved-history-scope.json
node /private/first-sync-history-batch.js \
  --server-root /app --mode apply \
  --input /private/approved-history-scope.json \
  --scope-sha256 EXACT_FILE_SHA256 \
  --output /private/history-admission-new.jsonl \
  --expected-database EXACT_DATABASE_NAME --actor-id ADMINISTRATOR_ID
```

`--mode preview` performs the same fresh review and records availability without
calling admission. Its tokens are diagnostic only: `--mode apply` always obtains
fresh per-SKU canonical evidence. A separate full preview run is optional when the
exact scope and effect have already been approved. There is no `enqueue`, field
apply, automatic retry or resume mode.

## Freshness and stopping

For each SKU the runner checks the current publication and Administrator, invokes
canonical `first-sync.service.review`, and validates exact native observations:
SKU, local product ID, `identity.observedMagentoId`, raw Magento ID/SKU, publication
and definition. It requires the available legacy-snapshot history proposal with
`doesNotAcknowledgeExport: true`. It fsyncs the exact prepared command before
calling canonical `first-sync-cutover-admission.apply`.

Apply performs its own fresh observation with the same identity checks and the
reviewed local source hash. Existing history, lifecycle, ownership, publication,
Administrator, protected-work and stale-evidence guards remain authoritative.
The runner does not implement a second admission policy or direct SQL mutations.
Category blockers remain visible diagnostics; this separate admission does not
resolve them or approve category ownership/publication.

Each confirmed receipt is fsynced before the next SKU. On a blocker, exception,
invalid receipt, interruption or journal failure, processing stops. Earlier
confirmed admissions remain committed: the batch is sequential, not atomic.
SIGINT/SIGTERM prevent starting the next admission; an already-started operation
is allowed to finish and record its receipt. A hard kill or lost connection can
leave an uncertain outcome.

Fresh runs may report `already_admitted` only after verifying the current
canonical opaque admission proof and absence of protected work. In this branch,
`existing.rootAuditEventId` is the root receipt, not a claim about the latest
renewal event. No new audit is written. A canonical apply response can separately
contain its exact `receipt.auditEventId` and `alreadyApplied: true`.

**Never blindly rerun after `unconfirmed`, a journal write failure or an
interrupted prepared command without a confirmed receipt.** Preserve the journal
and reconcile the saved exact command/token against the canonical audit first.
The underlying service supports exact-token receipt recovery, but this runner
does not automate it or silently replace the unresolved token with a new one.

## Reading the journal

JSONL entries are append-only: `start`, per-SKU `prepared`/`receipt`, and `complete`.
`start` seals the exact scope, input SHA256, database name, mode and actor.
Successful per-SKU receipts retain ordinary blocker codes, local source hash and
publication hash. For a failed apply, take those hashes from its preceding
`prepared` entry. No credentials or whole remote product are logged.

- Exit `0`: all selected rows are available (preview), recorded or verified already
  admitted.
- Exit `2`: stopped on a row blocker, uncertainty or interruption; inspect the
  receipt and `notChecked` count.
- Exit `1`: setup or evidence-output failure; do not assume a mutation rolled back.

After confirmed admission, perform fresh discovery/field preview. The existing
[local batch workflow](https://github.com/bohelskyi/amber-sku-generator/blob/30a34e0bc5dbd4a6c6b9d6784f59d5e6860ba0e4/docs/FIRST_SYNC_LOCAL_BATCH.md) remains separately guarded and
accepts at most ten products per field packet. Admission success alone does not
mean a product is ready for field choices or outward delivery.

## Verification

Synthetic unit tests cover exact scope/hash validation, fresh identity and source
checks, publication/authority changes, journal order, stop behavior, already
admitted proof and GET-only transport. The disposable PostgreSQL integration test
uses real canonical review/admission/preview services and compares every public
table, allowing only the exact new scoped audit records. It checks no-op preview,
successful sequential admission, read-only existing-proof detection, protected
work and identity drift. No production execution is part of these tests.
