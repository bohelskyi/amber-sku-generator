# Export UX/UI Redesign Plan

**Status: Approved plan — UX-1 checkpoint 1 implemented; manual visual/parity acceptance pending. Checkpoint 2 has not started.**

Document: `docs/EXPORT_UX_REDESIGN_PLAN.md`.

**Historical planning closeout:** the approved plan was saved with the four approved amendments below. Sections 1–15 record that planning inspection and its then-uncommitted functional baseline. The current UX-1 checkpoint 1 implementation record is in section 16; the approved later-phase architecture remains unchanged.

## 1. Repository baseline and evidence

Inspection date: **2026-09-25**.

| Item | Observed state |
|---|---|
| Repository | `D:\Work\amber-sku-generator` |
| Branch | `feature/magento-export-constructor` |
| HEAD | `4364cd0428b68209d495d1d9835aed31ade4c356` |
| Working tree | 23 modified tracked files; 7 untracked files |
| Staging/branch operations | None |
| Database/runtime operations | None |
| Screenshots | No attached screenshots were available in this conversation |
| Visual evidence | Current JSX/CSS and rendered-test implementations; no new browser or pixel-level verification |

The current working tree, including uncommitted column-form and source-support changes, is the authoritative functional state inspected for this plan; it is not yet the stable committed baseline required before UX-1. Earlier reports are historical evidence. In particular, statements that shared recovery, editable columns, or historical source support are unimplemented are superseded by current code.

Read completely: `AGENTS.md` and `PROJECT_CONTEXT.md`. Inspected the requested export, template, session, authentication and operations documents, relevant correction documentation, current routes/services/migrations, client controllers, forms, CSS and rendered regression tests.

### Prerequisite before UX-1 — stable committed functional baseline

The accepted Export Templates v1 / editable-column / source-support work must be committed as a stable functional baseline before the UX PR series begins. UX implementation must not be layered indefinitely over a large mixed uncommitted functional working tree.

This planning closeout does not stage, commit or push that baseline. Before starting UX-1, record the accepted baseline commit and begin the UX series from that coherent functional state, with unrelated user work preserved separately. The already committed engine and migrations remain part of the baseline; the current uncommitted delta is the remaining column-form and source-support work, not the entire template engine.

The following current functional files belong together in the baseline review and commit:

| Functional delta | Current files |
|---|---|
| Template API and page integration | `client/src/api/export-templates-api.js`; `client/src/pages/ExportTemplatesPage.jsx` |
| Column form, design grid and editing adapters | `client/src/components/export-templates/AdvancedDefinitionEditor.jsx`; `client/src/components/export-templates/DefinitionEditor.jsx`; `client/src/components/export-templates/OutputGrid.jsx`; `client/src/components/export-templates/ColumnForm.jsx` (new); `client/src/components/export-templates/export-template-editor.css`; `client/src/lib/export-template-columns.js` |
| Client functional regressions | `client/test/export-grid.test.jsx`; `client/test/export-template-columns.test.js`; `client/test/export-template-ui.test.jsx`; `client/test/export-column-form.test.jsx` (new) |
| Source-support routes and endpoint contract | `server/src/routes/admin/export-templates.routes.js`; `server/src/routes/endpoint-manifest.js` |
| Source-support evaluation, capture and draft workflow | `server/src/services/export-templates/definition.js`; `server/src/services/export-templates/evaluate.js`; `server/src/services/export-templates/published-capture.js`; `server/src/services/export-templates/source-references.js`; `server/src/services/export-templates/template.service.js`; `server/src/services/export-templates/source-support.js` (new); `server/src/services/export-templates/support-inputs.js` (new) |
| Shared SKU parser used by historical support | `server/src/services/sku-schema.service.js`; `server/src/utils/sku.js` |
| Server functional regressions and fixtures | `server/integration-test/critical-flows.test.js`; `server/integration-test/12-export-source-support.cases.js` (new); `server/test/export-source-support.test.js` (new); `server/test/fixtures/export-source-support.js` (new) |
| Functional documentation | `docs/EXPORTS.md`; `docs/EXPORT_TEMPLATES_PR4.md` |

The separate existing `client/test/auth.test.jsx` delta corrects asynchronous RBAC-test sequencing. It changes no runtime authorization behavior and is not export functionality; preserve and account for it separately rather than automatically bundling it into the export baseline. No migrations, dependencies or configuration files are dirty in the inspected tree. This UX plan is a documentation deliverable, not implementation of the functional delta or UX-1.

### Current surfaces and boundaries

| Surface | Current implementation | Responsibility |
|---|---|---|
| `/exports` | `ExportsPage` → `ExportTools` | Ordinary product export; entry to saved template exports; price export |
| `/` | `AppPage` → another `ExportTools` instance | Duplicated export workspace alongside product workflows and archive controls |
| `/admin/export-templates` | `ExportTemplatesPage` | Registry, system profile, creation, draft editing, checks, versions and candidate selection through local screen state |
| Template table | `DefinitionEditor`, `OutputGrid`, `ColumnForm` | Column structure, base/EN rules, column creation and inspection |
| Rule editing | `QuestionField`, `TaskValue`, `Mapping`, `AdvancedDefinitionEditor` | Source contracts, mappings, interpolation, conditions and technical definition |
| Draft sample | `SampleProducts`, `DraftPreview`, `PreviewTable` | SKU search, up to 100 selected products, saved-draft test results |
| `/exports/sessions/:sessionId?` | `ExportSessionsPage` | Lists, invitations, creation, settings, preparation, generation, recovery, participants and stored results on one page |
| Preview/snapshot tables | `ArtifactTables`, `PreviewTable`, `OutputGrid` | Quote-aware rendering of server CSV; client pagination at 50 rows |
| Product export state | `ExportWorkflowProvider`, `useProductExportController` | Principal-scoped state above routes, retained request identity and explicit confirmation |
| Session state | Local controllers inside `ExportSessionsPage` | Saved revision, dirty edits, access epochs, polling and durable recovery |
| Server authority | Export, template, session and price services | Evaluation, source proof, CAS, tokens, locks, capture, access, immutable files and confirmation |

Primary code references:

- [Template workspace](/D:/Work/amber-sku-generator/client/src/pages/ExportTemplatesPage.jsx), [table editor](/D:/Work/amber-sku-generator/client/src/components/export-templates/DefinitionEditor.jsx), [column form](/D:/Work/amber-sku-generator/client/src/components/export-templates/ColumnForm.jsx).
- [Export tools](/D:/Work/amber-sku-generator/client/src/components/app/ExportTools.jsx), [session workspace](/D:/Work/amber-sku-generator/client/src/pages/ExportSessionsPage.jsx), [export controller](/D:/Work/amber-sku-generator/client/src/hooks/product/useProductExportController.js).
- [Export service](/D:/Work/amber-sku-generator/server/src/services/export.service.js), [session service](/D:/Work/amber-sku-generator/server/src/services/export-sessions.service.js), [template evaluator](/D:/Work/amber-sku-generator/server/src/services/export-templates/evaluate.js).

### Permission matrix to preserve

All entries additionally require current authentication and active-user access; unsafe methods retain CSRF enforcement.

| Action | Current authority |
|---|---|
| Open exports, ordinary preview, export status | `exports.view` |
| Product snapshot creation/confirmation | `exports.create`; session-linked operations additionally enforce view/membership |
| Stored product files | `exports.view`; owner or accepted member when session-linked |
| Price status/download | `exports.view` |
| Price creation/confirmation | `exports.create` |
| Save Magento manual names | `exports.create` through existing preview/apply commands |
| Open template registry/system profile/definitions | `export_templates.view` |
| Prepare candidate | Template `view` + `manage` |
| Create/save/copy/upgrade draft; validate; source-support preparation/application | Template `manage`; the current page itself requires `view` |
| Draft sample/search | Template `manage` + `exports.view` |
| Publish | Template `publish`, independently of `manage` |
| Change selected candidate | Template `activate`, independently of `publish` |
| Export using selected publication | Ordinary export permissions; template-administration access is unnecessary |
| Choose a non-selected publication | Additional `export_templates.activate` |
| Create private session | `exports.view` + `exports.create` |
| Read session | `exports.view` + owner/accepted membership |
| Edit/prepare/generate session | View + create + owner/accepted membership; current revision/access epoch |
| Invite/search recipients/revoke | Owner + view/create; relevant epochs |
| Accept/decline invitation | Exact target + `exports.view` + current invitation epoch |
| Leave | Accepted member + `exports.view` + current epoch |
| Product/correction navigation | Existing product/decode/recount/correction capabilities; export permission grants none of them |

Administrator initially receives all capabilities, but UI decisions must use effective permission keys, never role names.

### Confirmed product decisions

1. Include narrowly scoped read-only API additions for history and diagnostic table presentation.
2. Split price export into explicit creation, download and confirmation actions.
3. Preserve all existing server export semantics.
4. Keep Ukrainian operator-facing copy.
5. Retain the current brand shell.
6. Introduce no global state library, migration, dependency or deployment change.

### Global invariant — UX semantic-change boundary

A UX PR may add explicitly planned bounded read-only projections or presentation metadata, but must not change export business semantics incidentally.

If a UX requirement would require changing evaluator behavior, readiness, source-support meaning, cursor/exposure/revision semantics, snapshot identity, confirmation semantics, RBAC or price-export rules outside this approved plan, stop and treat it as a separate engineering decision.

UI simplification is never authority to weaken server invariants. The approved separation of price creation, download and confirmation changes client orchestration only; it preserves the existing server commands and dedicated price-stream rules. Read-only projections remain observational and cannot become another authority for capture.

## 2. Task-based audit

Concept counts below are approximate counts of distinct things an operator currently needs to understand, not measured clicks.

Classification:

- **U:** usability defect.
- **V:** visual/layout defect or code-supported layout risk.
- **C:** missing product capability.
- **D:** unavoidable domain distinction.

For each task, the table records decisions/labels, hierarchy/control exposure, feedback/technical leakage, narrow/keyboard concerns and the proposed disclosure boundary. A dash means no additional defect was established through inspection.

Recurring layout/accessibility findings:

- **Grid:** 50-row pagination exists, but there is no SKU/readiness filter, sticky SKU context, resizing or cell-error model. Every populated cell is a button.
- **Inspector:** recent work already widened it and added focus handling. Remaining risks concern overlay/background interaction, long nested content and switching between editing surfaces.
- **Sessions:** list, settings, generation, result and membership coexist in a `max-w-5xl` stacked layout.
- **Navigation:** narrow global navigation hides text labels and uses horizontally scrolling icons.
- These are code/test findings and design risks, not claims that current screenshots were visually verified.

### Template tasks

| # / Task | Current path / concepts | Decisions and labels | Hierarchy, duplicated/hidden controls, proximity | Feedback and technical leakage | Narrow/keyboard and proposed disclosure |
|---|---|---|---|---|---|
| 1. Inspect system structure | Templates → system profile; **4** | Must distinguish profile, template, version and current implementation | System row is useful; table sits inside another editor surface | “Правила з коду”, contract and layout explanations compete with the table | Grid concerns. **U/V/D:** show read-only system table immediately; implementation details secondary |
| 2. Create editable copy | System → copy → creation → saved draft → column upgrade; **6** | Copy is not yet structurally editable; upgrade terminology includes v2 | Subsequent capability is discovered after creation | Source warnings can distract from naming the copy | Inspector/forms. **U/D:** explain structural enablement in product language; preserve explicit upgrade |
| 3. Create template | Registry → candidate → creation form; **6** | Name is clear; technical source-support checkbox is difficult | Large source diagnostics precede normal editing | Technical key is already generated and disclosed secondarily—retain this improvement | Long form on narrow screens. **U/V:** name first; compatibility choices explained separately |
| 4. Add CSV column | Editable draft → `+ Колонка`; **6** | Name, code, insertion point, source mode, mapping and selected language | Recent unified dialog fixes the former inert add action | Successful addition remains local until save; that distinction is necessary | Existing dialog focus tests are valuable. **U/D:** retain dialog, reorder fields into one coherent flow |
| 5. Bind characteristic | Column → filling form or complex inspector; **6** | Available-source labels expose category/key/type; path varies by rule shape | Similar source pickers exist in several editors | Approved-source selection is useful; unavailable evidence needs a precise explanation | Long select labels. **U/V:** one searchable SourcePicker; IDs in source details |
| 6. Configure mapping | Filling form → table ID → mapping editor; **7** | Requires names such as `color4`; a new mapping may require Advanced | Different mapping presentations expose labels inconsistently | Simple-column mappings show IDs even where labels can be retrieved | Wide mapping inputs and repeated controls. **U/C:** direct “characteristic value → CSV value”; create a local mapping in the same form |
| 7. Configure base/EN | Language selector + two blank layout rows; **5** | Selected language controls rules, while both layout rows remain blank | Language state is detached from the clicked table cell | Sparse EN is explained through prose; actual rule placement is less immediate | Grid/inspector switching. **U/V/D:** click base or EN rule cell directly; keep independent rules |
| 8. Rename/reorder/duplicate/delete | Column inspector → “Код, порядок та інші дії”; **7** | Label versus exported code is meaningful; duplicate requires another code field | Structural actions share one disclosure; some complex fields expose additional movement controls | Local mutations work, but scope and two-language effect are easy to miss | Long keyboard path. **U/V:** header menu; explicit move dialog; separated removal action |
| 9. Understand protection | Header → inspector/details; **4** | “Protected” conflates protected header and protected value rule | Protection is discovered late | Six headers cannot be removed/renamed, but only three cell rules are locked | **U/D:** distinguish “Обов’язкова колонка” from “Захищене правило” at the header |
| 10. Understand evidence/support | Check tab, source disclosures, mapping inspector; **9** | Historical evidence, current membership, placeholders, deferred IDs and output mapping coexist | Source panels and warnings repeat at multiple levels | Accurate but dense; raw IDs/codes dominate | Nested disclosures and long prose. **U/V/D:** contextual support status with expandable evidence |
| 11. Validate draft | Save → Check → full validation; **4** | Save and validation are correctly separate | Check action competes with support update and sample testing | Success is revision-oriented; blockers may appear in nested red panels | **U/V/D:** one validation summary associated with saved revision; separate sample result |
| 12. Select SKUs and inspect sample | Check → SKU picker → result; **5** | SKU picker is an improvement; ID language persists elsewhere | Selection/results are below other checks; draft results render multiple group sections | Sample validity and whole-template publication readiness are correctly distinct | Long selected lists and result pages. **U/V/D:** sample tray + shared tabbed review table |
| 13. Understand publication blockers | Full validation, sample warnings, publish response; **6** | “Sample passed” can be confused with “publishable” | Same source failure may appear in multiple panels | Errors sometimes open only the first affected field | **U/V/D:** issue index with all affected columns and explicit publication scope |
| 14. Publish version | Versions tab → publish; **5** | Immutable publication and draft are distinct | Main lifecycle action is separated from validation context | Server validates during publication; client must not require `manage` from a publish-only user | **U/D:** publish review dialog showing exact saved version and blockers |
| 15. Publication versus selection | Versions → selection panel; **6** | “Candidate”, publication, explicit export and normal default require interpretation | Selection/cancellation beside version browsing | Existing text correctly says ordinary export is unchanged | **U/D:** explicit candidate badge and separate “use in export” route; technical activation state secondary |

### Export tasks

| # / Task | Current path / concepts | Decisions and labels | Hierarchy, duplicated/hidden controls, proximity | Feedback and technical leakage | Narrow/keyboard and proposed disclosure |
|---|---|---|---|---|---|
| 16. Create private export | Exports → compound sessions link → create; **6** | “Controlled”, private operation and preparation are introduced together | Creation is embedded below a session list | Metadata-only creation is accurately described but verbose | Sessions layout. **U/V/D:** New export entry with template choice and private workspace creation |
| 17. Select publication | Session settings → ControlledExportOptions; **6** | Active/explicit mode appears before the actual publication | Nested bordered warning and selection panels | UUID fallback and “exposure” explain internals | **U/V/D:** show selected publication by name/version; alternative choice only with authority |
| 18. Define range | Ordinary re-export disclosure or session settings; **5** | Blank end means one SKU in ordinary UI, but open-ended in session UI | Range selection is presented differently in two workflows | Product-ID ordering is not obvious from SKU fields | **U/D:** explicit “new / one SKU / bounded / through latest” choices; preserve request semantics |
| 19. Preview actual rows | Preview → ArtifactTables; **6** | Preview identity and readiness must be inferred from several sections | Table exists, but problem products are outside it | Failed products are omitted from CSV; no cell diagnostics or search | Grid concerns. **U/V/C:** authoritative review projection plus problem navigation |
| 20. Generate files | Session preview → prepare → generate; **7** | “Спроба”, “доказ”, “експозиція” expose internal coordination | Prepare, replace and generate controls appear together | Existing original-operation recovery is correct but hard to interpret | **U/V/D:** state-specific primary action; retain distinct save-check/create steps |
| 21. Download files | Snapshot → table → file cards; **4** | File/category relationship is clear but repeated | Group tabs and separate cards duplicate navigation | No authoritative “download completed on disk” evidence exists | **U/V:** download selected stored file from table toolbar; browser handoff state only |
| 22. Confirm export | Snapshot bottom → finish; **4** | Current text correctly separates confirmation from Magento import | Confirmation is below potentially large table content | Consequence is explained; state lacks prominent time/actor context | **U/V/D:** dedicated confirmation section and consequence dialog, never download-triggered |

### Collaboration, recovery and cross-cutting tasks

| # / Task | Current path / concepts | Decisions and labels | Hierarchy, duplicated/hidden controls, proximity | Feedback and technical leakage | Narrow/keyboard and proposed disclosure |
|---|---|---|---|---|---|
| 23. Recover after reload/login | Sessions list → explicit open; historical ID fallback; **7** | Prepared, failed, interrupted and stored result need different actions | Recovery controls share the editing screen | Durable template-session recovery exists; ordinary in-memory operations have a narrower boundary | **U/C/D:** outcome-driven resume screen; retain exact operation and honest legacy limitations |
| 24. Share | Session → participants → Share → search/select/invite; **5** | Invitation is correctly different from permission grant | Main collaboration action is hidden in a disclosure | Exact recipient selection is safe; ID-heavy labels add noise | **U/V/D:** Share button opens focused participants/invite drawer |
| 25. Join export | Scope selector → invitations → join; **5** | Invitation and export readiness are separate concepts | Joining competes with independent creation text | Current capabilities are explained; pending invitation must remain minimal | **U/D:** explicit join dialog, then authorized open of the same session |
| 26. Revoke/leave | Participants list → revoke/leave; **4** | Scope of revocation is important | Revoke is a nearby text action on participant rows | Downloaded files cannot be recalled; this remains necessary feedback | **U/D:** labelled participant menu and scoped confirmation; no ownership transfer |
| 27. Find old/in-progress exports | Session list; known snapshot ID disclosure; **6** | Lists omit useful state/range data; historical IDs must be known | List and open workspace remain stacked | Session list orders by UUID, not recency; no general product/price snapshot index | **U/V/C:** dedicated lists and authorized history API |
| 28. Normal versus price export | `/exports`, stacked sections; **5** | Different streams share the word “export” | Price action sits beneath product export | Current price handler automatically confirms after download | **U/D:** separate Price updates workspace and explicit confirmation, as agreed |
| 29. System versus template export | `/exports` versus sessions; Templates → candidate; **7** | “Legacy”, system, candidate and publication overlap | Navigation forces a conceptual jump between pages | Actual ordinary dispatch remains legacy regardless of candidate | **U/D:** shared workspace shell, explicit recipe identity, separate execution adapters |
| 30. Read-only versus mutating actions | All surfaces; **8** | HTTP method does not express business effect; preview POSTs are read-only | Multiple similarly styled controls obscure consequences | Technical explanations substitute for clear action names | **U/V/D:** action verbs, outcome text and state-specific hierarchy; details contain protocol mechanics |

