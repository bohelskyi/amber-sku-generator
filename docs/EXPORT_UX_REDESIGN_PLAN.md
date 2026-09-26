# Export UX/UI Redesign Plan

**Status: UX-1 accepted. UX-2 remains complete for roadmap purposes and was not reopened. The UX-3 PostgreSQL blocker is resolved; its bounded stale-preview continuity fix is included in UX-4. UX-4 lists, sharing, history and recovery are implemented and verified by the full suites, pending manual operator visual acceptance. UX-5 has not started. See section 25 for current evidence; earlier sections retain their historical checkpoint status.**

Document: `docs/EXPORT_UX_REDESIGN_PLAN.md`.

**Historical planning closeout:** the approved plan was saved with the four approved amendments below. Sections 1–15 record that planning inspection and its then-uncommitted functional baseline. Sections 16–17 retain the original UX-1 checkpoint reports, including their then-pending acceptance. The operator's subsequent acceptance and UX-2 implementation are recorded in section 18; the approved later-phase architecture remains unchanged.

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

## 17. UX-1 checkpoint 2 implementation — 2026-09-25

**Checkpoint 1 manual acceptance recorded:** the operator confirmed on OFFICE that `/exports` is the natural export destination; local navigation, deep links, browser Back/Forward, template dirty Save / Discard / Stay and existing template/system views work, with no observed regression in the accepted flows. This explicit acceptance authorizes checkpoint 2 and supersedes section 16's acceptance-pending status.

- Starting checkout: branch `feature/magento-export-constructor`, HEAD `a34bee5e454692149173b6b1895a3d1598dd75aa`, clean `git status --short`. Checkpoint 1 is committed in that HEAD.
- `AppPage` no longer composes the full `ExportTools`. The existing `HomeDashboard` status panel now shows the ordinary pending-product count, pending price-change count and **Перейти до експорту** → `/exports`; the price count links to `/exports/prices`. It uses the existing read-only status, including zero/loading states, without claiming readiness. Native links perform navigation only. No routes were added or changed; old export/session/template deep links remain valid.
- The panel requires effective `exports.view`, including for view-only users. It grants no create/confirm authority and fetches no template definitions. Without export access, the panel is absent and the existing provider suppresses export reads. No session, invitation or template details were copied to the product page.
- The archive form formerly composed inside the product-page `ExportTools` remains on `AppPage`, using the same `products.archive` check, input state, confirmation and handler. Product creation, history, decode, recount and price-change components/controllers remain in place.
- Provider placement remains `AuthProvider → AuthGate → RouterProvider → Workspace → ExportWorkflowProvider → route pages`. Provider, controller, auth, workspace shells, router and `ExportTools` itself are unchanged. `/exports` still uses the complete ordinary export UI; `/exports/prices` retains its existing price workflow. Rollback requires restoring product-page composition/status presentation only, without reverting routes, providers, server behavior or data.
- Rendered regressions retain the checkpoint-1 assertions and adapt the former duplicated-workbench case to the handoff. They exercise original uncertain-operation retry identity through product/export/product/export; same-user refresh while on products; late-response fencing for A → B and A → B → A; permission invalidation; zero-count/view-only/denied handoff; navigation without preview, snapshot/session/template commands or downloads; preserved product/archive/decode/recount controls; existing dirty guards and deep links. Composition/focus checks at simulated 390/1440 px do not constitute browser layout verification.
- Verification: unchanged route/home characterization passed **20/20** before implementation; final focused home/route/auth/export/session/template suites passed **130/130**, including **21 workspace-route cases**. Full `npm test -- --maxWorkers=2` passed **137/137 Node tests + 212/212 rendered tests (20 files)**. Client lint, production build and `git diff --check` passed. A temporary preload guard verified Node **20.20.2** and the exact executable in npm and child processes. No server/DB tests were needed or run.
- Final scope: **5 modified tracked files, no staged or untracked files** — `AppPage.jsx`, `HomeDashboard.jsx`, `export-workspace-routes.test.jsx`, `home-workspace.test.jsx` and this plan. Shared CSS and global/local navigation are unchanged.

**Remaining manual checks:** inspect the compact product panel at about 1440 px and 390 px, including page overflow, text wrapping and keyboard focus/activation; follow both links and browser Back/Forward with a pending operation; verify view-only/no-export users and the retained archive form. No safe authenticated browser was available through the supplied tooling; no browser stack was installed or application bootstrapped. Checkpoint 2 visual acceptance remains pending.

UX-1 implementation is complete. UX-2 / UX-3 / UX-4 are not started. No server files, business semantics, dependencies, migrations or database operations changed. No staging, commit, push or branch operation was performed.

## 18. UX-2 implementation — 2026-09-25

**Acceptance boundary:** the operator explicitly confirmed that all of UX-1 is manually accepted and committed. `/exports` and the compact product handoff are the accepted baseline. This supersedes the pending-acceptance statements in the historical checkpoint reports above. UX-2 is implemented for manual acceptance; UX-3 and UX-4 are not started.

### Recorded starting state and unchanged contracts

- Branch: `feature/magento-export-constructor`; HEAD: `f41c2d0f41714ed0465933418d574773ed25d91d`; `git status --short` was empty before editing. No staging, commits, pushes, destructive Git operations or branch changes.
- Existing routes retained: `/admin/export-templates`, `/system`, `/new`, `/:familyId`, `/:familyId/check`, `/:familyId/versions`, and the `?version=:versionId` selection. Here the shorter paths are relative to `/admin/export-templates`. UX-1 export/session/price routes and product handoff are unchanged.
- Accepted identifiers retained: `formatVersion: 1`, `magento-declarative-1`, `magento-declarative-2`, `magento-products-v1`, `magento-products-columns-v2`, `historical-source-support-v1`, `numeric-zero-v1`. No definition regeneration, upgrade, source refresh or hash change occurs on open.
- No evaluator, source proof, column validation, publication/CAS, activation, session, snapshot/token/idempotency, export cursor/revision/exposure, price export, CSV serialization or formula neutralization semantics changed. Original oracle/golden files, dependencies and migrations are untouched.

### Implemented component structure

| Component / module | Responsibility |
|---|---|
| `ExportTemplatesPage` + existing `TemplateWorkspaceShell` | Existing route/controller, draft CAS, distinct Save/Validate/Test/Publish/Select actions, compact tray, compatibility proposal and publish review dialogs |
| `TemplateRegistry` | Permanent read-only system entry; shared family lifecycle summaries; All/Drafts/Published views; display-name search; separate candidate badge |
| `DefinitionEditor` | One category tab strip, selected column/row, transaction transitions, create/edit separation and measured-width layout |
| `TemplateDesignGrid` | Exact CSV order, Main/EN summaries, required-header versus locked-rule indicators, keyboard cells and header menu |
| `ColumnInspector` | Detached complete local transaction, Apply/Cancel, original-definition fence; 480 px aside only with at least 720 px table space, otherwise shared modal |
| `ColumnForm` | Separate new-column transaction, readable name/code/source/output/position/row sequence; explicit optional independent second row |
| `SourcePicker` + `useTemplateSourceEvidence` | Searchable authorized source metadata and identity-fenced label evidence; stored local source IDs remain intact and readable |
| `MappingTableEditor` | Verified label hints, explicit local mapping/preset choice, exact missing/empty/null/number/string/whitespace distinctions |
| `RuleEditor` + existing `QuestionField` | Typed literals, readable characteristic tokens, mapping, fallback, conditions, numeric boundaries and retained question guards |
| Existing `AdvancedDefinitionEditor` | Technical/lossless editing within the same inspector transaction; explicit shared scope lists consumers before changes |
| `SourceSupportStatus` + `SourceDiagnostics` | Separate semantic zero, own-schema historical placeholder, deferred values and unresolved evidence; exact category/column/Main-or-EN/source links |
| Existing `SampleProducts`, `PreviewTable`, `OutputGrid` | Authorized sample search and existing server-result presenter; no UX-3 diagnostic-cell projection |
| Existing `WorkspaceDialog`, `useDialogAccessibility`, `useDirtyNavigation` | Shared focus containment/restoration, suspended inspector while navigation is blocked, Save/Discard/Stay |

Normal editing does not require binding IDs, question-value wrappers or mapping-table IDs. Text tokens are readable presentation labels translated back to the original slot identities. Local mapping changes reuse dependency-copy/detach adapters. Complex/custom structures stay intact; unsupported structures lead to Advanced rather than being flattened. An unknown operation is preserved in the save payload, but remains subject to the unchanged authoritative server validation.

Only explicit inspector Apply changes the local definition. Page Save rejects unfinished inspector input. Cancel preserves other already-dirty changes. Clean no-op Save does not invalidate an open inspector; conflicts preserve local work without overwrite/rebase. Header duplicate clones both existing row rules and dependencies; rename/delete retain required-column restrictions. Historical fixed definitions retain explicit structural upgrade and their already-supported ordering operation.

