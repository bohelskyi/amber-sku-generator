# PR4: form editor and controlled published export

## Shared-session execution checklist (recorded before implementation, 2026-09-23)

Starting branch `feature/magento-export-constructor`, HEAD
`7003432d92a3dc8a182a751ccae413e2bcd034ca`; 18 modified tracked files and
13 untracked PR4 files are preserved. Migration inventory is 000–036; 037 is
the next available forward migration. No index/branch operations are authorized.

Execution checkpoints: (A) failing-before principal regression, lifetime and stale
dispatch guards; (B) local interpolation composition and router dirty navigation;
(C) durable private/shared sessions, invitations, atomic attempt capture and all
snapshot access paths; (D) explicit resume/share/join UI; (E) focused then full
checks on guarded Node 20 and only the canonical disposable PostgreSQL service.
Review each delta, retain all original oracle/migration bytes, then document results.

Proposed durable states: session editable → prepared → result (configuration
frozen); attempts prepared → executing → succeeded or failed. Under exclusive
session coordination, an interrupted executing attempt with no committed result
is recoverable under its original identity; no timeout declares it dead. Explicit
refresh/edit can supersede only while holding that coordination lock. Every command
checks current configuration/attempt and membership epoch, fencing old commands.
There is at most one successful snapshot per session. Prepare commits metadata only.

Permission matrix: active exports.view+exports.create creates a private session;
owner/accepted member plus exports.view reads; pending target sees minimal invitation
metadata and explicitly accepts/declines; accepted target may leave. Owner plus
exports.create invites/revokes. Owner/accepted member plus view+create saves,
prepares, generates and confirms. Non-active selection still requires activate.
Template authoring stays separate. No role-name bypass; every session-linked direct
snapshot/CSV/key path checks membership. Historical snapshots retain their contract.

Actual existing capture order inspected in export.service/published-capture:
shared access advisory lock before RR → per-key xact lock → selection → ascending
products → ascending revisions → new-mode cursor → snapshot/artifacts/audit.
Confirmation is snapshot → revisions → cursor. Proposed integration prepends a
per-session exclusive advisory lock **before BEGIN/RR**, after the access lock;
then session/membership/attempt evidence before existing capture or confirmation
locks. Session edits, join/revoke/leave and reconciliation use the same order.
Access writers never wait on sessions/products. Capture and its durable result link
must commit together using the existing coordinator; reads never generate/confirm.
This section records the original execution design. Completed verification follows.

## Completed corrections and durable shared sessions — 2026-09-23

This is the current implementation result. The earlier implementation/acceptance
records below are retained as historical evidence; their statements about unsafe
principal transitions, unsupported local slots, missing SPA protection and no
durable recovery describe the **pre-correction** checkout. They are superseded
by this section and [the current shared-session guide](SHARED_EXPORT_SESSIONS.md).
Browser/business/Magento acceptance remains separate and is not claimed here.

### Checkpoint A: principal isolation

The required safe assertion was run against the original active A → active B
`auth.refresh()` behavior with equal permissions and no intermediate logout.
It failed: after local user ID became `2`, `pendingCreate` still contained A's
original request/proof/key instead of `null`. The actual failing run is retained
in the process-local `session-isolation-before.log`: one failure, 17 skipped.
This replaces the previous unsafe characterization expectation.

AuthProvider now synchronously invalidates a lifetime object before changing local
application-user identity/CSRF. The export provider is keyed by local user ID and
effective export access; stale dispatch and response continuations check lifetime
validity. A → B → A does not revive A's first controller. Same-user profile/CSRF
refresh preserves the current lifetime. Axios captures request context synchronously
and ignores late A authentication errors for B. No browser token storage was added.

Rendered regressions cover pending work, old action references, old preview/create/
download/confirm responses, logout, permission loss and route persistence. The
controlled-controller suite has 20 passing cases; the former failing case now
passes. Shipped durable session UI separately checks explicit B-authorized reopening,
revocation cleanup and discarded late downloaded bytes. This is component/mock
evidence, not a real-browser OIDC claim.

### Checkpoint B: local forms and unsaved navigation

Local interpolation slots now have add/rename/remove forms using the existing
literal, approved text-source and semantic-source/compatible-lookup vocabulary.
The KL scenario adds mapped color while retaining material and SKU and evaluates
`Кулон з {material} бурштину, {color}. Арт: {sku}` without a new global binding,
mapping rule or evaluator extension. Rename explicitly rewrites placeholders;
removal rejects still-referenced slots. Invalid/prototype-sensitive/duplicate names,
dangling placeholders, incompatible types and the 16-slot limit are covered.
Shared consumer scope, local-copy behavior, sparse EN and no-op hashes remain intact.

The installed router now uses its supported data-router `useBlocker` mechanism.
Internal links/history and relevant family/version/session transitions offer Save /
Discard / Stay. A failed save or CAS conflict retains exact input and blocks
departure. `beforeunload` remains a separate best-effort unload warning. Memory-router
tests cover these transitions; actual browser back/forward prompts, keyboard/focus
and narrow rendering have not been visually verified.

### Checkpoints C/D: durable operations and explicit sharing

Forward migration [037_shared_export_sessions.sql](../server/migrations/037_shared_export_sessions.sql)
adds sessions, epoch-versioned invitations/membership, immutable attempt evidence and
atomic snapshot association. No historical snapshot ownership is invented. Every
new controlled operation in the shipped UI starts with private durable metadata.
Original PR3 direct callers remain compatible; default/price modes remain explicit
and retain their established semantics.

The operator chooses **Створити свій експорт**, enters title/range/publication and
creates private metadata. Read-only preview, durable preparation, actual file
generation, download and explicit confirmation are separate actions. Owner
**Поділитися** selects an existing named local user. That user sees a minimal
**Запрошення** entry, current capability limits and **Приєднатися до експорту
користувача X**. Acceptance opens the same operation through their own request.
They can instead create an independent session. **Мої експорти** and **Спільні зі
мною** provide paginated authorized reopening. Deep links never auto-open or replace
unsaved work. Owner can revoke; accepted participant can leave. Sharing still works
after generation without changing stored bytes or original actors.