Safety distinctions are not usability defects. The defects concern their placement, naming, feedback and presentation.

## 3. Target information architecture

### Global navigation

Keep two distinct global entries:

- **Експорт**
- **Шаблони експорту**

The target is to replace the full export workbench on the product page with a compact “Перейти до експорту” entry and contextual links. Stage this within UX-1: first introduce the export route/workspace while retaining the current product-page `ExportTools`; only at a later UX-1 checkpoint, after route/workspace parity, provider lifetime, permissions, deep links and manual acceptance pass, replace the duplicated workbench. Keep rollback straightforward and product archive operations in the product workspace.

Do not remount the principal-scoped export provider when moving between these routes.

### Export navigation

| Destination | Purpose |
|---|---|
| Новий експорт | Choose system rules or a published template, then define products |
| Мої експорти | Owned durable sessions; separate section for directly created files |
| Спільні зі мною | Accepted shared sessions |
| Запрошення | Pending invitations only |
| Історія файлів | Accessible stored product and price snapshots, including historical files |
| Оновлення цін | Dedicated `sku,price` workflow |

The extra **Історія файлів** destination is deliberate: historical non-session snapshots have an existing access contract, nullable creators and no private-session ownership. Calling all of them “mine” or manufacturing shared sessions would be misleading.

Use `/exports` as the New export landing page. Add child routes for list/history/price destinations while retaining `/exports/sessions/:sessionId` as the durable session permalink. Existing `/exports/sessions` remains a compatible entry to My exports.

A workspace replaces the list in the main content area. Its header contains a return link; list filters and scroll position survive the round trip.

### Templates navigation

Retain `/admin/export-templates` and add addressable system/family/version views under it.

Registry structure:

- Permanent **Поточний системний профіль** entry.
- **Усі шаблони**, **Чернетки**, **Опубліковані версії** views.
- Search by display name.
- Candidate-selection badge where applicable.

Do **not** make “Мої шаблони” the default. Current template permissions govern a shared registry, not privately owned template workspaces. Creator attribution is not an ownership ACL.

Inside a template workspace:

- **Таблиця** — default.
- **Перевірка** — a compact issue/sample workspace that preserves selected table context.
- **Версії** — publication history and read-only version selection.
- **Технічні подробиці** — secondary, not another normal workflow.

### Primary UI terminology

| Internal/current distinction | Operator wording |
|---|---|
| Code-backed legacy default | **Системний профіль · звичайний експорт** |
| Editable saved definition | **Чернетка** |
| Immutable publication | **Опублікована версія vN** |
| Activation metadata | **Вибрано для експорту за шаблоном** |
| Actual normal dispatch | **Звичайний експорт використовує системний профіль** |
| Read-only draft sample | **Перевірити на вибраних товарах** |
| Durable preparation | **Зберегти перевірку** |
| Snapshot generation | **Створити файли** |
| Stored snapshot | **Збережені файли · незмінний результат** |
| Retry original attempt | **Повторити створення цього експорту** |
| Confirmation | **Завершити експорт** |

Never label candidate selection “active everywhere”, “deployed”, or “default exporter”.

## 4. Table-first Template Builder

### Desktop layout

Use the available workspace width, with a maximum of approximately 1,800 px rather than the current 1,280 px editor container.

1. Compact header: back link, template name, Draft/Published/System status, save state and primary action.
2. One file/category tab strip.
3. Main table with column headers and **Основний** / **EN** rule rows.
4. Optional column inspector.
5. Compact validation/sample tray below the table.

The current category dropdown and category tabs are redundant. Keep **file/category tabs only**, including on narrow screens as a horizontally scrollable strip with visible overflow affordance.

Do not display two empty layout rows plus an unrelated rule row. In design mode, the base and EN cells themselves contain readable rule summaries:

- `Постійний текст: …`
- `Колір → відповідності`
- `Текст із 3 характеристик`
- `Порожня клітинка`
- `Умова`
- `Захищене правило`

These are explicitly labelled **rules, not product values**. Clicking a cell selects its column and language directly.

### Column inspector

At sufficiently wide layouts, use a 440–520 px inspector while leaving at least 720 px for the table. Otherwise use a modal drawer. Base this switch on available content width, not only a fixed viewport breakpoint.

One inspector contains:

- Column display name and CSV code.
- Main/EN selection.
- Source.
- Output format/mapping.
- Conditions/fallback summary.
- Source status.
- Advanced entry.

Only one inspector/dialog is active at a time. Opening a create dialog suspends the inspector without discarding its unresolved input.

### Column actions

Header menu:

- Налаштувати
- Додати ліворуч
- Додати праворуч
- Дублювати
- Перемістити…
- Перейменувати…
- Видалити…

No essential action requires right-click or dragging.

“Перемістити…” supports a numbered position and before/after another column. Dragging is not required in the first implementation.

Duplicate both existing row rules through the existing cloning adapters, including dependency isolation. Ask for the new exported code before applying the local change.

Removal names the column and states that both language rules are removed. Place it in a separated menu group. It must retain existing output-check ownership behavior and never delete global source evidence.

### Protection has two meanings

- **Required headers:** `sku`, `store_view_code`, `name`, `attribute_set_code`, `product_type`, `price` cannot be renamed or removed.
- **Locked cell rules:** existing protected identity rules for `sku`, `store_view_code`, `product_type`.
- Name, attribute-set and price rules retain the editing allowed today, subject to server validation.
- Moving a required column remains possible where currently supported.

Show an accessible protection indicator in the header, with a precise explanation rather than a generic lock over the whole column.

### New column dialog

Use one form in this order:

1. **Назва колонки** and **Код у CSV**.
2. **Звідки брати значення**.
3. **Як записувати у файлі**.
4. **Позиція**.
5. **Основний / EN** behavior.

CSV code is an actual output-header choice and belongs in the form. Internal source/table/binding IDs do not.

Defaults:

- Start with an empty literal column.
- Insert at the requested left/right anchor, otherwise at the end.
- Fill the selected row only; explicitly show that the other row stays blank.
- Offer separate Main and EN configuration; never introduce implicit inheritance.
- Require an explicit raw-versus-mapped output choice for characteristic sources.
- Generate internal local mapping/slot identifiers once; do not ask the operator to name them.
- Do not infer output text from current catalog labels.

Submission creates one complete local definition change. Cancel creates nothing. Server save remains explicit.

### One local editing contract

Unify inspector editing into a local column transaction:

- **Застосувати до чернетки** applies that inspector’s pending changes locally.
- **Скасувати** discards only those pending changes.
- Page-level **Зберегти чернетку** persists the complete draft with CAS.
- Page save cannot silently omit unfinished column input.
- Navigation uses the existing Save/Discard/Stay protection.

Preserve unrelated previously dirty definition content on inspector cancellation.

### Rule presentation

| Rule type | Normal presentation | Advanced details |
|---|---|---|
| Literal | Text/value input; explicit empty state | Scalar type where necessary |
| Semantic mapping | Characteristic value → CSV value table | Source/table IDs, exact semantic IDs and shared consumers |
| Text/interpolation | Text with selectable characteristic tokens | Slot identifiers and uncommon nested structure |
| Fallback | Ordered “use first filled value” list | Exact absence/error policy |
| Condition | “When … use … otherwise …” with readable source/value labels | Nested predicates and captured visibility contracts |
| Numeric bands | Min/max/output table with explicit inclusive boundaries | Existing parsing mode, invalid/outside policy |
| Source evidence | Compact supported/unresolved/deferred status | Current versus historical metadata and exact proof |
| Historical placeholder | Contextual explanation of verified historical absence | Numeric/string distinction, own-schema reconstruction evidence |
| Deferred value | “Значення ще не підтримується цією версією” | Frozen support membership and promotion evidence |
| Custom rule | Readable summary and “Розширені правила” | Existing lossless editor |

Never simplify an unrecognized complex rule into a literal or a simple mapping. Preserve it untouched and route to Advanced.

### Mapping editor

Default columns:

| Значення характеристики | Значення у CSV |
|---|---|
| Світлий | editable output |
| Темний | editable output |
| Комбінований | editable output |

Use approved metadata labels as hints, not source authority or default CSV text.

If a label is unavailable or ambiguous, show an honest identifier-based fallback such as `Значення №29 — назву не підтверджено`. Exact IDs remain available in expanded evidence.

Allow creating a new local mapping without entering Advanced. Reuse the current expression builders and local dependency-copy behavior.

Default scope: **Лише ця колонка**. Shared editing is an explicit Advanced choice listing all affected consumers. Preserve missing, empty string, null, numeric zero, string zero and whitespace exactly.

### Draft lifecycle and source support

Retain separate actions:

- Save.
- Validate full draft.
- Test selected products.
- Publish.
- Select candidate.
- Use a publication in an export.

For fixed historical drafts, rename the structural upgrade to **Дозволити додавання й видалення колонок**. Explain the effect without exposing v2 as the primary concept. Keep the current explicit revision/hash-checked upgrade; do not upgrade on opening.

Source-support changes stay two-step:

1. **Переглянути оновлення сумісності** — read-only proposal.
2. **Застосувати до чернетки** — explicit saved-draft mutation.