### Bounded deviations / API evidence

The existing registry list returned only `draft_revision` and `publication_count`; it could not identify the latest publication or associate an older selected version with its family without loading complete definitions. The **same existing read-only list query** now also returns `version_summaries` (ID, version number, source revision, publication timestamp) and `selected_version_id`. Counters remain strings. No new endpoint, permission, persistence model, command or migration was added. A PostgreSQL regression asserts that listing returns no definitions and changes no template, activation, audit or business data.

The design table is a dedicated `TemplateDesignGrid`; the accepted `OutputGrid` remains the result presenter. This avoids placing editor metadata into authoritative sample CSV values. The normal layout uses up to 1800 px; switching to a dialog uses available content width rather than only viewport width. There is no alternate normal category dropdown.

Source-support preparation remains read-only; explicit application uses the existing saved-revision/hash/preparation-hash command. Publication review calls the authoritative publish command directly, including for publish-without-manage users. Candidate selection remains independent and does not replace the system exporter.

### Regression and verification record

| Acceptance scenarios | Executable coverage |
|---|---|
| A–C: registry/system/copy | `export-template-ui.test.jsx`; list-summary read-only PostgreSQL case |
| D–G: one navigation, exact Main/EN, sparse EN | `export-builder-ux2.test.jsx`, `export-template-ui.test.jsx` |
| H–N: local mapping, shared consumers, protection, operations, stale callbacks | `export-column-form.test.jsx`, `export-grid.test.jsx`, template UI and existing column/presentation model tests |
| O–Q: custom/no-op preservation and source-support distinctions/proposal | Builder, template attributes/UI tests; unchanged source-support server regressions |
| R–S: exact issue target including dependent EN; sample versus publication blockers | Template UI tests and existing server draft-source-scope tests |
| T–Y: dirty transitions, CAS conflict, independent capabilities, denied reads | Template UI and workspace-route rendered tests; existing authorization/integration suite |
| Z: `test_export_note` / `test_export_color`, exact outputs/order | Rendered form-produced definitions compiled/evaluated through server pure modules; unchanged server oracle/parity/column/source-support suites |

- Runtime: Node **20.20.2**, explicit cached executable and temporary preload guard verifying the exact executable in npm and every child process. Tooling/logs live outside the repository.
- Focused final builder/column workflows: **21/21** passed; the additional five UX-2 registry/publication/save/issue-navigation cases passed. Existing template, column, source-support and route workflows are included in the full run.
- Full client `npm test -- --maxWorkers=2`: **137/137 model tests + 227/227 rendered tests (21 files)** passed. Client lint, production build and `git diff --check` passed. An earlier unconstrained parallel run hit UI timeouts; the final complete two-worker run passed. No expected golden output was updated.
- PostgreSQL: **195/195** integration tests passed against canonical disposable `postgres-test` at `127.0.0.1:55432/amber_test`; the service was stopped afterward. No useful developer database was contacted. Windows shell wildcard issues were resolved by explicitly expanding the existing test-file list, not by changing database environments.
- Server: **506/506** unit/evaluator/parity tests passed. Server lint passed with the two pre-existing unused-variable warnings in unchanged `product-timeline.js`.

### Changed-file manifest

- New files under `client/src/components/export-templates/`: `ColumnInspector.jsx`, `MappingTableEditor.jsx`, `RuleEditor.jsx`, `SourcePicker.jsx`, `SourceSupportStatus.jsx`, `TemplateDesignGrid.jsx`, `TemplateRegistry.jsx`.
- Modified in that directory: `ColumnForm.jsx`, `DefinitionEditor.jsx`, `QuestionField.jsx`, `SourceDiagnostics.jsx`, `export-template-editor.css`.
- New client support files: `client/src/hooks/useTemplateSourceEvidence.js`, `client/src/lib/export-template-categories.js`.
- Modified client support: `client/src/components/workspace/TemplateWorkspaceShell.jsx`, `client/src/components/workspace/WorkspaceDialog.jsx`, `client/src/hooks/useDialogAccessibility.js`, `client/src/hooks/useDirtyNavigation.jsx`, `client/src/lib/export-template-attributes.js`, `client/src/lib/export-template-columns.js`, `client/src/lib/export-template-presentation.js`, `client/src/pages/ExportTemplatesPage.jsx`.
- Tests: new `client/test/export-builder-ux2.test.jsx`; modified `client/test/export-column-form.test.jsx`, `client/test/export-grid.test.jsx`, `client/test/export-template-attributes.test.jsx`, `client/test/export-template-ui.test.jsx`, `client/test/export-workspace-routes.test.jsx`.
- Server: `server/src/services/export-templates/template.service.js` (read-only summary query only), `server/integration-test/12-export-templates.cases.js`.
- Documentation: this plan. Final working tree: **21 modified tracked files + 10 new untracked files**, all UX-2 work; nothing staged. Branch and HEAD remain the recorded starting values.

**Manual acceptance still required:** no safe browser tooling was available and no browser stack was installed. Rendered jsdom tests cover composition, focus/keyboard and content-width switching, not visual overflow. On approximately **1440 / 1920 / 390 px**, inspect registry, read-only system/copy, table and Main/EN inspector, creation/local mapping, long labels/values, horizontal table scrolling, validation/sample tray, compatibility proposal and publish/version/candidate flows. Verify focus containment/restoration and narrow-page overflow in the real application. Stop here for operator acceptance; UX-3/UX-4, deployment and product-page redesign remain excluded.

## 19. UX-2 acceptance polish — 2026-09-25

The operator manually accepted UX-2 functionality (registry/system/table, one category strip, independent Main/EN, column operations, server evaluation, dirty navigation and responsive behavior). Remaining feedback concerned developer terminology in ordinary attribute authoring. This record supersedes section 18's functional-acceptance-pending statement without changing its historical verification record.

- Starting state: `feature/magento-export-constructor`, HEAD `f41c2d0f41714ed0465933418d574773ed25d91d`; **21 modified tracked + 10 untracked files** from the accepted UX-2 work. Those changes are preserved. The existing server changes belong to section 18; this polish changes no server code, API, permission, database, dependency or migration.
- `ColumnValueForm` now asks **Як записувати значення**: **Як названо в характеристиці** or **Задати свої значення** for semantic options. Choosing either explicitly prepares editable CSV rows from available current names; opening a source alone does not copy anything. Existing stored mappings always display their actual outputs. Informational/product values default to **Використати значення як є** after explicit source selection.
- **Frozen authoring copy:** `export-template-option-labels` copies exact, unambiguous current labels from the existing authorized source-details read. The form previews these strings before local application. Existing mapping inspectors use `OptionNamesCopy` and the existing local/shared dependency adapters. Outputs are persisted in ordinary definition tables, with no new evaluator operation or runtime catalog lookup. Later catalog renames cannot refresh saved output. This explicitly requested authoring action is the sole extension to earlier “labels are hints” guidance; labels still provide no historical/source authorization.
- Missing, blank or conflicting labels, and ambiguous current questions, produce **Значення №… — назву не підтверджено**. The helper creates no output for them; existing outputs remain exact and an absent output requires explicit entry. Historical labels remain technical evidence, not an invented current label. Null, missing, empty text, numeric/string zero and whitespace remain distinct.
- Raw semantic output remains available as **Вивести внутрішній ID варіанта** under **Розширені налаштування виводу**, with the integration warning. It is never selected automatically for a new semantic source, including text-token insertion. Advanced complex-rule editing remains available and lossless.
- Mapping rows prioritize characteristic names, editable CSV text and actions. One **Подробиці джерела** disclosure replaces repeated **Свідчення** controls. IDs, SKU codes and historical records stay reachable there. **Де застосувати зміни** defaults to **Лише ця колонка**; explicit shared edits retain the affected-consumer list. Unresolved, historical-empty, genuine-zero and deferred support retain distinct explanations. Machine validation codes stay in **Технічні подробиці**. No blocker or server check is removed.
- Component scope: `ColumnForm`, `MappingTableEditor`, `RuleEditor`, `QuestionField`, `SourcePicker`, `SourceSupportStatus`, `SourceDiagnostics`, page diagnostics; `Scalar` only gains an accessible visually hidden label option. New helper/component: `export-template-option-labels.js`, `OptionNamesCopy.jsx`. Existing column, builder, attributes, grid and page rendered regressions are updated; new `export-option-names.test.js` and `export-operator-mapping.test.jsx` cover explicit copy, catalog rename, save/load/server output, custom text, EN, raw IDs, free text, ambiguous labels, unchanged source authorization and secondary technical evidence.

