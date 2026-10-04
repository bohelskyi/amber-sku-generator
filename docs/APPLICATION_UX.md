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
| Потребує уваги | `/attention` opens the synchronization problem queue directly; `/sync-problems` remains a compatible entrance to the same workspace. |
| Переоцінка | `/admin/repricing`; preparation, review and batch history retain domain controllers. |
| Налаштування | `/settings` links to Каталог (`/admin/catalog`), Ціноутворення (`/admin/pricing`) and Інтеграція Magento (`/admin/magento`). Integration rules belong inside Magento. |
| Адміністрування | `/administration` links to `/admin/users`, `/admin/roles`, `/admin/audit`. |

The product-owner correction of 2026-10-03 removes all export destinations from
daily navigation. Current daily work is **Товари → Потребує уваги → Переоцінка**;
current product and price changes use the supported Magento integration.
Administration shows **Користувачі → Ролі та дозволи → Аудит**.

Permitted users find **Історичний експорт** in the account menu, leading to the
existing `/exports` overview. File history comes first; product/price snapshots,
own/shared sessions, invitations, exact results and original-operation recovery
remain at their existing `/exports/history`, `/exports/prices`, `/exports/sessions`,
`/exports/shared`, `/exports/invitations` and deeper routes. Price Export is also
legacy, labelled **Експорт цін (сумісність)**. No top-level archive is introduced.
Export-only users retain a `/` fallback to this compatibility overview without a
daily export destination. Permissions, reads/writes, files and recovery are unchanged.

Templates remain current integration configuration, presented as **Правила товару**
inside `/admin/magento/rules` instead of another Settings destination.
This is a verified dependency, not an inference from the editor's existence:
[`binding.service.js`](../server/src/services/magento/binding.service.js) pins and
validates an immutable `export_template_versions` version for each binding revision;
[`sync-preview-db.js`](../server/src/services/magento/sync-preview-db.js) loads that
pinned definition and checks its hash for direct synchronization planning;
[`integration-successor.js`](../server/src/services/magento/integration-successor.js)
requires an explicit published template version for reviewed successor preparation.
Existing `/admin/export-templates/*` URLs redirect with their path, query and hash
to `/admin/magento/rules/*`. Publication contracts and legacy export selection remain
compatible; CSV activation is secondary compatibility functionality. Template
publication does not itself publish a Magento binding.

**Історичні запити** is a capability-filtered account-menu entry to
`/admin/corrections`. New request creation is absent from product/recount/price
and repricing interfaces. Existing requests, claims, completion, ownership,
active-request blockers and historical API contracts remain intact. A user with
only `corrections.create` is not granted direct modification by this UX change.

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

Magento field warnings include a cause and **Що виправити** action. Optional empty
descriptions are shown as **Не заповнюємо** with **Додати текст**, not as broken
bindings. Category operational problems open the filtered product queue. Category
placement repairs use **Категорії магазину** in the same workspace and retain a
return link to the product problem. A guided product check combines explicit local
recovery reading with the original job inspection or recommended lifecycle preview;
confirmation and external writes remain separate. An eligible resync handoff can be
reviewed inline for the exact product, with the original Administrator restriction.

| Term | Exact meaning |
| --- | --- |
| Артикул | Authoritative `publicSku`; never an internal-SKU fallback. Legacy public articles remain valid. |
| Внутрішній SKU | Configuration/history identity and permitted compatibility lookup input. |
| Переоблік | Existing target-validated direct recount; historical request completion retains its separate contract. |
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

The original shell waves introduced no role grant, permission or migration.
The subsequent operational recovery work adds explicit reviewed HTTP entrances
to domain recovery; it does not merge checking with dispatch or replace an
original uncertain operation. See the current Magento domain guide.
Authentication, CSRF, active-user boundaries, immutable publications/files,
reservations, CAS/revisions and transaction ordering remain authoritative.

## Synchronization and integration workspaces (2026-10-04)

Attention now shows a bounded product queue with article search, category and
reason filters. Selecting a product retains `?problem=<productId>`; exact detail
is read separately so an off-page or resolved product remains addressable. The
detail explains **what prevents delivery → its effect → the next permitted action**.
It offers name/size repair in context, direct recount for characteristics, category
configuration links and controlled original-operation recovery. Raw codes, fields
and evidence remain under technical disclosure. Unknown evidence is never success.
Background refresh reads Amber only; a remote check requires an explicit action.

The detail starts with **З чого почати** and the actual permitted action, ahead
of other blockers. Original uncertain-operation recovery takes precedence over
history checks and data/configuration repairs in presentation only. Repeated
history diagnostics share one task; distinct field/path/value repair targets
remain separate under **Інші перешкоди**. All original records remain in the
single lazy technical disclosure. Optional category/attribute comparison is
collapsed and mounted on demand; opening it does not run a remote check.
No grouping releases holds, acknowledges jobs or changes eligibility.