Show the proposal in a focused dialog containing changed support categories and consequences. Do not place the entire NM/AR implementation explanation permanently on the validation page.

The support choice remains opt-in; opening a copy or publication never applies it automatically.

Publication must remain possible for a permitted publish-only user. Do not impose a new client-side requirement that they first call the manage-only validation endpoint. The publication command performs authoritative validation itself.

## 5. Export Workspace: review, creation and stored result

### Setup

Present the execution recipe clearly:

- **Системний профіль** — selected by default.
- **Опублікований шаблон** — explicit choice using safe publication metadata.

Choosing a template does not call administrative definition APIs or mutate global candidate selection.

For template exports, creation saves a private workspace first. Sharing is optional and available later.

Use explicit product selection choices:

- **Нові товари**
- **Один SKU**
- **Діапазон SKU**
- **Від SKU до останнього товару**

Encode them through existing contracts:

- One SKU sends both anchors equal.
- Bounded range sends both entered anchors.
- Open-ended range sends a null end.
- New mode retains its existing stream-specific caller intent.

Preserve product-ID ordering and exclusion rules. Show the resolved range after server preview; filters never redefine it.

### Review table

Before generation, a persistent label reads **ПОПЕРЕДНІЙ ПЕРЕГЛЯД**.

Toolbar:

- File/category tabs.
- SKU search.
- All / Needs attention readiness filter.
- Both rows / Main / EN view filter.
- Check time and stale/current state.
- One state-appropriate primary action.

Table behavior:

- Preserve actual CSV column order.
- Add a clearly separate, sticky review rail for SKU, row language and readiness. It is not part of the CSV.
- Keep row ordinals from the full response when filtering.
- Use 50 visible CSV rows per page initially.
- Search/readiness/language filters are view-only and operate across the loaded response.
- No sorting or selection checkbox that silently changes the export range.
- Useful width presets: short codes 100–140 px, ordinary values 160–220 px, names/SEO 280–420 px.
- Allow local column resizing and an accessible “Column width” menu; widths do not modify template definitions.
- Truncate long values visually; open exact text in a detail drawer/popover.
- Display problems in their affected cells when authoritative coordinates exist.
- Row-level problems remain row-level when the server cannot identify a specific cell.
- The table must retain failed products, including categories where every product failed.

Do not reconstruct future values from browser-side product answers or execute template rules in React.

### New diagnostic review projection

Current evaluators omit failed products from provisional CSV. Extend read-only previews with a separate presentation projection.

The projection contains:

- Represented product identity and authoritative order.
- Group/file identity and actual header order.
- Main/EN row identity.
- Evaluated display values where available.
- Cell/column/row/source issue targets.
- `not evaluated` where evaluation did not produce a value.
- Existing preview binding identity.

The normal CSV artifacts remain unchanged. Failed-product rows are diagnostic review rows, not partially exportable files.

Ready-cell display values must match quote-aware parsing of the finalized server CSV, including formula neutralization. Failed-cell values must be marked provisional or unavailable; an empty error result must not look like an intentionally blank valid cell.

Collect diagnostics during the existing evaluation, without extra eager evaluation of lazy branches. Preserve evaluation limits, existing errors, ready counts and token eligibility.

### Correcting products

Issue actions route to existing workflows:

- Missing manual Magento name: existing authorized manual-name preview/apply dialog.
- Informational/product correction: existing product workspace and recount/information workflow.
- Existing correction request: existing request permalink.
- Insufficient permission: readable issue details and copyable SKU; no unauthorized editor.

The product page currently lacks a general SKU deep-link handoff. Add a minimal explicit-open handoff into the existing decode workflow, preserving dirty navigation and product/decode permission checks. It may prefill the SKU; it must not apply a correction.

After a product change, mark the export preview outdated and require explicit rechecking. Recount can change identity/exclusions; never substitute the successor automatically.

### Creation steps

For a durable template session:

1. Save settings.
2. **Перевірити товари** — read-only.
3. **Зберегти перевірку** — retain the reviewed binding for recovery.
4. **Створити файли** — immutable capture.

These actions remain distinct. Show only the next relevant action prominently.

A replacement preparation is secondary and explicitly labelled **Оновити та замінити збережену перевірку**. Never silently replace an uncertain original operation.

Ordinary system export retains preview → create with its existing expectation and original-key retry handling.

### Stored snapshot transition

After successful capture:

- Replace preview identity with **ЗБЕРЕЖЕНІ ФАЙЛИ**.
- Show created time, captured range, system/template identity and version.
- Freeze range/template editing.
- Load exact stored artifacts.
- Remove live preview refresh from this surface.
- Permit a separate **Новий експорт** action.
- Distinguish manifest-load failure from capture failure: “Files created; could not load the stored table” must not offer another creation.

File toolbar provides **Завантажити CSV** for the selected file. Other files remain available through the same tab strip and compact file list.

Download feedback means **“Передано браузеру для завантаження”**. It does not prove a disk save or Magento import. Local download indicators are transient and never become shared authoritative state.

Confirmation:

- Explicit **Завершити експорт** action.
- Dialog names the stored result and describes queue/revision consequences.
- No backend download gate is invented.
- Confirmation does not imply Magento import.
- Success displays server confirmation time/actor when available.
- Repeated confirmation preserves existing idempotency and attribution.

Historical snapshots without Magento artifacts show that limitation. Never regenerate missing historical artifacts with current rules.

### Price updates

Use the same visual shell with a separate controller and stream.

- No template selector, category files or product range.
- CSV remains exactly `sku,price`.
- Optional read-only queue review shows current eligible prices.
- Creation still captures current eligible pending revisions through the existing service.
- Stored two-column table appears after creation.
- Download and confirmation are separate explicit actions.

The price stream currently has no full-product preview-token contract. Its read-only review must say that creation rereads eligible prices. Do not claim the preview freezes them or add a new token requirement to the existing price API.

If values changed between review and creation, show the stored values and a compact change notice before confirmation. Do not regenerate automatically.

## 6. Sessions, sharing, history and recovery

### Lists

Owned/shared lists show:

- Title.
- Owner name and initials avatar.
- Template name/version, or “resolved during checking” where appropriate.
- Requested range; captured range when available.
- Human status.
- Participant count.
- Creation time and last recorded activity.
- Stored-file/confirmation state.

Use stable server pagination. Replace UUID-order presentation with an additive recent-first list mode; do not sort only the currently loaded page.

Do not call `updatedAt` comprehensive activity: current membership and confirmation events do not all update it. A safe read projection may derive last activity from existing session events, attempt timestamps and snapshot confirmation.

Pending invitations retain their current minimal disclosure. Do not expose range, participants, preview rows or snapshot contents before acceptance.

### Display-state mapping

These are presentation states, not new database states.

| Display | Existing evidence |
|---|---|
| Чернетка | New local form or unsaved local settings |
| Потрібна перевірка | Saved configuration without a current review; stale review; prepared session reopened without matching table |
| Перевірено · перевірку не збережено | Current ready read-only preview without a matching durable preparation |
| Готовий до створення файлів | Prepared attempt, matching configuration/fingerprint and available reviewed table |
| Створюються файли | Authoritative executing attempt while generation is active |
| Файли створено | Linked snapshot with `status=generated` |
| Завершено | Snapshot `status=confirmed` |
| Потрібна увага | Readiness failure, configuration conflict, failed/interrupted creation or classified current blocker |

Important qualifications:

- `session.executing` currently reflects inability to obtain the session lock. Alone it does not prove files are being generated; another command may hold it.
- `interrupted` is server-derived through lock reconciliation, not a browser timeout.
- `not-ready` is a preview/preparation result, not a persisted attempt enum.
- `superseded` belongs in history/technical evidence, not as the active export status.
- A prepared token may become stale. “Ready” is not a guarantee that final capture will succeed.

### Sharing

Move **Поділитися** into the workspace header.

The drawer contains current participants and a recipient search:

1. Enter name/login.
2. Select an exact existing local user.
3. Review recipient and session title.
4. Send an in-application invitation.

Show “Запрошено” until accepted. Do not claim email delivery or grant capabilities.

Recipient actions:

- **Приєднатися**
- **Відхилити**
- Separate **Створити власний експорт**

Joining explicitly explains that this is the same export, files and confirmation state. It does not clone the session or create files.

Owner revoke and member leave use focused confirmations naming the target/export. Preserve current epochs, ownership limits and lack of administrator takeover.

### Recovery

Opening a saved export performs an authorized read only.

- Stored result: open its exact snapshot.
- Executing: show progress and refresh; no replacement operation.
- Prepared without table: require a matching read-only check before first generation.
- Failed/interrupted: offer retry of the original creation.
- Stale/expired unused preparation: explain explicit refresh/replacement.
- Conflict: retain local input and show the newer saved state separately.
- Access loss: remove private data and fence late responses.

An original retry must remain bound to its original operation even if a newer preview has been displayed.

### History boundary

Add authorized browsing of existing product and price snapshots. This improves discovery of committed files; it does not manufacture durable sessions for old exports. UX-3 owns the shared authoritative read-only snapshot/history metadata contracts; UX-4 consumes them for My exports, Shared, History and Recovery. Session-list projections may remain separate where membership semantics require them, but snapshot history identity and status terminology must be shared.

Do not:

- Infer ownership for null historical creators.
- Match an unknown operation automatically by time/range/SKU.
- Treat absence from a history page as proof an in-flight request cannot commit.
- Store tokens, request payloads or idempotency keys in browser storage.
- Promise full reload recovery for an ordinary operation that never obtained a durable session/result identity.

Keep exact known-ID opening as a secondary support path.

## 7. Diagnostic hierarchy