Verification: Node **20.20.2**, with an external preload guard checking the exact npm/child executable. Focused mapping/attributes/builder/column/grid/page tests passed **78/78**; the final full client run includes one additional custom-mode cancellation case and the page-code disclosure assertion. Full `npm test -- --maxWorkers=1` passed **138/138 model + 234/234 rendered tests (22 files)** with standard timeouts. An earlier two-worker run concurrent with the production build hit three 5-second workflow timeouts; the final sequential run passed without relaxing assertions or timeouts. Client lint and production build passed. Relevant unchanged server pure evaluator/parity/columns/source-support/Magento suites passed **246/246**. No expected golden is rewritten. No useful database is accessed; PostgreSQL integration is unnecessary for this client-only polish.

This pass touches **19 files**, including four new files named above. Final tree, including the preserved accepted UX-2 work: **22 modified tracked + 14 untracked files**, nothing staged; branch and HEAD unchanged. The two pre-existing server files were compared with the starting SHA-256 inventory and remain byte-identical. `git diff --check` passes; new untracked files are also checked for whitespace errors.

**Manual visual acceptance remains required:** no browser tool is available and none was installed. Inspect new/existing mapped columns, **Світлий → Світлий UX2**, source details, validation details and the 390 px form. Acceptance question: can an operator add **Браслети → Колір** and choose current names or custom names without understanding `value_id`, `color4` or lookup terminology? UX-3 / UX-4, deployment and UX-1 redesign remain excluded. No staging, commits, pushes or branch operations.

## 20. Final UX-2 manual-acceptance correction — 2026-09-25

The operator accepted the functional UX-2 baseline and the improved mapping authoring, but found existing conditional columns (especially AR SEO description) unintuitive. This correction presents ordinary conditional output as an ordered business rule list, while retaining the existing evaluator and authoring transaction.

- Starting branch/HEAD: `feature/magento-export-constructor`, `f41c2d0f41714ed0465933418d574773ed25d91d`. Starting tree: **22 modified tracked + 14 untracked files**, all preserved accepted UX-2/polish work; nothing staged. A temporary SHA-256 inventory distinguishes this correction from the earlier changes.
- `ConditionComposer` shows **Коли виконуються умови**, readable characteristic/value selectors, **Додати умову**, keyboard-accessible move/remove buttons, and an explicit **Інакше** result. Reordering restores focus to the moved rule. Rows stack vertically and fit the existing narrow inspector dialog; no second category or language selector is introduced.
- `export-template-conditions.js` is a lossless authoring lens over existing `when`/nested `else` expressions and references. Normal predicates cover exact equality, membership, presence and absence (`eq`, `in`, `present`, `not`). Numeric/text comparisons retain exact types; semantic options display authorized catalog labels but store the original semantic IDs. Labels provide no source authorization. Unknown predicates or expression properties remain intact and expose **Розширені правила**; ordinary results of those predicates can still be edited separately.
- Multiple rules serialize through existing nested `when` nodes. Only explicit edits construct nodes; opening/cancelling/no-op application does not rewrite bindings, expressions, hashes or source support. A newly added branch initially copies the explicit fallback, preserving its output type/guards; its condition must be configured before applying. Local/shared edits use the existing dependency adapters and consumer warnings. Main and EN remain independent.
- `RuleEditor` reuses ordinary interpolation, literal, mapping and fallback controls inside results. A plain text result can insert readable characteristic tokens directly. AR SEO's outer computed-presence guard stays separate, including its otherwise result; `require` readiness checks stay separate as well. Neither is flattened into a new decision rule. Complex/custom children remain available through Advanced without simplification.
- Raw semantic output is now **Внутрішній ID варіанта**, only inside collapsed **Технічні налаштування**, with the integration explanation. It is never automatically enabled. Existing raw-ID definitions and frozen label copies retain their earlier behavior.
- Source status is compact and follows ordinary input. Repeated source evidence within the same condition list is consolidated. **Подробиці джерела** stays collapsed, including after issue navigation. Historical placeholder, deferred values, unresolved sources and genuine zero retain distinct meanings. Unchecked sources are not falsely labelled confirmed merely because labels are available; support/publish checks remain authoritative.
- Validation prioritizes **Шаблон ще не готовий до публікації** and readable category/characteristic issues. Codes, raw keys, ID sets, schema evidence and original machine messages remain in **Технічні подробиці**. Distinct diagnostics are no longer merged by display label, and the tray counts distinct diagnostics. Issue links retain exact category/column/Main-or-EN/source navigation. Sample messages likewise separate readable explanations from exact technical records; no diagnostic-cell projection or UX-3 review grid is added.

Changed files in this correction (20; earlier accepted changes elsewhere are preserved):

- New: `client/src/lib/export-template-conditions.js`, `client/src/components/export-templates/ConditionComposer.jsx`, `client/test/export-conditions.test.js`, `client/test/export-conditions.test.jsx`.
- Components: `ColumnForm.jsx`, `ColumnInspector.jsx`, `RuleEditor.jsx`, `QuestionField.jsx`, `SourcePicker.jsx`, `MappingTableEditor.jsx`, `SourceSupportStatus.jsx`, `SourceDiagnostics.jsx`, and `export-template-editor.css`, all under `client/src/components/export-templates/`.
- Page: `client/src/pages/ExportTemplatesPage.jsx`.
- Existing rendered regressions under `client/test/`: `export-builder-ux2.test.jsx`, `export-column-form.test.jsx`, `export-operator-mapping.test.jsx`, `export-template-attributes.test.jsx`, `export-template-ui.test.jsx`.
- This plan document.

Verification: Node **20.20.2**, with the existing external preload guard checking the exact executable of npm and child Node processes. New deterministic coverage (**4 model + 10 rendered tests**) includes the actual AR Landscape/Icon/default workflow, existing and referenced chains, reorder/remove/focus, branch token insertion, independent EN, untouched outer AR guard, no-op/custom round-trips, typed comparisons, lazy errors, local/shared consumers, exact issue targets, secondary technical evidence and narrow dialog composition. Form-produced definitions are compiled/evaluated by the existing server pure evaluator. Original CSV goldens are not changed.

- Focused conditional/page regression run: **52/52** passed. The final full `npm test -- --maxWorkers=1` run passed **142/142 model + 244/244 rendered tests across 23 rendered files**, with standard assertions and timeouts. An earlier full run exposed the duplicate source disclosure after issue navigation; it was fixed and tested. A subsequent run had two transient failures in the unchanged repricing-autosave and expired-preview tests; both files passed **35/35** independently, then the entire suite passed without changing those files or relaxing tests.
- Client lint and production build passed. Relevant server pure evaluator/parity/columns/source-support/Magento suites passed **246/246**. No server implementation change was made in this correction, so no PostgreSQL integration or useful-database access was needed.
- `git diff --check` and whitespace checks for all correction files, including new untracked files, passed. Final tree: **22 modified tracked + 18 untracked files**, including the earlier accepted work; nothing staged. Branch and HEAD unchanged. Both pre-existing server files remain byte-identical to the starting SHA-256 inventory.

**Manual visual acceptance remains pending:** no browser tool is available and no browser stack was installed. Check AR SEO with Landscape/Icon/another type and fallback text, token insertion, reorder focus, Main/EN, ordinary versus technical source details, validation links and the approximately 390 px layout in the actual application. jsdom verifies controls and dialog composition, not real overflow or visual appearance. UX-3 and UX-4 remain **not started**. No useful database, migrations, dependencies, RBAC, runtime export/evaluator/source-support semantics or UX-1 product handoff are changed. No staging, commits, pushes or branch operations.

## 21. Final structural UX-2 request: lifecycle audit and mandatory stop — 2026-09-25

**Structural redesign is blocked, not implemented.** The operator found that ordinary column editing still mixes business rules with technical evidence. The requested replacement is one intent mode (constant, characteristic, text with characteristics, conditions, first available value, or complex rule), with separate Technical and Advanced surfaces. These changes, including the AR SEO task surface, remain outstanding; they are not merely visual polish deferred to UX-5.

Starting state: branch `feature/magento-export-constructor`, HEAD `f41c2d0f41714ed0465933418d574773ed25d91d`, **22 modified tracked + 18 untracked files**, nothing staged. All earlier UX-2 work is preserved. The mandatory audit found that the requested new-copy default conflicts with the accepted explicit opt-in contract documented in section 4 and `EXPORTS.md` (Opt-in historical source support). The task explicitly requires stopping if correcting that default changes support semantics.

### Code-grounded source-support lifecycle audit