| Authority | Owner | Accepted participant | Pending target / unrelated user |
| --- | --- | --- | --- |
| Read session/preview/linked manifest and CSV (`exports.view`) | Yes | Yes | Minimal invitation only / no access |
| Save/prepare/generate/confirm (`exports.view` + `exports.create`) | Yes | Yes | No |
| Recipient search/invite/revoke (same capabilities) | Yes | No | No |
| Accept/decline/leave (`exports.view`, exact target/epoch) | Not applicable | Leave | Accept/decline pending invitation only |
| Non-active publication | Additionally `export_templates.activate` | Same requirement | No borrowed authority |

Administrator role alone grants no private session or linked snapshot access.
Capabilities are current effective capabilities; membership grants none. Direct
manifest/internal CSV/group CSV/confirmation and completed-key recovery paths enforce
the same additional membership boundary. Unknown/inaccessible reads use the same
404 boundary. Historical non-session snapshots keep the old contract. Global status
retains global cursor/counts while hiding private last-result ID/range/row count.

Preparation stores original normalized intent, configuration revision, publication/
evaluator/input binding, signed proof, internal key and preparer before capture.
Proof/key stay server-side. Metadata does not expose/reserve products or advance any
cursor. Successful capture freezes settings and writes snapshot/artifacts/exposure/
revisions/audit plus attempt/session result links in the existing single transaction.
Database uniqueness, immutable evidence, insert guards and deferred reverse-link
constraints enforce one committed result per session and no orphaned result.

The final lock order is the shared access-admin advisory boundary → exclusive
session advisory lock, both before BEGIN/RR → fresh membership/epoch/revision/attempt
checks → existing per-key/selection/products/revisions/cursor capture order. Confirm
uses the same access/session prefix → snapshot/revisions/cursor. Access writers never
wait on sessions/products. Current permission is protected through session-lock waits;
membership is loaded freshly after the wait. This preserves PR3 RR rollback/fresh
winner handling and the global singleton cursor. Sessions do not reserve ranges.

Reads reconcile exact durable identity: committed result opens stored bytes; a busy
session lock reports pending; an executing marker with the lock available reports
interrupted. There is no timeout-based declaration of failure. Explicit retry uses
the original attempt; explicit supersession is fenced under the same lock. Opening
never generates/confirms. Polling is bounded to visible idle detail every ten seconds
plus focus/manual refresh; dirty input remains based on its original revision.
Known historical snapshot IDs can be explicitly opened; unknown pre-feature operations
without durable evidence still have no guaranteed recovery or heuristic backfill.

### Checkpoint E: real HTTP/PostgreSQL and race evidence

Twelve new serialized shared-session integration cases use normal authenticated
HTTP routes with independent synthetic OIDC users and the canonical disposable DB.
They establish more than component mock recovery:

- A private operation denies B/C and an unrelated Administrator; only named B sees
  minimal invitation metadata and explicitly joins. B can create a separate operation.
  A viewer reads/downloads but cannot generate/confirm. Owner permission loss is enforced.
- A test-only outer HTTP wrapper destroys the socket **after committed** create,
  prepare and generation responses. A new independently authenticated client for
  the same local user finds the original session/attempt/exact snapshot through lists.
  The production application/auth code is unchanged by this response-loss harness.
- A separate Node process exits with code 86 after executing metadata/exposure work
  but before snapshot INSERT. PostgreSQL rolls capture back and releases the lock;
  another authorized participant resumes the original identity without a TTL. The
  original first initiator and actual later snapshot creator remain distinct.
- Completed recovery also runs in a fresh process with time advanced past original
  proof expiry and the compiler unavailable, returning the exact stored result with
  no recapture. A full client unmount/remount is separately exercised with mocked APIs.
- Independent connections and explicit query barriers plus `pg_blocking_pids` force
  A/B prepare/generate races, executing-status reads, concurrent CAS edits, an old
  queued attempt behind a winning revision, and both revocation/capture orderings.
  Final IDs/counts/actors/audit/artifact bytes/cursor/revisions are asserted. A prior
  revoke denies the waiting worker; prior committed capture survives a later revoke.
- Permission revocation and disablement committed while a worker waits at the access
  boundary prevent capture. Leave/reinvite/rejoin changes epochs and rejects old work.
- Injected artifact, snapshot-audit and result-link errors roll back every capture
  effect; no fake success remains. Retry/supersession are explicit. Concurrent confirm
  keeps one confirmer/event and later price revision 3 remains pending above confirmed 2.
- Fresh migration startup, actual 036 checkpoint upgrade, forced 037 rollback and
  repeat startup preserve old checksums, old bytes/null attribution and immutable
  attempt/result constraints. The wider preexisting integration suite also passed.

At UI review, two additional creation regressions were fixed: definitive validation
failure unlocks correction; unknown transport outcome retains the exact descriptor.
Explicitly discarding that form and choosing a new operation creates a new workspace
lifetime, without resurrecting the old key. It does not claim the old server operation
was rolled back; it remains discoverable through authorized lists.

### Final verification and boundaries

The verified process-local executable is Node **20.20.2**. Its guard verifies the
exact executable/version in child processes too; repository/dependency configuration
was not changed. npm scripts used the existing process-local npm launcher and Git
Bash script shell. No new dependencies or lockfile changes were introduced.

| Final check | Actual result |
| --- | --- |
| Focused shared-session HTTP/DB suite | 12 passed; 174 unrelated cases skipped |
| Focused session UI suite | 8 passed |
| Server `npm test` | 486 passed, no skips/failures |
| Server `npm run lint` | 0 errors; two existing `product-timeline.js:391` unused-variable warnings |
| Server `npm run test:integration` | 186 passed, no skips/failures |
| Client `npm test` | 118 Node + 152 Vitest tests (16 files) passed |
| Client `npm run lint` / `npm run build` | Passed |
| Protected files | 56 unchanged against HEAD checkout/blob and normalized SHA-256, including all 37 historical migrations 000–036 and PR1 oracles |
| `git diff --check` / index | Passed / no staged paths |
| Real browser/OIDC/two-user desktop/narrow/keyboard checks | Not run: CUA inventory returned `apps: [], browsers: []`; no verified isolated authenticated UI available |

