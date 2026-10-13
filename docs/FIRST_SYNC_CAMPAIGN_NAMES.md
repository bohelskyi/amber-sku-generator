# Reviewed initial Magento names

This standalone adapter accepts the initial Magento full names in the `all`
(Ukrainian/main) and `en` scopes for the exact `nameOnlyPreview` list produced by
the [PR70 campaign review](FIRST_SYNC_CAMPAIGN.md). It depends on PR70; it is not
an extension of that PR's local-choice runner. The dependency reviewed here is
PR70 head `a0254211005d83158b1573fa5b9942ac3777418e`.

Only the first remote-name receipt is authoritative. Later Manager edits retain
the existing generated-name anchors and ordinary reconciliation rules; this tool
does not reimport a name that already has its terminal receipt. See the
[canonical field contract](MAGENTO_FIRST_SYNC_FIELDS.md#names-are-received-once-per-language).

## Scope and checks

The input is an intact sealed campaign review and its raw `review.json` SHA-256.
The adapter resolves each `nameOnlyPreview` entry back to its original packet,
source snapshot, product ID, exact remote ID and field values. It does not accept
an arbitrary SKU list, extra names, or replacement field choices. Campaign
bounds remain 2,000 candidates and at most 10 products per original packet;
execution is sequential.

Before each local commit it obtains a fresh ordinary preview and the canonical
first-sync inspection. Publication, actor, database, identity, source snapshot,
preview token and exact name values must still match the sealed evidence. Only
new `name/all` and `name/en` accepted transitions are permitted. The original
full projection goes to the existing canonical commit; the adapter neither
truncates the manifest nor constructs synthetic decisions or receipts.

Previously approved local price, physical-weight and SEO evidence remains
protected. The original local choices are checked read-only to confirm the
reviewed remainder; this adapter does not execute them. Canonical comparison
receipts for other fields remain part of the full manifest. History, lifecycle,
empty-field, binding and local setter checks retain their existing boundaries.
If fresh planning cannot preserve a prior receipt exactly, including historical
SEO authority-change evidence, the adapter blocks. It does not repair or replace
that evidence to make a name import pass.

The canonical commit runs on one real PostgreSQL connection under the existing
access-administration advisory lock. Administrator authority is checked after
that lock is acquired and remains pinned through commit. All Magento reads
finish before acquiring this additional lock. Failed SQL or uncertain cleanup
on this borrowed commit connection destroys it instead of returning it to the
pool. A confirmed domain rejection with successful rollback can return the
clean connection normally.

## Delivery effect

`deliveryEffect` in preview and receipts explicitly describes the normal side
effect of changing names. The existing product trigger can create a sync request
or advance its desired generation when automatic synchronization is enabled.
The existing worker may subsequently process that request under its ordinary
guards. A local receipt does not confirm Magento delivery.

**No direct enqueue does not mean no sync request.** The adapter makes no direct
enqueue, resync, activation or Magento mutation calls. It leaves the trigger and
automatic synchronization settings in place. A future production run must
include this delivery effect in its exact approved scope. Development and test
results do not authorize a production run.

## Run from the reviewed bundle

Keep both new scripts beside the PR70 campaign helpers. Use the target
installation's existing `server` directory and canonical service modules; no new
HTTP endpoint, migration, startup hook or dependency is introduced. Configure the
same database and Magento read credentials as the existing helpers, without
putting credentials in arguments or evidence files.

First run the read-only preview into a new private directory:

```sh
node server/scripts/first-sync-campaign-names.js \
  --mode preview \
  --review /private/review \
  --review-sha256 REVIEW_JSON_RAW_SHA256 \
  --output /private/names-preview \
  --server-root /installation/server \
  --expected-database EXACT_DATABASE \
  --actor-id ADMINISTRATOR_ID \
  --installation-key EXACT_INSTALLATION
```

After reviewing the exact names and delivery effect, the local-write command
uses the same arguments with `--mode apply` and a different, new output directory
such as `/private/names-run`. This documentation is an operator contract, not a
record of a production execution.

For a safely interrupted run, use `--mode resume` with the original review,
raw SHA and `/private/names-run`. Resume validates the journal and its canonical
immutable receipts before skipping recorded items. A known blocker stops the
run, remains in the journal and requires a new review before further execution.
An unresolved prepared intent, uncertain commit result, malformed journal or
unconfirmed receipt stops the run; it is not retried automatically. Do not edit
the journal or remove a stale lock to force execution.

After any successful name import, repeat discovery and campaign review before
executing the remaining PR70 local choices: the source snapshot, generation and
preview token may have changed. Neither a names receipt nor the earlier review
proves current outward readiness or delivery.

The adapter does not reconcile media, import other attributes, migrate data,
renew history admission, change lifecycle protections, or perform controlled
resynchronization.