| Question | Actual behavior and evidence |
|---|---|
| A. Generic upgrade or targeted repair? | `source-support.js` declares one closed version, `historical-source-support-v1`, targeting `NM.extra` and `AR.size`. `upgradeSourceSupport` upgrades an absent policy and returns an existing policy unchanged. It is a version-labelled, explicitly selected compatibility extension, not a general successive-version migration framework or a recurring catalog repair. Unknown versions fail compilation. |
| B. New templates/copies already use it? | **No, not by default.** `prepareMagentoCandidate` calls the legacy factory and upgrades only with explicit `supportPolicy`. The system route supplies no policy. Client new/system-copy flows pass that original definition unchanged; the creation checkbox defaults off. `createTemplate` preserves the supplied definition. `cloneDraft` copies the published definition exactly, including presence/absence of its policy. |
| C. Only an older/missing policy needs updating? | In the current implementation, only a missing policy produces a changed definition. There is no older-version migration branch. New drafts without the opt-in are also eligible immediately; eligibility does not imply that the draft was created under an older application release. |
| D. Can ordinary catalog changes cause recurrence? | An existing policy is never refreshed or promoted by preparation, even after new historical evidence appears. Evidence changes can invalidate a previously prepared application fingerprint. Separately, `ExportTemplatesPage` always renders the prepare button for a manageable draft, even when the proposal would report `changed: false`; it is not an availability indicator. |
| E. Where are NM/AR rules encoded? | The two targets, numeric-zero exception and allowed deferred IDs 29/30/31 are hardcoded, narrowly scoped policy rules centralized in `source-support.js`; the approved registry also describes them. Generic loading, source validation and lazy evaluator reads call this policy module. They are not a data-driven general upgrade registry, nor scattered UI-driven product repairs. |
| F. What does application preserve? | The pure transformation changes only `evaluatorVersion` and `sourceSupport`. Columns/order/labels, Main/EN, custom mappings, bindings, captured question contracts, readiness and output contract remain exact. The command then updates draft revision/hash/audit through existing CAS, with a fresh evidence/fingerprint check. |
| G. Can it mutate a publication? | No. Prepare/apply load the draft; `replaceDraft` updates only `export_template_drafts`. From-version copying reads/verifies the publication and changes the draft. Migration 035 independently prohibits publication UPDATE/DELETE/TRUNCATE. No published-version upgrade endpoint exists. This persistence conclusion was inspected in code; integration tests were not rerun. |

Consequently, the proposed explanation that every eligible draft was created under an older policy would be false. A fresh default system copy can immediately receive a changed proposal. Automatically adding support to new templates/copies would change their evaluator version, canonical hash, publication source validation and consumed-value support requirements. This requires a separate engineering decision about default policy and exact-copy behavior. No such semantic change or cosmetic disguise was made. Under the current contract, the meaningful action is explicit opt-in for a saved policy-free draft; an already supported draft produces no upgrade, irrespective of later catalog additions.

### Verification and scope

- Node **20.20.2**, using the external launcher/preload guard to verify the exact executable in child processes.
- Existing server pure suites `export-source-support`, `export-template-definition`, `export-template-parity`, `export-template-office`, and `export-template-persistence`: **148/148 passed**. This includes placeholder/genuine-zero/deferred, lazy-read, canonical-hash and original parity coverage; no expected output was rewritten.
- Existing rendered `export-template-ui.test.jsx -t SUPPORT --maxWorkers=1`: **3/3 passed** (39 unrelated cases filtered out), covering explicit new-candidate opt-in, detached prepare/apply, and conflict/local-input preservation.
- An external synthetic audit additionally verified a custom local mapping and independent EN: only the two expected definition keys change, BR evaluated output/CSV stays exact, the input hash is untouched, and repeated preparation after new historical evidence retains the same hash and deferred membership. Own-schema proof remains required. No product/catalog or database writes occurred.
- Only this appended documentation record changes in this task. No runtime/test implementation, dependency, migration or configuration change; full client tests/lint/build and PostgreSQL integration were not rerun because implementation stopped at the semantic boundary. Browser acceptance was not performed. `git diff --check` passes; the before/after SHA-256 inventory confirms all other tracked and untracked files are unchanged. Final status remains **22 modified tracked + 18 untracked**, nothing staged, with the same branch/HEAD.

Technical/Advanced separation and the six focused modes remain UX-2 work pending that decision. UX-5 can handle later purely visual refinements but cannot substitute for this unimplemented structural acceptance requirement. UX-3 and UX-4 remain **not started**. No staging, commits, pushes, resets or branch operations.

## 22. Separately approved source-support lifecycle correction — 2026-09-25

The operator explicitly approved the semantic decision requested by section 21 and limited this task to lifecycle/default attachment. **The structural UX-2 editor redesign is not resumed.** This decision supersedes section 4's explicit opt-in requirement only for creating a new definition from current Magento rules; all existing-definition boundaries remain intact.

Starting state: `feature/magento-export-constructor`, HEAD `f41c2d0f41714ed0465933418d574773ed25d91d`, **22 modified tracked + 18 untracked files**, nothing staged. The accepted UX-2 implementation/polish and the preceding audit record are preserved.

Before editing, code inspection confirmed: candidate preparation attached support only with an explicit query option; both system-copy entries used the legacy system definition; create/save preserved supplied definitions; publication cloning copied exact stored content; support preparation/application were detached-read/CAS operations; validation/publication never attached policy; and the upgrade action rendered even for already-current drafts. Baseline audit verification was 148 server pure tests and 3 rendered support tests, all passing under the old opt-in behavior.

| Boundary | Approved implementation |
|---|---|
| New current template | Existing `/candidate` defaults to `historical-source-support-v1` and its required evaluator. Current catalog and authoritative evidence are captured in one read-only transaction; support is attached before final compilation/hash/diagnostics. Explicit existing `supportPolicy` callers remain compatible; unknown policy requests fail closed. |
| New editable system copy | Both registry and system-view copy actions request that same current candidate. The read-only `/system` response remains an honest legacy exporter description and writes nothing. No creation checkbox is needed. |
| Existing draft/create/save/read | Exact supplied definition remains authoritative, including safe incomplete/legacy definitions. No refresh or attachment on GET, render, save, validate, publish or startup. Generic create is not an implicit import/migration operation. |
| Publication clone | Exact definition/evaluator/policy presence or absence, output contract, mappings, columns/order, Main/EN and definition hash are preserved. Only normal draft identity/revision/base-version metadata changes. A legacy clone can subsequently receive an explicit upgrade; a current clone has no upgrade action. |
| Upgrade availability | Additive server `sourceSupportUpdate` metadata distinguishes `available`, `current`, and `unsupported`; it depends on compilation of the frozen contract, not catalog changes. Prepare preserves its previous response fields and adds this status. Unknown/newer/malformed policies are not rewritten; prepare/publish reject them. Conflicts retain existing 409 behavior. |
| Explicit apply / no-op | Read-only review and explicit apply retain revision/hash/preparation-fingerprint checks and authority. Application preserves all output/user structure. Repeated no-op application remains compatible without revision/audit changes, but no-op actions are hidden in normal UI. |

The check view now displays **Доступне оновлення правил сумісності шаблону** only for server-reported availability, explains **Цю чернетку можна оновити до поточних правил перевірки джерел. Перегляньте зміни перед застосуванням.**, and offers **Переглянути зміни** followed by explicit application. Policy identifier and NM/AR implementation explanation are secondary technical details. Catalog drift, mapping edits and support-policy upgrades remain distinct. A changed preparation response is still a proposal, not publication approval.

Only one current policy is supported; no general migration engine, new endpoint, permission, dependency or migration was introduced. Centralized NM own-schema numeric-placeholder proof, genuine semantic zero, AR deferred membership, lazy evaluation and readiness are unchanged. Old definitions/goldens keep their interpretation and identity. No product/catalog repair or useful-database access is part of this task.

Implementation scope: `server/src/services/export-templates/{source-support.js,template.service.js}`, new `server/test/export-source-support-lifecycle.test.js`, `server/integration-test/{12-export-source-support.cases.js,12-export-template-editor.cases.js}`, `client/src/pages/ExportTemplatesPage.jsx`, `client/test/export-template-ui.test.jsx`, this plan, `docs/EXPORTS.md`, and the superseding note in the historical `docs/EXPORT_TEMPLATES_PR4.md` record. The existing OFFICE unresolved-draft regression now explicitly starts from the legacy system definition, retaining its old strict-draft purpose instead of accidentally testing today's supported candidate.

Verification on Node **20.20.2**, with the external preload guard checking the exact executable in npm and child processes:

- Focused support/lifecycle pure tests: **13/13** (including five new lifecycle cases); focused rendered creation/copy/availability/apply cases: **8/8**. An additional assertion verifies that a valid legacy alias unsupported by the closed policy reports `unsupported`, without rewriting it.
- Final complete server unit/pure suite: **511/511**, including unchanged evaluator, source-support, old hashes and goldens. Server lint passes with the two pre-existing unused-variable warnings in unchanged `product-timeline.js`.
- Final complete PostgreSQL integration suite: **197/197**, using only canonical disposable `postgres-test` / `127.0.0.1:55432/amber_test`; the service was stopped afterward. An initial new assertion compared an HTTP timestamp string to a service `Date`; it was corrected to compare the same server representation, then the complete suite passed. The final suite was rerun after the alias-availability guard. No useful database was accessed.
- Full client `npm test -- --maxWorkers=1`: **142/142 model + 248/248 rendered tests (23 files)**, with normal assertions/timeouts. Client lint and production build pass. No expected output golden was changed.
- `git diff --check` and the new regression-file whitespace check pass. A SHA-256 comparison of the 485 starting files confirms exactly **9 existing files changed**, plus **1 new regression file** listed above; all other earlier work is byte-identical. The preceding plan text is preserved exactly, with this record appended. Final status: **27 modified tracked + 19 untracked files**, including the preserved earlier work; nothing staged. Branch/HEAD unchanged.

