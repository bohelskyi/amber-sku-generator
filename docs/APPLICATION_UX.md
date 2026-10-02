# Amber operations interface

This guide describes the local full-application redesign of 2026-10-02. Its
implementation waves 0–7 are distinct from historical production Wave 1 and
Magento self-service Wave 2. It is not a deployment or real Magento acceptance
receipt. Domain guides, current server code and migrations remain authoritative.

## Navigation and compatibility

The shell groups work by operator intent and filters destinations using effective
capabilities. Personas are acceptance fixtures, not authorization replacements.

| Destination | Routes and context |
| --- | --- |
| Товари | `/products`; create at `/products/create?category=…`; open at `/products/open?article=…`; history at `/products/history`. |
| Потребує уваги | `/attention`; independently authorized corrections at `/admin/corrections` and recorded synchronization problems at `/sync-problems`. |
| Переоцінка | `/admin/repricing`; preparation, review and batch history retain domain controllers. |
| Експорт | `/exports`; `/prices`, `/sessions`, `/shared`, `/invitations`, `/history` and exact stored-result links below it. |
| Налаштування | `/settings` links to `/admin/catalog`, `/admin/pricing`, `/admin/magento` and `/admin/export-templates`. |
| Адміністрування | `/administration` links to `/admin/users`, `/admin/roles`, `/admin/audit`. |

`/?article=…` and `/?exportSku=…` redirect to the permitted product context while
retaining meaningful query information. `/admin` and its former catalog/pricing
anchors have compatibility entrances. Existing export continuation, correction
history and Magento deep links remain supported. Navigation does not remount the
principal-scoped export provider or replace an original uncertain operation.

Desktop uses a navy sidebar, compact context bar and account menu. Narrow screens
use a drawer with the same permitted destinations. Page titles describe the task;
local navigation represents its subworkspaces. Attention has no notification
storage, unread state, combined task total, assignment, deadlines or reminders.

## Presentation system

Shared primitives live in
[`client/src/components/ui`](../client/src/components/ui/index.js): headers,
breadcrumbs, navigation, buttons, fields, validation/read/status states,
dialogs/drawers, confirmations, copy actions, tables/filter toolbars/pagination,
receipts, change/selection summaries and lazy technical disclosures.

[`index.css`](../client/src/index.css) defines navy/amber identity, neutral surfaces,
status colors, 6/8/10px radii, restrained shadows, typography, spacing, focus,
controls and row density. Desktop controls are 36px, compact controls 32px, and
narrow/coarse-pointer targets 44px. Opaque navy focus is used on light surfaces,
amber on the dark shell. Ordinary tables retain useful density; matrices, CSV and
template grids may scroll inside their own labelled region.

Panels group a form, result or selected object. Ordinary page content and evidence
tables do not require decorative nested cards. Technical IDs, revisions, hashes
and JSON are disclosed on demand. Primitives never calculate prices, determine
eligibility/permissions, interpret business state or retry commands.

## Language and state

| Term | Exact meaning |
| --- | --- |
| Артикул | Authoritative `publicSku`; never an internal-SKU fallback. Legacy public articles remain valid. |
| Внутрішній SKU | Configuration/history identity and permitted compatibility lookup input. |
| Переоблік | Existing target-validated recount and unchanged direct/request rules. |
| Незбережені зміни | Browser-local changes; no persistent product draft is implied. |
| Чернетка збережена | A domain-specific persisted draft has been saved. |
| Перевірка неактуальна | Reviewed evidence cannot authorize the next apply action. |
| Опубліковано | The corresponding immutable schema, template or binding publication; these remain separate contracts. |
| Очікує синхронізації | Recorded pending delivery, distinct from a committed Amber change. |
| Дані недоступні | Missing/failed evidence, never a fabricated zero or success. |

ProductBuilder follows entry → **Перевірити дані** → server review →
**Зберегти товар** → authoritative receipt and exact article copy. Recount, prices,
corrections, repricing and Magento share presentation while retaining separate
protocols. Receipts distinguish saved/applied/published work from external delivery.
Successful writes followed by failed reads are reported truthfully.

Reviewed confirmation dialogs initially focus cancellation. Archive, access
removal, publication, rollback and irreversible external actions retain explicit
names and scope. Unknown writes retain their domain-specific recovery; there is
no generic retry, draft persistence or workflow engine.

## Reads and lifetimes

- Product browsing keeps `history.view`; exact opening uses `products.decode`;
  configuration keeps `products.view`. The additive register defaults to 50/max
  100 rows, uses immutable-ID keyset pagination and filter-bound cursors.
- Pricing metadata has a `pricing.view` GET instead of requiring catalog or product
  browsing. Old configuration endpoints and write permissions are unchanged.
- Corrections, sync problems and repricing history use bounded domain reads. See
  [corrections](RECOUNT_CORRECTIONS.md), [repricing](REPRICING.md) and
  [Magento](MAGENTO_INTEGRATION.md) for exact contracts.
- Export status is observed on export routes without destroying pending work.
  Own/shared/invitation/history pages replace their visible 20-item page. CSV and
  repricing presentation paging does not change authoritative apply/capture scope.
- Hidden advanced template editors and technical details mount on demand.
  Category/request epochs fence late pricing/schema responses. Dirty guards and
  conflicts preserve local input without silent rebasing.

No role grant, new permission, migration or server write semantic is introduced.
Authentication, CSRF, active-user boundaries, immutable publications/files,
reservations, CAS/revisions and transaction ordering remain authoritative.

## Verification and human acceptance

Use Node 20/PostgreSQL 16 and the checks in [AGENTS](../AGENTS.md). Windows
integration verification uses only disposable canonical `postgres-test` and stops
it afterward. Browser harnesses use built assets, deterministic local API fixtures
and remote-request blocking; screenshots are stored outside the repository.
An earlier wave's passing run is not final acceptance of later edits.

After building the client, run both fixture harnesses from the repository root
with an installed Chromium/Edge executable as their sole argument:
`node scripts/test-client-browser.mjs <browser-executable>` and
`node scripts/test-magento-workspace-browser.mjs <browser-executable>`.
They serve built assets and fake API responses on loopback, block external browser
requests, and print their acceptance report and temporary screenshot directory.
The browser profile used for 200% acceptance has an actual browser zoom preference;
it is not a device emulation or screenshot scaling substitute.

Browser acceptance covers desktop, 390px, 360px, keyboard/focus restoration,
reduced motion, overflow, bounded row rendering and actual browser 200% zoom.
A narrow viewport alone is not a zoom test. Fixture success does not establish
human comprehension, screen-reader comfort, live OIDC, real multi-account
collaboration or Magento acceptance; those need separate evidence.
