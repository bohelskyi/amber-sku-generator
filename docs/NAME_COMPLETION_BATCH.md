# Batch completion of missing names from Magento

`server/scripts/name-completion-batch.js` runs the existing **Заповнити назви з Magento**
action (`name-resolution` preview/apply with `intent: "complete"`, `choice: "magento"`)
for an explicit list of SKUs, one product at a time. It adds no new write rule.

Business rule (confirmed 2026-10-14): when Amber cannot produce a full UA/EN name pair
and Magento has a valid UA/EN pair, Amber accepts the Magento pair without manual
review of each product.

## What each product goes through

The canonical action is unchanged:

- The published definition must use `effective-product-names-v1`.
- Amber's own pair must be missing.
- Magento must have exactly one active `en` store view and the same remote identity in both scopes.
- The action refuses unresolved dispatched work.
- Apply takes the public-identity and SKU locks, re-reads Magento, and compares the
  preview token against that fresh read (`MAGENTO_NAME_PREVIEW_STALE` on change).
- It repeats product, name-state and binding CAS inside the access transaction.
- A successful apply stores `magento_name_override`, writes the
  `product.magento_name_external_accepted` audit and makes the automatic request
  `pending` with a new generation. It does not touch `reconciliation_required`.

The batch transport accepts GET only. The batch never enqueues jobs, never resends,
and never writes to Magento. Delivery and ACK remain with the ordinary worker.

## Modes

| Mode | Writes | Purpose |
| --- | --- | --- |
| `preview` | none (read-only pool) | Runs the canonical preview for every SKU and writes `preview.jsonl`. |
| `apply` | local, per product | Writes a `prepared` intent before each apply and a `receipt` after it. Each record is fsynced to `journal.jsonl`. |
| `resume` | local, per product | Continues the same output directory. See below. |
| `status` | none (read-only pool) | Reports the automatic request for every receipt. `delivered` means `state = synced` and `synced_generation >= desired_generation`. |

How `resume` treats each product:

- **Has a receipt:** skipped.
- **Has an intent without a receipt:** checked read-only for the exact stored pair plus its
  audit after the intent. If found, a recovered receipt is recorded.
- **Has no commit evidence:** nothing was saved, because the action is one local transaction.
  A fresh canonical preview decides again.

Product-level refusals are recorded as `review` with their code, and the tail continues.
A lane busy with the worker (`MAGENTO_SYNC_BUSY`) is retried once at the end. Authority
or configuration failures stop the run.

Exit codes:

- `0`: all processed products completed, or all were delivered for `status`.
- `2`: review rows remain, or delivery is not finished yet.
- `1`: setup or global failure.

A leftover `run.lock` is never removed automatically.

## Input

The input is one of:

- JSON: `{"items":[{"sku":"SV1121001"}]}`.
- Output of the read-only `sv-name-shape-diagnostic.js` (`.jsonl`). Only rows with
  `completionDecision: "completion_review"` are taken.

The limit is 2000 SKUs.

## Running in the server container

The script loads services from `--server-root` and has no sibling dependencies. It can
run from a temporary directory before it is part of a deployed image:

```bash
D=/tmp/name-completion-$(date +%Y%m%d)
docker compose exec -T server mkdir -p $D
docker compose cp server/scripts/name-completion-batch.js server:$D/
docker compose cp shapes-all.jsonl server:$D/
docker compose exec -T -u root server chmod -R a+rX $D
S="node $D/name-completion-batch.js --server-root /app --expected-database amber --actor-id 1"

docker compose exec -T server $S --mode preview --input $D/shapes-all.jsonl --output $D/preview-01
docker compose exec -T server $S --mode apply   --input $D/pilot.json      --output $D/run-01
docker compose exec -T server $S --mode status  --output $D/run-01
```

Start with a small pilot (`pilot.json`, about 5 SKUs). Wait until `status` reports
those products delivered, then run the remaining list in a new output directory.
Copy output directories to persistent host storage before the container is recreated.

## Verification

- `server/test/name-completion-batch.test.js`: arguments, input filtering,
  intent/receipt order, per-product refusal, busy retry, global stop, resume recovery,
  the GET-only transport and status.
- `server/integration-test/name-completion-batch.test.js`: disposable PostgreSQL with
  the real canonical action. It covers two legacy products, a remote change between
  batch preview and locked apply, resume, two audits, zero jobs and GET-only
  transport.

Repository tests are not production acceptance.
