# Durable controlled export sessions

Implemented for the explicitly selected `template-v1` product workflow. Ordinary
Magento v1 remains the default; dedicated `sku,price` semantics are unchanged.
This guide describes application behavior, not operational/Magento acceptance.

## Operator workflow

From **Експорт**, use **Мої експорти** (`/exports/sessions`), **Спільні зі мною**
(`/exports/shared`) or **Запрошення** (`/exports/invitations`).
**Створити свій експорт** opens `/exports/new/template`.

1. **Створити свій експорт**: enter a title, new-products or explicit SKU range,
   and active/pinned published-template selection. **Створити приватний експорт**
   saves metadata only. Only the owner initially has access.
2. **Перевірити товари** reads current readiness.
   **Зберегти перевірку** durably records the exact preview binding and
   operation identity. Neither action reserves/exposes products or confirms anything.
3. **Створити файли** explicitly invokes the existing snapshot engine.
   Successful configuration, exact CSV bytes, publication and result association
   become immutable. A different range/template needs a deliberately new session.
4. Download each stored artifact. **Завершити експорт** separately confirms the
   existing snapshot; it can advance the singleton product cursor and captured
   revision high waters. It does not assert a Magento import.
5. Owner **Поділитися** → search an existing local user by name/login (at least
   two characters), select the exact user → **Надіслати запрошення в застосунку**.
   This creates an in-application invitation, without email or external messaging.
6. Recipient opens **Запрошення**, sees their current capabilities, and explicitly
   chooses **Приєднатися** or **Відхилити**.
   They can instead choose **Створити свій експорт** for an independent operation.
   Accepted invitations appear under **Спільні зі мною**. Joining preserves the
   same session, attempt and snapshot; it creates no copy and grants no global rights.
7. Owner can revoke pending/accepted membership; accepted participants can leave.
   Sharing remains available after generation. No owner transfer or Administrator
   takeover exists. Previously downloaded files cannot be revoked retroactively.

Owned/shared/invitation lists use authenticated keyset pagination, default 20,
maximum 50. Search returns at most 20 safe identity records (`id`, display name,
username); no issuer, OIDC subject, email, roles/history or administrative directory.
There are at most 100 current pending/accepted participants. Detail prioritizes
those participants and bounds historical membership display to 100 records.

Opening a deep link is explicit through the current account. It never silently
replaces a dirty form or auto-generates/confirms. Snapshot IDs, session IDs,
invitation epochs and operation keys are locators, not authority.

## Authority matrix

All routes retain authentication, current active-user resolution and CSRF on writes.
No named role implies membership or special ownership powers.

| Action | Current effective capability | Relationship |
| --- | --- | --- |
| Create private session | `exports.view` + `exports.create` | Current actor becomes immutable owner/creator |
| List/read/detail/preview/status | `exports.view` | Owner or accepted member |
| Pending invitation list | `exports.view` | Exact target; only ID/title/owner/epoch/state |
| Accept/decline | `exports.view` | Exact invited target and current epoch |
| Leave | `exports.view` | Accepted target and current epoch |
| Save/prepare/generate | `exports.view` + `exports.create` | Owner/accepted member; revision and access epoch |
| Search recipients/invite/revoke | `exports.view` + `exports.create` | Owner; target epoch for revoke |
| Manifest/internal CSV/group CSV | `exports.view` | Owner/accepted member for session-linked snapshots |
| Confirm session-linked result | `exports.view` + `exports.create` | Owner/accepted member and current access epoch |
| Completed direct key lookup | Existing create authority + `exports.view` | Owner/accepted member for session-linked result |
| Choose a non-active publication | Above + `export_templates.activate` | Does not borrow preparer's/owner's rights |
| Template draft/publication work | Existing template capabilities | Separate lifecycle; unsaved drafts are not shared |

Historical non-session snapshots retain their established access contract and null
session attribution. All existing direct snapshot routes, artifacts, confirmation
and completed key paths check session membership when linked. Unknown/inaccessible
session and snapshot reads return the same `404 EXPORT_NOT_FOUND` boundary (the
legacy snapshot routes retain their JSON error envelope). Global export status
keeps global counts/cursor semantics but omits private last-result identifiers,
SKU range and row count for unrelated users.

## HTTP commands

Routes are below `/api/export/sessions`:

| Method/path | Command |
| --- | --- |
| `GET /?scope=owned|shared|invitations&order=recent&after=...&limit=20` | Recent-first authorized workspace list; omitted order retains the old UUID cursor mode |
| `POST /` | `{creationKey,title,settings}`; retry same original normalized intent returns same session |
| `GET /:id` | Current saved configuration, bounded members, safe attempt summary/result/status |
| `PUT /:id` | `{expectedRevision,expectedAccessEpoch,title,settings}`; CAS, invalidates/supersedes old attempt only under lock |
| `POST /:id/preview` | Read-only authoritative preview; original proof removed from response |
| `POST /:id/prepare` | `{expectedRevision,expectedAccessEpoch,supersedeAttemptId?}`; absent supersede ID reuses current attempt |
| `POST /:id/generate` | `{expectedRevision,expectedAccessEpoch,attemptId}`; explicit create/retry of exact stored attempt |
| `GET /:id/recipients?q=...` | Owner-only bounded recipient picker |
| `POST /:id/invitations` | `{expectedAccessEpoch,userId}` |
| `POST /:id/membership` | `{action,expectedAccessEpoch}` for accept/decline/leave; revoke also supplies `userId,expectedMemberEpoch` |