| Level | Presentation | Action |
|---|---|---|
| A. Current action blocker | One compact alert beside the blocked action | Retry original operation, refresh explicitly, resolve conflict or reopen access |
| B. Product readiness | Row/cell marker and compact issue count | Filter problems; open exact field/product workflow |
| C. Publication issue | Template issue panel with category/column/source targets | Open affected rule/source |
| D. Future/deferred limitation | Neutral informational badge | Inspect support explanation |
| E. Technical evidence | Collapsed details/support copy | IDs, codes, hashes, revisions and evidence |

Use one issue collection per evidence identity. Render references to it rather than duplicating the same red block in the header, source panel and sample result.

Clicking an issue must reveal the relevant file, page, row language and cell, or the exact source when a cell target is unavailable.

Technical support copy excludes tokens, credentials and internal idempotency keys. It may include the safe request ID, error code and relevant saved object identifiers.

### Source-support copy must remain exact

- **NM historical placeholder:** numeric zero is accepted only through the implemented own-schema proof. It is not a universal zero-to-empty rule.
- **String `"0"`:** not automatically a historical placeholder.
- **Genuine semantic zero:** ordinary supported semantic value; never relabel as missing.
- **AR deferred values:** mappings may exist and publication may succeed, while a product consuming a deferred value remains blocked.
- **New live schema:** does not promote frozen deferred values in an existing publication.
- **Unresolved source:** blocks the applicable validation/publication/export scope.
- **Missing output mapping:** separate from source evidence.
- **Product readiness:** separate from template publication readiness.

A successful sample for one category must not erase publication blockers in other categories.

## 8. Visual system, narrow layouts and accessibility

### Visual direction

Reuse navy, amber, canvas, text and border tokens from the application shell.

- One workspace title and status.
- One dominant table surface.
- Dividers rather than cards within cards.
- One filled primary action per state.
- Secondary actions as outline/text buttons.
- Destructive actions separated spatially.
- Routine draft/unverified states use neutral styling.
- Red indicates a current failure; amber indicates attention, not general implementation explanation.
- Approximately 24 px outer padding on desktop and 12–16 px on narrow layouts.
- Table text 13–14 px; controls/body 14–16 px.
- Row height around 40–44 px; long content opens separately.
- Avoid broad `overflow-wrap:anywhere` on ordinary labels; technical strings get deliberate clipping/scrolling.

### Narrow behavior

- Preserve the file-tab model; no second category selector.
- Settings and sharing use full-width dialogs/drawers.
- Inspector does not squeeze the table.
- Sticky SKU/language context becomes compact.
- Horizontal scrolling stays inside the table; the page itself must not overflow.
- Toolbars wrap into labelled rows; primary actions remain reachable.
- Lists become compact stacked rows containing the same essential metadata.
- Global navigation offers an accessible labelled menu on narrow screens instead of relying on indistinguishable icons.
- Mobile table inspection is supported; complex rule authoring remains usable but desktop-oriented.

### Accessibility from the first PR

- Native table headers/captions and explicit row-language labels.
- One roving focus position for interactive data cells; arrow-key navigation.
- Enter opens cell details; Escape closes and restores focus.
- Header menus work with keyboard, visible trigger and pointer.
- File tabs implement correct tab semantics and keyboard movement.
- Dialogs have labelled titles, modal semantics, focus containment, background isolation and focus restoration.
- Reuse and strengthen `useDialogAccessibility`; avoid separate partial focus-trap implementations.
- Focused cells/headers scroll clear of sticky navigation.
- Issue summaries announce changes once; do not put every repeated diagnostic in `role=alert`.
- Error state uses text/icon as well as color.
- Disabled actions have a nearby reason, not a tooltip-only explanation.
- Column resize has keyboard controls.
- No drag-only, hover-only or right-click-only essential workflow.
- Test keyboard operation at 200% zoom and with a screen reader.

## 9. Component, state and API plan

### Retain, split and replace

| Existing seam | Plan |
|---|---|
| `WorkspaceNav`, `PageHeader`, `UiPrimitives`, design tokens | Retain; add export-local navigation and consistent toolbar/status primitives |
| `ExportWorkflowProvider` | Retain principal-scoped lifetime above routes |
| `ExportTemplatesPage` | Split registry, workspace shell and controller; preserve revision/lifetime guards |
| `DefinitionEditor` | Retain adapters and rule semantics; replace duplicate navigation and layout orchestration |
| `ColumnForm` | Refactor into the unified create/inspect transaction model |
| `OutputGrid` | Split shared table mechanics from template-design and export-review behavior |
| `PreviewTable`, CSV parser | Retain quote-aware parsing; adapt to review/stored table models |
| `QuestionField`, mapping/text adapters | Retain semantic lenses and lossless editing; consolidate presentation |
| `AdvancedDefinitionEditor` | Retain as progressive disclosure; do not delete custom-rule capabilities |
| `SourceDiagnostics`, `ReadinessProblems` | Replace repeated panel rendering with a common issue model and contextual navigation |
| `ExportTools` | Split into setup, review, snapshot and price surfaces; retain product-page composition through the initial UX-1 parity checkpoint, then replace it with navigation |
| `ControlledExportOptions` | Refactor into a concise publication picker; keep exact selection encoding |
| `ExportSessionsPage` | Split lists, invitations, workspace controller and participants |
| `StoredResult`, `SnapshotFiles` | Consolidate into stored-result controller and summary/table presentation |
| `SampleProducts` | Retain authorized search, deduplication, limits and stale-response protection |
| `useDirtyNavigation` | Retain and integrate every new route/dialog transition |

Suggested reusable components:

- `ExportWorkspaceShell`
- `TemplateWorkspaceShell`
- `TemplateDesignGrid`
- `ExportDataGrid`
- `ColumnInspector`
- `ColumnCreateDialog`
- `MappingTableEditor`
- `SourcePicker`
- `ExportIssuePanel`
- `TemplateVersionHeader`
- `ExportSessionList`
- `SessionParticipants`
- `SnapshotSummary`
- `ExportProgress`

`ExportProgress` is informational. It must not make later stages clickable shortcuts that mutate state.

### State ownership

Use existing React hooks/context and focused reducers where useful.

Keep separate:

1. Saved server draft/configuration.
2. Local complete edits.
3. Pending inspector/form input.
4. Validation/sample evidence.
5. Current read-only preview.
6. Retained creation/preparation identity.
7. Stored snapshot.
8. Display-only filters, widths, selected cells and scroll position.

Never merge preview and stored snapshot into one loosely typed object.

Preserve:

- Principal lifetime invalidation, including A → B → A.
- Same-user refresh behavior.
- Permission-change invalidation.
- Per-open session lifetime.
- Dirty revision captured when editing began.
- Access/membership epochs.
- Original-key retry state.
- Late-response fences.
- Authoritative reload after mutations.
- Visible/idle session polling at the existing ten-second cadence.

No optimistic draft save, publication, membership, preparation, generation or confirmation.

### Public API additions

All additions are read-only projections unless they invoke an already-existing explicit command. The global UX semantic-change boundary applies.

**One snapshot/history read-model contract:** UX-3 owns the authoritative product and price stored-result metadata and snapshot-history contracts, including the product metadata expansion, price snapshot metadata endpoint and `GET /api/export/history` below. UX-4 consumes those contracts and must not introduce a second competing snapshot-history model or duplicate API surface. Membership-aware session-list projections and recent-first session pagination may be delivered in UX-4, but they reference the shared snapshot identity/status terminology rather than redefining it.

| Addition | Minimum contract |
|---|---|
| Optional review projection on existing ordinary/published/session/draft preview responses | Group/header order, represented row identity, evaluated values, issue targets and existing evidence identity |
| Product snapshot metadata expansion | Captured range, creation/confirmation attribution and timestamps already stored; no live reevaluation |
| Price snapshot metadata endpoint | `GET /api/price-export/snapshots/:id`; safe manifest fields without full revision internals |
| Price read-only preview | Current eligible `sku,price` rows and observation time; no token or queue mutation |
| Snapshot history | `GET /api/export/history`; product/price stream, mine/accessible scope, generated/confirmed filter, bounded pagination |
| Session list projection | Template/range, raw attempt summary, snapshot confirmation, participant count and recorded activity |
| Recent-first session list mode | Additive cursor mode; preserve existing UUID pagination for old callers |
| Template list/version summaries | Safe lifecycle metadata without loading every complete historical definition when only summaries are needed |

Use `exports.view` for operational read projections. Session-linked rows enforce the same membership predicate as direct snapshot reads. Pending invitation responses remain minimal.

History pagination uses immutable creation time plus ID as a tie-breaker, default 20/max 50. Do not paginate by mutable last-activity time.

Review metadata must not enter persisted definitions, alter canonical hashes, change existing preview fingerprints, or become a second source of generation authority. Existing response fields and omitted-parameter behavior remain compatible.

No new permission keys or database migrations are required.

## 10. Performance strategy

### Current facts

- Preview transfers complete CSV responses.
- Only the selected artifact is parsed for display, but every file’s bytes are transferred.
- Pagination is local at 50 rows.
- Failed products are separately listed.
- Snapshot manifest reads currently return CSV for all artifacts.
- Family detail returns complete definitions for all publications.
- Template evaluation already has explicit work, cell, definition and output limits.

### Initial implementation

- Keep one complete authoritative preview response as the consistency boundary.
- Parse lazily by file and memoize by evidence/file identity.
- Avoid reparsing on selection, toolbar state or cell focus.
- Keep 50 visible rows; do not add row virtualization merely because total rows are large.
- Avoid thousands of tab stops through roving cell focus.
- Render long values only when requested.
- Load source evidence only for the selected source.
- Add metadata-only snapshot retrieval; fetch the selected stored artifact lazily through existing authorized file access.
- Avoid N+1 session-detail reads for list rows.
- Load publication definitions when opened, not merely to render version names.