No unresolved semantic decision remains for this bounded lifecycle correction. Browser visual acceptance is not claimed. UX-3 and UX-4 remain **not started**; the large column-inspector redesign remains a separate unfinished UX-2 task and was not resumed here. No staging, commits, pushes or branch operations.

## 23. Final structural UX-2 editor — resumed after the accepted lifecycle fix, 2026-09-25

The operator resumed the structural work paused in section 21 after accepting section 22. The remaining problem was the engine-first existing-column inspector: business text, conditions, mappings, contracts and proof were mixed into one long surface. **The intent-based structure is now implemented for manual acceptance.** UX-3/UX-4 remain not started.

Starting state: `feature/magento-export-constructor`, HEAD `f41c2d0f41714ed0465933418d574773ed25d91d`, **27 modified tracked + 19 untracked files**, nothing staged. Earlier UX-2 and source-support lifecycle work is preserved. An external SHA-256 inventory and backup were taken before editing.

### Operator structure and actual components

`ColumnInspector` owns one detached transaction and separates the normal task surface from two independently opened `WorkspaceDialog` surfaces. The normal sequence is column/category/Main-or-EN context, **Як формується значення**, relevant settings, **Короткий підсумок**, Apply/Cancel, then compact status and secondary tools. The display name can be changed explicitly from the header. Simple direct rules can switch between constant and characteristic using the existing direct-column adapter; other modes are recognized from their saved shape, not regenerated by selecting a generic engine operation.

| Recognized mode | Normal controls |
|---|---|
| Постійне значення | Value and, where applicable, exact scalar type. No characteristic/mapping/evidence controls. Empty string, null, numeric zero and string zero remain distinct. |
| Значення характеристики | Approved characteristic and applicable output settings. Semantic options offer an explicit frozen copy of current names or custom stored outputs; ordinary rows show names and CSV values. Informational text offers as-is output. Numeric ranges keep their inclusive/exclusive boundaries. |
| Текст із характеристиками | Focused textarea, readable tokens and characteristic insertion. Selecting a token opens its relevant value controls; internal slot renaming lives in Technical. Unsupported interpolation shapes use Advanced. |
| Значення залежить від умов | The existing ordered `ConditionComposer`, ordinary result editors and explicit otherwise result. Complex predicates/results have their own Advanced entry without being flattened. |
| Перше доступне значення | Ordered entries with explicit add, move and remove. The existing presence/error behavior stays intact; exact policy is available separately. |
| Складне правило | Concise preserved-rule summary and an Advanced button. No partially rendered recursive engine editor underneath. |

`export-template-intent.js` supplies read-only shape lenses and source discovery within the existing definition. `RuleEditor` renders focused controls only for recognized shapes, retaining its technical editing path. `ColumnValueForm`, `MappingTableEditor`, `SourcePicker` and `ConditionComposer` share their existing builders/adapters with this focused presentation. `RuleSummary` describes the pending rule; it never evaluates products. `ColumnTechnicalDetails` loads authorized source evidence only when the separate technical surface opens.

**Технічні подробиці** contains source keys, semantic/SKU IDs, table identities, contracts, current/historical evidence, exact diagnostics, raw-ID output and compatibility controls. Shared editing still requires explicit scope and lists consumers. **Розширені правила** opens `AdvancedDefinitionEditor` separately. Closing either returns to the same column/category/row with the normal controls and pending transaction preserved. Both reuse the existing focus containment/restoration helper. The suspended normal surface rejects stale callbacks; cancel discards only this transaction, and page Save still cannot bypass unfinished editor input.

For AR SEO the operator edits Landscape → landscape text, Icon → icon text, and Otherwise → default text, including readable characteristic tokens. These remain existing nested lazy `when` expressions. The actual AR computed-presence guard, its alternate result, readiness dependencies, mappings and independent EN are preserved. Synthetic fixture strings remain in tests only.

Normal validation prioritizes **Шаблон ще не готовий до публікації** and **Джерело потрібно перевірити перед публікацією**, with the original exact category/column/row/source targets. Machine codes and proof remain secondary technical content. The normal inspector has no inline JSON/evidence arrays; confirmed approved sources and exceptional placeholder/deferred/unresolved states use compact wording. Labels never authorize semantic values, and source status is not full-template publication approval.

Simple editors retain the table on sufficiently wide layouts. Conditions use a focused dialog (up to 880 px); narrow normal/Technical/Advanced surfaces use the viewport rather than squeezing the table. Business text can scroll; technical strings scroll within the technical surface. Apply/Cancel remain sticky and keyboard reachable.

### Preserved lifecycle and scope

Section 22 remains authoritative and unchanged: current candidates/system copies start with the current policy, old drafts are not rewritten, publication clones retain exact semantics, catalog drift is not an upgrade, real server-reported availability controls the action, and publications stay immutable. This task changes no server implementation, policy, evaluator, readiness, snapshot, CSV, RBAC, migration, dependency or UX-1 handoff. No useful database was accessed, and no integration run is required for these client changes.

Files changed in this structural task (earlier modifications in other files are preserved):

- New: `client/src/lib/export-template-intent.js`, `client/src/components/export-templates/ColumnTechnicalDetails.jsx`, `client/src/components/export-templates/RuleSummary.jsx`, `client/test/export-intent-editor.test.jsx`.
- Existing components under `client/src/components/export-templates/`: `ColumnInspector.jsx`, `DefinitionEditor.jsx`, `RuleEditor.jsx`, `ConditionComposer.jsx`, `ColumnForm.jsx`, `MappingTableEditor.jsx`, `SourcePicker.jsx`, `SourceSupportStatus.jsx`, `SourceDiagnostics.jsx`, `export-template-editor.css`.
- Existing tests under `client/test/`: `export-builder-ux2.test.jsx`, `export-column-form.test.jsx`, `export-conditions.test.jsx`, `export-grid.test.jsx`, `export-operator-mapping.test.jsx`, `export-template-attributes.test.jsx`, `export-template-ui.test.jsx`.
- This plan record; preceding planning/acceptance history remains intact.

### Verification and remaining manual acceptance

Verification results are recorded below after the final checks. Manual browser acceptance is pending: no browser tool was available and no browser stack was installed. Check the real 1440/1920 px and 390 px application, two/three AR SEO conditions and tokens, ordinary mappings, separate Technical/Advanced, long values, internal scrolling and keyboard return focus. UX-5 may refine spacing, density and visual treatment after acceptance; it does not replace this implemented structural UX-2 work. No staging, commits, pushes or branch operations.

Final verification on Node **20.20.2**, with the external preload guard verifying the exact executable in npm and child processes:

- **12 new structural regressions**, including read-only intent detection, constant/scalar types, frozen/custom mapping and as-is text, readable interpolation, ordered/lazy fallback, opaque rule preservation, exact issue context, separate technical evidence/raw-ID controls, shared transaction across all three surfaces, suspended-callback rejection, and focus restoration at 390 px. Existing AR Landscape/Icon/default, token insertion, condition add/move/remove, Main/EN, local/shared mapping, dirty navigation, CAS conflicts and permission cases remain green.
- Final complete client `npm test -- --maxWorkers=1`: **142/142 model + 260/260 rendered tests, 24 rendered files**. This includes all **126** tests in the nine focused UX-2 editor/source/route/grid files. The earlier focused pass exposed old assumptions about inline evidence and an always-present side drawer; those tests now exercise explicit Technical opening and both appropriate surface types, without changing evaluator expectations or relaxing timeouts.
- Client lint and production build pass. Full server unit/pure suite: **511/511**, including original evaluator/parity/CSV goldens, legacy hashes, editable-column behavior and accepted source-support lifecycle/placeholder/zero/deferred cases. UI-produced definitions are compiled and evaluated through the existing server pure evaluator in the client regressions. No output golden was rewritten.
- No PostgreSQL integration or useful-database access: server implementation and persistence are unchanged in this structural task.
- `git diff --check` passes; new files were checked separately for whitespace. The final SHA-256 inventory confirms **18 existing files changed + 4 new files**, matching the manifest above; all other starting files, including every server file and the UX-1 product handoff, remain byte-identical. The preceding plan text is preserved exactly.
- Final status: **27 modified tracked + 23 untracked files**, including all preserved earlier work; **nothing staged**. Branch and HEAD unchanged. No staging, commits, pushes or branch operations.