Database identity was verified as `amber_test`, user `amber_test`, PostgreSQL
**16.15**, canonical `postgres-test` on `127.0.0.1:55432`. Only that disposable
service and its harness databases ending `_test` received test/migration writes.
After the final integration suite only `postgres-test` was stopped; status is
**Exited (0)**. No fallback PostgreSQL instance or useful DB was accessed.

Final logs are process-local under `%TEMP%/amber-pr3-node20/`: `shared-server-unit-final.log`,
`shared-server-lint-final.log`, `shared-integration-final.log`, `shared-client-final.log`,
`shared-client-lint-final.log`, `shared-client-build-final.log`, and focused logs.
These are local reproduction evidence, not committed artifacts. Git reports the
existing LF→CRLF working-copy warning for `12-export-template-snapshots.cases.js`;
historical migration checksums/bytes were not rewritten.

Remaining acceptance prerequisites: a verified isolated real-OIDC two-user browser
environment; actual reload/back/forward, keyboard/focus and ~375px/~1280px visual
checks; current catalog/readiness/business validation; retained recount release
prerequisite and separately authorized Magento Check Data/import/rollout gates.
No auth bypass, live template activation, production action, dump/restore, deployment,
Magento check/import or recount behavior change occurred. Previously downloaded files
cannot be revoked. Historical unknown operations without durable evidence remain a
documented limitation. Original ten pure goldens, mappings, semantic-difference
register, evaluator, formula neutralization and legacy price meaning remain unchanged.

### Final file register

Branch/HEAD are unchanged: `feature/magento-export-constructor` at
`7003432d92a3dc8a182a751ccae413e2bcd034ca`. The original 18 modified + 13 untracked
PR4 paths were preserved. Final status is **28 modified tracked + 23 untracked
files**, nothing staged. The register includes preexisting PR4 work, not only files
first created in this task. All tracked/untracked deltas were reviewed. No staging,
commit, push, reset, clean, stash, rebase, merge, cherry-pick or branch switch was run.

Modified tracked paths:

```text
PROJECT_CONTEXT.md
client/src/api/exports-api.js
client/src/auth/AuthProvider.jsx
client/src/components/app/ExportTools.jsx
client/src/components/app/WorkspaceNav.jsx
client/src/hooks/product/useProductExportController.js
client/src/hooks/useSkuManager.js
client/src/lib/api.js
client/src/lib/role-management.js
client/src/pages/AppPage.jsx
client/src/router.jsx
client/test/auth.test.jsx
docs/AUTH_RBAC.md
docs/DATABASE_MIGRATIONS.md
docs/EXPORTS.md
docs/EXPORT_TEMPLATES_V1_PLAN.md
docs/README.md
server/integration-test/02-migration-foundation.cases.js
server/integration-test/06-migration-upgrades.cases.js
server/integration-test/12-export-template-snapshots.cases.js
server/integration-test/critical-flows.test.js
server/src/routes/admin/export-templates.routes.js
server/src/routes/endpoint-manifest.js
server/src/routes/public.routes.js
server/src/routes/public/exports.routes.js
server/src/services/audit-viewer.service.js
server/src/services/export-templates/template.service.js
server/src/services/export.service.js
```

Untracked paths (including preserved preexisting PR4 files):

```text
client/src/api/export-sessions-api.js
client/src/api/export-templates-api.js
client/src/components/app/ControlledExportOptions.jsx
client/src/components/export-templates/DefinitionEditor.jsx
client/src/hooks/product/export-workflow-context.jsx
client/src/hooks/product/useExportWorkflow.js
client/src/hooks/useDirtyNavigation.jsx
client/src/lib/export-template-editor.js
client/src/pages/ExportSessionsPage.jsx
client/src/pages/ExportTemplatesPage.jsx
client/src/pages/ExportsPage.jsx
client/test/controlled-template-export.test.jsx
client/test/export-sessions-ui.test.jsx
client/test/export-template-editor.test.js
client/test/export-template-ui.test.jsx
docs/EXPORT_TEMPLATES_PR4.md
docs/SHARED_EXPORT_SESSIONS.md
server/integration-test/12-export-sessions.cases.js
server/integration-test/12-export-template-editor.cases.js
server/migrations/037_shared_export_sessions.sql
server/src/routes/public/export-sessions.routes.js
server/src/services/export-session-access.js
server/src/services/export-sessions.service.js
```

## Earlier PR4 implementation and acceptance record (historical)

Implementation checkpoint, 2026-09-23. This is **not operational acceptance or rollout**.

## Checkout and checklist

Actual workspace: `D:/Work/amber-sku-generator`; branch
`feature/magento-export-constructor`; starting HEAD
`7003432d92a3dc8a182a751ccae413e2bcd034ca`. Starting `git status --short` was empty,
including untracked files. PR3 was already committed. Migrations were 000–036.
AGENTS.md, PROJECT_CONTEXT.md, current Exports/Auth guides, relevant plan sections
and actual PR2/PR3 addenda/contracts were read before implementation.

Completed implementation checklist:

- Reuse PR1B definitions/compiler/evaluator and PR2/PR3 services unchanged in semantics.
- Add read-only server candidate preparation from the actual captured catalog.
- Implement structural forms, separate saved-revision actions and immutable publication browsing.
- Add explicit controlled export without switching the default or price workflow.
- Bind uncertain creation to one original operation across route navigation.
- Add rendered/model/API regressions and a real serialized PostgreSQL lifecycle.
- Characterize same-input persisted SV escaping without replacing the original oracles.
- Review scoped tracked/untracked changes and record verification limitations.

## Routes, adapters and permissions

`/admin/export-templates` requires `export_templates.view` and does not mount or
request administrative sources/definitions without it. Independent manage,
publish and activate capabilities govern their own controls. Manage alone does
not grant definition access; view+publish works without manage; view+activate
can browse publications and select them. Draft previews require manage+exports.view.
Role administration has Ukrainian labels for all four existing capabilities;
no role grants, dependencies, auth bypasses or migration changes were introduced.