### Measurement and escalation

Use synthetic fixtures with:

- 100, 1,000 and 5,000 products.
- Multiple files.
- 32 and 64 columns.
- Long quoted SEO/category values.
- Mixed readiness failures.

Record payload size, parsing time, peak memory, first-table render and filter/page response time on a documented machine.

Target local filter/page feedback within approximately 200 ms after data loading. This is an acceptance target, not a measured current result.

Introduce column windowing only if 50 × 64 rendering fails the target. Preserve semantic/keyboard access and a paginated fallback.

Server preview pagination is **deferred**. It must never issue independent “latest rows” reads per page. Any later implementation needs one immutable review identity, authorization on every page and wholesale invalidation when that identity expires or changes. Do not hold a database transaction open for a browsing session.

No automatic truncation or range splitting when server limits are reached.

## 11. Compatibility and non-goals

The global UX semantic-change boundary in section 1 governs every PR, including the explicitly planned read-only additions. A requirement outside that boundary stops for a separate engineering decision.

The redesign must preserve:

- Server-authoritative evaluation and stored final prices.
- Immutable published definitions and stored artifacts.
- Draft revision/hash CAS, no-op behavior and dirty conflict retention.
- Frozen source-support and captured visibility/requiredness.
- Numeric-zero/string-zero/placeholder distinctions.
- Deferred unsupported values and explicit promotion through a new draft/publication.
- Output-column order, sparse EN and protected-column contracts.
- Local dependency isolation and output-check ownership.
- Explicit published-template selection and unchanged ordinary dispatch.
- Full-product preview expectations/tokens, original intent and idempotent recovery.
- Atomic session/result association.
- Current membership/access enforcement.
- Product-ID ranges, exclusions and monotonic cursor.
- Separate dedicated price revisions and confirmation.
- Stored download versus confirmation.
- Legacy API compatibility and candidate rollback to legacy metadata.
- Existing exact CSV escaping and formula neutralization.
- Historical snapshots with unavailable artifacts or attribution.

Do not redesign:

- Magento API integration or automatic attribute creation.
- Bulk product editing.
- Spreadsheet formulas or a new expression language.
- SKU/catalog business rules.
- Repricing.
- Authentication/RBAC.
- Deployment or infrastructure.
- Unrelated pages or services.

Selecting a candidate is not rollout. UI release is not Magento acceptance.

## 12. Textual wireframes

### Templates list

```text
Шаблони експорту                            [Створити шаблон]

Системний профіль
Magento · використовується звичайним експортом    [Переглянути]

[Усі шаблони] [Чернетки] [Опубліковані версії]   Пошук [...]

Назва              Чернетка       Публікація       Вибір
Основний каталог   Збережена      v3               Для шаблонного експорту
Сувеніри           Є зміни       v1               —
```

### System profile

```text
← Шаблони
Magento · Системний профіль · Лише перегляд
Використовується звичайним експортом       [Створити копію]

[Браслети] [Намиста] [Кулони] [Чотки] [Картини] [Сувеніри]

               SKU 🔒       Назва              Ціна
Код CSV        sku          name               price
Основний       З товару     Текст + правила     Збережена ціна
EN             З товару     English name        Порожньо

[Подробиці системного профілю]
```

### Editable builder

```text
← Шаблони     Основний каталог · Чернетка       [Зберегти]
Є незбережені зміни                    [Перевірка] [Версії]

[Браслети] [Намиста] [Кулони] [...]                 [+ Колонка]

┌──────────────────────────────────────┬─────────────────────┐
│ SKU 🔒 | Назва ▾ | Колір ▾ | Ціна ▾  │ Колір · kolir       │
│ Основний:       | Колір → значення    │ [Основний] [EN]     │
│ EN:             | Порожньо           │ Джерело: Колір      │
│                                      │ Як записувати:      │
│                                      │ Відповідності       │
│                                      │ Світлий → [...]     │
│                                      │ Темний  → [...]     │
│                                      │ [Застосувати]       │
│                                      │ [Джерело] [Advanced]│
└──────────────────────────────────────┴─────────────────────┘
Перевірка: 2 питання до публікації  [Показати]
Товари для тесту: 3                [Перевірити на товарах]
```

### New column

```text
Нова колонка · Браслети                              [Закрити]

1. Назва                    [Колір для магазину          ]
   Код у CSV                [custom_color               ]

2. Звідки брати значення     [Характеристика товару       ]
   Характеристика           [Колір                      ]

3. Як записувати            [Відповідності               ]
   Світлий                  [Light                      ]
   Темний                   [Dark                       ]
                            [+ Додати відповідність]

4. Позиція                  [Після Назва                 ]

5. Рядки                    [Основний] [EN]
   EN: порожня клітинка     [Налаштувати EN]

                         [Скасувати] [Додати до чернетки]
```

### Before snapshot

```text
← Мої експорти       Каталог за вересень       [Поділитися]
Олена · Приватний     Шаблон: Основний каталог v3

Товари: BR... — SV...                           [Налаштування]
ПОПЕРЕДНІЙ ПЕРЕГЛЯД · перевірено 14:32
120 товарів · 3 потребують уваги                 [Перевірити]

[Браслети] [Намиста] [...]   SKU [...]   [Показати проблеми]

SKU / мова / стан │ name            │ price │ kolir
BR... Основний ✓  │ Браслет ...     │ 1200  │ Світлий
BR... EN       ✓  │ Amber ...       │       │
SV... Основний !  │ Потрібна назва  │ 800   │

[Попередні] 1–50 / 240 рядків [Наступні]
Проблема: SV... / Назва                      [Заповнити назву]

Коли перевірка готова: [Зберегти перевірку]
Після її збереження:   [Створити файли]
```

### After snapshot

```text
← Мої експорти       Каталог за вересень       [Поділитися]
ЗБЕРЕЖЕНІ ФАЙЛИ · створено 25.09.2026, 14:40
Основний каталог v3 · 120 товарів · Незмінний результат

[Браслети] [Намиста] [...]                    [Завантажити CSV]

SKU / мова │ name                │ price │ kolir
...        │ точні збережені значення CSV                 ...

Файли: Браслети · Намиста · Сувеніри
Підтвердження: очікує завершення
Після завершення зміниться черга експорту. Імпорт Magento
цим не підтверджується.                        [Завершити експорт]

[Новий експорт]                        [Технічні подробиці]
```

### Shared exports and invitations

```text
Експорт
[Мої експорти] [Спільні зі мною] [Запрошення]

Спільні зі мною
Назва          Власник   Шаблон   Діапазон   Стан       Оновлено
Вересень       Олена     v3       ...       Файли є   14:40
                                                     [Відкрити]

Запрошення
Олена запрошує вас до «Каталог за вересень»
Ваш доступ: перегляд і завантаження
                         [Відхилити] [Приєднатися]

До приєднання таблиці, діапазон і учасники не розкриваються.
```

## 13. Before/after workflow comparison

| Job | Current experience | Target |
|---|---|---|
| Add mapped column | Add dialog → technical mapping selection → another editor → save | One column form with readable mapping → apply locally → save |
| Compare Main/EN | Language dropdown changes inspector rules while layout remains blank | Click the relevant Main/EN rule cell |
| Resolve publication issue | Check tab → large diagnostics → source/field panel → return | Issue → exact category/column/source while keeping table context |
| Create template export | Compound link → list → creation → settings → preview/attempt controls | New export → private workspace → check → save check → create |
| Inspect readiness | Preview counts/table → separate problem list | Same table with issue filter and cell/row navigation |
| Recover result | Find session or enter known snapshot ID | My/shared/history list → explicit authorized open → exact server state |
| Share | Scroll to participants → expand → search → select | Header Share → focused drawer |
| Export prices | One button creates, downloads and confirms | Review → create → stored table → download → explicit confirm |

The target reduces navigation and technical interpretation, not the number of safety boundaries.

## 14. Phased implementation PRs and acceptance

Five PRs are appropriate because the current implementation already has tested behavioral seams. Accessibility is included in every phase; UX-5 verifies the complete experience rather than introducing accessibility at the end.

Before any of these PRs begins, satisfy the stable committed functional-baseline prerequisite in section 1. This documentation closeout starts none of them.

### UX-1 — Workspace shells and state boundaries

**Scope**

- Export/Templates local navigation.
- Addressable workspace/list views with compatible old routes.
- Shared toolbar, status, issue-summary and dialog primitives.
- Extract template/session controllers without changing command behavior.
- Retain the current product-page `ExportTools` while introducing the export route/workspace.
- Replace that duplication with navigation only in the later accepted UX-1 checkpoint below.

**UX-1 checkpoints**

1. **Establish parity:** introduce the new route/workspace with the existing product-page workbench still available. Verify route/workspace parity, principal-scoped provider lifetime, effective permissions, old/new deep links, dirty navigation, retained operation identity and manual acceptance.
2. **Replace the duplicated entry:** only after the first checkpoint passes, replace the product-page workbench with the compact “Перейти до експорту” entry and contextual links. Keep the same authoritative controllers and commands. Keep this replacement isolated so reverting it restores the old entry without reverting workspace contracts, changing persisted state or losing the shared provider.

Do not remove the product-page workbench in the first change that introduces the export workspace.

**Affected:** router, WorkspaceNav, ExportsPage, ExportTemplatesPage, ExportSessionsPage, AppPage, export provider.

**Non-goals:** new evaluation, grid diagnostics, mapping behavior or history APIs.

**Risks:** provider remounts, lost dirty state, accidental deep-link auto-opening, late principal responses.

**Tests**

- Rendered route/back/forward and Save/Discard/Stay tests.
- Existing principal isolation and permission UI tests.
- Verify no mount/navigation calls create, prepare, generate, confirm or accept.
- Existing server permission contracts remain unchanged.