Implementation and automated verification are complete. Stop here for operator manual acceptance; the browser/layout checks above remain open. UX-3/UX-4 have not started.

## 24. UX-3 execution record — 2026-09-25

### Roadmap and preserved scope

The operator accepted UX-2 functionality sufficiently to proceed. **UX-2 is
complete for roadmap purposes.** The known usability debt is explicitly retained
for integrated final UX/polish: **intent-based rule authoring can still be
simplified further**. This work does not reopen the Template Builder, alter its
definitions/rules or change its sample/editor grids. The future Magento
schema/attribute synchronization idea remains a post-redesign integration epic;
no Magento API integration is implemented. UX-4 collaboration/list redesign has
not started and must consume this shared history contract later.

### Inspection before edits

| Item | Recorded baseline |
| --- | --- |
| Branch | `feature/magento-export-constructor` |
| HEAD | `d5847ffedbc594dcd14ff60715ed6ce98cb28c9e` |
| `git status --short` | Empty; no pre-existing working-tree changes |
| Migration inventory | 39 migrations, contiguous `000`–`038`; none changed or added |
| Relevant persisted domains | `013_export_snapshots`, `027_export_and_sku_schema_actor_attribution`, `031_product_price_reexports`, `032_price_change_requests_and_price_exports`, `033_magento_snapshot_artifacts`, `034_product_magento_manual_names`, `035_export_templates`, `036_export_snapshot_template_binding`, `037_shared_export_sessions`, `038_editable_export_columns` |
| Provider/controller | `AuthProvider → AuthGate → RouterProvider → Workspace → ExportWorkflowProvider → route content`; `useProductExportController` remains above route content |
| Workspace routes | `/exports`, `/exports/prices`, `/exports/new/template`, `/exports/sessions/:sessionId?`, `/exports/shared`, `/exports/invitations`; minimal product handoff goes to existing `/` |
| Existing product endpoints inspected | `/api/export/status`, `/template-options`, `/preview`, `/snapshots`, `/snapshots/:id`, `/snapshots/:id/magento/:group/csv`, `/snapshots/:id/csv`, `/snapshots/:id/confirm` (paths after status relative to `/api/export`) |
| Existing session/price boundaries | Session save, preview, prepare, generate and membership predicates; price status/create/stored CSV/confirm remain separate server commands |

The current implementation, migrations, rendered tests and export/source-support/
session/price integration suites were inspected alongside the required project,
RBAC, migration, export and UX-plan documents. Ordinary preview already returned
authoritative provisional CSV and `tableFingerprint`/`previewExpectation`; it did
not require a snapshot to display a table. Published binding and session durable
preparation remained the existing generation authority. Existing legacy failed
products were omitted from provisional CSV, requiring a separate projection.

### Implemented workspace behavior

- **ПОПЕРЕДНІЙ ПЕРЕГЛЯД** now displays actual server-finalized cells for ordinary
  export and published/session export. It has checked time, explicit stale state,
  coherent publication labels/IDs and explicit recheck. Successful relevant writes
  invalidate review; focus probes compare the existing server fingerprint only.
- One `ExportDataGrid` supports exact file/header order, Main/EN, a sticky
  SKU/language/readiness rail, internal horizontal scrolling, SKU and attention/
  language filters, local keyboard-accessible column widths, 50-row pages, exact
  long-value dialogs and roving cell focus. No visual sort or request/range changes.
- The server collects diagnostic values and issue ownership during the existing
  lazy evaluator/mapper. Failed-only categories/products stay visible without
  fabricating CSV rows. `final`, `blank`, `provisional` and `not-evaluated` states
  are distinct. Cell/column evidence marks cells; unknown source/row evidence stays
  on the row. Issues use one compact summary with details and authorized handoff.
- Existing manual-name and product/decode workflows are reused. `exportSku` only
  offers an explicit exact-SKU decode; dirty product work blocks that action.
  No inline editing, automatic correction or successor substitution is added.
- Session save/check/prepare/capture remain separate. The next relevant action
  is visually primary. Replacement of saved preparation stays explicit and
  secondary; unknown original operations retain their original recovery identity.
- Successful capture replaces preview with **ЗБЕРЕЖЕНІ ФАЙЛИ**, freezing range,
  publication and preparation. It shows stored range/provenance/counts/status/
  attribution and reads selected immutable artifacts lazily. Failed table loading
  offers only reading retry, never another create action. Historical missing
  artifacts are not reconstructed. Stored results have no live-refresh control.
- Selected-file download is separate from confirmation and says only that bytes
  were handed to the browser. **Завершити експорт** explains actual cursor/revision
  consequences and explicitly does not assert Magento import success. Confirmation
  needs no previous download; time/actor come from stored server metadata.
- `/exports/prices` has no template/range. Explicit queue review → create → stored
  `sku,price` table → download → **Підтвердити експорт цін** replaces combined
  orchestration. Review explicitly freezes nothing. A changed stored file is shown
  with a notice before confirmation; table-read retry never recreates it. Only
  the existing confirmation command advances captured dedicated revisions.
- Basic **Історія файлів** at `/exports/history` opens product and price snapshots
  through `/exports/history/:stream/:snapshotId`. Generated files survive reload
  through this read model. This is not a second session/collaboration status model.

### Exact read-only API additions