Settings reuse PR3 normalization: `requestContract:"template-v1"`, profile
`magento-products-v1`, new/manual mode, normalized original anchors, and
`selection:{mode:"active"}` or an explicit family/version pair. Original intent
is distinct from resolved range and effective capture identity. Decimal-string
configuration revisions and membership epochs avoid bigint precision loss.
Owners use access epoch `"owner"`; membership epoch advances on every state change,
including re-invitation/rejoin. An old action never revives through membership ABA.

Session-linked direct `POST /api/export/snapshots/:id/confirm` additionally accepts
`{expectedAccessEpoch}`. The existing manifest read returns that epoch and session
ID to authorized members. Completed direct retries still recover existing results;
a prepared server-owned key is not a second raw capture entrance. Existing PR3
direct callers remain compatible; the shipped controlled UI starts durable sessions.

## Durability, atomicity and recovery

Migration `037_shared_export_sessions.sql` adds permanent sessions, versioned
membership and immutable attempt identity/evidence. Existing migrations 000–036
remain unchanged. No historical ownership/attempt backfill is performed.

Session state is derived from saved configuration/current attempt/result:
editable → prepared → generated (configuration frozen). Attempts follow
`prepared → executing → succeeded` or `failed`. A failed/prepared/interrupted
attempt can be explicitly retried with its original key/proof; an explicit refresh
or saved configuration change can supersede it only while holding the exclusive
session lock. Superseded/succeeded identity and result evidence cannot be mutated.

The initial session transaction stores owner, creation identity, title and normalized
settings. Preparing commits only attempt metadata: immutable session/revision,
request intent, signed effective version/evaluator/selection/input binding, opaque
proof, internal idempotency key, preparer and bounded safe preview summary. Raw proof
and key are never returned in lists, links, audit or session UI. No product payload,
token or credential is written to localStorage/sessionStorage.

Generation first commits an `executing` metadata marker with immutable first
initiator/time, then calls PR3's existing capture coordinator on the same connection.
Snapshot, exact artifacts, exposure/revisions, snapshot audit, attempt success,
session result and generated audit commit in **one** capture transaction. The result
hook does not commit independently. A deferred database constraint requires the
reverse session/attempt association at commit; a unique session FK allows at most
one successful snapshot. Insert guards compare current attempt, configuration,
request intent, original key and exact binding evidence. Link failure rolls back
every capture effect. No fake/empty snapshot is used as an operation reservation.

Lock order is:

1. Shared session-level access-admin advisory lock **before BEGIN**; current actor
   view/create check, held through the operation.
2. Exclusive session advisory lock **before BEGIN/RR**; fresh current session,
   membership epoch, revision and attempt checks. Creation instead uses an
   owner+creation-key transaction lock before INSERT/retry lookup.
3. For capture: existing per-key transaction lock/second lookup → selection →
   ascending products → ascending revisions/exposure → new-mode cursor → immutable
   snapshot/artifacts/audit/result links. Existing RR/fresh-winner rollback handling
   remains authoritative; an advisory wait never refreshes an old RR snapshot.
4. For confirmation: same access/session prefix → snapshot → ascending revisions →
   singleton cursor. Edit/join/revoke/leave/reconcile use the same session prefix and
   do not acquire product/cursor locks.

Access writers retain their exclusive access boundary and never wait for sessions
or product locks. Membership revocation committed first prevents the waiting command;
capture committed first remains durable and later revocation prevents future access.
Already accepted HTTP work can commit after the browser closes. Cancellation is not
server rollback. Independent sessions may overlap products; no separate cursor or
reservation is introduced.

Status uses `pg_try_advisory_lock`: a held session lock reports executing without
guessing failure. If it can acquire the lock and the durable marker is executing
without a committed result, it reports **interrupted**. This proves that no previous
connection still holds authority to commit that capture; it does not rely on a TTL.
Process death releases the connection lock and PostgreSQL rolls back an unfinished
transaction. Explicit retry retains the same attempt. Late superseded requests fail
the current revision/attempt check. Merely reading status performs no generation,
confirmation or product effects.

After reload/logout/new login/another client, use the authorized list and open the
saved session: committed result opens exactly its stored snapshot; executing means
wait/refresh; prepared/interrupted/failed means choose an explicit next action.
Metadata creation/preparation retries do not force a replacement operation. A lost
response is discoverable through the lists even without a browser key. Completed
results require no valid current preview TTL/compiler or recapture.

The **Відкрити відомий історичний знімок** panel reads an exact known ID and offers
the established explicit confirmation. It does not heuristically match old unknown
operations by actor/time/range. Pre-feature unknown operations without durable
session/attempt evidence still have no guaranteed recovery.