The new `GET /api/admin/export-templates/candidate` requires view+manage. Inside
REPEATABLE READ READ ONLY it uses `loadSourceEvidence`, `loadMagentoCatalog` and
the existing `materializeMagentoV1` factory, reports duplicate/source diagnostics,
and returns the detached definition/hash. Missing contracts remain diagnosed;
the adapter never substitutes seed/test defaults or repairs a catalog. The
explicit create button calls the existing authorized mutation service. Preparing
a candidate writes no family, draft, publication, selection or export state.

The new `GET /api/export/template-options` is an exports.view read model. It
returns safe publication name/number/IDs and selection generation, never
definitions or sources. Only activate-capable actors receive non-active version
identities. `/exports` therefore works for delegated exporters without product or
template-admin access; the same workspace remains on the product page.

Existing APIs/transport remain authoritative: draft CAS uses decimal-string
expectedRevision, validate/preview/publish send the exact saved revision and
server hash, clone sends same-family versionId, selection sends expectedGeneration.
Auth/CSRF wrappers, server permissions, access locks, publication semantics and
PR3 token/transaction/idempotency rules were not replaced.

## Forms and lossless behavior

The form supports six groups and base/EN rows; approved column ordering with move
buttons; literal types and significant whitespace; approved source references
with kind/category/key/unit hints; lookup selection/entries; name/category
interpolation and declared slots; conditions, ordered fallback lists, numeric
bands, diagnostic text, text flags, joins, requiredness, captured visibility and
allowed IDs. Empty EN cells stay absent until explicitly added, with no inherited
base value. Schema routes/column membership and identity SKU/store/type controls
are protected; required identity cells cannot be removed.

Editing changes only the selected structural path. Bindings are not flattened,
regenerated or reordered. Shared rule/table panels show transitive consumers,
including groups and readiness checks. A local rule copy replaces only that
reference; nested references/tables remain explicitly shared. A separate table
copy can be edited and explicitly selected by that local rule. No render-time
default chooses a source, rule, table or version. Server hashing/evaluation is
never imported into the production client; server imports occur only in tests.

Unsupported future operations/formats stay intact and are explicitly read-only.
Source descriptors/aliases, fixed evaluator policies, binding identity/scope and
question existence evidence are inspectable but not freely rewritten. The editor
does not create an arbitrary scripting/node language or alias lineage. Declared
interpolation slots can be edited through their existing expression controls;
adding/removing slot declarations or creating entirely new binding IDs is not
offered in this checkpoint. All baseline mapping expressions are available through
forms; technical JSON is read-only. These limits do not prevent baseline editing,
literal overrides, table copies, visibility edits or column ordering.

Inline numeric/interpolation checks attach errors to the control; native form
validity prevents sending an unfinished numeric input. Server errors retain their
codes/reference diagnostics. Full semantic and source validation remains server-owned.

## Draft/publication lifecycle and races

There is no autosave. Local edits, the saved revision, validation, test-preview
and immutable publication have distinct labels/actions. Editing invalidates local
evidence. Revision conflicts preserve unsaved forms without fetching a revision
for automatic overwrite. Dirty forms prevent family/version switching until
explicit save/discard. Request-generation guards ignore obsolete family, save,
validation and preview results. Publishing sends only the currently intended
saved revision/hash; it does not silently save newer edits. Publication and
candidate selection are separate, and published content is edited only by cloning.

Draft test-preview accepts a clearly labelled list of 1–100 unique product IDs.
It never sends product answers/prices, never silently drops missing IDs, and makes
no unauthorized product-search requests. It displays server readiness, diagnostic
text and sample CSV as text, with no executable HTML or durable export effects.
It cannot provide a published-export creation token.

## Controlled export and recovery

The opt-in checkbox starts off, regardless of activation metadata. In controlled
mode the operator can choose the selected publication; activate-capable operators
can select an explicit other publication by name/version (UUIDs remain secondary).
The preview exposes the effective identity; incompatibility/unavailability is an
error, with no silent fallback. Candidate selection affects only explicitly opted-in
future operations; it is not a global rollout switch.

The sequence remains published preview → explicit create → stored downloads →
explicit normal confirmation. Real snapshot creation can establish exposure;
confirmation can advance the normal cursor. Draft tests are the read-only alternative.
Grouped readiness, custom-range disclosure, problem expansion and manual-name
resolution remain. A correction obtains fresh preview evidence. Price-export
create/download/confirm semantics are unchanged and accept no template selection.

One pending descriptor retains the original intent, effective evidence, token
and idempotency key. Synchronous submit exclusion prevents double-click creation.
Transport/ambiguous failures do not create a replacement key, refresh/rebind, or
claim that no snapshot was created. Retry sends the original operation even after
local time would exceed token TTL; the server resolves completed retries. Explicit
stale/expired unused-preview codes invalidate evidence and require a fresh action.
An arbitrary 409, idempotency conflict or authorization denial never triggers an
automatic retry or legacy fallback.

The shared mounted controller survives internal route navigation. Tokens are
memory-only: not decoded, logged, placed in URLs or persisted in browser storage.
**Reload/close/logout recovery remains limited:** in-memory uncertain operations
do not survive it. The UI warns and shows the idempotency key for reconciliation;
it does not invent successful recovery or silently start another operation.
After success, the snapshot ID, manifest and captured range own download/confirm;
later selector changes cannot attach those files to a different range/version.
A failed confirmation retries that same snapshot, never another creation.

## SV escaping evidence and preserved oracles

The original `SV-escaping` fixture passes `full_sku: " =SKU"` before persistence.
Migration `001_sku_registry_and_indexes.sql` defines `products_reserve_sku`, a
BEFORE INSERT OR UPDATE OF full_sku trigger calling `reserve_product_sku()`.
That application/schema function executes `UPPER(TRIM(NEW.full_sku))`, producing
the exact persisted `"=SKU"`. This is not a universal PostgreSQL text behavior.