See [Exports — UX-3 contracts](EXPORTS.md#ux-3-authoritative-review-stored-files-and-shared-history)
for the complete field descriptions and compatibility behavior.

| Contract | Exact boundary |
| --- | --- |
| Existing product/session preview | Adds `checkedAt`, `review:{version:"export-review-v1",identity:tableFingerprint,files}` and published `templateLabel` outside binding. Files contain group/name/profile/fileName, exact headers and rows with canonical product/row positions, Main/EN identity, readiness, issues and `{state,value}` cells. Preparation returns this transiently, not in persisted summary. |
| `GET /api/export/history` | `stream=all|product|price`, `scope=accessible|mine`, `status=all|generated|confirmed`, `limit` default20/max50, opaque `after`; `{items,next}`. Invalid filters/cursors are422. Descending immutable creation time + ID, then stream for cross-table ID ties; microsecond cursor precision and filter binding. |
| Shared history/result metadata | Stored ID, stream, generated/confirmed status and time, nullable creator/confirmer, product/CSV counts, captured product range, actual profile/publication provenance and available artifact summaries. Unknown historical creator/provenance stays unknown; no audit-derived owners or fake sessions. |
| `GET /api/export/snapshots/:id?includeRows=false` | Metadata without artifact CSV SQL selection; omitted parameter retains prior response compatibility. Existing stored group CSV route provides selected-file bytes and independently enforces access. |
| `GET /api/price-export/preview` | `{checkedAt,rowCount,csvContent}` from current eligible queue, product-ID order, exact finalized `sku,price`; no token, mutation or frozen queue. |
| `GET /api/price-export/snapshots/:id` | Safe stored-result metadata and one `prices` artifact summary; no internal captured revision list. Existing `/:id/csv` remains stored-byte access. |

Every operational read requires authenticated active `exports.view`; create and
confirm remain `exports.create` plus existing CSRF. History uses canonical tables
and checks effective authorization in the query. Session-linked rows require owner
or accepted membership, exactly as direct stored-result reads; administrator is
not a bypass and pending invitations are insufficient. `mine` filters only recorded
creator ID, never null history. Opening and every artifact read reauthorize.

These are observational additions. Product-ID normalization/order, exclusions,
cursor/exposure/revision rules, signed binding/ordinary expectation identity,
idempotency/retry, immutable publication/snapshot identity, capture lock ordering,
transactional result/artifact/audit behavior, source support, exact CSV and formula
neutralization remain in their existing authoritative paths. The observer neither
eagerly evaluates skipped branches nor supplies capture rows. It fails closed at
the existing 64 MiB output ceiling without raising limits or splitting ranges.

### Performance evidence

Environment: Windows, AMD Ryzen 9 9950X3D, exact Node **20.20.2**. A preload guard
outside the repository verified the executable/version in npm and child processes.
One complete preview remains the consistency boundary; no server paging. Stored
files parse lazily and memoize within the authorized result/file identity. A
slice-based review CSV scanner avoids per-character concatenation nodes for long
quoted values, without changing the Template Builder parser.

Synthetic test data uses two files, Main/EN rows, 100/1,000/5,000 products, 32/64
columns and long quoted multiline SEO/category values. Total fixture bytes stay
below the existing ceiling. Standalone measured parsing results:

| Products | 32 columns | 64 columns |
| --- | --- | --- |
| 100 | 7.3 ms | 2.9 ms |
| 1,000 | 36.1 ms | 33.5 ms |
| 5,000 | 108.3 ms | 126.5 ms |

At 5,000 × 64 across two files: 31,836,694 UTF-8 bytes, cached read0.009ms,
filter0.40ms; cumulative test-process peak RSS260.5MiB (includes fixture creation,
both parsed files and prior fixtures; not an isolated browser allocation).
Chrome development-build React Profiler with 5,000 products/two files/64 columns,
50 visible rows: initial grid177.8ms, next page68.5ms, SKU filter36.6ms. This does
not justify virtualization in this change. Operator-machine acceptance remains
separate from these synthetic measurements.

### Verification and remaining acceptance

- Focused UX-3/ordinary/template/session/workspace rendered set: **74/74**.
- Complete client: **149/149** model and **272/272** rendered tests, **25** rendered
  files. Existing UX-1 and UX-2 suites remain included and pass. An earlier full
  run had one timing failure in the unchanged repricing characterization; its
  isolated15-test file and the final complete run passed. No repricing code changed.
- Client lint and production build pass. Full server unit/pure suite **516/516**;
  server lint has no errors and the two pre-existing unused-variable warnings in
  `product-timeline.js`. New integration case syntax was checked.
- New server regressions cover failed-only groups, blank/provisional/unknown cells,
  finalized formula/quoted text, authority/metrics equality and lazy source support.
  New integration cases cover readonly effects, immutable metadata/bytes, precise
  cross-stream pagination, null authors, private-session membership and explicit
  price creation/download/confirmation with later/out-of-order revisions. Existing
  direct/template/session rollback/race suites are still in the integration runner.
- **PostgreSQL integration is NOT verified.** The one canonical
  `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d postgres-test`
  failed because Windows forbade binding `127.0.0.1:55432` (“An attempt was made to
  access a socket in a way forbidden by its access permissions”). No alternative
  port/instance/database was tried. Canonical `stop postgres-test` completed after
  the work. No useful HOME/OFFICE/production database was touched.
- Browser tools were available for DOM/keyboard checks on a temporary offline
  fixture entry using actual workspace components/controllers, with a fail-closed
  in-memory API adapter and no DB connection. Widths **1440, 1920, 390** were checked;
  page scrollWidth did not exceed viewport. Checked ordinary preview/six category
  tabs, failure filter/cell handoff, long exact value, Escape/focus return, sticky
  rail during horizontal scroll, stored transition/no live refresh, history, price
  review/changed stored values and both explicit confirmation dialogs. These are
  synthetic UI checks, not real API integration or Magento acceptance.
- Screenshot capture twice timed out in the browser backend; actual visual
  screenshots could not be inspected. **Manual operator visual acceptance remains
  required**, particularly density/spacing at all three sizes, real stored sessions,
  representative production-like diagnostics and full end-to-end flows after the
  canonical disposable database infrastructure is repaired. Temporary fixture files
  and server were removed/stopped; browser viewport override was reset.
- `git diff --check` passes. No migration, dependency, package lock, environment,
  deployment or configuration file changes. No staging, commits, pushes or branch
  switching/reset/clean/stash/merge/rebase/cherry-pick operations.

Implementation is handed off for manual operator acceptance with the explicit
integration infrastructure blocker above. UX-4 remains unstarted. The final
working-tree inventory is **24 modified tracked files + 16 new files; 0 staged**,
all on the unchanged baseline branch/HEAD.

Changed-file inventory (repository-relative):

- New client review/stored surfaces: `client/src/components/exports/ExportDataGrid.jsx`,
  `ExportReview.jsx`, `StoredSnapshot.jsx`, `StoredResult.jsx`,
  `PriceExportWorkspace.jsx`, `export-data-grid.css` in that same directory.
- New client controller/read helpers: `client/src/hooks/product/usePriceExportController.js`,
  `client/src/lib/export-review-events.js`, `client/src/lib/export-review-presentation.js`,
  `client/src/pages/ExportHistoryPage.jsx`.
- Existing client integration: `client/src/api/exports-api.js`,
  `client/src/components/app/ExportTools.jsx`,
  `client/src/components/workspace/ExportWorkspaceShell.jsx`,
  `client/src/hooks/product/useProductExportController.js`, `client/src/lib/api.js`,
  `client/src/pages/AppPage.jsx`, `ExportSessionsPage.jsx`, `ExportsPage.jsx`.
- New server projections: `server/src/presenters/export-review.js`,
  `server/src/services/export-history.service.js`.
- Existing server integration: `server/src/routes/endpoint-manifest.js`,
  `server/src/routes/public/exports.routes.js`,
  `server/src/services/export-sessions.service.js`,
  `server/src/services/export-templates/evaluate.js`,
  `server/src/services/export-templates/published-capture.js`,
  `server/src/services/export.service.js`, `server/src/services/magento-products-v1.js`,
  `server/src/services/price-export.service.js`, `server/src/utils/csv.js`.
- New tests: `client/test/export-ux3.test.jsx`,
  `client/test/export-review-performance.test.js`, `server/test/export-review.test.js`,
  `server/integration-test/12-export-ux3.cases.js`.
- Updated tests/runner: `client/test/controlled-template-export.test.jsx`,
  `client/test/export-sessions-ui.test.jsx`, `client/test/export-workspace-routes.test.jsx`,
  `client/test/magento-export-ui.test.jsx`, `server/integration-test/critical-flows.test.js`.
- Documentation: `docs/EXPORT_UX_REDESIGN_PLAN.md`, `docs/EXPORTS.md`.

## 25. UX-4 execution record and UX-3 carry-over — 2026-09-25

### Starting evidence and prerequisite verification

The authoritative starting branch was `feature/magento-export-constructor`, HEAD
`d5847ffedbc594dcd14ff60715ed6ce98cb28c9e`. The working tree already contained
**24 modified tracked files and 16 new UX-3 files**, with nothing staged. Initial
status, tracked diff and per-file hashes were recorded outside the repository.
All existing files were preserved. Migration inventory is still **39 files,
000–038**; no migration was edited or added. Current code, migrations and tests
were read alongside AGENTS, PROJECT_CONTEXT, this plan, EXPORTS, AUTH_RBAC,
OPERATIONS, DATABASE_MIGRATIONS and SHARED_EXPORT_SESSIONS before implementation.

UX-4 began only after the blocked UX-3 full PostgreSQL suite passed **201/201**.
Windows excluded `55373–55472`, including the unbound port55432. IPv4/IPv6 excluded
ranges and listeners were inspected; **56432** was outside exclusions and a
temporary loopback bind succeeded. Docker Compose v5.1.1 supported this external,
non-committed override, merged after the two existing repository Compose files:

```yaml
services:
  postgres-test:
    ports: !override
      - "127.0.0.1:56432:5432"
```

Only `postgres-test` was started, with `--no-deps`; resolved configuration retained
`postgres:16-alpine`, disposable tmpfs storage and no persistent volumes. The exact
test connection used throughout was:

```text
TEST_DATABASE_URL=postgresql://amber_test:amber_test_local_only@127.0.0.1:56432/amber_test
```

Before imports, the URL suffix and actual `current_database()` were both checked:
**amber_test**, ending exactly in `_test`; current_user was `amber_test`, server
PostgreSQL16.15. `DATABASE_URL` in test processes matched the same disposable URL.
No Windows exclusions, shared Compose configuration, production ports or useful
database were changed. Readiness was awaited on this same service; there was no
fallback database. The service was stopped after each integration run.

### Routes, workspace composition and read models

The existing `/exports`, `/exports/prices`, `/exports/sessions`,
`/exports/sessions/:sessionId`, `/exports/shared`, `/exports/invitations`,
`/exports/history`, `/exports/history/:stream/:snapshotId` and
`/exports/new/template` routes remain. UX-1 routes and UX-3 stored-table components
are reused. Provider placement remains AuthProvider → AuthGate → router Workspace
→ ExportWorkflowProvider → route content. Session controllers stay local to
ExportSessionsPage; the provider retains only principal-scoped display memory and
the existing ordinary/price workflow controllers. No browser storage was added.

- **Мої експорти / Спільні зі мною** use compact responsive list rows: title,
  human status, owner, accepted participant count, authoritative publication,
  requested/captured range, available files, confirmation, creation time and last
  recorded action. UUID/permalink and raw states are secondary details. Shared
  means accepted membership; opening reads the same durable session.
- The additive `GET /api/export/sessions?order=recent` mode orders the authorized
  set by immutable `(created_at DESC,id DESC)`, retaining microseconds in an opaque
  scope-bound cursor. It limits before metadata projection, default20/max50. The
  old omitted-order UUID cursor mode remains compatible. There is no page-local
  sort and mutable activity is never a pagination key. New creations appear after
  an explicit first-page refresh; intervening activity cannot move existing rows
  across page boundaries. Membership changes still take effect on each read.
- `export-session-list.js` projects existing attempts, publication labels,
  accepted/pending counts, audit/member/attempt/session/confirmation timestamps and
  safe artifact metadata. **Остання зафіксована дія** is the maximum existing
  recorded timestamp, not presumed human activity or last read. Pending invitations
  retain exactly the prior minimal ID/title/owner/epoch/state response, without
  this private metadata projection.
- The UX-3 `snapshotMetadata` presenter is reused for list/detail stored results;
  history continues to use the sole `GET /api/export/history` contract. Product
  and price identity/status/attribution/artifact availability stay shared. Null
  creators display **Автор невідомий**; historical unlinked files acquire no
  session, owner or regenerated artifact. History filters still use that contract.

### Sharing, status and recovery

**Поділитися** opens the existing accessible modal primitive with owner, accepted
members and pending invitations. The owner searches local users, selects and
reviews an exact identity, then sends an in-app invitation. Labels are **Власник**,
**Приєднався**, **Запрошено**. Joining explicitly says it opens the same export,
creates/confirms no files and grants no global permission. Revoke and leave have
focused confirmation views explaining future access and irretrievable downloads
or preservation of the session. Owner-only authority, self-revoke denial, original
target/access/member epochs and existing leave/reinvite rules are unchanged.

Display mapping is evidence-driven and introduces no persisted status enum:

| Evidence | Display |
| --- | --- |
| Unsaved local fields | Чернетка |
| No current loaded review; stale or unusable saved preparation | Потрібна перевірка |
| Ready loaded review without saved preparation | Перевірено · перевірку не збережено |
| Ready loaded table matching saved preparation | Готовий до створення файлів |
| Executing marker plus current server lock evidence | Створюються файли |
| Stored generated snapshot | Файли створено |
| Stored confirmed snapshot | Завершено |
| Failed/interrupted/uncertain operation, conflict or current errors | Потрібна увага |

Lists do not probe locks: an executing marker alone is attention, not proof that
generation is running. A held non-generation lock gets neutral workspace wording.
Opening stays observational. Saved preparation without rows shows recovery and a
disabled first-create action, rather than a fictitious loading table. Explicit
read-only review must match before first capture. For prepared state only, detail
reports `preparationIssue: null|expired|unavailable` from the existing signer; this
is an observation, never a new command gate, TTL policy or exposed proof. Stale or
unusable preparations require explicit review and an explicit replacement dialog.

Executing work exposes state/refresh without replacement creation. Interrupted,
failed or uncertain creation offers **Повторити створення цього експорту**. The
browser retains the original submitted revision/access epoch/attempt descriptor;
later reads or preview results cannot replace it. Explicit accepted save or
replacement remains the existing deliberate abandonment boundary. The server
remains authoritative and can reject an original operation that was superseded.
Stored results immediately read their exact saved files without evaluation.

Conflicts retain exact dirty input and show newer saved fields separately. Access
denial or changed membership clears private detail, tables and cached lists and
invalidates late continuations. Principal A→B→A, logout/permission changes and
same-user auth refresh retain their existing lifetimes. Visible/idle ten-second
detail polling, focus and explicit refresh remain; overlapping reads are fenced.
Recovery focus, modal containment/restoration and native keyboard list links are
covered without changing global navigation or Template Builder.

### UX-3 manual finding and bounded continuity fix

The operator's UX-3 acceptance report supplied the concrete two-problem workflow:
after a successful authorized product/name correction the old diagnostic review
correctly becomes stale, but the next problem action was hard to recover. This
carry-over is now implemented without locally patching rows or auto-refreshing:

> Дані товару змінено. Попередній перегляд застарів.
>
> Оновіть перевірку, щоб продовжити роботу з актуальними проблемами.

**Оновити перевірку** receives focus after the product editor releases its modal
focus. Explicit successful recheck preserves only file/category, SKU search,
attention filter, Main/EN filter, column widths and valid page. The fingerprint
still remounts the grid so stale cells/details disappear. A shortened result
clamps the page; an unloaded saved summary cannot reset it. The first fixed issue
is not recreated, and the second current issue remains actionable. Display memory
cannot carry preview proof or operation identity and cannot alter range/order or
eligibility. The grid's existing data/CSV semantics and design were not redesigned.

### Verification and acceptance boundary

- Node **20.20.2** executable and every npm/test child runtime were verified by an
  external preload guard; no runtime/dependency/configuration change was committed.
- Final full server unit/pure suite: **516/516**. Server lint: no errors, the same
  two pre-existing unused-variable warnings in `product-timeline.js`.
- Focused UX-4 PostgreSQL suite: **4/4**. Final full canonical runner, including
  new UX-4 cases and existing export/session/history/price/template/source-support,
  membership/capture/confirmation races and CAS/ABA tests: **205/205**, no skips.
  It used only port56432 / `amber_test`, verified before destructive imports, and
  `postgres-test` was stopped afterward. UX-3 PostgreSQL verification is now green.
- Client UX-4/carry-over: **17/17**; focused session/route/UX-4 set **48/48** before
  the final additional denied-focus-read regression. Full client: **149/149 model**,
  **289/289 rendered**, 26 rendered files. Client
  lint/build pass. Existing UX-2 files/tests remain unchanged from this task's
  initial hashes and remain included in the green suites.
  One full run and the first isolated workflow run hit intermittent failures in
  the unchanged repricing characterization (preview readiness/autosave and newer
  scenario response). The final isolated workflow file passed **15/15** and the
  final complete client command passed **149+289** without test or repricing code
  changes. The failed-run logs were retained alongside the successful evidence.
- New integration assertions cover private owned/accepted shared lists, minimal
  pending invitations, same-session acceptance, decline/reinvite epochs,
  revoke/leave/self-revoke/admin denial, stable microsecond pagination, truthful
  activity, shared UX-3 metadata equality, absence of read side effects, signer
  expiry observation, interrupted/non-generation-lock recovery and original retry
  despite newer review. Existing independent-connection race tests remain included.
- Rendered coverage includes exact recipient choice, pending/revoke/leave,
  view-only controls, prepared/expired/executing/interrupted/stored recovery,
  conflict input, principal changes and late private reads, shared history, and
  the full two-problem authorized mutation → stale → explicit recheck sequence.
- Browser DOM/keyboard/geometry checks used the actual shell/components/controllers
  with a temporary fail-closed in-memory synthetic API adapter, never a useful DB.
  Checked lists at **1440/1920/390**, sharing/search/select/invite/revoke, join,
  view-only leave, prepared/executing/interrupted/stored recovery, reload,
  back/forward route behavior, history and stale-review continuation. Page width
  stayed within viewport; narrow rows stacked; modal Tab/Escape containment and
  focus return worked. Browser testing found and fixed the unloaded-summary
  pseudo-table and post-name-editor focus ordering.
- Screenshot capture failed twice with a backend `Page.captureScreenshot` timeout.
  Browser zoom shortcuts did not establish 200% zoom. **Visual pixel inspection,
  real 200% zoom and final operator acceptance remain pending**, including real
  representative sessions/roles/files. Synthetic checks are not manual acceptance.
  Temporary files/server were removed/stopped and viewport override was reset.
- `git diff --check` passes. No staging, commit, push, branch changes, migration,
  dependency, shared configuration or useful-database writes. No UX-5 work or
  weakening of authorization, capture/idempotency/snapshot/cursor/price semantics.
  UX-4 new-file whitespace checks also pass. A broader no-index audit of inherited
  untracked UX-3 files reported the pre-existing blank final line in
  `client/src/lib/export-review-presentation.js`; its initial hash is unchanged
  and it was preserved rather than changed incidentally.

UX-4 delta relative to the preserved initial UX-3 working tree:

- Client changes: `src/api/export-sessions-api.js`, `src/pages/ExportSessionsPage.jsx`,
  `src/pages/ExportHistoryPage.jsx`, `src/components/app/ExportTools.jsx`,
  `src/components/exports/{ExportDataGrid,ExportReview,StoredResult}.jsx`,
  `src/hooks/product/useProductExportController.js`, `src/lib/api.js`,
  `src/lib/export-review-events.js`, `test/export-sessions-ui.test.jsx`.
- New client files: `src/components/exports/{ExportSessionList,SessionSharing}.jsx`,
  `src/components/exports/export-workspaces.css`,
  `src/hooks/product/useExportReviewView.js`, `src/lib/export-session-presentation.js`,
  `src/lib/export-view-memory.js`, `test/export-ux4.test.jsx`.
- Server changes: `src/services/export-sessions.service.js`,
  `integration-test/critical-flows.test.js`; new
  `src/services/export-session-list.js`, `integration-test/12-export-ux4.cases.js`.
- Documentation: this record, `SHARED_EXPORT_SESSIONS.md` and the bounded continuity
  clarification in `EXPORTS.md`. The final combined working tree is **26 modified
  tracked files + 25 new files, 0 staged**, on the unchanged branch/HEAD.

Implementation stops here for manual operator acceptance; UX-5 remains unstarted.
