# Read-only exact SV identity classification

`server/scripts/first-sync-local-classify.js` classifies an operator-owned exact
scope through the installed `previewProduct` and `first.inspect`. It does not
start the application, migrate, admit history, prepare decisions, import fields,
enqueue, apply, resync, or write Magento. Output files are its only writes.
Repository tests do not establish production readiness or delivery acceptance.

For standalone use, keep these three unchanged files together:

- `first-sync-local-classify.js`
- `first-sync-local-discovery.js`
- `first-sync-initial-name-plan.js`

Use the configured installed server through `--server-root`. Its existing
canonical modules and dependencies are required. The helper does not load `.env`,
start a worker or require an application restart. Do not mix companion versions.

## Exact input

```json
{
  "bindingRevisionId": "11111111-1111-4111-8111-111111111111",
  "expectedDefinitionHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "items": [
    {"sku":"AG-SYNTHETIC","productId":123,"category":"SV","remoteProductId":null}
  ]
}
```

This is synthetic. Supply actual exact public SKUs and local product IDs. The
top-level keys and all four item keys are required; extra keys are rejected.
Category must be `SV`; SKU prefixes and souvenir/stone variants do not determine
membership. A known positive remote ID is an exact precondition. Null means
unknown, never remote absence or CREATE permission. Duplicate public SKUs,
local IDs, or known remote IDs are rejected. Input contains no values, choices,
tokens, assumed modes, or publicationHash. The actual publication hash is captured
and checked throughout the run.

Maximum input is 4 MiB / 2000 items. Preserve the full original accounting scope
outside the helper: for the reviewed 801 cohort, run the 746 normal singletons and
retain the 51 holds plus four lineage exceptions separately. Those numbers are
not built into the script or inferred from local ACK/session counts.

## One operator launch

```sh
node /private/helpers/first-sync-local-classify.js \
  --server-root /installation/server \
  --input /private/sv-746-identities.json \
  --output-dir /private/sv-classification-01 \
  --expected-database amber --actor-id 1 --installation-key amber \
  --offset 0 --limit 746
```

Paths are placeholders. Use the current active Administrator and existing runtime
environment. Default limit is 10, so set the actual scope length explicitly.
Products are processed sequentially. Fresh schema/product/category/domain reads
use the canonical service behavior; this is not an atomic Magento snapshot.
The pool enforces `default_transaction_read_only=on` on every connection and the
transport rejects non-GET methods and request bodies. Authority is checked before
and after each row and at completion; source/lifecycle is reread after inspection.

## Output and route meanings

- `scope.json`: original input bytes, unchanged.
- `results.jsonl`: fsynced start, per-item evidence and final summary. Expected and
  observed remote IDs, eligibility mode, inspection mode, ordinary/eligibility/field
  blockers, exact source snapshot/hash and field observations remain separate.
- `manifest.json`: raw input hash, canonical input hash, captured publication,
  selected slice, counts, raw subset hashes and completion status.
- Nonempty `ordinary-scope.json`, `history-scope.json`, `initial_names-scope.json`,
  `create-scope.json`, `review-scope.json`: disjoint identities for subsequent review.

Routes mean the next workflow, not permission or readiness:

| Route | Meaning |
| --- | --- |
| ordinary | Canonical ordinary lane; old ACKs do not certify current remote equality. Retain and review its ordinary blockers. |
| history | Fresh available exact legacy-snapshot admission proposal. Ordinary name/payload diagnostics remain visible and do not replace canonical admission checks. |
| initial_names | Existing pure initial-name selection validator accepted the original proof-owning inspection. A separate sealed names preview is still required. |
| create | Fresh proven absence plus canonical create lane; no CREATE authorization is issued. |
| review | Identity/lifecycle/read/history/field blockers. `reviewKind:field_stage` distinguishes first-sync field review without a new name stage. |

History and initial-name files already use their existing CLI input schemas;
the latter includes `choice:"magento"`. Other scopes are diagnostic identity
lists, not apply/API request bodies. No saved preview token is an apply plan.
The classifier never treats `inspectionReadyForOutbound`, `ordinarySendable`,
stored ACKs, or a completed manifest as fresh remote equivalence.

## Checkpoint and failure contract

Use subsets only if the `incomplete` marker is absent, `manifest.complete` is true,
`globalFailure` is null, and every used file/hash is listed in the manifest.
`remainingInput:0` is additionally required to claim the whole input was examined.
Counts partition the checked identities; the rows remain diagnostic on failure.
Authority/publication changes, changed input bytes and duplicate observed remote
IDs invalidate the whole run and publish no subsets. A per-item read failure
retains safely established identity evidence as review and continues the tail.

Existing output paths are never overwritten. Each journal record and output file
is fsynced. POSIX also fsyncs the directory; Windows lacks directory fsync, so its
power-loss directory-entry durability is not claimed. Output/fsync failures retain
or attempt to restore `incomplete`; even a readable manifest from a failed seal
must not be used. Do not remove that marker to recover a run.

Exit 0: completed slice without review rows. Exit 2: completed diagnostics with
review rows, interruption, or global invalidation. Exit 1: setup/output failure.
There is no write-resume operation. For an interrupted/unsealed read-only run,
rerun its original slice into a new directory. Completed slices can continue at
`nextOffset` in a new directory, using the unchanged input.

## Reuse existing next stages

Run `first-sync-campaign.js --stage history --mode preview` on `history-scope.json`
with its raw SHA-256 and a new output directory. Only later authorize history
apply separately. Already admitted `initial_names` rows can go directly to
`first-sync-initial-names.js --mode preview`, also with the raw scope SHA-256.
After history admission, the existing initial-names preview can review those
exact identities without repeating a full field discovery just to learn IDs.
Names apply can update automatic requests through existing triggers; it is a
separate reviewed business action. Refresh field evidence after names change.

For SV, later local choices may select Manager `price/all` and proven physical
`decor_weight/all` integer-rounding differences. Keep incoherent/zero/invalid
weight evidence for review; do not repair it here. The SV template in this task
does not provide SEO outputs, so do not invent or clear SEO. Ordinary broader
resync remains a separate exact bounded action that can authorize worker delivery.

## Synthetic verification

```sh
cd server
node --require ./test/setup-env.js --test test/first-sync-local-classify.test.js
```

Tests use fake canonical observations and fail-on-write services, real filesystem
checkpoints, and existing scope validators. They cover modes, identity mismatch,
unknown versus absent remote IDs, authority/source/input drift, disjoint outputs,
GET/read-only guards, partial reads, interruption and fsync failures. They do not
connect to a database or establish live Magento acceptance.