The existing PR3 supplemental expected Buffer is retained. A new focused assertion
reloads the authoritative persisted product, feeds it and the same captured rules
to the old `buildMagentoPayload`, and compares exact UTF-8 bytes with the new
published-template stored artifact (also compared with the HTTP download).
It passed. No unexplained same-input exporter mismatch was found by this check.

The distinct claims remain: ten original pure goldens through persisted definitions;
nine original literal storage goldens; one separately characterized normalized-SKU
storage case. No original oracle, CSV normalization, escaping rule, trigger,
historical migration or closed semantic-difference register was changed.

## Verification and remaining gates

Runtime: the verified existing npm-cache Node executable reports **20.20.2**;
the process-local `%TEMP%/amber-pr3-node20` npm **10.9.0**, Git Bash launcher and
NODE_OPTIONS exact-executable/version guard cover child processes. No system Node,
persistent npm configuration, dependencies or package scripts changed.

Only the canonical Compose `postgres-test` service was started. Identity was
`amber_test` / `amber_test`, PostgreSQL **16.15**, loopback **127.0.0.1:55432**.
TEST_DATABASE_URL and DATABASE_URL were set to the AGENTS throwaway URL before
DB-bound imports. Existing destructive tests ran serialized on that service;
no useful database, restore, new dump, production or Magento operation occurred.

| Check | Result |
| --- | --- |
| New pure editor-model tests | 5 passed; includes all ten unchanged golden CSVs and server canonical hashes |
| New rendered/API suites | 30 passed across two files |
| Focused PR4 + PR3 persisted-boundary integration | 3 passed, 171 unrelated cases intentionally filtered |
| Full client npm test | 117 Node tests + 132 Vitest tests in 15 files passed; no failures/skips |
| Client lint | Passed, no diagnostics |
| Client production build | Passed |
| Full server npm test | 486 passed, no failures/skips |
| Server lint | Passed; two pre-existing unused sortOrder/sourceOrder warnings in product-timeline.js:391 |
| Full serialized PostgreSQL integration | 174 passed, no failures/skips |
| Protected file verification | 56 files byte-identical to HEAD/checkout filters, including 37 migrations 000–036 and eight original PR1A oracle working/blob fingerprints |
| Whitespace/index | git diff --check passed; index unchanged |

One intermediate concurrent verification run exposed the existing UsersPage auth
test's timing sensitivity; its isolated repeat and final full client suite passed
without modifying that test or access code. An intermediate new read-model query
used a UUID cast against the existing text IDs; integration caught it and the query
was corrected to the actual schema before the passing full integration run.

Browser visual inspection was attempted with the available CUA tool. It returned
`No browser is available`; inventory contained `apps: []`, `browsers: []`.
No browser screenshots, desktop/narrow layout, real keyboard/focus navigation or
pixel-level visual acceptance are claimed. The rendered DOM behavior tests use
the actual components but do not substitute for that remaining visual check.

Remaining release/acceptance prerequisites are unchanged: the documented missing
recount release fix (not reinvestigated), real target catalog/source/alias evidence,
frozen requiredness/visibility approval, KL.addit=0 decision, narrow SV naming,
closed malformed-input semantic differences, measurement-unit expectations,
real-browser visual review and a fresh controlled six-group Magento Check Data
run with approved publication/hash/manifests. Check Data is not Magento import.
Synthetic tests set no acceptance flag and do not authorize operational rollout.

## Changed-file register

Existing files modified (18, unstaged):

- `PROJECT_CONTEXT.md`
- `docs/AUTH_RBAC.md`
- `docs/EXPORTS.md`
- `docs/EXPORT_TEMPLATES_V1_PLAN.md`
- `client/src/api/exports-api.js`
- `client/src/components/app/ExportTools.jsx`
- `client/src/components/app/WorkspaceNav.jsx`
- `client/src/hooks/product/useProductExportController.js`
- `client/src/hooks/useSkuManager.js`
- `client/src/lib/role-management.js`
- `client/src/pages/AppPage.jsx`
- `client/src/router.jsx`
- `server/integration-test/12-export-template-snapshots.cases.js`
- `server/integration-test/critical-flows.test.js`
- `server/src/routes/admin/export-templates.routes.js`
- `server/src/routes/endpoint-manifest.js`
- `server/src/routes/public/exports.routes.js`
- `server/src/services/export-templates/template.service.js`

New files (13, untracked and explicitly reviewed):

- `docs/EXPORT_TEMPLATES_PR4.md`
- `client/src/api/export-templates-api.js`
- `client/src/components/app/ControlledExportOptions.jsx`
- `client/src/components/export-templates/DefinitionEditor.jsx`
- `client/src/hooks/product/export-workflow-context.jsx`
- `client/src/hooks/product/useExportWorkflow.js`
- `client/src/lib/export-template-editor.js`
- `client/src/pages/ExportTemplatesPage.jsx`
- `client/src/pages/ExportsPage.jsx`
- `client/test/controlled-template-export.test.jsx`
- `client/test/export-template-editor.test.js`
- `client/test/export-template-ui.test.jsx`
- `server/integration-test/12-export-template-editor.cases.js`

Final branch/HEAD remain the initial values. No staging, commits, pushes, reset,
clean, stash, merge, cherry-pick, rebase or branch switches were performed.
Only the disposable service is stopped after verification; no useful database or
production service/volume is touched. No image/deployment/Compose file changed,
so Docker image build and Compose-change checks were not applicable.

## Operator-acceptance closeout addendum — 2026-09-23

This addendum qualifies the implementation report above; it does **not** mark
operator acceptance, production activation or rollout complete. Closeout started
on `feature/magento-export-constructor`, HEAD
`7003432d92a3dc8a182a751ccae413e2bcd034ca`, with the **18 modified tracked and
13 untracked files** listed above already present. The earlier clean-start statement
belongs to implementation, not this closeout. All existing work was preserved.

### What the forms actually construct

“New binding IDs and slot declarations are not created” describes two separate
properties. A no-op open/save preserves existing IDs, structure and canonical
hash; it does not regenerate bindings. Independently, there is no form action to
declare a new interpolation slot or a new named binding. Stable IDs are not
evidence that arbitrary new compositions can be constructed.