**Manual acceptance**

- Open each destination at desktop and 390 px.
- Navigate away with dirty template/session input.
- Return to an uncertain operation without losing its identity.
- Confirm global/local navigation remains keyboard reachable.
- Compare old product-page and new route workflows with view-only, create-capable and template-export permissions; verify direct links, back/forward navigation and provider state survive.
- Complete and record the parity/manual acceptance checkpoint before replacing the old workbench; verify the compact entry and its rollback afterward.

**Dependency:** the accepted functional baseline must first be committed. **Start with this PR only after that prerequisite is satisfied.**

### UX-2 — Registry and unified Template Builder

**Scope**

- Registry lifecycle views and system-profile distinction.
- Single category-tab navigation.
- Main/EN rule cells.
- Unified column inspector/create dialog.
- Header actions, local mapping creation and readable SourcePicker.
- Compact validation/sample tray.
- Source-support proposal dialog.
- Publication and candidate-selection presentation.

**Affected:** template page, DefinitionEditor, ColumnForm, QuestionField, SourceDiagnostics, SampleProducts, existing column/presentation adapters.

**Non-goals:** new rules, automatic upgrades/support changes, template privacy or Magento validation.

**Risks:** loss of complex nodes, shared-consumer edits, readiness ownership, EN inheritance, required-header overprotection.

**Tests**

- Extend `export-column-form`, `export-grid`, template UI/attributes/presentation/columns tests.
- Evaluate form-produced definitions through the server evaluator.
- No-op hash/round-trip tests; exact whitespace/null/zero handling.
- Existing draft CAS, source-support, publication and column integration tests.

**Manual acceptance**

- System → copy → enable structural editing.
- Add `test_export_note` and mapped `test_export_color`.
- Keep neighboring name/price and other groups unchanged.
- Configure EN separately.
- Validate an incomplete template, test a valid sample and inspect remaining publication blockers.
- Publish without selecting globally.

**Dependency:** UX-1.

### UX-3 — Authoritative review, stored files and price actions

**Scope**

- ExportDataGrid and issue navigation.
- Read-only review projections for failed products.
- SKU/readiness/language filtering, widths and pagination.
- Shared authoritative read-only product/price snapshot and history metadata contracts, including the existing product-manifest expansion, price manifest and `GET /api/export/history`.
- Stored snapshot identity/metadata and lazy artifact loading; common snapshot identity/status terminology for UX-4 consumers.
- Product/correction handoff.
- Price review, stored result and separate confirmation.

**Affected:** OutputGrid/PreviewTable/ArtifactTables, ExportTools, export controller, exports API, preview presenters and bounded evaluator observation seams, product/price snapshot metadata and shared history presenter/API, price UI/read endpoints.

**Non-goals:** server preview paging, changing capture/token semantics, inline product editing.

**Risks:** presenting failed partial values as valid CSV, mixing preview identities, changing fingerprints, auto-confirming, price-stream confusion.

**Tests**

- Ready table values equal downloaded CSV bytes.
- Failed-only categories remain visible.
- Unknown issue target stays row/source-level.
- Filter/page/resize sends no changed export request.
- Stored results remain unchanged after product edits.
- Stale preview and ambiguous original-key retry tests.
- No confirmation call on download, including prices.
- Read-only projection tests assert no snapshot/audit/exposure/cursor changes.
- Existing CSV goldens and full capture rollback/race tests.
- Shared snapshot/history contract tests for product and price identities/statuses, nullable historical creators, bounded stable pagination and the same authorization/membership predicates as direct stored-result reads.
- Snapshot/history reads produce no audit, exposure, cursor, revision or workflow mutations.

**Manual acceptance**

- Inspect all six files and long quoted cells.
- Navigate issue → exact cell → existing correction → explicit recheck.
- Generate, navigate away, reopen stored result and download.
- Change a price after review; inspect captured stored price before confirmation.

**Dependency:** UX-1; integrate builder sample presentation after UX-2.

### UX-4 — Lists, sharing, history and recovery

**Scope**

- Dedicated owned/shared/invitation lists.
- My exports / Shared / History / Recovery views consuming UX-3's shared snapshot/history read-model contracts.
- Separate read-only session-list projections only where membership semantics require them; shared snapshot identity/status terminology.
- Recent-first stable session pagination.
- Share/participants drawer.
- Explicit join/revoke/leave.
- Outcome-driven recovery screens.
- Confirmation attribution and recorded activity.

**Affected:** session page/controller/API/service and membership-aware list projections, history UI consuming UX-3 contracts, participants and stored-result components.

**Non-goals:** a second snapshot-history model or duplicate history API; new membership roles, ownership transfer, legacy-session backfill, email invitations or durable download receipts.

**Risks:** private metadata leakage, N+1 requests, false recency/status claims, membership ABA, replacing uncertain operations.

**Tests**

- Pending invitation minimal disclosure.
- Owner/accepted/nonmember access on lists, manifests and CSV routes.
- Nullable legacy creator handling.
- Stable pagination without duplicate/missing items.
- Original-operation retry despite a newer displayed preview.
- Reload/new-login stored result recovery.
- Existing independent-connection membership/capture/confirmation races.
- No audit or workflow writes from list/history reads.

**Manual acceptance**

- Two users: invite, decline, reinvite, accept, collaborate, revoke and rejoin.
- View-only participant downloads but cannot create/confirm.
- Reopen prepared, executing, interrupted and generated sessions.
- Find old direct product and price files without inventing session ownership.

**Dependency:** UX-1 and UX-3, including the accepted shared product/price snapshot and history metadata contracts. UX-4 must consume those contracts rather than creating a competing model.

### UX-5 — Integrated visual, responsive and accessibility acceptance

**Scope**

- End-to-end desktop/narrow polish.
- Keyboard and screen-reader verification.
- Sticky/focus/overflow fixes.
- Performance measurements.
- Remove obsolete duplicated technical UI and dead export-only styles.
- Update documentation and operator wording.

**Non-goals:** unrelated refactoring, infrastructure, dependency upgrades or business rollout.

**Risks:** deleting Advanced capabilities, hiding necessary failure states, CSS affecting unrelated app surfaces.

**Tests**

- Complete client test/lint/build checks.
- Applicable server unit/lint/integration checks.
- Keyboard navigation, dialog focus restoration and long-table fixtures.
- Golden and compatibility regressions remain intact.

**Manual acceptance**

- 1,920, 1,440, 1,024, 768 and 390 px widths.
- 200% zoom.
- Keyboard-only full builder/export/share workflows.
- Screen-reader table, issue and dialog navigation.
- No page-level horizontal overflow or sticky focus obstruction.
- Compare actual rendered results against this plan and supplied negative references when available.

**Dependency:** UX-2 through UX-4.

### Release acceptance criteria

The redesign is accepted only when:

1. Operators can explain the two mental models without knowing evaluator/binding terminology.
2. The system profile is visibly read-only and accurately identified as ordinary dispatch.
3. A new mapped column is completed without internal source/table IDs.
4. Required-header protection is distinct from locked rule protection.
5. Main/EN differences are visible directly in the design table.
6. Existing complex rules survive opening, cancellation and no-op save exactly.
7. Save, validate, sample, publish and selection remain separate.
8. Publish-only and exporter-only permission combinations work.
9. Every represented product is accounted for in review, including failures.
10. Ready preview values match server-finalized CSV.
11. View filters never change range, ordering, eligibility or creation identity.
12. First session generation requires the matching reviewed table.
13. Uncertain retries retain the original operation.
14. Stored results never refresh from live products.
15. Download never confirms either stream.
16. Confirmation shows consequences without claiming Magento import.
17. Shared membership is explicit and grants no global permissions.
18. Revocation closes access and fences stale responses.
19. History preserves nullable attribution and old snapshot compatibility.
20. All primary tasks work with keyboard and at narrow widths.
21. No new migration, permission, global state library or engine language is introduced.
22. Existing server safety, concurrency and CSV regression suites remain intact.
23. The accepted functional baseline is committed before UX-1 begins; no UX series is layered indefinitely over the mixed uncommitted functional tree.
24. Every UX PR stays within the approved semantic-change boundary; out-of-plan semantic changes stop for a separate engineering decision.
25. Product-page `ExportTools` remains available until UX-1 route/workspace parity and manual acceptance pass; its later replacement has a straightforward rollback.
26. UX-3 provides the single shared snapshot/history read model for product and price stored results; UX-4 consumes it without a competing API or status model.

## 15. Inspection verification and preserved work

Repository inspection was read-only. The planning closeout adds only `docs/EXPORT_UX_REDESIGN_PLAN.md`, preserving the exact approved plan except for the four approved amendments and the small delivery/verification wording updates required now that the file can be saved.

The completed document is read back end-to-end. Verification includes `git diff --check -- docs/EXPORT_UX_REDESIGN_PLAN.md` and final `git status --short`. Because an untracked file is not included in ordinary `git diff`, a supplemental no-index whitespace check covers the new file itself. File-content hashes are compared with the pre-write inventory to verify that existing tracked and untracked user files remain unchanged.

Branch/HEAD remain as recorded in section 1. The final status adds only `?? docs/EXPORT_UX_REDESIGN_PLAN.md` to the following pre-existing status:

```text
 M client/src/api/export-templates-api.js
 M client/src/components/export-templates/AdvancedDefinitionEditor.jsx
 M client/src/components/export-templates/DefinitionEditor.jsx
 M client/src/components/export-templates/OutputGrid.jsx
 M client/src/components/export-templates/export-template-editor.css
 M client/src/lib/export-template-columns.js
 M client/src/pages/ExportTemplatesPage.jsx
 M client/test/auth.test.jsx
 M client/test/export-grid.test.jsx
 M client/test/export-template-columns.test.js
 M client/test/export-template-ui.test.jsx
 M docs/EXPORTS.md
 M docs/EXPORT_TEMPLATES_PR4.md
 M server/integration-test/critical-flows.test.js
 M server/src/routes/admin/export-templates.routes.js
 M server/src/routes/endpoint-manifest.js
 M server/src/services/export-templates/definition.js
 M server/src/services/export-templates/evaluate.js
 M server/src/services/export-templates/published-capture.js
 M server/src/services/export-templates/source-references.js
 M server/src/services/export-templates/template.service.js
 M server/src/services/sku-schema.service.js
 M server/src/utils/sku.js
?? client/src/components/export-templates/ColumnForm.jsx
?? client/test/export-column-form.test.jsx
?? server/integration-test/12-export-source-support.cases.js
?? server/src/services/export-templates/source-support.js
?? server/src/services/export-templates/support-inputs.js
?? server/test/export-source-support.test.js
?? server/test/fixtures/export-source-support.js
```

No runtime code, tests, migrations, dependencies, database state or existing user changes were modified by this task. No runtime tests, database tests, application restarts, staging, commits, pushes or branch operations were performed. UX-1 has not started; the only file added by this closeout is this documentation file.

## Підсумок українською

**П’ять головних UX-проблем:**

1. Один робочий процес розпорошений між сторінками, вкладками й повторними панелями.
2. Внутрішні поняття — спроби, джерела, таблиці відповідностей, ревізії — займають місце зрозумілих дій.
3. Налаштування колонок і Main/EN недостатньо пов’язані з самою таблицею.
4. Проблемні товари відокремлені від CSV, тому оператор не бачить помилки в контексті клітинок.
5. Списки, відновлення, спільна робота та історія файлів не утворюють цілісного робочого простору.

**Нова модель:** «Шаблони» відповідають на питання, як виглядає CSV і звідки беруться значення. «Експорт» показує товари, перевірку, створені незмінні файли та завершення роботи.

**Послідовність:** UX-1 навігація й каркаси → UX-2 конструктор → UX-3 таблиця перевірки/результату та ціни → UX-4 спільна робота/історія/відновлення → UX-5 комплексна візуальна й доступнісна перевірка.

**Перед UX-1:** прийняту функціональну базу Export Templates v1 / editable-column / source-support потрібно зафіксувати комітом. У цьому завданні коміт або push не виконуються.

**Перший PR:** UX-1, зі збереженням чинних контролерів, прав, незбережених змін і початкової операції повторного створення. Дубльований `ExportTools` на сторінці товарів прибирається лише після окремого checkpoint паритету маршрутів і ручного приймання.

**Межі UX:** зміни бізнес-семантики поза погодженим планом потребують окремого інженерного рішення. UX-3 володіє спільними контрактами snapshot/history для товарних і цінових результатів; UX-4 їх використовує без другого API чи моделі історії.

**Не можна допустити регресій:** серверна авторитетність, CAS, історична підтримка NM/AR і справжнього нуля, незмінність публікацій/файлів, точність Main/EN, права учасників, відновлення початкової операції, окреме підтвердження, монотонний курсор і незалежні ревізії `sku,price`.

Редизайн не реалізовано. Додано лише `docs/EXPORT_UX_REDESIGN_PLAN.md` з чотирма погодженими поправками. UX-1 не розпочато.

## 16. UX-1 checkpoint 1 implementation — 2026-09-25

**Implementation complete; stop for manual acceptance. UX-1 checkpoint 2 is NOT implemented.**

### Verified starting point

- Checkout: `D:\Work\артикул\amber-app`, branch `feature/magento-export-constructor`.
- HEAD: `b0baf53ef60ec69a4a7d1b8623469ee52b5c3d5d`; initial `git status --short` empty.
- Accepted functional baseline is committed in `f7b7eaefa31debb18b0a4b7121f2bbe8825e2ca0`; the separate RBAC-test correction is `1494133`. The plan itself is committed in HEAD.
- Previous routes: `/` → `AppPage` with `ExportTools`; `/exports` → `ExportsPage` with `ExportTools`; `/exports/sessions/:sessionId?` → `ExportSessionsPage`; `/admin/export-templates` → `ExportTemplatesPage` with local screen/tab state. Other routes are unchanged.
- Provider placement remains `AuthProvider → AuthGate → RouterProvider → Workspace → ExportWorkflowProvider → global navigation / Suspense / route pages`. Neither the provider nor `useProductExportController` moved or changed.

### Actual routes and components

| Address | Checkpoint 1 behavior |
|---|---|
| `/exports` | Primary New export landing; existing system workflow and explicit link to published-template creation |
| `/exports/new/template` | Existing private-session form; only explicit creation persists metadata |
| `/exports/sessions` | Existing owned-session API, now a dedicated list |
| `/exports/shared` | Existing accepted-shared-session API |
| `/exports/invitations` | Existing minimal invitation list and explicit accept/decline |
| `/exports/sessions/:sessionId` | Compatible permalink; list clicks open through the current principal; direct/reloaded links retain explicit current-account opening |
| `/exports/prices` | Existing price controller/action unchanged, including its current create/download/confirm sequence |
| `/admin/export-templates` | Existing shared registry |
| `/admin/export-templates/system` | Read-only system profile |
| `/admin/export-templates/new` | Existing candidate/copy and draft-creation form |
| `/admin/export-templates/:familyId` | Existing table/editor |
| `/admin/export-templates/:familyId/check` | Existing validation, source support and sample workflow |
| `/admin/export-templates/:familyId/versions` | Existing publication and candidate-selection controls |
| `?version=:versionId` on family views | Addressable immutable publication; no tokens/proofs/operation keys in URLs |

`ExportWorkspaceShell`, `TemplateWorkspaceShell`, `WorkspaceLocalNav`, `WorkspaceHeader`, `WorkspaceToolbar` and `WorkspaceDialog` are in `client/src/components/workspace/`. They reuse application tokens, `AppPageHeader`, `StatusBadge`, `Notice` and `useDialogAccessibility`. Local destinations are native links with `aria-current="page"`, visible focus and wrapping narrow layouts. The dirty dialog contains focus, makes its background inert and restores focus on Stay/Escape. Existing grids, column dialogs and Advanced remain unchanged.

One existing template controller and the existing per-open session controllers remain authoritative client adapters. Complete template draft/inspector selection survives same-family table/check/versions navigation without a reload. Unfinished inspector input, another family/publication, leaving the workspace and history transitions that would discard state retain Save / Discard / Stay; failed saves keep the requested navigation blocked. Session forms use the same guard, original revision and existing retry descriptor. List scope is addressable; return links and in-memory list scroll state support the list/session round trip. List ordering/pagination APIs remain unchanged.

### Parity and bounded deviations

- `AppPage` is unchanged and still renders the full product-page `ExportTools`, including archive controls. Both ordinary export surfaces still use the single principal-scoped provider. A presentation-only recovery button now exposes its existing original-operation retry in the durable-session composition; it neither creates a replacement key nor changes the handler.
- No history destination is rendered: truthful cross-stream file browsing requires UX-3. Known-ID snapshot opening remains available as a secondary capability.
- This checkpoint uses current list metadata and ordering; it does not implement UX-4 list projections or recency. Pending invitations render only their existing minimal identity/owner information and explicit response actions.
- Controller extraction is limited to reusable shells and route orchestration. No second controller/state library, server change, migration, dependency, browser storage, history API, evaluator or price-workflow redesign was introduced.
- Effective permissions gate all route mounts and controls. Ordinary exporters issue no template administration reads; publish and activate remain independent of manage. A direct session URL is never membership authority.

### Verification and remaining acceptance

- Before editing: existing auth, controlled-export, Magento, session and template rendered suites passed **106/106** on Node **20.20.2**.
- `client/test/export-workspace-routes.test.jsx` exercises the real route tree: non-mutating mounts/navigation; product/workspace pending-operation round trips; list/session/history identity; template dirty Save/Discard/Stay and inspector protection; principal A → B / A → B → A fencing; same-user refresh; export permission loss; view-only and denied routes; independent publish/activate; minimal invitations; old deep links; keyboard-reachable native navigation and focus restoration.
- Existing rendered regressions retain their business assertions and use the new native links/addresses. Final `npm test`: **137/137 Node tests + 208/208 rendered tests (20 files)**, including **17 workspace-route cases**. The final focused workspace/column-dialog check passed **28/28**. `npm run lint`, `npm run build` and tracked/untracked whitespace checks passed. A temporary preload guard verified the exact Node **20.20.2** executable in npm and child processes; no persistent runtime configuration changed. Server/DB checks were not run because no server files changed.
- **Visual acceptance pending:** no safe authenticated browser session was available through the supplied tooling. No browser stack was installed, authentication bypassed or useful database accessed. Rendered DOM tests are not pixel/browser acceptance.
- Required manual comparison remains desktop about 1440 px and narrow about 390 px; old `/` versus new `/exports`; direct/reloaded URLs and browser back/forward; dirty template/session forms; view-only/create-capable and ordinary non-admin exporters; session reopening; keyboard navigation, modal focus and responsive overflow.

Checkpoint 2 requires a later explicit acceptance task. No staging, commit, push or branch operation is part of this implementation.

Final working-tree scope: **10 modified tracked files, 6 new files; nothing staged**. Modified: `client/src/router.jsx`; the three export/template/session pages; `client/src/components/app/ExportTools.jsx`; `client/src/hooks/useDirtyNavigation.jsx`; `client/src/hooks/useDialogAccessibility.js`; the existing template/session rendered tests; this plan. New: the five workspace shell/primitive/style files and `client/test/export-workspace-routes.test.jsx`. All changes were inspected; branch and HEAD remain at the starting point. `AppPage`, export provider/controller, auth, server, migrations, dependencies and deployment files are unchanged.