Audit events `export_session.created`, `.updated`, `.prepared`, `.started`,
`.generated`, `.invited`, `.accepted`, `.declined`, `.left`, `.revoked` use the current
local actor and the corresponding metadata/capture transaction. `started` records
committed execution metadata, not snapshot success; only the capture transaction
can emit `generated`. Failures/no-op/idempotent completed reuse emit no success event.
Owner, inviter, preparer, first initiator, actual snapshot creator and confirmer may
all differ; retries never rewrite original attribution.

## Client lifetime and unsaved work

AuthProvider invalidates an opaque in-memory principal lifetime synchronously before
switching identity/CSRF. Workflow providers key on stable `application_users.id` and
effective export access; each explicit session opening has its own lifetime. Old
dispatch references and async continuations are fenced, including A → B → A.
Same-user profile/CSRF refresh keeps the lifetime. Axios captures request context
synchronously; late A 401/403 cannot replace B's authentication gate.

Session detail polls at most once per ten seconds while visible and idle, plus focus
and explicit refresh. Revocation/denied actions or membership epoch change closes
inaccessible data, invalidates continuations and requires another authorized opening.
Saving uses the revision on which local edits began; refresh never replaces dirty
fields with a newer revision. Conflicts retain exact input.

React Router's installed data-router `useBlocker` covers internal links, history
back/forward and workspace navigation. Local family/version/session changes use the
same Save / Discard / Stay prompt; failed/invalid/conflicting save blocks departure.
`beforeunload` remains a separate best-effort real-page-unload warning. Component
tests of memory-router behavior do not establish browser prompt/keyboard acceptance.

Local interpolation add/rename/remove uses existing literal/text/source/lookup
expressions. Renaming explicitly updates references; removal stays disabled while
the text references the slot. Safe names/duplicates and 16-slot bounds are checked
in forms; existing server compilation enforces types/placeholders/depth/size. Shared
bindings/tables keep their consumer warnings. Local copies preserve unrelated cells,
sparse EN and no-op canonical hashes. Published versions remain immutable.

Verification counts, failing-before isolation evidence, exact files and remaining
browser/catalog/Magento gates are recorded in [the PR4 report](EXPORT_TEMPLATES_PR4.md).

## UX-4 list and recovery read behavior

Recent lists order by immutable creation time descending, then session ID
descending, with a scope-bound microsecond cursor. Later edits, invitations and
confirmation cannot reorder already paginated rows. Each page rechecks current
authority; newly created rows are discovered by refreshing the first page. Default
limit20/max50 and the previous UUID pagination mode remain compatible.

Owned and accepted-shared list rows add `participantCount` (owner plus accepted),
`pendingInvitationCount`, `template`, `attempt`, `snapshot` and
`lastRecordedActivityAt`. The last field is the greatest recorded session,
membership, attempt, session-audit or confirmation timestamp; it is not a live
activity estimate and reading does not update it. Snapshot metadata uses the
same UX-3 presenter as `/api/export/history` and stored-result reads. Pending
invitations still expose only their original minimal fields. There is no second
history endpoint/status model and no persisted display-status enum.

The workspace header shows title, owner, private/shared state, publication, count
and human status. Sharing uses the existing owner authority in a focused dialog;
pending and accepted participants stay distinct. Revoke explicitly warns that
downloaded files cannot be recalled; leave removes future access without deleting
the export. No roles, ownership transfer or global permission grants were added.

Opening a session is read-only. A stored result opens its exact bytes. A prepared
session without loaded reviewed rows first requires **Перевірити товари**. The
detail's observational `attempt.preparationIssue` is null, `expired` or
`unavailable`, based on the existing signer for a prepared attempt only. It never
changes stored state, returns a proof or replaces the command's authorization and
final validation. Expired/stale unused preparation needs explicit review and an
explicit replacement. Completed snapshots/retries do not depend on preview TTL.

Only a current executing marker plus held-lock evidence is presented as active
file generation; a held unrelated lock is neutral, and an executing marker whose
lock can be acquired is interrupted under the existing rule. Lists do not test
locks and conservatively display attention for raw executing markers.
**Повторити створення цього експорту** retains the originally submitted operation
descriptor despite later preview/detail responses. Explicit accepted configuration
save or explicit replacement remains the existing supersede boundary. Read/poll
does not create, replace, confirm, audit or advance a cursor.

Dirty conflicts display newer saved fields separately. Denial/changed access epoch
clears private table/detail/list caches and fences old responses. Reads preserve
the visible/idle ten-second cadence and overlap guards. Principal lifetime and
dirty navigation remain above the existing routes. Only allowed display values
(file/search/readiness/language/page/widths and product-change notice) survive
review remounts in principal-scoped memory; no private browser storage or retry
token storage is introduced. See [UX-4 execution evidence](EXPORT_UX_REDESIGN_PLAN.md#25-ux-4-execution-record-and-ux-3-carry-over--2026-09-25)
for the full disposable-PostgreSQL checks and pending operator visual acceptance.