Evidence below uses the actual [DefinitionEditor](../client/src/components/export-templates/DefinitionEditor.jsx),
[structural model](../client/src/lib/export-template-editor.js) and
[rendered tests](../client/test/export-template-ui.test.jsx).
Tests use the server baseline factory with synthetic catalog fixtures; network
adapters are mocked. Pure server compilation/evaluation in a test is explicitly
not evaluation in the production browser and not a new persisted integration run.

| Concrete operator task | Current controls/actions | Status | Evidence and exact boundary |
| --- | --- | --- | --- |
| A. Change existing `meta_title` | `Група` → `Колонка` → `SEO заголовок (meta_title)` → `Значення`; then explicit save | Supported | `literal, shared table and local name interpolation edits…` preserves `  Новий SEO\n` exactly. Typed literal controls preserve string/number/null distinctions; no automatic trimming. |
| B. Change a semantic display value while retaining semantic ID, SKU code and unrelated consumers | Open the relevant shared rule/table, edit `ID 1`. For one consumer: first `Створити локальну копію правила …`, then `Створити окрему копію таблиці`, edit its `ID 1`, return to the local rule and select the copy in `Таблиця відповідностей` | Supported with explicit scope | `separate lookup copy affects only the explicitly detached consumer…` edits `materialUa.copy1`. The original table, key set, sources, question contracts and bindings remain unchanged. Added pure server evaluation of the form result proves only BR/base/name changes; every other BR cell, BR EN and all NM/KL/CH/AR/SV output are identical for the same product facts. These are template output dictionaries, not catalog `value_id`/`sku_code` mutations. Editing the original shared table intentionally changes all its consumers; it is not cell-local. |
| C. Modify an existing name using current slots | Open shared `KL.nameUa`, or detach its cell reference; edit `Текст із підстановками` and existing slot expressions | Supported | Name interpolation rendered test and new `KL composition boundary…` test. Text/order around `{material}` and `{sku}` can change. Existing source/lookup nodes can select another already-declared source/table. All declared placeholders must remain; unknown placeholders fail form validity. |
| D. Add mapped KL color to a name while keeping material and SKU | Attempt `Кулон з {material} бурштину, {color}. Арт: {sku}` in the local name | **Unsupported** | New rendered `KL composition boundary…` proves baseline `KL.color` and `klColor` exist, but name slots remain exactly `material, sku`; `{color}` produces an associated error and invalid form. The existing material lookup can be rewired to KL.color/klColor, but that **replaces material**; it does not add color. No add-slot/declaration control exists. Synthetic probe only; nothing published and no golden changed. |
| E. Change an existing fallback/condition | `Спільне правило` → e.g. `BR.nameValid` → `Допустимі значення 1`; `BR.category.material` → `Запасне значення` → `Значення`. Visibility also has `Джерело нової умови`, `Додати умову видимості`, all/any branches | Limited to the existing structure and exposed operations | `conditions, category fallback and ordered columns…`, `category interpolation and visibility conditions…`, numeric-band test. Values, supported list additions/removal/order, bands and captured visibility branches are editable. There is no general operation selector to turn a literal into a lookup/when/interpolate tree. Fixed evaluator policies remain fixed. |
| F. Change one cell without changing shared consumers | `Створити локальну копію правила …`; edit detached expression; copy and explicitly select a lookup table if needed | Supported with explicit scope | Local-copy and separate-lookup tests; only the selected reference is detached. Nested references and original tables remain shared until individually detached/copied. The panel warns about this and shared editors list affected consumers. SKU binding cannot be detached/edited. |
| G. Reorder allowed columns while retaining identity and sparse EN | `Колонка` → `Перемістити колонку вище/нижче`; inspect `Рядок` base/EN | Supported | Strengthened column test checks identical column membership and row definitions, with absent EN price still absent. Pure model move test checks boundaries; identity rendered test protects SKU. No column/route creation or deletion is offered. Moving columns does not synthesize EN values. |

The baseline is editable within those existing shapes. Some new combinations are
possible by selecting a different declared source/table in an existing lookup,
detaching a reference, copying a table or adding exposed list/visibility branches.
This is **not a general composition builder**. Even a new composition using only
already-supported evaluator vocabulary can be unavailable, as task D shows.
Unknown future operations/formats are separately identified and preserved read-only;
that preservation does not imply editing support.

Task D is an acceptance limitation if operators require new-source composition.
The smallest proposed follow-up is an explicit local interpolation slot add/remove
control using existing approved sources/lookups and server validation, with scope
and round-trip tests. No new evaluator operation is needed or proposed here.
It was deliberately not implemented in this closeout.

### Recovery: retained evidence and actual available paths

Code: [controller](../client/src/hooks/product/useProductExportController.js),
[provider](../client/src/hooks/product/export-workflow-context.jsx),
[router](../client/src/router.jsx), [AuthProvider](../client/src/auth/AuthProvider.jsx),
[AuthGate](../client/src/auth/AuthGate.jsx), [API adapter](../client/src/api/exports-api.js),
[export routes](../server/src/routes/public/exports.routes.js),
[snapshot service](../server/src/services/export.service.js),
[binding contract](../server/src/services/export-templates/snapshot-binding.js).

| Evidence | Internal route navigation, same mounted provider | Reload/close or successful logout followed by login | Server after a committed create |
| --- | --- | --- | --- |
| Pending operation, idempotency key, original requested intent, opaque preview token and effective preview evidence | Retained in React state/refs; retry sends the original descriptor | Lost. No storage or rehydration exists | `export_snapshots` stores key, normalized intent, effective binding/fingerprint and creator; client token is not a recovery index |
| Known successful snapshot ID/manifest | Retained; download/confirm use that ID despite selector changes | Lost from controller; recoverable only if the ID was independently retained or positively identified | Snapshot and group CSV artifacts remain durable |
| Audit/exposure/cursor evidence | Server-owned | Not erased by logout/reload | Creation, artifacts, exposure and `export_snapshot.created` commit together. Confirmation is separate; unchanged cursor does not mean create failed |

