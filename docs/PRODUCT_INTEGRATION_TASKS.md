# Product integration tasks

## Manager flow

A fresh product preview can identify a missing category output, a selected value
outside the published source contract, deferred AR size 29–31, or missing native
characteristic support. This is a narrow configuration finding, not proof that a
remote category/attribute/option is absent and not an approval of Magento delivery.

The creation form names the category, characteristic and selected value. An
explicit **Create Administrator task** action records a durable local task in
Attention. It does not save a product, reserve a SKU, enqueue synchronization,
publish rules, or call Magento. The same owner and exact open defect reuse one
task; each accepted request UUID retains its immutable creation context.

The form retains current input and staged photo intent. Recovery of an ambiguous
task response uses GET for the original UUID, including after a not-found result;
it never resends an uncertain POST. Editing current fields does not relabel an
older recovered receipt as a receipt for those changed fields.

## Ownership and resuming

Owners can inspect their tasks and explicitly restore the latest accepted
creation context. Restoring a nonempty current form requires the labelled replace
action. Current category/questions/options and every staged original are checked;
missing, expired, attached or foreign photos block the restore instead of being
silently discarded. Staged assets retain their existing expiry contract.
Restoration performs no upload or product save and requires a new product preview.

Administrator inspection of another owner's task provides configuration inputs
and photo count, without the owner's photo IDs/bytes or a resume action. Ordinary
creators cannot enumerate or inspect another owner's tasks. Principal changes,
permission revocation and late responses cannot carry another user's result into
the current form.

## Administrator decision

Processing requires the active immutable Administrator role plus the existing
export_templates.manage capability. Delegating that capability alone does not
grant task-wide Administrator authority. The repair link preserves the exact
category, characteristic/value and Attention return context.

The operator prepares and reviews the relevant configuration through the existing
guided workflow. Opening a task or its repair link performs no synchronization,
publication or remote write. Explicit resolution inspection reads the current
local configuration. A final acknowledgement requires the exact task revision
and fresh resolution token and rechecks authority and configuration under the
mutation fence. Concurrent acknowledgements produce one durable resolution.

A resolved task proves only that its narrow local configuration blocker cleared.
It does not approve delivery, enable a product, or replace a fresh product preview
and existing reviewed Magento publication/delivery checks.

## API and installation

All routes share the application's authenticated active-user boundary. Mutations
also require CSRF and existing business gates.

| Route under /api | Authority |
| --- | --- |
| POST /integration-tasks | products.create |
| GET /integration-tasks/attempts/:requestId | products.create; original actor only |
| GET /integration-tasks | products.create or export_templates.manage; service scopes ownership |
| GET /integration-tasks/:id | same ownership boundary |
| GET /integration-tasks/:id/resolution | actual Administrator and export_templates.manage |
| POST /integration-tasks/:id/resolve | same Administrator boundary; revision/token required |

Migration 067 creates permanent tasks and immutable UUID attempt evidence. It
creates no task from existing history, changes no product or permission, and
performs no remote operation. The feature is advertised only with the existing
public-identity activation gate. Local tests and synthetic UI renders remain
separate from authenticated browser and real Magento acceptance.