Direct repair uses `/products/open?article=…&action=recount&returnTo=…`.
It waits for the exact stored public article and effective direct-recount
permission before opening the form; it never applies changes on navigation.
The return target is restricted to the local attention workspace. Receipts say
that Amber saved the change, while Magento delivery remains a separate state.

Magento opens a category workspace with categories on the left, all fields of
the applicable Magento set in the centre and a field editor on the right (a dialog
on narrow screens). Characteristics and UA/EN text templates share this screen.
The simple view separates **Характеристики / Назва й описи**, hides codes and
secondary operations, and uses **Перевірити зміни → Застосувати зміни**. The first
action saves/prepares work and requests product impact after required decisions;
restoration alone never starts that check. System fields remain in a disclosure.
Unused output sources, explicit option suggestions and human-readable ownership
are visible. Delivery overview is separate at `/admin/magento/overview`.
The workspace reads the exact pinned binding/template, saves an isolated rules
draft and prepares a successor before explicit review and application. Existing
names use a separate Administrator confirmation, filtered to the category with
the existing 100-product bound. See [the domain guide](MAGENTO_INTEGRATION.md).
Advanced preparation
opens with a task intent instead of demanding that an operator choose technical
layers. Published current state and future drafts remain visibly separate;
publication steps keep their own authority and review.

Catalog handoffs accept `category`, `question` and an explicit form-opening
`action` (`new-category`, `new-question`, `new-option`, `edit-question`). They select
the exact existing context once and never issue catalog writes on entry. A local
Magento `returnTo` preserves the return path; dirty changes keep their guard.
Amber category/questions/options and Magento category/attribute options remain
different domain objects. The bounded [attribute workflow](MAGENTO_ATTRIBUTES.md)
adds reviewed creation of ordinary text/single-select Magento attributes and a
separate existing-set membership action; it is not a generic EAV editor.

### Administrator scenarios

| Task | Entry and visible result |
| --- | --- |
| New Amber category | `/admin/magento/categories/new` uses the existing catalog create contract and returns a resumable category receipt. Separate checkpoints open the exact category's characteristics, SKU publication, pricing and shop connection. A saved category never implies valid prices or delivery readiness. |
| New shop subcategory | Category → **Розміщення в магазині** → prepare change → the pinned category placement rule. Choose an existing observed section or an observed parent plus a new name; explicitly choose all category products or a characteristic/value condition. The authoring form appends to the exact old rule, preserving existing placements, EN rules and shared references. Save/review/publication and remote category creation remain separate actions. |
| New characteristic | Category → **Характеристики** → prepare change. An Amber question is edited in Catalog; an actual new Magento attribute uses explicit type/scope/visibility/requiredness settings, reviewed creation and a separate set assignment. The exact attribute then opens a suggested new field in the rule editor. Creating a rule column does not create an attribute. |
| New characteristic value | The same category selects the exact question and semantic value, including `0`. Existing remote values can be connected; a missing value has reviewed creation. A fresh successor observes newly created resources before connections and publication. |
| Existing product problem | Attention → exact product → explicit Magento check shows Amber's intended values versus observed Magento values and delivery policy. Field/value/path links retain the product, category, source context and safe return URL through diagnosis, rules, preparation and back to the product. Applying a configuration change is not proof of product delivery. |

Category detail has **Розміщення в магазині / Характеристики / Товари** views.
Text characteristics remain visible even without enumerated options. Category
paths and attribute-set names use observed selectors; ambiguous names never
silently choose a target. Missing requested categories/fields produce a clear
handoff instead of opening another category or the SKU column.

Preparation keeps intent, category, selected draft and step in the URL. Technical
revision selection is secondary. A resource creation receipt requires a fresh
successor because existing drafts retain their frozen observation. Unpublished
decisions are not silently copied. Reads and completion receipts are scoped to
the selected draft/category; stale publication evidence blocks continuation.

**Перевірити структуру** explicitly performs bounded Magento GETs and compares
the current approved routes, category paths, attribute metadata, required set
members and approved options. Its result names affected settings and opens their
category. It does not turn unrelated future preparation into a failure, claim to
have checked all products, or report unavailable evidence as healthy. A publication
change during the check invalidates the result. No background remote polling or
implicit resource creation was added.

These scenarios retain effective capabilities and actual Administrator-only
contracts. Attribute creation/assignment is the new bounded write surface for
these five scenarios; forward migration 059 extends the existing permanent
configuration-action ledger. Lost remote writes use original-action recovery,
never blind retry. Stock Magento can verify set membership but does not provide
assignment group/order readback or remote CAS; see the attribute guide's limits.

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