**Normal UI while still mounted:** leave the uncertain operation intact, return
to `/exports` after internal navigation and use `Повторити початкове створення`.
It retains the same key, payload, selection and token, including after elapsed
token TTL or changed selectors. There is no automatic retry, replacement-key
creation or fallback. Definitive stale/expired unused-preview codes require an
explicit new preview; ambiguous transport/5xx failures do not. A failed normal
confirmation retries the same known snapshot, not creation.

**Known ID after reload:** `/exports` has no history, “open by ID” control or
rehydration action; `exportsApi.getSnapshot` exists but is not consumed there.
Existing authorized API access is possible: `GET /api/export/snapshots/:id`
returns the stored manifest; `GET /api/export/snapshots/:id/magento/:group/csv`
downloads its stored artifact. Both require an active authenticated user with
`exports.view`. Explicit `POST /api/export/snapshots/:id/confirm` requires
`exports.create` and the current session's CSRF token. This is an API-assisted
administrative path, **not a shipped operator recovery UI** or a procedure executed
in this closeout. Confirmation is a business mutation and must follow the usual
operational decision, never merely discovery of an ID. These calls need no current
template selection, preview token, compilation or re-evaluation.

**Unknown result after reload/logout:** there is no safe self-service recovery
through the export UI and no authenticated key-lookup endpoint. If the original
key **and exact normalized requested intent** were independently retained, the
existing create endpoint's completed-request contract can recover a matching
committed result, including without a supplied preview token. Without a completed
match, absence of that token prevents a new capture (`EXPORT_PREVIEW_REQUIRED`).
This contract is not browser recovery: the UI loses its key/intent and offers no
way to resume them. Do not reconstruct “new” intent from displayed resolved SKU
anchors. Do not infer absence from one failed request while an original request
could still be in flight.

An authorized administrator with `audit.view` can use the existing `/admin/audit`
filters: `Ключ події = export_snapshot.created`, `ID виконавця`, time interval and
`Тип об’єкта = export_snapshot`; `Застосувати` displays subject snapshot IDs and
details. The event records from/to SKU, row count and template/version IDs, but
**not the idempotency key**. Matching actor/time/range is therefore candidate
identification, not unique reconciliation of a lost operation. The corresponding
authenticated read API is `GET /api/admin/audit-events`. `/api/export/status`
reports cursor/last confirmed export state, not a history of generated snapshots.
No key-search UI or guaranteed unknown-result reconciliation procedure is claimed.

If neither the ID nor original key/intent can be established safely, stop the
export attempt and escalate reconciliation; do **not** start with a new key, infer
“nothing created” from empty client state/expired preview/unchanged cursor, or
confirm an ambiguously matched snapshot. A commit may already have established
exposure. This is an unresolved operator-release risk. The smallest follow-up
requirement is an authenticated, documented and tested way to identify the exact
original operation after session loss and resume its stored result without a new
capture. Known-ID opening alone would not solve completely unknown outcomes.
No persistence, new API or recovery subsystem was added here.

**Session isolation qualification:** successful logout calls `markUnauthenticated`,
clears identity/permissions/CSRF and unmounts the AuthGate business tree. New tests
prove a same-user or other-user subsequent mocked `/auth/me` gets no old pending
state or late snapshot response. However, the provider is not keyed by principal.
A separate characterization test changes `/auth/me` from active user 1 to active
user 2 through `auth.refresh()` with identical export capabilities, without an
intermediate unauthenticated gate: the old pending descriptor and retry button
remain visible. This is a **confirmed client isolation defect**, not a logout
failure. Real cross-tab/OIDC reproduction was not run; `refresh` is an actual
AuthProvider method also used by role/user administration. No cross-user server
retry was attempted. Smallest proposed fix: reset/remount the workflow on change
of authenticated application-user identity and invalidate old responses, while
preserving same-user internal navigation. Unknown-result reconciliation remains
necessary for the abandoned operation. Production code was not changed to hide it.

Recovery test evidence is in [controlled-template-export.test.jsx](../client/test/controlled-template-export.test.jsx):
existing mounted-route navigation, ambiguous failure/same-key/double-click/expiry
and stored-download/confirmation tests; two new full unmount/remount cases
(uncertain versus known result); two successful logout/late-response cases
(same versus different next user); one active-to-active principal-change case.
These are rendered component lifecycles with mocked API responses, **not real
browser reload, server commit simulation or end-to-end login**. Server durability
and completed retry evidence is reused from the existing PR3 integration cases
`retry identity survives confirmation, expiry, product and activation changes…`
and `completed retries, stored reads and confirmation do not need an available evaluator`;
those PostgreSQL cases were inspected, not rerun for this tests/docs-only closeout.

### Manual acceptance gate and deferred checklist

**Manual browser acceptance not run.** One current CUA inventory check returned
`apps: [], browsers: []`. No verified isolated authenticated UI environment was
available. No application was started; no mock UI is presented as real API/OIDC
acceptance. Desktop/narrow rendering and actual keyboard/focus remain unverified.

The **only executable preparation step supplied now**, from the repository root,
is the repository-supported disposable database service command:

```powershell
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d postgres-test
```

It was **not executed in this closeout**. Stop there: this creates only the
disposable prerequisite, not an authenticated UI fixture. Before any application
startup, a separately verified isolated application configuration must explicitly
target `amber_test` on `127.0.0.1:55432` using the AGENTS throwaway credentials,
with real OIDC and authorized test users plus synthetic catalog/products. Startup
can migrate/initialize data. Do not run the ordinary developer application against
its useful database, improvise an auth bypass, or run the destructive integration
harness while a manual UI session uses that test DB. If the canonical service
fails, report it and do not substitute a database.

The following is a **deferred acceptance specification**, not an instruction to
continue running steps in the current environment. Every item remains NOT RUN.
It supplies the requested code-grounded visible criteria for a later verified
isolated environment; all product IDs/data must belong to that environment.

