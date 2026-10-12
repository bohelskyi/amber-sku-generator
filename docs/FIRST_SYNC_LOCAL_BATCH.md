# Reviewed local authority through canonical first-sync

This adapter reconciles confirmed Manager prices (all categories), exact physical
weights for integer-rounding-only differences, and current Amber SEO. It operates
on one product atomically and limits each packet to ten products. It is not a
catalog exporter or a historical/lifecycle unblock. Deployment and production
execution require their own approval; repository tests are not live acceptance.

## Normalize a reviewed packet

Use the current publication from `GET /api/admin/magento-integration`:
`currentPublishedId`, plus the exact definition hash. Never reuse a remembered
binding UUID. Exact source snapshots and remote IDs come from reviewed inventory;
catalog membership alone does not prove eligibility. The large audit manifest is
not a request body. Convert only reviewed eligible candidates into bounded packets:

```json
{
  "bindingRevisionId": "11111111-1111-4111-8111-111111111111",
  "expectedDefinitionHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "items": [{
    "sku": "SYNTHETIC-EXAMPLE",
    "remoteProductId": 1001,
    "expectedProduct": {
      "id": 1,
      "public_product_identity_id": "17",
      "full_sku": "SYNTHETIC-EXAMPLE",
      "public_sku": "SYNTHETIC-EXAMPLE",
      "category": "NM",
      "status": "active",
      "exclude_from_export": 0,
      "corrected_to_product_id": null,
      "sku_schema_version_id": null,
      "characteristic_version_id": null,
      "weight_numeric": "132.300",
      "total_price_uah": "1700.00",
      "answers": {},
      "magento_name_subject_ua": null,
      "magento_name_subject_en": null,
      "magento_name_override": null
    },
    "fields": [{"target":"decor_weight","scope":"all","local":"132.300","remote":132}]
  }]
}
```

All source keys are required; copy exact JSON types from the snapshot. Use the
physical custom gram target from the published binding, never native Magento
`weight`. Price scope is `all`; SEO scopes are `all` and `en`. Duplicate products,
fields, sparse arrays and unsupported properties are rejected. No automatic
physical weight adoption is introduced: 132.300 and answer `"132,3"` represent a
filled physical source. Non-rounding differences need a separate review.

## Preview without writes

From the configured server container/workspace, use an explicit existing active
Administrator application-user ID and exact database name. No app, workers or
migrations are started by this script:

```text
node scripts/first-sync-local-batch.js --mode preview --input packet.json --output new-preview.json --expected-database DATABASE_NAME --actor-id ADMIN_ID
```

The preview uses current canonical Magento GET observations and short existing
local authority/identity locks. It performs no persisted Amber changes, adoption,
enqueue or Magento writes. Output is a new private file (0600, exclusive create).
The printed SHA256 hashes the canonical JSON plan, not raw file bytes.

Review every `results[]` entry, selected `applyInput.choices`, `initialImports`,
`remainingBlockers`, and `readyForOutboundAfterChoices`. `readyForApply` means the
local decision can be recorded; it does not certify delivery. Historical holds,
retired/test products, changed IDs/snapshots/bindings, unknown/malformed values,
unproven EN scope/inheritance and unready canonical payload remain blockers.
Ordinary products require their separate ordinary preview. A global authority
failure removes every ready command and marks untouched products `not_checked`.
Exit 2 indicates blockers, untested products or an ordinary-preview requirement.

## Apply reviewed local choices separately

Only after approval of the concrete preview, use that exact plan and its printed
hash, same actor/database, and a new output path:

```text
node scripts/first-sync-local-batch.js --mode apply --input new-preview.json --output new-local-receipts.jsonl --expected-database DATABASE_NAME --actor-id ADMIN_ID --plan-sha256 REVIEWED_PLAN_HASH
```

A plan hash does not prove field facts by itself. On a fresh apply, the server
compares every requested source, identity, definition, actual field value and
rounding claim with the already obtained canonical preview before any commit.
Exact committed receipt replay precedes this check and performs no new transition.

This mode writes canonical local first-sync receipts and any explicitly reviewed
canonical initial imports visible in the plan. It sends no Magento mutation and
directly enqueues no job. Canonical initial imports can change product/name data
and stage ordinary automatic sync requests through existing database triggers.
If automatic synchronization is enabled, an existing worker may process those
requests under the existing first-sync gate; review this effect with the imports.
This tool never suppresses or resets that queue. It repeats fresh preview-token, publication, identity, actor,
protected-work, audit and CAS checks. All choices of one product share one existing
transaction. Packet products are sequential; rejection stops the packet, preserves
prior committed receipts in an append-only JSONL journal, and reports recorded,
failed, unconfirmed and untouched counts. An unknown apply/commit failure is
`unconfirmed`, never proof that nothing committed. Each journal line is fsynced
before moving to the next product; a partial last line cannot replace older lines. Repeating
the original plan recovers exact receipts without duplicate transitions. Preserve
both files privately; a disk/transport failure is not proof that nothing committed.
Re-read the canonical receipt before any retry with a new plan.

An unfinished old NM `seo_pending_initial_readback` can be explicitly changed to
local outward direction under migration 076 only before protected work, with
exact old revision/evidence, current mapping and fresh text proof. Earlier records
remain unchanged. Existing completed sessions, terminal fields, uncertain catalog
steps, media and visibility fences cannot be reset by this workflow.

## Canonical delivery and acceptance

After recording choices, request a fresh first-sync preview. If initial name or
other canonical imports changed the product, obtain a fresh snapshot/packet; the
old preview cannot authorize a job. Resolve remaining blockers separately. Use the
existing exact-product sync preview, enqueue, apply and readback workflow for each
sendable product. No bulk automatic dispatch is provided here. Confirm exact
Manager price, non-rounded physical weight, both SEO fields in each selected
language, acknowledged job, `outward_verified` fields and completed session.
Repeated clicks/retries must not create another receipt or repeat a remote step.

Media reconciliation is separate. `photos/reconcile` performs remote GET reads
but writes local receipts/jobs and may resume work; it is not a read-only diagnostic.
For uncertain media, prepare a diagnostic plan without invoking that mutation.

## Test evidence and limits

Focused units cover strict choices, no implicit SEO adoption, malformed values,
integer rounding, source drift, authority revocation, validated readiness,
exclusive output, digest checks, partial packet failure and the GET-only firewall.
Disposable PostgreSQL 16 tests cover migration rollback/upgrade/restart, immutable
history, old pending supersession, direct SQL trigger denials, protected work,
atomic local choices, zero-write preview, idempotent receipts, local SEO delivery
and verified readback with successful job acknowledgment. All transport is synthetic; production manifest execution
and live Magento acceptance remain separate.