| Deferred check, in order | Expected visible result/current controls | Business writes if executed |
| --- | --- | --- |
| `/admin/export-templates` with `export_templates.view`; test a separate denied user | `Шаблони експорту Magento`; empty registry or family list. Denied user sees no-permission page and makes no definition/source request | No business data |
| With view+manage, `Створити шаблон на основі Magento v1` | `Новий кандидат — ще не збережено`, frozen required/visibility explanation; source/catalog diagnostics if incomplete. No acceptance claim | No business data |
| `Група`, `Рядок`, `Колонка`, `Розділ редактора`: inspect BR/name and meta_title, KL/name and kolir, SV source key `2` and `svStoneProcessing` key `0`; inspect empty EN price | Existing shared references and consumer lists; identity cells protected; no inherited serialization for absent EN. KL new `{color}` is rejected as above, not a supported composition | No business data; local edits only |
| Fill `Назва шаблону` and `Сталий ключ…` with a synthetic test name/key, then `Створити й зберегти чернетку` | Saved draft revision/hash replaces unsaved candidate; no publication or selection is created | Template draft/family metadata and its normal audit |
| `Перевірити збережену ревізію`; enter 1–100 known synthetic IDs in `ID товарів…`, then `Переглянути тестовий результат` | Exact saved revision, readiness/errors and sample CSV in `Тест чернетки — лише читання`. Duplicate IDs rejected locally; missing IDs reported by server, not silently dropped | No business data: validation/test-preview are read-only |
| Compare shared edit with detached rule + copied table; explicit `Зберегти чернетку`, validate/test again | A shared edit lists all consumers. The local-copy procedure changes only the intended output, with nested sharing disclosed; editing invalidates previous evidence | Local edits: none; explicit save: draft metadata |
| Optional separate publication test only when intentionally included in isolated acceptance: `Опублікувати ревізію N`, then browse `Версія`; optionally `Копіювати публікацію в чернетку` | Published view read-only and version/hash visible; clone creates/updates draft. `Вибрати відкриту публікацію vN` is a separate activate-capability action, not rollout | Publication/clone/selection metadata respectively; no snapshot/exposure/cursor |
| `/exports` on a fresh mounted application even when candidate metadata is selected | Controlled-export checkbox off; legacy explanatory text; familiar readiness/range/manual-name disclosure | No business data; status reads |
| Explicit `Контрольований експорт за опублікованим шаблоном (явний opt-in)` and published preview using synthetic products | Selected candidate or permitted explicit version; actual effective version shown; unavailable selection gives an error without legacy fallback. Real-export warning visible, distinct from blue draft-test panel | No business data for metadata/published preview |
| Separate deliberate snapshot test, only with isolated data and exports.create: `Створити файли…`, stored artifact download, then separately `Завершити експорт` | Creation returns stored snapshot/manifest; download uses that ID and does not confirm. Confirmation is a separate explicit action. Never use this to resolve an unknown previous result | Create: snapshot/artifacts/exposure/audit. Download: none. Confirm: confirmation/revisions and possibly normal cursor/audit |

For every deferred screen inspect desktop (~1280px) and narrow (~375px), long
mapping text/IDs and CSV overflow, readable consumer scope, associated labels,
Tab/Shift+Tab order, visible focus, native select keyboard use, Enter/Space buttons
and disabled states. Check numeric/interpolation validation placement and focus;
keep invalid draft output from save/publish. None of these visual checks is implied
by passing jsdom tests.

Unsaved-work check: family/version switches are disabled while dirty and explicit
`Відкинути локальні зміни` discards edits; page installs a `beforeunload` warning.
There is **no SPA navigation blocker or lifted editor state** in the current
TemplateWorkspace/router. Leaving the editor through workspace navigation can
lose unsaved work; a beforeunload listener does not protect that transition.
This is code-inspected, not a browser-observed prompt guarantee. Save/discard
deliberately before navigation; record the behavior during deferred acceptance.
Do not confuse it with the separate export provider's retained pending operation.

### Closeout-only delta and verification

Only these three pre-existing untracked PR4 files were changed by this closeout:

- `client/test/export-template-ui.test.jsx`: one KL composition-boundary test;
  stronger existing copied-lookup test checks exact server-evaluated output for
  all six groups; stronger existing column test checks row/membership/EN preservation.
- `client/test/controlled-template-export.test.jsx`: five lifecycle/session cases
  (two remount, two logout, one active-principal change).
- `docs/EXPORT_TEMPLATES_PR4.md`: this appended addendum; earlier evidence retained.

Fresh verification uses the same process-local guarded Node **20.20.2** launcher
(including child processes), without runtime/configuration changes:

| Check in this closeout | Result |
| --- | --- |
| Focused two rendered suites | 36 passed (six added cases); mocks plus pure server model evaluation |
| Full client tests | 117 Node + 138 Vitest tests / 15 files passed |
| Client lint and production build | Passed |
| Browser visual/OIDC/real reload | Not run; no browser or verified isolated UI |
| Server unit/lint/PostgreSQL | Not rerun: no server implementation or server test delta; existing integration evidence inspected and labelled above |
| Scoped preservation/whitespace | Closeout changes confined to the three files above; `git diff --check` passed; index unchanged |

Final status remains 18 modified tracked files and 13 untracked files, with the
same branch/HEAD and no staged files. No new file was introduced by closeout.
No staging, commit, push, reset/clean/stash, merge/cherry-pick/rebase or branch switch;
no useful-DB connection, test DB start, application bootstrap, production activity,
dump/restore, activation, Magento Check Data/import or recount change occurred.
Migrations 000–036, PR1 oracles/goldens, semantic-difference register, evaluator,
CSV serialization, default legacy flow and dedicated price exports are untouched.

The preceding SV same-persisted-input evidence and Node-runtime findings are reused,
not reopened or claimed as newly run. Recount release prerequisite and remaining
catalog/business/Magento gates above remain outstanding. The new-slot limitation,
unknown-result recovery gap, active-principal isolation defect and deferred browser
acceptance must be resolved or explicitly dispositioned before operational rollout;
passing characterization tests is not acceptance of the unsafe behavior.
