# Configurable Export Templates v1

Status: **Proposed — Phase 0 design; not implemented.**

Audit date: 2026-09-23. This document is the sole Phase 0 deliverable. All names of new modules, tables, operations, permissions, and endpoints below are proposals, not existing APIs. Sections headed “Current” describe inspected code; acceptance history is explicitly separated from new verification.

## 1. Verified repository baseline and scope

| Evidence | Observed value |
| --- | --- |
| Working directory | `D:\Work\артикул\amber-app` |
| Branch | `feature/magento-export` |
| HEAD | `fa8570cdeeacab3a2218d696e8514b36e778f049` (`feat(client): redesign Magento export workflow`) |
| Initial `git status --short` | Empty; clean checkout |
| Nearby commits | `7d487ce` Magento decimal normalization/error handling; `9139d16` Magento product information service |
| Accepted implementation prerequisite | Present: six-group Magento mapper, immutable artifacts, manual-name support, CH normalization, KL fallback, operator workflow, and regression tests |
| Merge/deployment evidence | Not established. A local branch/commit is not evidence of a merged PR or deployed release. No branch switch or remote operation performed. |
| Local restored database | Not connected to or inspected. No bootstrap, migrations, seeds, repair, restore, or Magento connection used. |

Read completely: root `AGENTS.md`, `PROJECT_CONTEXT.md`, `docs/EXPORTS.md`, `docs/SKU_CATALOG.md`, `docs/DATABASE_MIGRATIONS.md`, `docs/AUTH_RBAC.md`, `docs/PRICING.md`, `docs/RECOUNT_CORRECTIONS.md`, and `docs/OPERATIONS.md`. The code below takes precedence over their snapshots. No nested `AGENTS.md` was found. The completed optional-placeholder recount fix is outside this design; export characterization must preserve its resulting stored data, not reopen recount.

Current implementation/test entry points:

| Path | Inspected responsibilities |
| --- | --- |
| `server/src/routes/public/exports.routes.js` | Status, preview, snapshot creation/manifest/artifact download/confirmation, disabled direct CSV, dedicated price routes, permissions |
| `server/src/services/export.service.js` | `getExportRows`, `resolveNewExportRange`, `previewExport`, `createExportSnapshot`, `assertSnapshotMatchesRequest`, `assertSnapshotProfile`, `establishProductSnapshotExposure`, downloads, confirmation and status |
| `server/src/services/magento-products-v1.js` | `HEADERS`, `GROUPS`, `V`, `ATTRIBUTE`, `SEO`, `AR_NAMES`, `AR_SIZE`; `loadMagentoCatalog`, `optionValue`, `rawName`, `categoryPaths`, `mapProduct`, `buildMagentoPayload` |
| `server/src/services/price-export.service.js` | Separate price selection, captured revisions, immutable CSV, idempotency and confirmation |
| `server/src/utils/csv.js`, `server/src/utils/money.js`, `server/src/utils/rules.js` | Actual CSV bytes, existing Number conversion, live visibility-rule semantics |
| `server/src/services/product-magento-name.service.js`, `server/src/services/product-information.service.js` | Existing data-resolution boundaries; no template evaluator writes through these services |
| `client/src/hooks/product/useProductExportController.js`, `client/src/api/exports-api.js`, `client/src/components/app/ExportTools.jsx` | Preview/create/download/confirm flow, readiness labels, manual-name action, collapsed re-export flow |
| `server/test/magento-products-v1.test.js` | Six-group smoke, sparse EN, constants, KL priority, CH decimals/invalid inputs, Stone EN set |
| `server/test/csv.test.js`, `server/test/csv-presenters.test.js`, `server/test/product-magento-name.test.js` | CSV safety/presentation and saved-name/translation boundary |
| `server/integration-test/critical-flows.test.js` | Serialized destructive PostgreSQL entry point, loading `suite-context.js` and ordered `.cases.js` files |
| `server/integration-test/11-magento-products.cases.js` | Readiness, informational/manual-name edits and snapshot races, exposure, old artifacts, new-product cursor workflow |
| `server/integration-test/11-exports-schemas.cases.js` | Snapshot attribution/audit/idempotency/immutability, permissions, initial exposure, dedicated prices, exclusions, captured revisions, out-of-order confirmations |
| `server/integration-test/02-migration-foundation.cases.js`, `06-migration-upgrades.cases.js`, `12-rbac-audit.cases.js` | Migration and RBAC boundaries to extend later |
| `client/test/magento-export-ui.test.jsx`, `client/test/permission-ui.test.js` | Operator workflow, readiness presentation, permissions |

Actual migration inventory ends at **`034_product_magento_manual_names.sql`**, not 030 or 032. Export-relevant history is `013_export_snapshots.sql`, `016_legacy_zero_price_compatibility.sql`, `020_application_users_rbac.sql`, `021_business_permission_enforcement.sql`, `023_audit_events.sql`, `027_export_and_sku_schema_actor_attribution.sql`, `028_custom_roles.sql`, `031_product_price_reexports.sql`, `032_price_change_requests_and_price_exports.sql`, `033_magento_snapshot_artifacts.sql`, and `034_product_magento_manual_names.sql`. SKU semantics also depend on `006_sku_schema_versions.sql` and `007_compact_sku_version_markers.sql`. Future work starts with the next available forward migration (**035 if still free**); recheck the inventory before assigning it. Do not edit any historical migration or checksum. No assertion is made about migrations applied to the restored database.

Product goal: administrators configure ordered export columns from approved sources using bounded transformations, through forms. One published version governs the complete multi-file normal-product snapshot. The current exporter stays active until independent parity, concurrency, and fresh Magento Check Data gates pass.

Excluded: readiness spreadsheet/matrix, bulk/inline product correction, price templates, additional cursors, delivery/scheduling/Magento API, executable expressions, SQL/JS/network access, and unrelated SKU/pricing/recount/auth/infrastructure work.

## 2. Current workflow and contract

### 2.1 Selection, capture, artifact and confirmation

1. `GET /api/export/status` reports eligible products after the confirmed singleton ID cursor. Eligibility is `COALESCE(exclude_from_export,0)=0`; the template must never decide eligibility. Archive/recount workflows set exclusions elsewhere. There is no extra export `status='active'` predicate to invent.
2. `previewExport({mode:'new'})` uses a `REPEATABLE READ READ ONLY` transaction. `resolveNewExportRange` selects MIN/MAX eligible IDs greater than the cursor; empty means `range:null`, zero counts and no artifacts. Manual preview uses SKU anchors.
3. `getExportRows` trims/uppercases requested anchors, resolves existing products, selects inclusive min/max **product IDs**, orders by ID, and omits excluded rows. Missing `toSku` in the service means open-ended to latest; the current manual UI substitutes `toSku=fromSku` for a blank upper input, meaning one product. Reversed endpoints select the same ID interval, but request identity is still directional (below).
4. Loaded Magento inputs are `id`, `full_sku`, `category`, `weight`, `total_price_uah`, `details`, manual UA/EN subjects; the query also loads `created_at`. `getExportRows` additionally prepares legacy internal text/size columns from live non-SKU questions and labels. `loadMagentoCatalog` reads live question existence, requiredness, visibility and option value IDs. It does **not** load the product's historical schema.
5. `buildMagentoPayload` calls `mapProduct` for every represented product. Products with errors are excluded from its provisional artifacts but included in `representedCount` and errors. `readyCount=representedCount-productsWithErrors`. Preview returns only artifact metadata. Snapshot creation rejects the **entire range** with `422 MAGENTO_NOT_READY` if any product fails, so provisional omissions cannot consume the cursor.
6. `createExportSnapshot` first handles idempotency; on a new key it begins a transaction, re-resolves `mode:new` anchors/count, selects products `FOR SHARE` in ID order, reloads catalog and evaluates readiness. Empty Magento ranges fail. It then establishes revision exposure, rechecks/locks the new-mode cursor, inserts the parent internal CSV plus every group artifact and one audit event, and commits once. Failure rolls everything back. Current create isolation is default READ COMMITTED, not preview's repeatable-read transaction.
7. `getMagentoArtifacts` lists stored metadata in BR, NM, KL, CH, AR, SV order. `getMagentoArtifact` validates group and selects the stored `magento-products-v1` bytes; it never runs the mapper. Old snapshots with no Magento artifacts remain internal-CSV-only. Downloads require `exports.view` and change no export state.
8. `confirmExportSnapshot` locks the snapshot `FOR UPDATE`. First confirmation records actor/time/status and one event. It locks represented revision rows by product ID and applies `GREATEST(confirmed_revision,capturedRevision)` with the upper bound on current revision, then advances `export_state` using `GREATEST`. Older confirmations cannot regress the cursor; `last_snapshot_id` follows a non-regressing high water (equal IDs may update it). Repeated confirmation retains creator/confirmer and emits no new event while retaining high-water repair.

Current preview is not a complete staleness contract: it has no signed export input token. New-mode create checks anchors/count and the cursor read within create; it does not bind the cursor or all product fields from the earlier preview. A changed product that remains ready can therefore be exported with newer values. This must be strengthened for template-aware requests, not described as an existing guarantee.

Current key contract: trimmed nonempty key, maximum 200 characters, global unique key in `export_snapshots`; normalized requested anchors use trim/uppercase, blank upper anchor becomes null. `assertSnapshotMatchesRequest` compares ordered `from_sku`/`to_sku`, **not** sorted endpoint IDs. Thus `(B,A)` and `(A,B)` select the same products but conflict under the same key. Open-ended and explicit-last requests also differ. Profile defaults to `magento-products-v1`, with `internal-legacy` available for old callers. Profile identity currently means presence/absence of Magento artifacts. Both early-hit and SQL `23505` loser paths check range/profile. Mode is not part of legacy key identity. Preserve these details rather than silently broadening “normalized range.”

Parent metadata: UUID text ID, key, requested/resolved SKU anchors, exported-to product ID, `row_count` (represented **products**, also internal CSV data rows), internal filename/content, generated time, generated/confirmed status, confirmation time, nullable local creator/confirmer and immutable `reexport_revisions`. Magento artifact metadata: parent FK, `profile_version`, group code, filename, content, product count, CSV data-row count and created time. Its PK is `(snapshot_id,profile_version,group_code)`; 033 restricts profile to `magento-products-v1`, six groups and `row_count=product_count*2`. UPDATE/DELETE/TRUNCATE are prohibited for artifacts. Parent payload immutability is enforced on UPDATE by the function last replaced in 031; do not claim identical parent DELETE/TRUNCATE protection to 033's artifacts.

### 2.2 Price-export boundary

`price-export.service.js` stays outside template configuration. Selection is exposed, non-excluded products with `confirmed_revision<revision`, no SKU range and no normal cursor. Product changes coalesce into one revision row; pending requests do not change it. Creation locks products by ID, then revision rows by ID, reselects eligible rows, stores current final UAH with immutable captured revision evidence, and audits once. CSV is exactly `sku,price`. Key retry returns the stored price snapshot.

Normal generation sets `has_product_snapshot=true`, because a generated file may expose a SKU. It captures only a previously unexposed positive revision for initial confirmation; newly inserted revision-zero exposure has no pending evidence. Normal re-export after exposure does not consume later price revisions. Dedicated confirmation locks its own snapshot then revisions and uses GREATEST. Exclusion suppresses both streams without erasing pending revisions. Publication/activation must neither queue old products nor change exposure, confirmed revisions, or either high water.

The current client price action calls create, download, then the explicit price-confirm API in sequence. The download endpoint itself does not confirm. Leave that price UI behavior untouched; the full-product UI retains a separate acceptance action. Check Data/import success is not inferred by either server confirmation.

## 3. Complete current mapping inventory

Appendix A gives **every header in exact order** for every group. Appendix B gives **every semantic attribute mapping and all literal lookup values**, including the unusual `SV` answer key `"2"`. Appendix C gives exact naming/SEO constants. Together with this section these are the complete inventory, not examples. All mappings are in `server/src/services/magento-products-v1.js` unless a different path is named.

### 3.1 Common row rules and readiness

Group routing is exact `String(product.category || '')`: BR=Браслети, NM=Намиста, KL=Кулони, CH=Чотки, AR=Картини, SV=Сувеніри. Unsupported groups fail on `attribute_set_code`; no fallback group exists. Each ready product yields **base then EN**, adjacent, in product-ID order within its group. Group construction initially follows first encountered product; stored manifest retrieval sorts by the fixed group list. No empty group files. SV Stone remains in the SV file, with attribute set Камінь; there is no Silver/Stone workflow.

`hasAnswer` means not undefined, not null, and `String(value).trim()!==''`. Numeric and string zero are present. Lookup uses the **untrimmed** `String(answer)` as key (so `' 1 '` is not `'1'`). Values are semantic `value_id`, never `sku_code` or live labels. `optionValue` first requires the question to exist, then applies its live `visible_if_json` using `isRuleMatched`. Hidden yields blank without answer validation. Missing visible answer errors only if `Number(required)===1`. Present unmapped value always errors, including optional questions. Mapped values other than AR.size are not checked against the current options list or archived flag. AR.size must both exist in current question options and have an AR_SIZE mapping; the outer `mapProduct` check can add an error even when its attribute was hidden but a size answer is present. Preserve this edge rather than normalizing it away.

`isRuleMatched` supports equality/membership and `$and`/`$or`, using its legacy Number-based normalization. Malformed string JSON becomes an empty rule and hence visible; nonobject/array roots are treated as visible. This is a current catalog compatibility quirk, not permission for malformed new template rules.

Coverage notation used below/appendices: **U** = six-group unit smoke (asserts selected outputs, not an exhaustive golden); **K** = KL-specific unit; **C** = CH-specific unit; **S** = Stone unit; **I** = `11-magento-products.cases.js`; **E** = `11-exports-schemas.cases.js`; **CSV** = `csv.test.js`. A U or I entry does not imply every dictionary member is already tested. The complete independent golden suite is planned in section 9.

| Output column | Group / rows | Authoritative source, type, transformation, fallback/readiness | Function; coverage |
| --- | --- | --- | --- |
| `sku` | All / base+EN | Stored `products.full_sku`, String(value or empty); no slicing/decoding and no separate mapper nonblank check | `mapProduct`; U, I |
| `store_view_code` | All / base+EN | Constants empty / `en` | `mapProduct`; U, I |
| `name` | All / base+EN | Rules in 3.3 and Appendix C; missing naming map blocks, SV saved subjects take precedence | `rawName`; U, I, manual-name unit |
| `price` | All / base only | `products.total_price_uah`, PostgreSQL NUMERIC(18,2) string, final UAH; finite `Number(x)>0`, then String(number). `2000.00`→`2000`, exact ordinary manual decimals retained. Missing/invalid/zero blocks Magento, including grandfathered zero; no recalculation/fallback | `mapProduct`; U, I, E |
| `categories` | All / base only | Ordered comma-joined paths from 3.4, fixed literals and semantic answers; missing required path mappings block | `categoryPaths`; U partial, I partial |
| `attribute_set_code` | All / base+EN | Fixed group Ukrainian name, except SV `String(souvenir)==='5'`→`Камінь`; identical EN value | `mapProduct`; U, S, I |
| `product_type` | All / base+EN | `simple` | `mapProduct`; U |
| `product_websites` | All / base only | `base` | `mapProduct`; U partial |
| `product_online` | All / base only | `2` (not a boolean) | `mapProduct`; U partial |
| `visibility` | All / base only | `Catalog, Search` (CSV quoted) | `mapProduct`; U partial |
| `qty` | All / base only | `1` | `mapProduct`; U partial |
| `is_in_stock` | All / base only | `1` | `mapProduct`; U partial |
| `old_product` | All / base only | `No` | `mapProduct`; U |
| `is_ownproduction` | All / base only | `Yes` | `mapProduct`; U |
| `short_description` | All / both | Always empty | `mapProduct`, header missing-cell fallback; U partial |
| `description` | All / both | Always empty | Same; U partial |
| `meta_title` | All / both | BR/NM/KL/CH base literals; NM/KL EN literals; AR base by type; SV and all other EN blank | `SEO`, `paintingSeo`; U partial |
| `meta_description` | All / both | BR/NM/KL/CH base literals; NM EN literal; AR base by type (mosaic exception); SV/all other EN blank | Same; U partial |

All remaining columns on EN rows are empty, not inherited in the serialized file. Base rows also serialize any undefined field as empty. Magento's downstream interpretation of sparse EN is outside this repository.

### 3.2 Measurements and category-specific columns

Answer sources below mean stored `products.details.answers[key]`. Free text may encode a measurement but no unit conversion occurs. Do not infer units from a Magento header: e.g. the bracelet header says inches, while code emits stored text unchanged. Actual live catalog labels/units have not been checked. Product weight is the application's grams; SV uses its answer weight (business grams implied by fraction bands), independently of `products.weight`.

| Output column | Group / rows | Source and full transform/fallback/readiness | Function; coverage |
| --- | --- | --- | --- |
| `decor_weight` | BR,NM,KL / base | `products.weight` NUMERIC(14,3); finite positive Number→String; missing/nonpositive invalid | `numericWeight`; U, I partial |
| `decor_weight` | SV / base | Answer `weight`, not product weight; same conversion and requirement. Stored comma decimals are not accepted by Number here | `numericWeight`; I |
| `dovzhyna_brasletu_diuimiv` | BR / base | `braclet_size`, present→trimmed String; missing blocks; no numeric/unit validation | `requiredText`; U, I |
| `dovzhyna_namysta_tochna` | NM / base | `neckle_size`, required trimmed String; no decimal normalization | `requiredText`; U |
| `dovzhyna_namysta` | NM / base | Same trimmed length: replace first comma with dot for Number classification. Nonfinite parse returns original text with **no error**. Numeric ranges: [19,35] Колар (30-35 см); (35,42] Чокер (35-40 см); [43,49] Принцеса (43-48 см); [50,65] Матіне (50-63 см); [66,91] Опера (66-91 см); [92,180] Роуп (120-180 см). Gaps/outside block. Empty produces empty, with missing error on exact length | `necklaceBand`; U only happy path |
| `rozmir_iuvelirnoho_vyrobu` | KL / base | First present `pedant_size`, otherwise `exact_size`; trimmed String; both absent→empty without error. Null/blank count as absent. No validation of dimension syntax, no guess from SKU | `hasAnswer`, `requiredText`; K |
| `dovzhyna_namystyny` | CH / base | Required `bead_length`, trim String, unsigned decimal grammar digits with optional single comma/dot fraction, finite Number check; replace comma by dot, retain leading/trailing digits (e.g. `015,80`→`015.80`); zero accepted | `requiredText`, `magentoDecimal`; C |
| `diametr_namystyny` | CH / base | Required `bead_width`, identical numeric rule | Same; C |
| `dovzhyna_vyrobu` | CH / base | Required `rosary_length`, identical numeric rule | Same; C |
| `vaha_vyrobu` | CH / base | Positive `products.weight` as above | `numericWeight`; U, I |
| `rozmir_kameniu` | CH / base | Join trimmed **pre-normalization** `bead_length` and `bead_width` with `×` if both nonempty. Keeps comma/dot spelling; invalid component separately blocks its numeric column | `mapProduct`; C |
| `rozmir_suveniriv` | SV / base | Required trimmed `size` text; no dimensional parser | `requiredText`; I |
| `fraction` | SV / base | Only souvenir 5 with valid decor_weight. Strict upper thresholds 2,5,10,20,50,100,200,300,500,1000 grams yield `0-2`,`2-5`,`5-10`,`10-20`,`20-50`,`50-100`,`100-200`,`200-300`,`300-500`,`500-1000`; >=1000→`1000+`. Threshold itself belongs to next band. Other SV empty | `fraction`; I covers 25→20-50 |

Every option-based output is enumerated in Appendix B. Special base override: AR `sklo` becomes `Без скла` if glass is absent by `hasAnswer`, even after optionValue has run; an already-recorded missing-question/required error is not cleared. Unknown present glass (including zero) does not get that fallback. `rozmir_kartyny` uses multiplication sign `×`, not ASCII x.

### 3.3 Names and SEO

BR/NM/KL/CH require raw_type 1 or 2 even if the attribute is hidden: UA is `{Браслет|Намисто|Кулон|Чотки} з {натурального|формованого} бурштину. Арт: {sku}`; EN is `{Natural|Pressed} amber {bracelet|necklace|pendant|rosary}. Art: {sku}`. Unknown raw type adds a name error. AR uses the exact type→UA/EN pairs in Appendix C and appends `. Арт: {sku}` / `. Art: {sku}`; unknown type errors.

SV: trim manual subjects only if their product fields are strings. If both are nonblank, use `{subjectUa} з бурштину. Арт: {sku}` and `Amber {subjectEn}. Art: {sku}`. Otherwise **only souvenir=6** auto-names `Брелок з бурштину. Арт: {sku}` / `Amber key chain. Art: {sku}`. Every other SV has `manual_name_required`, even when bird, plant, game, etc. is concrete. No translator is called by export. Partial manual pairs cannot normally be stored because 034 enforces paired nonblank strings of length 1–200, but the pure mapper falls back to automatic naming if a malformed input has only one subject.

Appendix C is the literal SEO contract. BR and CH UA titles deliberately contain two spaces before `|`. AR uses type-specific title and description subjects, with a distinct complete mosaic description. Unknown AR type gives blank SEO but already fails name/type. SV SEO is blank. There is no `url_key` header or generator.

### 3.4 Exact category path construction

Paths are joined with a comma **without extra spaces**, then escaped as a CSV field. `base=Default/{group Ukrainian name}`. Optional path entries are removed when empty, retaining order. Labels here are template constants, never live option labels.

* BR/NM: base; `{base}/{noun} з {material} бурштину`; `{base}/{noun} з {surface} намистинами`; `{base}/{noun} з {texture} фактурою намистин`; `{base}/{noun} {color} кольору`; `{base}/{noun} з намистинами: {shape}`; `{base}/{style}`; for NM extra=1 only, `{base}/Намиста з підвісками`.
* KL: base; `{base}/Кулони з {material} бурштину`; `{base}/Кулони з {surface} поверхнею`; `{base}/Кулони з {texture} фактурою`; `{base}/Кулони {color} кольору`; `{base}/{shape}`; if `hasAnswer(addit)`, `{base}/З інклюзом`. That last presence test is independent of question visibility; hidden present zero still adds the path.
* CH: base; `{base}/Чотки з {material} бурштину`; `{base}/Чотки з {texture} намистинами`; `{base}/Чотки {color} кольору`; `{base}/Чотки з намистинами у формі {shape}`; `{base}/{religion} чотки`; `{base}/Чотки на {count} намистин`. Missing mapped texture/color/shape/religion/count blocks categories; count `?` also blocks and omits its last path. CH texture 8 maps to an attribute but has **no category-path mapping**.
* AR: base; `{base}/{mapped kartynyy}`. There is no extra categories-specific error for an empty kartynyy; e.g. hidden type can leave a trailing slash, while other checks may still fail.
* SV souvenir=5: `Default/Камінь`; `Default/Камінь/{mapped suveniry}`; if nonblank mapped processing, `Default/Камінь/{mapped kamin_obrobka}`.
* Other SV: base; `{base}/{mapped suveniry}`; if nonblank mapped statuette, `{base}/{mapped suveniry}/{mapped vyd_statuetky}`; if nonblank mapped game, `{base}/{mapped suveniry}/{mapped nastlni_ihry}`. No separate category error when those mapped parents are blank.

Category-only dictionaries (attribute dictionaries are separately in Appendix B):

| Input | Exact path values |
| --- | --- |
| raw_type all four jewelry groups | 1=`цільного каменю`, 2=`формованого`; unknown emits categories error |
| BR/NM processing | 1=`полірованими`, 2=`шліфованими` |
| KL processing | 1=`полірованою`, 2=`шліфованою` |
| BR/NM texture | 1,4=`прозорою`; 2,5=`напівпрозорою`; 3,6=`матовою`; 7=`пейзажною`; 8=`змішаною` |
| KL texture | Same 1–7 as BR/NM, no 8 |
| CH texture | 1,4=`прозорими`; 2,5=`напівпрозорими`; 3,6=`матовими`; 7=`пейзажними` |
| BR/NM color | 1=`світлого`, 2=`темного`, 3=`пейзажного`, 4=`комбінованого` |
| KL color | 1=`світлого`, 2=`темного` |
| CH color | 1=`світлого`, 2=`темного`, 3=`пейзажного` |
| BR/NM shape | 1=`кулі`, 2=`бочки`, 3=`оливки`, 4=`сегменти`, 5=`галька`, 6=`геометрія`; 7=`змішана форма` BR / `змішані форми` NM |
| CH shape | 1=`кулі`, 2=`бочки`, 3=`оливки` |
| KL type | 1=`Природна форма кулона`, 2=`Форма: коло`, 3=`Форма: овал`, 4=`Форма: серце`, 5=`Форма: крапля`, 6=`Форма: хрест` |
| BR/NM style | 1=`Класичні браслети` / `Класичні намиста`; BR 5=`Шамбала`; otherwise `Комбіновані браслети` / `Комбіновані намиста`. An invalid visible attribute separately fails; hidden unknown style can reach this default |
| CH religion/count | Same literals as V.chReligion and V.chCount; count 9=`?` is a category error |

### 3.5 CSV bytes

`buildCsv` / `escapeCsvValue` in `server/src/utils/csv.js` supply UTF-8 text without BOM, comma separators, LF row separators and **no trailing newline**. Empty/null/undefined cell is an empty field, not `null`. Quote only fields containing comma, double quote, CR or LF; double embedded quotes. Embedded CR/LF remains inside the quoted cell. The HTTP route declares `text/csv; charset=utf-8`; the browser Blob adds no BOM.

Formula protection applies to **strings** matching `/^[\t\r ]*[=+\-@]/`: prepend apostrophe before CSV quoting. Leading LF or arbitrary Unicode whitespace is not matched; do not describe protection more broadly than implemented. A numeric `-12.5` is not neutralized, but a string `'-12.5'` is. Every Magento numeric output currently becomes a string. Quoting, exact blanks, decimal spelling and formula neutralization belong to the fixed serializer contract, not editable controls. File name is `amber-magento-{group}-magento-products-v1.csv`.

### 3.6 Handoff reconciliation and known gaps

| Handoff claim | Repository finding |
| --- | --- |
| Six groups; SV 5 Камінь, other SV Сувеніри; no Silver/Stone workflow | Verified in GROUPS, routing, attributes and tests |
| No/Yes flags; simple on both rows; same EN set | Verified in mapper and unit assertions |
| KL pedant_size then absent-only exact_size, no SKU guessing | Verified. “Absent” includes null and whitespace-only. Dimensions are not parsed/validated |
| CH comma/dot normalization and invalid-present failure; stone-size unchanged | Verified in mapper and dedicated unit assertions |
| SV semantic naming when concrete | **Narrower in code:** automatic semantic name only for key chain (souvenir 6); all other SV require manual subjects. Do not expand names silently during parity |
| No translation dependency; URL key deferred | Verified; no URL key column, exporter uses saved subjects |
| 40 fixtures, six Check Data files valid, not an import | Recorded in `docs/EXPORTS.md`, but fixture artifacts/report are local-only and were not inspected or re-executed. Historical operator acceptance, not independently reproduced Phase 0 evidence |

Other compatibility gaps: current requiredness/visibility comes from mutable live catalog, not historical schema; live duplicate question keys use first question metadata and accumulate options; seed/catalog cannot certify deployed values; valid live AR.size outside the fixed 1–28 dictionary fails. Product SKU-schema ID is not currently projected by the export query. `product-information.service.js` permits KL `exact_size` but not `pedant_size`, so an existing nonblank pedant_size can shadow edits to the old field. This is an operator-resolution limitation, not authorization to change that workflow. No current complete golden inventory covers all mappings. Parent key normalization is narrower than “same represented interval.” These facts must be visible in acceptance.

## 4. Recommended architecture and source stability

Keep `export.service.js` as coordinator. Add a small `server/src/services/export-templates/` area in later PRs:

| Proposed module | Responsibility / actual seam |
| --- | --- |
| `input-projection.js` | Explicit product/answer/schema provenance projection from `getExportRows` under the caller's transaction; no prices recalculated, no SKU parsing |
| `definition.js` | Validate bounded JSON schema, source registry, references, compatible evaluator version, types and operation limits; compile immutable definitions to a bounded execution plan |
| `evaluate.js` | Pure `evaluateProduct(compiled, projection)` / `evaluateBatch` returning rows and diagnostics; no pool, network, clock or random access |
| `magento-v1-definition.js` | Seedable baseline declarative definition containing ordinary maps, category grammar, names, SEO, thresholds and columns; this is data, not another whole mapper |
| `template.service.js` | Draft/version/activation APIs with concurrency and transactional audit |
| `snapshot-binding.js` | Request identity, selection resolution, preview fingerprint and snapshot provenance; called from existing coordinator |

Reuse `buildCsv` exactly, current range/exclusion selection, actor/audit helpers, artifact writer and confirmation services. Reuse safe normalization/hash helpers after characterizing them; do not delegate evaluation to `mapProduct`, `rawName`, `categoryPaths` or the entire old mapper. The old pure mapper is the differential oracle while independent expected fixtures supply a second oracle. Nothing new wraps price-export evaluation.

Choose **one template with six output-group profiles**, two row profiles each, one ordered column list per group, shared definitions expanded/validated at publication. Profiles differ by group/attribute set; they are not separately published. Fixed v1 capabilities require all six routes and base/EN rows, unique nonempty columns, no product filter, and error on unknown group. Stone routing is an attribute-set/category condition within SV. Header reorder/mapping changes are configuration, but v1 publication validates the approved Magento header/required-identity contract; initial release must preserve all audited headers exactly.

### 4.1 Approved input projection

Expose exact allowlisted product fields: `id` (positive ID), `full_sku` (text), `category` (group code), `weight` (stored numeric string, grams), `total_price_uah` (stored final numeric string, UAH), `magento_name_subject_ua`, `magento_name_subject_en` (nullable text), `sku_schema_version_id` (nullable historical ID, newly selected by future query). Keep selection flags/IDs outside template control. No arbitrary `product[path]` or JSON traversal.

Answers are addressed through a **declared source descriptor**, not an unchecked property name. Each descriptor has category, immutable storage key as captured, kind (`semantic` or `information`), expected input type, provenance contract, and optional schema-specific key aliases. Semantic answers are stored value IDs; numeric 1/string `"1"` may map identically by explicitly selected `semanticKey` conversion, never by label or SKU code. Informational answers are the current stored fields of that particular product. The baseline keeps existing `details.answers` values authoritative, including historical placeholders; it does not run new-product validation or “fix” values during export.

Historical SKU-schema ownership and recorded answer provenance are separate from today's informational question metadata. Pin export required/visibility rules and approved mapping constants inside publication. Historical schema IDs/options can document the source and disambiguate genuine zero; they must not be used to reinterpret raw stored values into a different accepted export. A raw placeholder zero remains present to the parity evaluator exactly as today: it may be hidden/blank, explicitly mapped (NM.extra=0, CH.count=0, SV.stone_processing=0), or an unmapped error. Calibration 0/1/2 is preserved distinctly; legacy CH 3 is not exported or independently rejected. No export “zero means absent” global rule.

There are **no necessary Magento-specific computed sources** for v1. Names, categories, fractions, measurement bands and SEO are ordinary configurable maps/conditions/interpolation. The only optional computed fact allowed is `answerProvenance` (historical schema identity and evidenced placeholder/genuine-zero classification), implemented by the authoritative projection for diagnostic display, **not to change baseline cell values/readiness**. Do not expose calculated/automatic/manual prices as alternative `price` sources in v1; `total_price_uah` is the single approved final-price source. If those other fields are ever exposed, their units/meanings require distinct registry entries, not a generic “price” selector.

### 4.2 Catalog dependency policy — concrete recommendation

Publish a **self-contained contract**: copy the needed question existence, required flags, visibility rule structure, AR.size allowed IDs, all literals and mappings into the version's JSON; validate and hash them. Do not reference live label dictionaries, mutable shared lookups, or mutable visibility settings during evaluation. This preserves the meaning of a published definition when catalog labels, archives or settings change. Labels remain optional editor hints, never output sources. Archived semantic options remain mapped by their historical IDs.

For the first baseline candidate, capture the *verified target catalog contract* read-only and compare old/new exporters against exactly that same contract. The seed and artificial unit catalog are insufficient evidence of the deployed required/visibility rules. A future controlled read-only target-catalog review is an acceptance prerequisite, not a reason to connect to the useful local DB now. Frozen rules matching the captured catalog yield byte/readiness parity at that baseline. Future live visibility/requiredness edits intentionally no longer rewrite published export semantics; they require a new template version. This is an explicit compatibility boundary requiring business acknowledgment before activation, not a claim of universal parity across arbitrary future catalog edits.

Reference stability has a real repository limitation: `catalog/question-commands.js:updateQuestion` can rename a key; `question-key-references.js:rewriteQuestionKeyReferences` rewrites **stored product answer keys** and rules but does not rewrite immutable historical SKU-schema keys. A stable live question ID alone cannot identify which storage key exists across such history. Do not hide this behind label lookup. Recommended v1 behavior: a published source pins a storage key; at publication validate known historical schemas and declared aliases; changed keys with no approved alias fail `SOURCE_REFERENCE_UNRESOLVED`/missing-data readiness, never guess from current labels or SKU. An explicit, immutable schema-scoped alias in a new version can accept verified equivalent keys; if both aliases occur with unequal values, fail `SOURCE_REFERENCE_AMBIGUOUS`. For non-SKU answers without schema-key history, aliases need explicit operator-reviewed lineage evidence. Catalog rename does not mutate an old template. A durable cross-schema semantic-question identity is a separate future catalog project, not a hidden prerequisite implementation here.

Malformed legacy visibility rules and duplicate question-key catalogs can be characterized by the old engine, but **new publication rejects** them with template diagnostics instead of adopting permissive parsing. This is a declared activation blocker if encountered in the selected catalog; no catalog repair is part of this feature.

## 5. Declarative representation and evaluation

Use JSON `formatVersion:1`, `evaluatorVersion:"magento-declarative-1"`, `outputContract:"magento-products-v1"`, a source registry, literal tables, captured `questionContracts`, ordered `bindings`, six `groups`, each with `columns` and ordered `rows`. A cell is a literal or a typed node; bindings only reference earlier bindings. Bindings are evaluated lazily and memoized: unused/hidden branches emit no product diagnostics, although all branches are statically validated. Row overrides inherit shared bindings, never inferred nonblank cells from another row. Unspecified EN columns serialize empty by the explicit row default.

Value states are tagged internally: **missing** (key absent), **null**, **blank** (empty/whitespace string under the requested presence rule), **present valid**, **present invalid**. Numeric/string zero are present; booleans are a separate type. Source descriptors retain the raw value and origin for diagnostics. Never use `x || fallback` or Boolean for semantic fields. JSON objects/arrays are not acceptable v1 answer values: flag invalid input rather than serializing `[object Object]`. The old mapper's JavaScript coercion of malformed values is recorded as a negative-case discrepancy, not an approved data contract.

Operations (complete v1 set; no arbitrary expression syntax):

| Operation | Typed contract | Missing / invalid / failure behavior |
| --- | --- | --- |
| `literal` | JSON scalar→same scalar; empty string allowed | Immutable data; object-valued constants only in declared tables |
| `source` | Declared product/answer ID→tagged scalar | Unknown registry ID is invalid template; absent answer stays missing |
| `ref` | Earlier named binding→its type | Unknown/forward/cyclic reference rejected at publication |
| `text` | Stored string/number/boolean→String, optional trim | Legacy scalar conversion selected explicitly for audited text fields; missing/null→empty only with `onAbsent:"empty"`; no object/array coercion |
| `present` | Tagged scalar→boolean | Explicit `answer-v1` test treats missing/null/trim-blank as false, zero and false as present; no parsing |
| `semanticKey` | String or finite number→untrimmed string | Missing propagates; boolean/composite invalid. Does not parse `sku_code` or normalize whitespace |
| `lookup` | Semantic key + inline named immutable table→declared scalar type | Missing policy explicit (empty/error); unmapped present value errors. A deliberately declared `onUnmapped` literal is allowed only for audited optional/default branches, never a required mapping |
| `firstPresent` | Ordered equal-type sources→first present by specified absence policy | Does not swallow an invalid present value. KL uses missing/null/trim-blank only; present malformed dimension *text* is still text because old exporter has no dimension grammar |
| `when` | Typed predicate + then/else→one common result type | Lazy branch evaluation; errors in selected branch propagate; both branches statically validated |
| Predicates `eq`, `in`, `all`, `any`, `not` | Scalars/membership/boolean lists→boolean | Strict types after explicit semanticKey; missing does not equal any literal, null equals only explicit null, invalid operands propagate errors. `all`/`any` short-circuit in listed order. No arithmetic or arbitrary access. Imported catalog visibility uses a separately versioned `catalogRule` predicate retaining `isRuleMatched` scalar normalization for valid captured rules only |
| `questionValue` | Declared captured question contract + typed cell expression→scalar | Require question descriptor, check captured visibility, then presence/requiredness; evaluate present mapping only when visible. This is generic gating, not a Magento field mapper. AR post-check declared separately |
| `numberText` | Scalar→numeric text, format `js-number-positive-v1` | Exact finite Number>0→String behavior for stored price/weight; invalid/nonpositive error, no fallback. Compatibility accepts scalar Number coercion (e.g. stored numeric hex text); not a reusable strict decimal parser |
| `decimalText` | Trimmed text→text, format `unsigned-comma-dot-v1` | Exact CH digits/[.,] grammar plus finite check; comma→dot, preserve zeros; empty policy explicit; invalid-present error |
| `numericBand` | Scalar/text + declared parse format, ordered bounded intervals→text | Immutable inclusive/exclusive limits, required explicit outside policy. SV uses validated positive weight; NM uses finite Number after first-comma replacement, `onInvalid:"input"` to reproduce its **specific existing** nonnumeric-text passthrough and `onOutside:"error"` for numeric gaps |
| `interpolate` | Literal string with named typed slots→string | Slots reference nodes only; fixed `{slot}` substitution, no evaluation/format directives. Blank slots allowed only when specified (AR/SV path compatibility); errors cannot be interpolated |
| `join` | Fixed bounded list of text nodes + literal delimiter→text | `omitEmpty:true` drops only empty/missing entries explicitly permitted by child; never drops errors; no product iteration |
| `require` / `error` | Assert predicate or emit diagnostic, attached to cell/binding | Stable code, field/source metadata; required constraints cannot be disabled in the approved output contract |

Every formatting enum is closed. Unknown operation/format, wrong type, invalid reference, duplicate output column, unknown group, or missing base/EN identity columns is `TEMPLATE_INVALID`, not product-not-ready. `numericBand.onInvalid=input` is confined to the named NM compatibility rule; defaults elsewhere are failure. `numberText` matches legacy Number behavior, including its finite/safe-precision limits; this task does not improve financial representation. New strictness on malformed composites/booleans for semantic IDs is explicitly tested as invalid input, not quietly called parity.

Configure all tables in Appendices B/C, category phrase tables and interpolation, category conditional entries, manual-name precedence, AR glass override, NM and SV intervals, CH raw size binding, common literals and columns in JSON. No audited legitimate mapping needs a new hardcoded domain mapper. Present implementation quirks (AR hidden-size postcheck, CH count `?`, hidden KL addit presence, NM invalid text passthrough) use explicit conditions/requirements. Known malformed catalog input is publication-blocking as above; it is the declared representational boundary, not an unspecified extension.

Bounds: maximum 256 KiB UTF-8 definition, six group profiles/two row profiles, 64 columns/group, 256 declared sources, 512 bindings, 8 node nesting levels, 16 predicate branches/list children per node, 512 entries/table and 4096 total table entries, 4096 characters/literal, 20,000 evaluated nodes/product, 16 KiB/cell and 64 MiB generated CSV/request. Validate before compile; count work including repeated references (memoize bindings), stop with an explicit limit error and roll back the entire snapshot, never truncate products or cells. Definition table strings have exact case/Unicode; only JSON key ordering is canonicalized for hashing. Large valid batches can use explicitly smaller existing manual ranges; do not add a new cursor. Measure limits against synthetic maximum-range fixtures before activation.

### 5.1 Valid JSON examples (partial fragments, not publishable six-group definitions)

This first fragment shows common base/EN bindings and the KL fallback. Source IDs are local names whose descriptors use the **verified repository fields**. Shared declarations are expanded before immutable publication; no runtime mutable includes.

```json
{
  "formatVersion": 1,
  "evaluatorVersion": "magento-declarative-1",
  "outputContract": "magento-products-v1",
  "sources": {
    "sku": {"kind": "product", "field": "full_sku", "type": "text"},
    "price": {"kind": "product", "field": "total_price_uah", "type": "numeric"},
    "klCurrent": {"kind": "information", "category": "KL", "key": "pedant_size", "type": "text"},
    "klLegacy": {"kind": "information", "category": "KL", "key": "exact_size", "type": "text"}
  },
  "bindings": [
    {"id": "sku", "value": {"op": "source", "id": "sku"}},
    {"id": "attributeSet", "value": {"op": "literal", "value": "Кулони"}},
    {"id": "dimensions", "value": {
      "op": "text", "trim": true, "onAbsent": "empty",
      "input": {"op": "firstPresent", "absence": "answer-v1", "inputs": [
        {"op": "source", "id": "klCurrent"},
        {"op": "source", "id": "klLegacy"}
      ]}
    }}
  ],
  "groups": [{
    "code": "KL",
    "columns": ["sku", "store_view_code", "price", "attribute_set_code", "product_type", "rozmir_iuvelirnoho_vyrobu"],
    "rows": [
      {"id": "base", "default": "", "cells": {
        "sku": {"op": "ref", "id": "sku"},
        "store_view_code": {"op": "literal", "value": ""},
        "price": {"op": "numberText", "format": "js-number-positive-v1", "input": {"op": "source", "id": "price"}},
        "attribute_set_code": {"op": "ref", "id": "attributeSet"},
        "product_type": {"op": "literal", "value": "simple"},
        "rozmir_iuvelirnoho_vyrobu": {"op": "ref", "id": "dimensions"}
      }},
      {"id": "en", "default": "", "cells": {
        "sku": {"op": "ref", "id": "sku"},
        "store_view_code": {"op": "literal", "value": "en"},
        "attribute_set_code": {"op": "ref", "id": "attributeSet"},
        "product_type": {"op": "literal", "value": "simple"}
      }}
    ]
  }]
}
```

The following separate partial SV binding fragment shows routing and **current**, deliberately narrow naming. Complete base and EN cells interpolate the two subject bindings with the exact suffix/prefix rules in 3.3; categories use the same attributeSet condition plus the mapped attribute paths in 3.4. Both subject bindings use the **same pair-presence predicate**, preventing mixed automatic/manual pairs.

```json
{
  "sources": {
    "souvenir": {"kind": "semantic", "category": "SV", "key": "souvenir", "type": "value_id"},
    "manualUa": {"kind": "product", "field": "magento_name_subject_ua", "type": "text"},
    "manualEn": {"kind": "product", "field": "magento_name_subject_en", "type": "text"}
  },
  "bindings": [
    {"id": "souvenir", "value": {"op": "semanticKey", "input": {"op": "source", "id": "souvenir"}}},
    {"id": "attributeSet", "value": {"op": "when",
      "if": {"op": "eq", "left": {"op": "ref", "id": "souvenir"}, "right": {"op": "literal", "value": "5"}},
      "then": {"op": "literal", "value": "Камінь"},
      "else": {"op": "literal", "value": "Сувеніри"}}},
    {"id": "hasManualPair", "value": {"op": "all", "items": [
      {"op": "present", "policy": "answer-v1", "input": {"op": "source", "id": "manualUa"}},
      {"op": "present", "policy": "answer-v1", "input": {"op": "source", "id": "manualEn"}}
    ]}},
    {"id": "subjectUa", "value": {"op": "when", "if": {"op": "ref", "id": "hasManualPair"},
      "then": {"op": "text", "trim": true, "input": {"op": "source", "id": "manualUa"}},
      "else": {"op": "when",
        "if": {"op": "eq", "left": {"op": "ref", "id": "souvenir"}, "right": {"op": "literal", "value": "6"}},
        "then": {"op": "literal", "value": "Брелок"},
        "else": {"op": "error", "code": "manual_name_required", "field": "name"}}}},
    {"id": "subjectEn", "value": {"op": "when", "if": {"op": "ref", "id": "hasManualPair"},
      "then": {"op": "text", "trim": true, "input": {"op": "source", "id": "manualEn"}},
      "else": {"op": "when",
        "if": {"op": "eq", "left": {"op": "ref", "id": "souvenir"}, "right": {"op": "literal", "value": "6"}},
        "then": {"op": "literal", "value": "key chain"},
        "else": {"op": "error", "code": "manual_name_required", "field": "name"}}}}
  ]
}
```

The fragments intentionally omit most columns, captured question contracts, other groups and names; full-definition validation would reject them as incomplete. They demonstrate valid JSON and the exact proposed node shapes, not a claim that a partial definition can be published.

A third **partial synthetic fixture fragment** specifies the ordinary attribute gate/lookup shape. Its required/visibility values are illustrative test inputs, not claims about the user's live catalog. In the real baseline version these values must be captured and approved from the target contract. Contract rule dependencies refer only to declared answer sources; compiler validation rejects unresolved keys. Missing source-question metadata during baseline capture is a contract-validation error and blocks publication; the legacy comparator still records its current `QUESTION_MISSING` readiness outcome. That intentional template-versus-product diagnostic distinction must be reported, not suppressed.

```json
{
  "sources": {
    "svSouvenir": {"kind": "semantic", "category": "SV", "key": "souvenir", "type": "value_id"},
    "svProcessing": {"kind": "semantic", "category": "SV", "key": "stone_processing", "type": "value_id"}
  },
  "questionContracts": {
    "svProcessing": {
      "category": "SV",
      "key": "stone_processing",
      "required": true,
      "visible": {"op": "catalogRule", "format": "catalog-rule-v1", "rule": {"souvenir": 5}},
      "ruleSources": {"souvenir": "svSouvenir"}
    }
  },
  "tables": {
    "stoneProcessing": {"0": "Необроблений", "1": "Полірований"}
  },
  "bindings": [{
    "id": "stoneProcessing",
    "value": {
      "op": "questionValue",
      "contract": "svProcessing",
      "source": "svProcessing",
      "field": "kamin_obrobka",
      "value": {
        "op": "lookup",
        "table": "stoneProcessing",
        "onAbsent": "error",
        "onUnmapped": "error",
        "input": {"op": "semanticKey", "input": {"op": "source", "id": "svProcessing"}}
      }
    }
  }]
}
```

### 5.2 Shared evaluation/readiness result

`validateDefinition` returns template diagnostics with JSON path, code and expected type. `evaluateBatch` takes a validated compiled version and authoritative projections; returns ordered represented IDs/group assignments, rows/artifacts and product diagnostics. Invalid template is `422 TEMPLATE_INVALID` (or unsupported evaluator code); valid template with bad product is `422 MAGENTO_NOT_READY` at snapshot create. Preview returns ordinary readiness results without durable export effects. Unexpected internal failure/limit breach cannot produce partial artifacts.

Product diagnostic shape (proposed):

```json
{
  "productId": 42,
  "sku": "CH-EXAMPLE",
  "group": "CH",
  "row": "base",
  "storeViewCode": "",
  "column": "diametr_namystyny",
  "source": {"kind": "information", "category": "CH", "key": "bead_width"},
  "code": "INVALID_DECIMAL",
  "message": "Некоректне числове значення для Magento.",
  "resolution": "product_information"
}
```

Other stable codes: `QUESTION_MISSING`, `REQUIRED_VALUE_MISSING`, `UNMAPPED_VALUE`, `UNKNOWN_OPTION_VALUE`, `NONPOSITIVE_FINAL_PRICE`, `NONPOSITIVE_WEIGHT`, `NUMERIC_BAND_UNMAPPED`, `UNSUPPORTED_GROUP`, source reference codes above, and the existing lowercase `manual_name_required`. A shared name failure can apply to both rows; retain a `rows` list internally, deduplicate the legacy field presentation per product. Preserve deterministic product/field diagnostic ordering and field meaning; added machine codes are deliberate metadata additions.

Adapt diagnostics to existing `{productId,sku,group,fields:[{field,code,message}]}` response shape as well as the richer detail. Preserve `ExportTools.jsx:FIELD_LABELS/getIssueLabel`, including “Потрібно вказати назву”, “Відсутня вага”, “Відсутня ціна”, “Не визначено категорію Magento”, expandable problem lists, and the existing manual-name action. Do not turn a missing-weight error into permission to fill weight. Resolution links obey existing product permissions and leave changes to authoritative product workflows. Evaluate never mutates products, selects options, calls translators, saves names, or recalculates price.

## 6. Persistence, publication, permissions and API proposals

### 6.1 Proposed entities and constraints

| Entity | Fields / relations / invariant |
| --- | --- |
| `export_templates` | UUID text ID; permanent unique key, display name, created actor/time; one logical product-template family, no hard delete |
| `export_template_drafts` | PK/FK template ID; nullable base published-version FK; JSONB definition; bigint `revision>0`; modified actor/time; one working draft/template; optimistic revision compare |
| `export_template_versions` | UUID text ID; template FK RESTRICT; monotonic per-template version number with UNIQUE(template_id,version); source draft revision; definition JSONB; canonical SHA-256; format/evaluator/output-contract identifiers; published actor FK RESTRICT/time; UNIQUE(template_id,source_draft_revision) to prevent duplicate publish retries |
| `export_template_activation` | Singleton product-export scope; generation counter; implementation enum `legacy`/`template`; nullable active version FK; changed actor/time. Check implementation/version pairing. Selection is separate from immutable definitions |
| `export_snapshots` additions | Nullable `template_version_id` FK RESTRICT, `template_definition_hash`, evaluator identifier, `request_contract` enum, requested-selection intent JSON, immutable preview/input fingerprint. New template rows require all provenance fields; old rows retain NULL template attribution |

Definition contains its own lookup constants, question contracts and aliases; no editable shared table is dereferenced by a published version. Canonical hash sorts JSON object keys, retains array order, exact strings and numeric representation policy; define that canonicalization in `definition.js` and test it. Bind compiled cache by `(definitionHash,evaluatorVersion)` only. Updating an evaluator implementation under the same identifier may not change semantics; use a new identifier/version for output-changing behavior. Unsupported versions cannot be activated/evaluated, but their existing stored artifacts remain downloadable.

DB triggers reject UPDATE/DELETE/TRUNCATE of published versions, including all JSON/constants/provenance. Protect new parent binding fields in a **forward replacement** of the existing payload trigger, retaining every older check; old parent rows cannot be “attributed” later. FK RESTRICT prevents deletion of referenced versions/templates; retain even unreferenced published versions for audit. Use a unique referenced tuple `(id,definition_hash,evaluator_version)` on versions and a composite parent FK so a snapshot cannot claim a hash/evaluator different from its version. Request-contract shape checks require the complete tuple for template-v1 and null template provenance for legacy rows. Validate explicit template ownership through the version's template FK. Activation alone is mutable. Draft updates use `WHERE revision=expectedRevision`, increment on real change, 409 `TEMPLATE_DRAFT_CONFLICT`; no last-write-wins. Publication locks parent/draft, revalidates the complete definition, source contracts and expected revision/hash, allocates the next number under that lock, inserts one version and audit event atomically. Publication does not activate. Duplicate same-revision publication returns the original version without another event; different expected hash conflicts. Clone-to-draft from a published version creates a new editable revision, never edits publication.

Use `createMutationContext`, `getRequestMutationContext`, `writeAuditEvent`; actor is `application_users.id`, not OIDC identity. Events: `export_template.created`, `export_template.draft_updated`, `export_template.published`, `export_template.activated` (including rollback selection). Details carry template/version IDs, hashes and draft/activation revision changes, not full product input data. Success/audit share the same transaction; failures/no-ops have no success event. Extend `audit-viewer.service.js`'s detail allowlist/presentation deliberately so these fields remain visible. Publication/activation should use `runAccessAdminMutation` / its shared access advisory lock and actor recheck pattern from `access-admin-transaction.js` before template locks, keeping access revocation serialized. Draft writes can use the same small admin transaction boundary. No new independent audit commit.

### 6.2 Capabilities and endpoint surface

Current routes check `exports.view` for status/preview/download and `exports.create` for creation/confirmation, behind authentication, active-user and unsafe-method CSRF. Effective keys are loaded each request by `auth/authorization.js`; role names are not authorization. Administrator receives newly inserted permissions through 028's protected permission-catalog behavior. Do **not** grant template capabilities to Manager/Storekeeper or custom roles as an incidental upgrade.

Propose four keys: `export_templates.view` (definitions/source registry), `export_templates.manage` (draft writes/test preview), `export_templates.publish` (publish), `export_templates.activate` (future-route/version selection, including rollback). Initially only Administrator gets these. They need not be made new reserved permissions: an Administrator may later delegate explicitly through existing role management. Ordinary exporters retain `exports.view/create`, use the selected active version, and see only safe version identity in preview/manifests. Choosing a non-active version for a new controlled export requires `export_templates.activate` plus the usual export permission. Retry of an already-created snapshot only needs ordinary export permission and matching identity; it must not require activation permission anew just to retrieve immutable output.

Proposed API/service contracts, all inside existing business authentication/CSRF boundaries:

| Endpoint | Contract |
| --- | --- |
| `GET /api/admin/export-templates` and `/:id` | View families, draft revision, publications/hash/format; view capability |
| `GET /api/admin/export-templates/sources` | Closed registry and safe catalog/schema reference hints, supported transforms, units and limits; no arbitrary product properties |
| `POST /api/admin/export-templates` | Create family/draft; manage capability and mutation context |
| `PUT /api/admin/export-templates/:id/draft` | `{expectedRevision,definition}`; returns revision/hash; manage |
| `POST /api/admin/export-templates/:id/validate` | Read-only validation of specified draft revision/hash; manage |
| `POST /api/admin/export-templates/:id/test-preview` | `{expectedRevision,productIds}` with max 100 IDs; manage + exports.view; authoritative read-only inputs, no snapshot/exposure/cursor. Never accepts browser-authored product facts as authoritative |
| `POST /api/admin/export-templates/:id/publish` | `{expectedRevision,expectedDefinitionHash}`; publish; atomic revalidation/version insertion |
| `PUT /api/admin/export-templates/activation` | `{expectedGeneration,implementation,templateVersionId,reason}`; activate; 409 on stale generation; version/output/evaluator compatibility checked |
| Existing `/api/export/preview` and `/snapshots` | Opt-in `requestContract:"template-v1"`, selection and preview token as section 7; preserve legacy payload handling until activation transition |
| Existing manifest/download/confirm | Add safe nullable provenance fields; download exact existing bytes; confirmation semantics unchanged |

No public raw-JSON editor is required. The future form selects template/group, shows ordered columns, approved source selectors, literal/lookup rows, fallback and condition controls, bounded numeric-band controls, interpolation slot chips, base/EN toggles, validation messages and a read-only test preview. Save draft, publish, and activate are separate actions with visible version/hash and human change summary. Existing ExportTools operator layout/steps remain; show selected version and invalidate preview on selection changes, without mixing template edits with product correction or adding a matrix.

## 7. Snapshot identity, preview and concurrency

### 7.1 Compatible request identity

Keep legacy requests' exact trim/uppercase ordered-anchor/profile behavior, including null upper bound and reversed-endpoint conflict. Add `requestContract:"template-v1"` to opt into stronger binding. Initially legacy/default requests continue using the old mapper. Controlled activation moves the updated UI to the new contract; a legacy caller must not silently become template-aware merely because it omitted a profile. Keep a legacy route/dispatch choice for rollback. Both branches use the **same** parent snapshot/key namespace/cursor.

For template-v1, selection is either `{mode:"active"}` (omitted means this) or `{mode:"explicit",templateId,versionId}`. A template ID without a version is not “latest”; reject it. Preview resolves active selection exactly once and returns requested intent, effective template/version/hash/evaluator, activation generation, normalized requested anchors and mode, represented product IDs/counts, readiness, and an opaque signed preview token. The UI retains this result and one creation idempotency key through transport retries.

Store two identities: **request intent** (contract, profile, ordered normalized requested anchors, mode, active-vs-explicit selection and explicit IDs) and **effective binding** (resolved published version/hash/evaluator and captured input fingerprint). Reversed ranges are still selected by min/max ID but are not equal request intent. Changing from open range to fixed upper bound is a new intent. Legacy snapshot lookups keep legacy semantics; cross-contract key reuse conflicts rather than inventing template provenance.

| Request/retry | Required outcome |
| --- | --- |
| Existing key, same legacy anchors/profile | Original snapshot, even after active implementation changes; no re-evaluation/exposure/audit |
| Existing template-v1 key, same active intent and original token/version evidence | Original snapshot even if active version/generation, products or cursor subsequently change; token expiry does not invalidate completed retries |
| Existing key, same active intent, omitted retry token | Original snapshot. Effective selection is the recorded version, never re-resolve active. This is retrieval of a completed creation, not authority to create without preview |
| Same key, different explicit template/version, anchors, contract or template-v1 mode | 409 `EXPORT_IDEMPOTENCY_CONFLICT`; no create and no wrong snapshot |
| Same active intent/key but supplied preview token binds a different effective version/range/input | 409; caller has refreshed to a different operation and needs a new key |
| Same explicit intent/version and original preview, activation changed | Retry returns original; fresh creation may still use explicitly selected version if authorized |
| Unused key without valid template-v1 preview | Reject `EXPORT_PREVIEW_REQUIRED`; resolve no silent default at create |
| Unused active key with old preview and active version/generation changed | 409 `EXPORT_PREVIEW_STALE`; require explicit refresh, even if new version is byte-equivalent |

Check existing key **before** active selection, preview freshness, and range reloading. Verify any supplied token's signature and its recorded claims, but bypass expiry/current-data freshness for a matching completed operation. SQL concurrent insert losers must roll back first and run the identical stored-intent/effective-evidence comparison on the winner, never compare with whatever version is active now. Two same-intent same-token competitors return one snapshot. Two default previews resolving different versions under the same key are conflicting operations if both supply their different version evidence; neither may silently get the other's files.

Proposed template-v1 creation acquires a transaction advisory lock on a namespaced hash of the idempotency key **before its second existing-key check**, reducing duplicate same-key work. Preserve the unique constraint and loser comparison as defense in depth. A crucial PostgreSQL detail: a repeatable-read transaction can establish its snapshot before waiting for the advisory lock, so its second check may still not see a just-committed winner. Therefore **after rollback on a unique conflict, stale-preview/range failure, or serialization failure, perform a fresh committed key lookup and the same intent/effective-evidence comparison before surfacing that error**. A matching committed winner returns unchanged; mismatching winner returns 409; no winner means return the original failure and allow retry with the retained key. Do not claim the advisory lock refreshes the MVCC snapshot. Legacy creation remains compatible; if it races a template request, the unique-key conflict path still checks the contract. Do not independently commit a “reserved key” row.

### 7.2 Preview fingerprint

Use a server-signed token (HMAC with the existing server secret facility, purpose/version separated; never expose the key), TTL 15 minutes for **new** creations. Bind request intent, effective version/hash/evaluator, active generation when selection is active, new-mode confirmed cursor, ordered selected IDs and their category/SKU/exclusion status, stored final price/weight, entire stored answers, both manual subjects, schema-version link and source-alias/provenance evidence. Bind the captured legacy internal-column catalog projection too because the parent compatibility CSV is still created in the same snapshot. Canonicalize inputs without erasing missing/null/zero differences; no client rows/CSV are trusted.

Product edits, exclusions/archive/recount, represented membership changes, manual names, final price, or a reference-relevant schema change stale preview. In new mode, changed pending min/max/count or cursor also stales it. For an open-ended manual range, a newly eligible ID changes membership; a bounded manual range is unaffected by inserts above its upper anchor. Changed active selection stales **active-selection** preview even if later set back (generation protects ABA). Explicit pinned version preview ignores unrelated activation changes. Draft edits never affect published preview. Current catalog label/rule changes do not affect frozen Magento rules; any changes affecting the retained internal CSV projection do invalidate the shared snapshot fingerprint. Pricing matrices/exchange rates do not invalidate export by themselves: only stored final product state is read, with no calculation/rate calls. Revision/exposure changes caused by another export are not product-value changes and are handled under capture locks, not mistaken for data editing.

The client clears preview after selector/range changes, but server checks remain authoritative. Test preview of a draft binds draft revision/hash and cannot be used to create a durable snapshot. Publishing the draft does not upgrade its preview token; take a published preview.

### 7.3 Transaction boundary and lock order

For template-v1 use one REPEATABLE READ creation transaction, with explicit row locks and serialization-failure handling. A serialization failure returns a stable retry/refresh response after rollback; never partially commit or silently evaluate against a newer active definition. Read-only preview uses the existing repeatable-read boundary. This yields a coherent catalog/internal projection without a catalog framework rewrite; immutable template definitions need no mutable catalog joins for Magento values.

Order for new template-aware creation:

1. Route authentication/active-user/CSRF/exports.create; normalize syntax; initial immutable-key hit check. Begin transaction; take per-key advisory lock; repeat hit check.
2. Resolve/lock activation row `FOR SHARE` for active intent and compare token generation/version; explicit selection only reads immutable version and checks selection permission. Compile by immutable hash/version. Activation writers only take access-admin boundary then activation/template locks; they never acquire product/revision/cursor locks.
3. Resolve current eligible interval; lock represented products in ascending ID `FOR SHARE` through the current selection seam. Capture product/schema/reference/internal-catalog projections consistently; verify membership and fingerprint/token. Unsupported group or any error fails the **whole** selection. Evaluation uses this same projection for preview/readiness/rows.
4. Reuse exposure creation: insert missing revision rows deterministically, lock revisions ascending ID `FOR UPDATE`, capture initial evidence and set exposure. No price revision is confirmed here.
5. For new mode, lock `export_state` `FOR SHARE` **after revisions**, compare token cursor/current interval evidence. A concurrent confirmation causing repeatable-read serialization failure is a stale/retry failure, not permission to bypass the check.
6. Insert parent with provenance, stored internal CSV and every Magento artifact, then audit in the existing transaction; commit once. Any artifact/hash/audit/limit failure rolls back parent, artifacts and exposure together.

Preserve the established product→revision→cursor relationship. Normal confirmation stays snapshot→revisions→cursor; price creation stays products→revisions; price confirmation stays price snapshot→revisions. Do not move cursor locking in front of revisions, which can invert confirmation order. Published-template admin commands do not touch export streams. No snapshot-confirm path locks activation, preventing an activation/product cycle. `writeAuditEvent` retains its actor key-share lookup after business locks; new admin operations use the existing admin lock/recheck pattern, not a new inverse user-lock order.

Repeatable-read gives a deliberate capture instant: a newly inserted product outside that transaction's snapshot remains for a subsequent new export; it cannot be silently included under an old preview. Within the captured represented set, waiting for a concurrently changed product must fail/revalidate instead of emitting a mixture of old and new state. Concurrency tests must force these overlaps with independent connections/barriers and assert database state.

Keep artifact `profile_version='magento-products-v1'` as the **output contract**, not the configurable template identity. Bind version once on the parent; all six files inherit it. Thus 033's profile/group/row-count checks can stay intact for v1, and legacy artifact URLs/file names remain usable. Expose template version/hash in manifest JSON only; no CSV metadata rows/columns/comments. Old rows remain unattributed and byte-for-byte downloadable. Rollback never regenerates an artifact.

## 8. Decisions, risks and acceptance blockers

Concrete engineering choices made here: one six-group version, immutable embedded maps/contracts, fixed safe serializer, zero Magento-specific computed functions, optimistic draft revisions, separate publication/activation, parent snapshot version FK, opt-in request contract with signed preview, existing cursor/exposure coordinators, same-key advisory serialization and PostgreSQL unique-key defense. These are not open implementation questions.

Business decisions needed **before activation**, not permission requests to complete Phase 0:

1. Confirm the observed SV rule (automatic key-chain name only) is the parity baseline. If broader semantic names from the handoff are required, supply approved UA/EN subjects by exact semantic combinations; implement as a separately reviewed mapping-version change after baseline parity, not a hidden fix.
2. Approve frozen export visibility/requiredness per published version, so future live catalog edits require republishing export contracts. This stabilizes versions but differs from current runtime live-catalog dependency. If live rules must keep affecting exports, version identity would need immutable catalog-contract capture on each snapshot as an additional dependency; that is larger than the recommendation and must be explicitly selected.
3. Verify the real Magento measurement-unit expectations and current catalog text inputs (especially bracelet header and SV answer weight) during controlled acceptance. Preserve current bytes in the first parity version; do not invent conversion factors.

Engineering/operational blockers to activation: no checked-in 40-fixture artifacts or full golden oracle; target required/visibility contract not inspected; stable answer-key identity can break on catalog renames that rewrite historical product JSON; malformed/duplicate catalogs require explicit resolution; unsupported evaluator deployments must be rejected; legacy Number precision and sparse EN behavior must not drift. Source-key rename remediation is a new template/explicit alias with evidence, not a recount/catalog refactor. Old snapshot download is independent of all these blockers.

The representation expresses every legitimate audited mapping. It deliberately rejects new malformed rules, unknown references/operations/formats, composite semantic inputs and excessive work. Any difference from legacy permissive malformed-data coercion must be reported by the negative parity suite and accepted explicitly; it cannot be normalized away or counted as exact parity. Pending SV naming or catalog-contract decisions block **activation**, not the side-by-side characterization PR.

## 9. Parity-first verification and acceptance

### 9.1 Planned deterministic coverage (not executed in Phase 0)

First checkpoint adds fixtures and pure evaluator beside the active exporter with **no dispatch change**. Use small explicit product/catalog JSON fixtures independent of dump, seeds, OIDC credentials, pricing provider or translation service. Goldens must have independently reviewed expected headers, maps, paths, names and bytes; generating expected files with the old mapper and blindly approving them is insufficient. Differential comparison then checks the old and new engine on those same inputs. Mutation tests should demonstrate that editing a lookup, constant, category phrase, order or fallback in the definition changes output without changing evaluator code. A new engine delegating to the old whole mapper fails this gate.

| Parity dimension | Required cases / independent assertion |
| --- | --- |
| Group selection | All six groups; interleaved IDs; SV 5/other; unknown category blocks range; excluded products never represented; nonlexicographic/reversed/open/single SKU anchors |
| Multiplicity/order | Same represented product IDs, assignments, base then EN adjacency, ascending IDs per group, fixed stored manifest order; parent product count versus twice-as-many CSV data rows; header excluded from rowCount |
| Common contract | Exact No/Yes flags, simple on both rows, identical base/EN attribute set, blank base store view, EN `en`, sparse EN blanks, optional SEO and no URL key |
| Semantic dictionaries | Every entry in Appendix B exercised, plus unknown IDs; semantic ID differs from SKU digit code; label rename and archived option have no effect; captured visibility hides optional/required values; question missing; duplicate-key rejection at publication |
| BR/NM | Raw 1/2; processing/texture/color/shape/style branches; BR Shambala and mixed-shape wording; NM extra 0/1/2; exact length and every inclusive/exclusive interval endpoint, gaps, comma decimal, nonnumeric passthrough, hex/exponent Number compatibility |
| KL | Current only, legacy only, both (current wins), null/empty/whitespace current fallback, genuine zero, both absent, arbitrary dimension text; all pendant types; hidden present addit still adds path; no SKU-derived dimension for versioned/variant SKUs |
| CH | Every shape/religion/count including genuine count 0 and rejected 9; texture 8 category failure; comma/dot/leading zeros/trailing zeros, zero, trimmed text, invalid units/exponent/hex/sign/mixed separators/boolean; raw stone-size spelling; calibration 0/1/2 and legacy 3 untouched |
| AR | All seven names/type paths/SEO including mosaic; all 28 sizes plus known-but-unmapped and unknown option; missing glass→Без скла, present 1, present zero invalid, hidden/missing required glass and outer size postcheck |
| SV | Souvenir 1–9, all subtype dictionaries (including `2`), visible/hidden dependencies, manual pair precedence even for key chain, automatic key chain only, concrete bird/plant/game still manual-required, malformed partial pair, both subjects with whitespace; no translator/provider availability dependency |
| Weight/fraction | Product weight versus distinct SV answer weight; missing/null/blank/zero/negative/nonfinite, comma string rejected by Number; every SV fraction threshold just below/at/above and non-Stone blank |
| Price/history | Stored final differs from calculated/auto/manual evidence; exact 1234.56/manual rounding off; stored 2000.00→2000; grandfathered zero blocks Magento but stays zero in products/internal/price compatibility; large values characterize current Number limits; no rates fetched |
| Historical input | V1, compact V2+, historical Vn marker, sequence and -NNN variations all opaque SKU text; old schema options/archived options, optional placeholder versus real zero; aliases with evidence, unequal dual aliases fail; no recount or calibration normalization |
| CSV bytes | Every complete header/order, UTF-8 Ukrainian/× characters, no BOM, comma delimiters, LF/no final LF, exact empty fields and quote escaping, embedded comma/quote/CR/LF, leading spaces/tab/CR formula sigils and leading-LF current behavior; formula-like manual subjects/dimensions/SKU as applicable |
| Readiness | Exact ready/not-ready product set, field meaning and operator resolution; duplicate error behavior characterized; whole range blocked with one invalid product; no silent row drop; richer code/provenance metadata documented separately |
| Definition validation | Unknown op/ref/format, forbidden source, type mismatch, duplicate column/route, missing group, forward/cyclic binding, malformed rule, overlarge/deep definitions, cell/work/output budget; deterministic error and no partial output |

Compare raw UTF-8 Buffer bytes of each CSV; do not parse/reserialize, trim strings, sort rows, normalize line endings/BOM, replace decimal separators globally or ignore empty cells to pass. Intended non-CSV differences only: snapshot UUID/time, creator event metadata, definition/version/hash and additional structured diagnostic codes. File names and CSV headers remain unchanged for the parity candidate. Inspect rendered operator labels separately from machine diagnostic additions.

### 9.2 Planned PostgreSQL/API/UI integration

Extend the existing serialized entrypoint and appropriate export/migration/RBAC cases. Cover draft lost-update conflict, atomic publication and retry, version/constant UPDATE/DELETE/TRUNCATE rejection, FK protection, wrong template-version relationship, unsupported evaluator activation, access revocation during publish, CSRF/pending/disabled/no-permission responses, no incidental role grants, audit failure rollback and actor attribution. Validate fresh/034 upgrade/repeated startup/checksum/failure rollback with forward migrations.

For snapshots cover product edit/exclusion/membership/cursor and active-version stale previews; explicit version versus active selection; activation ABA; same-key old-token retry after activation/expiration/confirmation; same-key different version/range/profile/contract; concurrent insert winner/loser, including two active previews for different versions; all artifacts/parent/exposure/audit atomicity; old artifact download after product/catalog/template/evaluator changes and legacy null provenance; bounded failures cannot advance cursor.

Force real races with separate PostgreSQL connections/processes and controlled blocking, not only Promise scheduling: product/name/price mutation versus capture, activation versus create, same-key creations, normal confirmation versus creation, normal/price confirmations out of order and against later price changes. Assert one immutable parent/artifact set/event for retries, captured IDs/prices/revisions, exposure, pending revision high water, original actors, and non-regressing cursor. Retain existing product/price race tests; do not rewrite their semantics. UI tests cover conflict feedback, no preview reuse after selector edits, retained idempotency key on transport retry, effective permissions, normal form controls, and unchanged operator actions.

All DB writes for tests use **only** the canonical disposable Windows environment:

```powershell
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d postgres-test
# In the test process only, from server/:
$env:TEST_DATABASE_URL = 'postgresql://amber_test:amber_test_local_only@127.0.0.1:55432/amber_test'
npm run test:integration
# From repository root afterward:
docker compose -f docker-compose.yml -f docker-compose.local.yml stop postgres-test
```

Check service/target identity before any destructive harness run. If this instance cannot start, report that infrastructure failure and stop DB testing; never fall back to port 5432, another volume, staging, production or the user's restored database. Fixtures must be checked-in synthetic facts without real credentials/dump dependence.

### 9.3 Acceptance gates

Gate 1: independent complete fixtures plus exact differential parity and explicitly documented negative-input differences. Gate 2: persistence/immutability/RBAC/audit and real concurrency checks pass in the canonical disposable environment. Gate 3: read-only target catalog/source-reference review, acknowledged business decisions, performance/limits and minimum editor/operator verification. Gate 4: a **fresh controlled Magento Check Data** run for all six generated files and meaningful branch coverage, with recorded template version/hash/manifest and results. Check Data is not an import. Phase 0 performs neither. Only after these gates may an authorized activation replace the normal route; the original implementation remains available for future-operation rollback.

## 10. Bounded implementation roadmap

All PRs below require separate implementation authorization. No PR is implemented by this document.

| PR | Exact scope / dependencies | Acceptance and verification | Non-goals / activation and rollback |
| --- | --- | --- | --- |
| **1 — Characterize Magento v1; independent declarative parity** | Add deterministic fixtures/goldens and evaluator/definition/projection modules under proposed `server/src/services/export-templates/`; new focused `server/test/export-template-*.test.js`; reuse csv utility. Compare to current mapper through tests only. No dependency on persistence | Complete mapping/branch inventory, reviewed expected bytes/readiness, all six groups, negative cases, limits, demonstrable config changes with unchanged evaluator. `node --test test/magento-products-v1.test.js test/csv.test.js test/export-template-*.test.js`, then server `npm test` and `npm run lint`, root `git diff --check` | No routes, DB migration, editor, normal export dispatch or recount change. Rollback is removing unused code; active exporter unchanged |
| **2 — Version persistence, publish, permissions and audit** | Depends on PR1; next forward migration (035 if free), `template.service.js`, new admin route registered in current admin aggregator, source registry, existing mutation/audit helpers and audit viewer allowlist; focused serialized migration/RBAC/export cases | Draft CAS and publication retry; DB immutability including constants; activation selection validated but normal dispatch still legacy; no role broadening; audit rollback; fresh/034 upgrade. Server unit/lint + canonical `npm run test:integration`; applicable client tests/lint/build if audit presentation touched; diff check | No template snapshots/editor rollout, no product migration/backfill, no old snapshot attribution. Schema stays forward-compatible on rollback; published rows retained |
| **3 — Version-bound snapshots and staleness/retry contract** | Depends on PR1+2; forward migration for parent immutable provenance; `export.service.js`, `exports.routes.js`, `snapshot-binding.js`, `input-projection.js`, artifact manifest read model; existing product/price confirmation services retained; export integration cases | Opt-in requests only, consistent preview/capture, exact stored CSV, strong identity/retry winner-loser checks, lock-order race tests, old artifacts downloadable, both streams unchanged. Full server test/lint/integration; client API contract tests if changed; diff check | Default normal exporter remains legacy. No per-template cursor, no price templates, no product writes from evaluator. Rollback selects legacy for future operations, leaves stored template snapshots usable |
| **4 — Minimum editor and controlled activation** | Depends on PR1–3; proposed `client/src/pages/AdminExportTemplates.jsx`, focused components/API module; existing auth/navigation permissions; small additions to `useProductExportController.js`, `ExportTools.jsx`, `exports-api.js` for selection/provenance/token/retry handling; focused client tests | Form-only editing, conflicts and structured validation, draft test preview, publish/activate separation; full server test/lint/integration, client `npm test`, `npm run lint`, `npm run build`, diff/status; gates 3–4 and fresh Check Data evidence before activation | No export-screen redesign, matrix, bulk correction or delivery automation. No automatic activation upon publication; explicit capability-protected selection after acceptance |

Every behavior PR runs its narrow regression first, then all applicable root AGENTS checks. No server build exists. Compose config/build checks apply only if a later PR explicitly changes deployment/Compose (none planned here). Do not bundle dependency changes or infrastructure modernization.

Rollback selects `legacy` implementation or a compatible earlier published version for **future** previews/operations. Active-selection generation changes invalidate outstanding unused previews; matching completed retries still return original snapshots. Never reset cursors, rewrite existing artifacts/version attribution, erase exposure, remove pending price changes, or republish edited old versions. Keep handlers capable of downloading/confirming snapshots created before rollback, regardless of the current default engine.

## 11. Phase 0 verification actually executed

Repository inspection and existing checks were run; no feature code or new tests were created. Planned tests in section 9 and historical Check Data are not new executions.

| Executed check | Result |
| --- | --- |
| From server: `node --test test/magento-products-v1.test.js test/csv.test.js` | Passed, 7 tests |
| From server: `npm test` | Passed, 264 tests |
| From server: `npm run lint` | Exit 0; two existing unused-variable warnings (`sortOrder`, `sourceOrder`) in `server/src/presenters/product-timeline.js:391`; no errors |
| From client: `npm test` | Passed, 112 Node tests and 102 Vitest tests in 13 files |
| From client: `npm run lint` | Passed, exit 0 |
| From client: `npm run build` | Passed, Vite production build; generated ignored `client/dist` output only |
| Root `git diff --check`; direct new-file whitespace/diff inspection | Passed; the new untracked plan was also inspected through `git diff --no-index`, since ordinary diff excludes untracked files |
| Document JSON/inventory consistency check | All JSON blocks parse; Appendix A matches all 164 group header positions; Appendix B lists all 41 attribute mappings and exact V dictionaries |
| Final `git status --short` / change-scope inspection | Only `?? docs/EXPORT_TEMPLATES_V1_PLAN.md`; tracked files unchanged |

PostgreSQL integration is not applicable to validating this documentation-only change and was not run; no disposable instance or useful database was started/touched. No Compose/deployment file changed, so Compose build/config was not run. Tests ran against existing source, not a new evaluator. Client build output is ignored and is not a deliverable.

Only `docs/EXPORT_TEMPLATES_V1_PLAN.md` is authorized to differ at handoff. No commit/push/merge/deploy/branch switch.

## Appendix A. Exact ordered headers (current)

These lists were transcribed directly from exported `HEADERS` at the audited HEAD. Position is one-based. All groups have exactly two data rows per ready product; these are column counts, not row counts.

### BR — Браслети (26 columns)

| Position | Output column |
| ---: | --- |
| 1 | `sku` |
| 2 | `store_view_code` |
| 3 | `name` |
| 4 | `price` |
| 5 | `decor_weight` |
| 6 | `dovzhyna_brasletu_diuimiv` |
| 7 | `categories` |
| 8 | `attribute_set_code` |
| 9 | `product_type` |
| 10 | `product_websites` |
| 11 | `product_online` |
| 12 | `visibility` |
| 13 | `qty` |
| 14 | `is_in_stock` |
| 15 | `old_product` |
| 16 | `is_ownproduction` |
| 17 | `typy_obrobky_burshtynu` |
| 18 | `vyd_obrobky_kameniu` |
| 19 | `faktura_namystyn` |
| 20 | `kolir` |
| 21 | `forma_namystyn` |
| 22 | `typ_vykonannia` |
| 23 | `short_description` |
| 24 | `description` |
| 25 | `meta_title` |
| 26 | `meta_description` |

### NM — Намиста (28 columns)

| Position | Output column |
| ---: | --- |
| 1 | `sku` |
| 2 | `store_view_code` |
| 3 | `name` |
| 4 | `price` |
| 5 | `dovzhyna_namysta_tochna` |
| 6 | `categories` |
| 7 | `attribute_set_code` |
| 8 | `product_type` |
| 9 | `product_websites` |
| 10 | `product_online` |
| 11 | `visibility` |
| 12 | `qty` |
| 13 | `is_in_stock` |
| 14 | `old_product` |
| 15 | `is_ownproduction` |
| 16 | `decor_weight` |
| 17 | `dovzhyna_namysta` |
| 18 | `typy_obrobky_burshtynu` |
| 19 | `vyd_obrobky_kameniu` |
| 20 | `faktura_namystyn` |
| 21 | `kolir` |
| 22 | `forma_namystyn` |
| 23 | `typ_vykonannia` |
| 24 | `dodatkovo_namysta` |
| 25 | `short_description` |
| 26 | `description` |
| 27 | `meta_title` |
| 28 | `meta_description` |

### KL — Кулони (26 columns)

| Position | Output column |
| ---: | --- |
| 1 | `sku` |
| 2 | `store_view_code` |
| 3 | `name` |
| 4 | `price` |
| 5 | `rozmir_iuvelirnoho_vyrobu` |
| 6 | `categories` |
| 7 | `attribute_set_code` |
| 8 | `product_type` |
| 9 | `product_websites` |
| 10 | `product_online` |
| 11 | `visibility` |
| 12 | `qty` |
| 13 | `is_in_stock` |
| 14 | `old_product` |
| 15 | `is_ownproduction` |
| 16 | `decor_weight` |
| 17 | `typy_obrobky_burshtynu` |
| 18 | `vyd_obrobky_kameniu` |
| 19 | `faktura_kulonu` |
| 20 | `kolir` |
| 21 | `vyd_kulonu` |
| 22 | `kulony_dodatkovo` |
| 23 | `short_description` |
| 24 | `description` |
| 25 | `meta_title` |
| 26 | `meta_description` |

### CH — Чотки (29 columns)

| Position | Output column |
| ---: | --- |
| 1 | `sku` |
| 2 | `store_view_code` |
| 3 | `name` |
| 4 | `price` |
| 5 | `dovzhyna_namystyny` |
| 6 | `diametr_namystyny` |
| 7 | `dovzhyna_vyrobu` |
| 8 | `categories` |
| 9 | `attribute_set_code` |
| 10 | `product_type` |
| 11 | `product_websites` |
| 12 | `product_online` |
| 13 | `visibility` |
| 14 | `qty` |
| 15 | `is_in_stock` |
| 16 | `old_product` |
| 17 | `is_ownproduction` |
| 18 | `vaha_vyrobu` |
| 19 | `rozmir_kameniu` |
| 20 | `typy_obrobky_burshtynu` |
| 21 | `faktura_namystyn` |
| 22 | `kolir` |
| 23 | `forma_namystyn` |
| 24 | `relihiina_prynalezhnist` |
| 25 | `kilkist_namystyn` |
| 26 | `short_description` |
| 27 | `description` |
| 28 | `meta_title` |
| 29 | `meta_description` |

### AR — Картини (23 columns)

| Position | Output column |
| ---: | --- |
| 1 | `sku` |
| 2 | `store_view_code` |
| 3 | `name` |
| 4 | `price` |
| 5 | `categories` |
| 6 | `attribute_set_code` |
| 7 | `product_type` |
| 8 | `product_websites` |
| 9 | `product_online` |
| 10 | `visibility` |
| 11 | `qty` |
| 12 | `is_in_stock` |
| 13 | `old_product` |
| 14 | `is_ownproduction` |
| 15 | `kartynyy` |
| 16 | `rozmir_kartyny` |
| 17 | `sklo` |
| 18 | `dodatkovo_kartyny` |
| 19 | `kartyny_pidsvitka` |
| 20 | `short_description` |
| 21 | `description` |
| 22 | `meta_title` |
| 23 | `meta_description` |

### SV — Сувеніри (32 columns)

| Position | Output column |
| ---: | --- |
| 1 | `sku` |
| 2 | `store_view_code` |
| 3 | `name` |
| 4 | `price` |
| 5 | `decor_weight` |
| 6 | `rozmir_suveniriv` |
| 7 | `categories` |
| 8 | `attribute_set_code` |
| 9 | `product_type` |
| 10 | `product_websites` |
| 11 | `product_online` |
| 12 | `visibility` |
| 13 | `qty` |
| 14 | `is_in_stock` |
| 15 | `old_product` |
| 16 | `is_ownproduction` |
| 17 | `suveniry` |
| 18 | `vyd_statuetky` |
| 19 | `tematyka_vyrobu` |
| 20 | `vyd_ptakha` |
| 21 | `vyd_roslyny` |
| 22 | `vyd_symvoliky` |
| 23 | `nastlni_ihry` |
| 24 | `kamin_obrobka` |
| 25 | `kamin_suvenirnyi` |
| 26 | `kolir` |
| 27 | `typy_obrobky_burshtynu` |
| 28 | `fraction` |
| 29 | `short_description` |
| 30 | `description` |
| 31 | `meta_title` |
| 32 | `meta_description` |

## Appendix B. All semantic attributes and literal dictionaries (current)

Every row below applies to the base row only; its EN cell is empty. Source is the scalar semantic value ID in `products.details.answers[key]`, with no physical unit except AR.size mapping to fixed dimension text. All use `optionValue` and the common question-existence, live visibility, requiredness, missing and unmapped behavior in 3.1. `mapProduct` applies the AR.size postcheck and AR.glass override described there. Current coverage is U (selected-output smoke), with I for BR/SV examples; exhaustive dictionary-entry goldens are planned, not claimed.

| Group | Output column | Answer key | Immutable code table | Source function / existing coverage |
| --- | --- | --- | --- | --- |
| BR | `typy_obrobky_burshtynu` | `raw_type` | `V.raw` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U, I (partial) |
| BR | `vyd_obrobky_kameniu` | `processing` | `V.processing` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U, I (partial) |
| BR | `faktura_namystyn` | `texture` | `V.beadTexture` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U, I (partial) |
| BR | `kolir` | `color` | `V.color4` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U, I (partial) |
| BR | `forma_namystyn` | `shape` | `V.beadShape` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U, I (partial) |
| BR | `typ_vykonannia` | `style` | `V.brStyle` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U, I (partial) |
| NM | `typy_obrobky_burshtynu` | `raw_type` | `V.raw` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| NM | `vyd_obrobky_kameniu` | `processing` | `V.processing` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| NM | `faktura_namystyn` | `texture` | `V.beadTexture` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| NM | `kolir` | `color` | `V.color4` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| NM | `forma_namystyn` | `shape` | `V.beadShape` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| NM | `typ_vykonannia` | `style` | `V.nmStyle` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| NM | `dodatkovo_namysta` | `extra` | `V.nmExtra` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| KL | `typy_obrobky_burshtynu` | `raw_type` | `V.raw` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| KL | `vyd_obrobky_kameniu` | `processing` | `V.processing` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| KL | `faktura_kulonu` | `texture` | `V.pendantTexture` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| KL | `kolir` | `color` | `V.klColor` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| KL | `vyd_kulonu` | `type` | `V.klType` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| KL | `kulony_dodatkovo` | `addit` | `V.klAddit` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| CH | `typy_obrobky_burshtynu` | `raw_type` | `V.raw` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| CH | `faktura_namystyn` | `texture` | `V.beadTexture` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| CH | `kolir` | `color` | `V.color3` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| CH | `forma_namystyn` | `shape` | `V.chShape` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| CH | `relihiina_prynalezhnist` | `religion` | `V.chReligion` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| CH | `kilkist_namystyn` | `count` | `V.chCount` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| AR | `kartynyy` | `type` | `V.arType` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| AR | `rozmir_kartyny` | `size` | `AR_SIZE + current option-ID membership` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| AR | `sklo` | `glass` | `V.arGlass` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| AR | `dodatkovo_kartyny` | `additional` | `V.arAdditional` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| AR | `kartyny_pidsvitka` | `backlight` | `V.arBacklight` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U |
| SV | `suveniry` | `souvenir` | `V.svSouvenir` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U, I (partial) |
| SV | `vyd_statuetky` | `statuette` | `V.svStatuette` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U, I (partial) |
| SV | `tematyka_vyrobu` | `2` | `V.svTheme` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U, I (partial) |
| SV | `vyd_ptakha` | `bird` | `V.svBird` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U, I (partial) |
| SV | `vyd_roslyny` | `plants` | `V.svPlants` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U, I (partial) |
| SV | `vyd_symvoliky` | `symbolic_stat` | `V.svSymbolic` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U, I (partial) |
| SV | `nastlni_ihry` | `table_games` | `V.svGames` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U, I (partial) |
| SV | `kamin_obrobka` | `stone_processing` | `V.svStoneProcessing` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U, I (partial) |
| SV | `kamin_suvenirnyi` | `additional_stone` | `V.svAdditionalStone` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U, I (partial) |
| SV | `kolir` | `color` | `V.svColor` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U, I (partial) |
| SV | `typy_obrobky_burshtynu` | `material` | `V.raw` | `ATTRIBUTE`, `optionValue`, `mapProduct`; U, I (partial) |

The following JSON records every key/value in `V`. Keys are semantic IDs serialized as strings; they are not SKU digits. Distinct color dictionaries and historical spellings are intentional.

```json
{
  "raw": {
    "1": "Натуральний",
    "2": "Формований"
  },
  "processing": {
    "1": "Полірований",
    "2": "Шліфований"
  },
  "beadTexture": {
    "1": "Прозора",
    "2": "Напівпрозора",
    "3": "Матова",
    "4": "Прозора",
    "5": "Напівпрозора",
    "6": "Матова",
    "7": "Пейзажна",
    "8": "Змішана"
  },
  "pendantTexture": {
    "1": "Прозорий",
    "2": "Напівпрозорий",
    "3": "Матовий",
    "4": "Прозорий",
    "5": "Напівпрозорий",
    "6": "Матовий",
    "7": "Пейзажний"
  },
  "color4": {
    "1": "Світлий",
    "2": "Темний",
    "3": "Пейзажний",
    "4": "Комбінований"
  },
  "color3": {
    "1": "Світлий",
    "2": "Темний",
    "3": "Пейзажний"
  },
  "klColor": {
    "1": "Світлий",
    "2": "Темний"
  },
  "svColor": {
    "1": "Світлий",
    "2": "Темний",
    "3": "Комбінований",
    "4": "Пейзажний"
  },
  "beadShape": {
    "1": "Куля",
    "2": "Бочка",
    "3": "Оливка",
    "4": "Сегменти",
    "5": "Галька",
    "6": "Геометрія",
    "7": "Змішана"
  },
  "chShape": {
    "1": "Куля",
    "2": "Бочка",
    "3": "Оливка"
  },
  "brStyle": {
    "1": "Класичний",
    "2": "Комбінований",
    "3": "Комбінований",
    "4": "Комбінований",
    "5": "Шамбала"
  },
  "nmStyle": {
    "1": "Класичний",
    "2": "Комбінований",
    "3": "Комбінований",
    "4": "Комбінований"
  },
  "nmExtra": {
    "0": "",
    "1": "З підвісками",
    "2": "Дитяче"
  },
  "klType": {
    "1": "Природня форма",
    "2": "Коло",
    "3": "Овал",
    "4": "Серце",
    "5": "Капля",
    "6": "Хрест"
  },
  "klAddit": {
    "1": "Інклюз"
  },
  "chReligion": {
    "1": "Мусульманські",
    "2": "Християнські"
  },
  "chCount": {
    "0": "30",
    "1": "33",
    "2": "39",
    "3": "45",
    "4": "51",
    "5": "66",
    "6": "75",
    "7": "99",
    "9": "?"
  },
  "arType": {
    "1": "Ікони",
    "2": "Пейзажі",
    "3": "Панно",
    "4": "Символіка",
    "5": "Натюрморти",
    "6": "Портрети",
    "7": "Мозаїка"
  },
  "arGlass": {
    "1": "Зі склом"
  },
  "arAdditional": {
    "1": "На полотні",
    "2": "На бархаті"
  },
  "arBacklight": {
    "1": "З підсвіткою"
  },
  "svSouvenir": {
    "1": "Статуетки",
    "2": "Настільні ігри",
    "3": "Ручки",
    "4": "Письмові набори",
    "5": "Камінь сувенірний",
    "6": "Брелоки",
    "7": "Лампи",
    "8": "Скриньки",
    "9": "Годинники"
  },
  "svStatuette": {
    "1": "Тварини",
    "2": "Дерева та квіти",
    "3": "Військова техніка",
    "4": "Зодіаки",
    "5": "Символіка",
    "6": "Вітрильники",
    "7": "Авто"
  },
  "svTheme": {
    "1": "Ссавці",
    "2": "Птахи",
    "3": "Риби",
    "4": "Плазуни",
    "5": "Земноводні",
    "6": "Безхребетні"
  },
  "svBird": {
    "1": "Орел",
    "2": "Пава",
    "3": "Сова",
    "4": "Сокіл",
    "5": "Фазан",
    "6": "Лелека",
    "7": "Фенікс"
  },
  "svPlants": {
    "1": "Дерева",
    "2": "Квіти",
    "3": "Ікебана"
  },
  "svSymbolic": {
    "1": "Українська",
    "2": "Військова",
    "3": "Спортивна",
    "4": "Професійна",
    "5": "Релігійна",
    "6": "Корпоративна"
  },
  "svGames": {
    "1": "Шахи",
    "2": "Нарди",
    "3": "Доміно",
    "4": "Шашки/дама"
  },
  "svStoneProcessing": {
    "0": "Необроблений",
    "1": "Полірований"
  },
  "svAdditionalStone": {
    "1": "З інклюзом",
    "2": "На підставці"
  }
}
```

AR_SIZE (AR `size` semantic ID → exported `rozmir_kartyny`; units are not converted by code):

```json
{
  "1": "10×15",
  "2": "15×20",
  "3": "15×40",
  "4": "20×20",
  "5": "20×30",
  "6": "30×30",
  "7": "30×40",
  "8": "30×50",
  "9": "30×60",
  "10": "40×40",
  "11": "40×60",
  "12": "40×80",
  "13": "50×50",
  "14": "50×70",
  "15": "60×80",
  "16": "60×90",
  "17": "80×80",
  "18": "70×100",
  "19": "70×140",
  "20": "80×120",
  "21": "22×26",
  "22": "110×50",
  "23": "40×100",
  "24": "100×100",
  "25": "120×150",
  "26": "120×180",
  "27": "110×60",
  "28": "15×15"
}
```

## Appendix C. Exact name and SEO constants (current)

AR_NAMES is used by `rawName` before the SKU suffix; array order is UA then EN.

```json
{
  "1": [
    "Ікона з бурштину",
    "Amber icon"
  ],
  "2": [
    "Картина з бурштину пейзаж",
    "Amber landscape painting"
  ],
  "3": [
    "Панно з бурштину",
    "Amber panel"
  ],
  "4": [
    "Картина з бурштину символіка",
    "Amber symbolic painting"
  ],
  "5": [
    "Картина з бурштину натюрморт",
    "Amber still life painting"
  ],
  "6": [
    "Портрет з бурштину",
    "Amber portrait"
  ],
  "7": [
    "Мозаїка з бурштину",
    "Amber mosaic"
  ]
}
```

SEO supplies the named base/EN cells in section 3.1; missing properties become blank, not a translation request. Exact whitespace/punctuation must survive configuration publication.

```json
{
  "BR": {
    "uaTitle": "Браслет з бурштину купити у виробника  | Amber Galbin",
    "uaDescription": "Купити браслет з бурштину в Україні, широкий вибір ювелірних прикрас, вигідні ціни від виробника Amber Galbin, доставка по Україні. Телефонуйте або пишіть нам!"
  },
  "NM": {
    "uaTitle": "Намисто з бурштину купити у виробника | Amber Galbin",
    "uaDescription": "Купити намисто з бурштину у Рівному, широкий вибір ювелірних прикрас, вигідні ціни від виробника Amber Galbin, доставка по Україні. Телефонуйте або пишіть нам!",
    "enTitle": "Buy amber necklace from the manufacturer | Amber Galbin",
    "enDescription": "Buy amber necklaces in Rivne, a wide selection of jewelry, favorable prices from the manufacturer Amber Galbin, delivery across Ukraine. Call or write to us!"
  },
  "KL": {
    "uaTitle": "Кулон з бурштину купити у Рівному | Amber Galbin",
    "uaDescription": "Купити бурштиновий кулон у Рівному, широкий вибір ювелірних прикрас, вигідні ціни від виробника Amber Galbin, доставка по Україні. Телефонуйте або пишіть нам!",
    "enTitle": "Buy amber pendant in Rivne | Amber Galbin"
  },
  "CH": {
    "uaTitle": "Чотки з бурштину купити у виробника  | Amber Galbin",
    "uaDescription": "Купити чотки, вервицю з бурштину, широкий асортимент, ручна робота, ціни від виробника Amber Galbin, швидка доставка по Україні. Телефонуйте або пишіть нам!"
  }
}
```

`paintingSeo` uses the following type subjects (title noun, description subject), embedded here as immutable configuration candidates:

```json
{
  "1": [
    "Ікони",
    "ікони"
  ],
  "2": [
    "Пейзажі",
    "пейзажі"
  ],
  "3": [
    "Панно",
    "панно"
  ],
  "4": [
    "Символіка",
    "картини із символікою"
  ],
  "5": [
    "Натюрморти",
    "натюрморти"
  ],
  "6": [
    "Портрети",
    "портрети"
  ],
  "7": [
    "Мозаїка",
    "декоративну мозаїку"
  ]
}
```

Title: `{title noun} з бурштину від виробника | купити в Amber Galbin`. Non-mosaic description: `Купити {description subject} з бурштину від виробника Amber Galbin. Ручна робота підкреслює природну фактуру та красу бурштину. Картини з бурштину від Amber Galbin`. Mosaic description: `Купити декоративну мозаїку з бурштину від виробника Amber Galbin. Ручне оформлення підкреслює природну фактуру бурштину. Картини з бурштину від Amber Galbin`. AR EN SEO is always empty.

## PR1A addendum — independent characterization, 2026-09-23

PR1 is split into PR1A (this completed pure-test checkpoint) and PR1B (future
declarative validator/evaluator and old/new parity). Section 11 above remains the
unchanged historical Phase 0 record. **No evaluator or full PR1/parity gate is
complete.** The active exporter is unchanged.

### Actual checkout and seams

| Evidence | PR1A observation |
| --- | --- |
| Branch | `feature/magento-export-constructor` |
| HEAD | `1bed5d2311761b603d7857949d576aeee9e831b8` |
| Initial `git status --short` | Empty; the Phase 0 plan is tracked at this HEAD |
| Accepted six-group prerequisite | Present; current source and existing seven narrow mapper/CSV tests inspected and passed |
| Recent optional-SKU-placeholder recount fix | `7c803dc` is not an ancestor (`git merge-base --is-ancestor 7c803dc HEAD` exits 1); its `isOptionalPlaceholderAnswer` helper and new tests are absent. Older placeholder handling is not this fix. No recount edit or branch operation performed |
| Tested production entry points | Existing pure `mapProduct(product,catalog)`, `buildMagentoPayload(products,catalog)`, and `buildCsv(rows)`; no new production exports |
| Input/ordering seam | Already-selected synthetic inputs in caller order, normally ascending product ID. Mapper preserves input order, provisional groups follow first ready encounter. Stored manifest's fixed BR/NM/KL/CH/AR/SV order is a different service seam |

### Delivered contract and compatibility

Three new test files, reusable synthetic fixtures, ten complete exact-byte CSV
goldens and the [fixture provenance/compatibility register](../server/test/fixtures/magento-v1/README.md)
cover all six groups, all **164 header positions**, all **41 semantic bindings**,
all 30 V dictionaries plus all 28 AR sizes. There are 157 distinct dictionary
entries / 196 entries counted per binding, each tested as numeric and string IDs.
CH texture 8 and count 9 assert their actual readiness rejection.

Expected tables, category phrases, headers and base/EN cells are independently
specified test data; no production constants construct expectations. Full CSV
JSON was encoded offline from reviewed expected cells with the standard Python
CSV writer, never captured from mapper output. Tests compare raw UTF-8 Buffers;
seven corrupted-output self-checks prove sensitivity to constants, headers, EN,
decimals, newlines and BOM. Tests do not regenerate goldens. Source/inventory
comparison was a separate read-only audit, not expected-output generation.

Verified compatibility details (passing tests do not imply business approval):

- KL omitted/null/blank `addit` has no inclusion path. Present numeric/string zero
  always adds `Default/Кулони/З інклюзом`; a visible question records an unmapped
  `kulony_dodatkovo` error and excludes the product from provisional artifacts.
  A hidden question leaves that attribute blank and the product ready, including
  when required. Visible semantic 1 maps `Інклюз`. The zero input is never changed.
- Genuine NM extra 0, CH count 0 and SV stone-processing 0 retain their different
  meanings. Export does not infer placeholder provenance. SV automatic naming is
  still only souvenir 6; complete saved UA/EN pairs win even there.
- Current rules remain live catalog rules; hidden attributes can still affect
  paths/names. AR size postvalidation may add a second error on the same field.
  Errors retain exact messages/order and are **not deduplicated**; only the existing
  `manual_name_required` code is asserted, not proposed future evaluator codes.
- Provisional artifacts with ready products do not authorize a snapshot containing
  other invalid products. Range selection and whole-range transactional rejection
  remain service/integration responsibilities.
- NM nonnumeric length passthrough, Number coercion/precision, malformed rule
  permissiveness, missing SKU permissiveness and source-key rename limitations
  are recorded without runtime fixes. Formula protection matches leading
  space/tab/CR, but not leading LF or NBSP. Raw CH stone-size spelling is retained.

The register separates verified existing behavior, proposed future strict/frozen
contracts, and DB/API/concurrency coverage elsewhere. Remaining evidence gaps are
target live catalog/rename lineage, business approval of quirks and frozen rules,
measurement-unit expectations, new evaluator parity and fresh Magento acceptance.
Historical Check Data evidence was not rerun or promoted to new evidence.

### Verification actually executed

| Command / check | Observed result |
| --- | --- |
| Initial `node --test test/magento-products-v1.test.js test/csv.test.js` from server | 7/7 passed on system Node 22.12.0; these also pass in the later full Node 20 runs |
| Node 20.20.2: `node --test test/magento-v1-characterization.test.js test/magento-v1-categories.test.js test/magento-v1-goldens.test.js` | **83/83 passed**, no skips/failures |
| Node 20.20.2: plain `npm.cmd test` using default Windows shell | Existing launcher limitation: `test/*.test.js` is not expanded; exits before tests. Not a new test failure |
| Node 20.20.2: `node --require ./test/setup-env.js --test @testFiles`, where PowerShell enumerates `test/*.test.js` | **347/347 passed**, no skips/failures |
| Node 20.20.2: `npm.cmd --script-shell='D:/Programs/Git/bin/bash.exe' test` | Unmodified npm script, **347/347 passed**, no skips/failures. An earlier attempted shell path under `C:/Program Files/Git` did not exist and launched no tests |
| Node 20.20.2: `npm.cmd run lint` | Exit 0, no errors; two existing unused-variable warnings (`sortOrder`, `sourceOrder`) in `server/src/presenters/product-timeline.js:391`. Current lint script excludes test files |
| Read-only inventory audit | All 164 headers, 41 bindings and 30 V tables match independent fixture literals; all AR sizes exercised via actual mapper |
| Root `git diff --check`, scoped diff and explicit untracked-file review | Passed; only this addendum and new `server/test/` assets differ |

Node 20.20.2 was obtained in the user npm cache; only command-local PATH/shell
selection was used, with no repository dependency, lockfile or environment-setting
change. Full reproduction commands are in the fixture README. No behavioral test
failures were observed; Windows command-launch issues are listed separately.

PostgreSQL integration, client test/lint/build and Compose checks are not applicable
to this isolated pure server-test change and were not run. No database instance,
application bootstrap, migration, seed, restore, real snapshot or provider was
used. Production code, routes, snapshot/cursor/exposure logic, client, price-export
behavior, migrations, dependencies and configuration are unchanged. Final state:
one modified plan plus eight new untracked test/fixture files; nothing staged,
committed, pushed, merged or deployed. PR1A stops here; PR1B requires a later task.

## PR1B addendum — isolated declarative implementation (2026-09-23)

**Implemented in isolation, not activated or deployed. PR2 is not started.**
Initial branch/HEAD: `feature/magento-export-constructor` /
`1bed5d2311761b603d7857949d576aeee9e831b8`. Initial status already contained
the modified plan, the three untracked PR1A tests and their fixture directory.
Those changes were preserved. No existing runtime file was changed, and no
application entry point imports the new modules.

### Interfaces and representation actually implemented

All production additions are under `server/src/services/export-templates/`:

| Module | Pure interface / responsibility |
| --- | --- |
| `input-projection.js` | `readSource(descriptor, product)`; closed product fields and own-property answer access, literal key `2`, scalar/type checks, explicitly evidenced schema-scoped aliases. No database projection/loading |
| `definition.js` | `validateDefinition(definition)` returns measured definition inventory or throws `TEMPLATE_INVALID`; `compileDefinition(definition)` returns detached deeply frozen `{definition,hash,metrics}`. SHA-256 over canonical JSON; object keys sorted, arrays and exact strings retained. No compiled-result cache |
| `evaluate.js` | `evaluateProduct(compiled, product, optionalLowerBudgets)` returns legacy-compatible mapped rows/errors; `evaluateBatch(compiled, products, optionalLowerBudgets)` returns ordered represented identities/statuses, counts, diagnostics, artifacts and measured work/bytes; `legacyPreview(result)` projects the legacy provisional shape without changing values/errors |
| `magento-v1-data.js` | Frozen audited literals: approved headers, 41 attribute specifications, dictionaries, names and SEO. No legacy mapper import |
| `magento-v1-definition.js` | `materializeMagentoV1(explicitCatalogMap)` builds and validates detached serializable six-group JSON. Its helpers construct nodes and never accept products |

Definition identity is `formatVersion:1`, `evaluatorVersion:"magento-declarative-1"`,
`outputContract:"magento-products-v1"`. It contains `sources`, text `tables`,
`questionContracts`, ordered scoped `bindings`, and six `groups` with approved
ordered `columns`, explicit diagnostic evaluation roots and base/EN `rows`.
Each row has `default:""`; EN sparsity is explicit. The fixed header set is
validated, while column order is configurable. Missing required identity cells,
duplicate routes/columns/bindings, forward/cross-group/cyclic references,
unknown properties/operations/formats/types, unsafe keys and malformed rules fail.

Implemented operations: `literal`, `source`, `ref`, `text`, `present`,
`semanticKey`, `lookup`, `firstPresent`, `when`, `eq`, `in`, `all`, `any`, `not`,
`catalogRule`, `questionValue`, `numberText`, `decimalText`, `numericBand`,
`interpolate`, `join`, `require`, `error`. Scalar conversions and numeric formats
are closed/versioned. Required question/numeric/constraint failure branches must
emit diagnostics. Bindings are memoized per product; selected branches alone run.
All branches are validated, including hidden ones. No Magento category-specific
operation, executable definition callback, Python, test table, live catalog,
pricing utility, clock, random source, filesystem or network is used in evaluation.
Only the unchanged `buildCsv` and `escapeCsvValue` low-level utilities are reused;
catalog-rule scalar normalization is implemented with closed own-property sources.

Synthetic catalog provenance is exclusively PR1A `contract.js:catalog()` and
explicit per-case overrides; the old exporter receives that same Map. Labels,
SKU codes and archive hints are not semantic sources. Captured rules/options
are detached before compilation. Multiple catalog-rule predicates are captured
as ordered conjunction arrays to preserve short-circuit order through hashing.
An explicit captured `exists:false` preserves all PR1A missing-question product
diagnostics; an omitted/unresolved contract reference is invalid. This pure
representation does not implement the future publication policy for missing
catalog questions discussed in section 5.1.

Missing, null, trim-blank, numeric/string zero and invalid present values remain
distinct until the chosen operation handles them. Source aliases require a literal
key, positive schema ID string and nonempty evidence; only the supplied matching
schema enables them. Dual aliases must have identical stored scalars (no implicit
number/string normalization). Other alias/provenance features fail validation.
No historical schema, placeholder or calibration inference is performed.

### Traceable execution coverage and exact parity

`export-template-parity.test.js` executes independent expected rows and all ten
UTF-8 Buffer goldens directly, as well as all 392 numeric/string dictionary
checks (41 bindings; 164 header positions). Additionally, a child-only adapter
in `test/fixtures/export-templates/replay.cjs` runs the **unchanged** three PR1A
files: every supported mapper call compares old/new results and returns the
candidate result to the independent PR1A assertions. This is actual candidate
execution, not merely another green run of legacy tests. Serializer-only and
inventory-only assertions retain their original scope. The adapter is never
loaded by application code.

| PR1A family / stable test-name fragment | New execution path |
| --- | --- |
| `every semantic dictionary entry`, `all 41 question-existence`, `live catalog labels/options` | Replay + `candidate inventory`; all entries, missing/unknown/hidden/required gates and unmapped diagnostics |
| `every category-only phrase`, `natural/pressed`, `NM extra path` | Replay; complete ordered BR/NM/KL/CH paths and UA/EN names |
| `KL current/legacy dimensions`, `KL addit` | Replay + named `KL.addit=0 legacy inclusion presence`; absent-only fallback, opaque SKU, visible failure/hidden readiness, inclusion path unchanged |
| `NM bands` | Replay; every endpoint/gap, comma/hex/exponent and nonnumeric passthrough |
| `CH preserves`, `CH invalid numeric` | Replay; raw size versus normalized decimals, count 0/9, texture 8, calibration 0/1/2/3, exact errors; composite exceptions separately rejected |
| `AR seven type branches`, `AR size requires`, `AR absent glass` | Replay + AR/AR-mosaic goldens; all names/SEO, 28 sizes, membership and ordered duplicate post-check errors |
| `SV category routing`, `SV fractions`, `SV only key chain`, `SV synthetic dependent` | Replay + SV/Stone/escaping goldens; every subtype, literal key `2`, all thresholds, answer weight, pair precedence and narrow automatic naming |
| `final stored price`, `all weight sources`, `required free text` | Replay; stored price authority/coercions/zero rejection, all weight sources and presence rules |
| `hidden attributes`, `current source-key references`, `legacy malformed rules` | Replay; captured gating and original rename behavior; closed rejection register below |
| `readiness preserves`, `already-selected interleaved` | Replay + native invalid-batch test; exact counts, diagnostic order, duplicate products, first-ready group order and input order |
| `independent complete fields and UTF-8 golden`, byte comparator | Direct ten-golden tests + replay; every cell, sparse blanks, escaped Unicode, formula-neutralization, no BOM/newline normalization |

Measured replay calls (each compared directly with the old mapper):

| Group | Exact product-map comparisons | Products in exact batch comparisons | Complete independent goldens |
| --- | ---: | ---: | ---: |
| BR | 142 | 75 | 1 |
| NM | 165 | 63 | 1 |
| KL | 157 | 75 | 2 |
| CH | 184 | 56 | 1 |
| AR | 134 | 85 | 2 |
| SV | 319 | 111 | 3 |

Also compared: six unsupported/missing-group map calls and one unsupported-group
batch member. No unexplained CSV/readiness differences remain in supported cases.
These counts are mapper-seam coverage, **not** SQL selection, exclusions, stored
manifest order, locks, snapshots, confirmation or cursor verification.

Native batch metadata deliberately differs: `status`, `failedCount`, ordered
`represented` entries with readiness/artifact-row counts, and resource metrics.
Any represented invalid product makes `status:"not-ready"` and `artifacts:[]`;
ready products' rows are available only as `provisionalArtifacts`. Legacy preview
projection retains all errors and provisional readiness without authorizing a
snapshot. Invalid definitions, input-type/alias failures and limits throw, returning
no success or partial artifacts. Existing field messages, ordering, repeated errors
and `manual_name_required` are preserved for supported cases.

### Closed deliberate non-parity register — acceptance required

`test/fixtures/export-templates/differences.js` and named `intentional NON-parity`
tests record identical source input, the old result and new explicit failure.
There is no general legacy-differences exemption. The replay permits only its
17 enumerated PR1A cases (18 calls, because the price-object input is also batched);
they are **not counted as exact parity successes**. Supplementary cases extend
malformed-input coverage without changing the oracle.

| Named cases | Old result | New rule / diagnostic |
| --- | --- | --- |
| `D-rule-1`–`D-rule-8`: `{broken`, JSON `null`/`[]`/`42`/`"text"`, array/boolean/number rule roots | Visible NM.extra=1 → `З підвісками` | Object-rule contract rejects malformed JSON/root: `TEMPLATE_INVALID` |
| `D-rule-9`: `$and:"bad"` | Hidden NM.extra, blank and ready | Logical branches must be arrays of valid rules: `TEMPLATE_INVALID` |
| `D-composite-bead_length`, `-bead_width`, `-rosary_length` | `{}` coerced to text, then legacy numeric-field error | Evaluated composite source prohibited: `INPUT_INVALID` |
| `D-price-array`, `D-price-object`, `D-text-object`, `D-semantic-array` | `[12]` → price `12`; `{}` → price error; `{}` → `[object Object]` dimension; `[1]` → mapped natural material | Evaluated sources must be scalars: `INPUT_INVALID` |
| `D-semantic-boolean`, `D-semantic-NaN`, `D-semantic-Infinity` | NM.extra unmapped-value error | Semantic keys require text or finite numbers: `INPUT_INVALID` |
| `D-sku-number`, `D-sku-boolean`, named category `0` / `false` cases | SKU 0/false → blank; category 0/false → unsupported empty group | Stored identity inputs are nullable text, not coercible numeric/boolean identities: `INPUT_INVALID` |
| `D-manual-composite` | Object UA subject ignored, automatic key-chain name used | Evaluated composite source prohibited: `INPUT_INVALID` |
| `D-catalog-required`, `-options-shape`, `-duplicate-option`, `-option-type` | BR natural attribute remains mapped with required=2, non-array options, duplicate ID or object ID | Captured flags/options must have valid shape and unique scalar IDs: `TEMPLATE_INVALID` |
| `D-catalog-rule-object` | Object-valued expected operand hides the BR natural attribute; product ready | Captured comparisons require scalar operands: `TEMPLATE_INVALID` |

Other invalid-definition/security/limit tests exercise contracts with no valid
legacy template equivalent, not permissive parity exceptions. Executable accessors
and inherited definition properties are never evaluated. Hidden/unused product
answers remain lazy and may contain otherwise invalid values without diagnostics.

Business concerns remain open: KL inclusion-on-presence zero is an explicit
`KL.legacyInclusionPresence` expression, **not an approved business rule**; SV
automatic names still only souvenir 6; live-to-frozen catalog policy, actual
target source lineage/aliases and units require later acceptance. No live catalog
or production activation policy was inferred from synthetic inputs.

### Configurability, bounds and verification

`export-template-definition.test.js` proves exact output changes from definition
data alone for a literal, dictionary entry, name/category interpolation, condition,
fallback priority and column order. It also proves JSON roundtrip, deterministic
hash/output, object-key-order equivalence, array/string/contract hash sensitivity,
caller/catalog/result mutation isolation, lazy branches with eager static validation,
own-property access, explicit aliases/conflicts and malformed-reference rejection.

Baseline definition: **103,012 UTF-8 JSON bytes**, 55 sources, 133 bindings,
245 literal-table entries plus 232 captured/inline membership entries. Limits:
256 KiB definition; six groups/two rows; 64 columns/group (approved exact sets);
256 sources/contracts; 512 bindings; depth 8; 16 expression/predicate children;
512 entries per lookup/membership table and 4,096 combined; 4,096 characters per
literal; 20,000 evaluated nodes/rule steps per product; 16 KiB per accessed scalar
text/intermediate/cell; 64 MiB final escaped CSV across all artifacts. Inline `in`
values are bounded membership tables, not expression children. Structural JSON
traversal is also capped before cloning. Diagnostic bytes use the same request
budget independently, with an additional 20,000 failed-product cap.

Boundary evidence: work fixture succeeds at **19,522** steps and fails at the
20,000 cap with 512 repeated catalog predicates; a formula/quote/CRLF/Unicode
fixture has **787 exact escaped UTF-8 bytes** and **151 steps** (exact lower budget
succeeds, one less fails). A 16,384-byte cell succeeds; 16,385 fails. A synthetic
SV batch succeeds at **4,004 products / 67,107,447 bytes**, while 4,005 fails before
serialization/allocation of a success artifact. No timings are asserted.

Actual environment: system **Node 22.12.0**, installed Git Bash at
`D:/Programs/Git/bin/bash.exe`; no Node/dependency/configuration changes.

| Actual command/check (server working directory unless noted) | Result |
| --- | --- |
| `node --test test/magento-v1-characterization.test.js test/magento-v1-categories.test.js test/magento-v1-goldens.test.js` before edits and after implementation | 83/83 passed, unchanged oracle |
| `node --test test/export-template-parity.test.js test/export-template-definition.test.js` | 126/126 passed; includes the child execution of all 83 original assertions and explicit non-parity rejection checks |
| `npm.cmd --script-shell='D:/Programs/Git/bin/bash.exe' test` | 473/473 passed, no skips/failures |
| `npm.cmd run lint` | Exit 0; only the two pre-existing `sortOrder`/`sourceOrder` warnings in `product-timeline.js:391` |
| Root `git diff --check`, complete scoped/new-file inspection, import-boundary search | Passed; no existing runtime module imports the candidate. New-file diff inspection reports Git's existing LF→CRLF working-copy policy warnings; no whitespace errors |

PostgreSQL integration, client test/lint/build and Compose checks were not applicable
to an isolated candidate absent from the application dependency graph. They were
not run and are not parity evidence. No database connection/instance, bootstrap,
migration, seed, restore, snapshot, translation, Magento Check Data/import or
production operation occurred. Later integration must run its applicable checks;
only the canonical disposable `postgres-test` environment may be used.

Oracle SHA-256 fingerprints were recorded before implementation and rechecked
afterward; all eight match exactly (including the independent Python writer):

| Artifact (`server/test/`, fixture paths abbreviated) | SHA-256 before = after |
| --- | --- |
| `magento-v1-characterization.test.js` | `2CA4967801403961B892D4F565BECA168D0F51E3DAACF2FE1F92AF12C67131DC` |
| `magento-v1-categories.test.js` | `26C848196251FA1024BDC3AB58C850F8742CDB27A4C67D1A71A4524D1ABDEF9D` |
| `magento-v1-goldens.test.js` | `DB84DA7C2E94C2269D6D0741145BC5E5D8AD3CE9CC70D60472F3E0261AB4B1B0` |
| `fixtures/magento-v1/contract.js` | `3A377B7A8FAC617C851908C9E7BEF9F3318A1597C37E3D3290C9C81B5BF5D4A4` |
| `fixtures/magento-v1/expected-rows.js` | `998964357A96F771BA7B8F6C722E718FD631B192746CE2FD498FDEB52B4C5C63` |
| `fixtures/magento-v1/goldens.json` | `FFFD67A04CBA342A80BB8094643CC91A1D4742C5406DFC8B57A804E57B444150` |
| `fixtures/magento-v1/README.md` | `A1B86C11D7537C9F59C05CDA5708EAB9EE879B67B4A815DCDCDD476B0F3871E3` |
| `fixtures/magento-v1/write-goldens.py` | `642671ADA1CA9F616A7EBFB69A89D0B0ADB1884274BCD7FB858908A69547F65E` |

Recount prerequisite rechecked: `git merge-base --is-ancestor 7c803dc HEAD`
returns 1; the commit exists in repository history. Its actual helper and the
selected/retained optional-placeholder guards are absent from
`client/src/lib/product-recount.js:normalizeRecountTargetState`; the added
placeholder-preservation regressions in `product-recount.test.js` and
`home-workspace.test.jsx` are also absent. Older optional-selection/zero tests
are not equivalent. Integrating that fix remains a later deployment prerequisite,
not a blocker for this isolated work; recount was not changed.

Final change scope: the previously modified plan with this appended record, five
new isolated production modules, two new test files and two supplementary fixture
helpers; the pre-existing PR1A files remain untracked and unchanged. No staging,
commit, push, reset/clean/stash, branch switch/merge/rebase/cherry-pick, persistence,
publication or snapshot integration was performed.

### Target-runtime verification follow-up (2026-09-23)

The repository still targets Node 20: `server/Dockerfile` uses
`node:20-bookworm-slim`, CI sets `node-version: 20`, and AGENTS/project
context agree. No conflicting server package engine declaration was found.
Branch remained `feature/magento-export-constructor`, HEAD
`1bed5d2311761b603d7857949d576aeee9e831b8`.

Verification used the existing cached standalone **Node v20.20.2** executable:
`C:/Users/bohdan.bohelskyi/AppData/Local/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node.exe`
(`$node20` below). Its reported `process.execPath` matches that executable.
npm **10.9.0** was run explicitly through Node 20 using
`C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js` (`$npmCli`).
Tests ran against the actual working tree, including all untracked PR1A/PR1B
files, with existing dependencies; no installation or disposable repository copy
was necessary.

Only process-local PATH/NODE_OPTIONS and temporary files were used. A preload
guard checked the exact executable and Node major in every Node process.
Git Bash exists at `D:/Programs/Git/bin/bash.exe`; its initial resolution of
the extensionless `node` command selected system Node 22 and was rejected by
the guard before tests ran. A temporary extensionless shell launcher pointing
explicitly to the cached Node 20 executable resolved this environment issue.
A temporary preload-path quoting issue was also corrected. Neither was an
evaluator defect. Successful PR1A, PR1B, full-suite and lint runs recorded,
respectively, **4, 7, 58 and 2** guarded processes, all on that Node v20.20.2
executable, including npm-spawned tests and ESLint.

Commands from `server/` and observed results (all exit 0):

| Command | Result |
| --- | --- |
| `& $node20 --test test/magento-v1-characterization.test.js test/magento-v1-categories.test.js test/magento-v1-goldens.test.js` | 83 passed, 0 failed/skipped |
| `& $node20 --test test/export-template-parity.test.js test/export-template-definition.test.js` | 126 passed, 0 failed/skipped |
| `& $node20 $npmCli --script-shell='D:/Programs/Git/bin/bash.exe' test` | 473 passed, 0 failed/skipped |
| `& $node20 $npmCli run lint` | 0 errors; the same 2 existing unused-variable warnings for sortOrder/sourceOrder at product-timeline.js:391 |

All output-limit tests remained enabled: the 4,004-product case produced
67,107,447 bytes and the 4,005-product case was rejected. Work-limit checks also
remained enabled (19,522-work case accepted; 512-predicate case exceeded 20,000).
No compatibility defect was reproduced, so no source/test fix or Node 22 rerun
was needed. Earlier Node 22 results above remain historical evidence; the
machine's default Node v22.12.0 was not changed.

All eight PR1A SHA-256 fingerprints, recomputed with
`Get-FileHash -Algorithm SHA256`, match the preceding register and the
follow-up's initial snapshot. All 17 untracked files were explicitly inspected
and retain their initial hashes. Runtime declarations, lockfile and package
scripts are unchanged. The only follow-up edit is this appended documentation;
the preceding document bytes are preserved. `git diff --check` passed, with
the existing modified-plan/untracked-PR1A/PR1B Git status preserved.

The target-runtime verification gate is **passed**. The previously recorded
recount integration/release prerequisite remains unchanged and was not
re-audited. No database/client/Magento checks or operations were needed or run.
No staging, commits, pushes, branch operations, dependency/configuration changes,
production activity or PR2 work occurred; active export dispatch is unchanged.

## PR2 addendum — persistence and administrative API (2026-09-23)

**PR2 implemented and verified. PR3/PR4 not started; exporter dispatch remains legacy.**
Actual starting/final branch: `feature/magento-export-constructor`; HEAD:
`7a3adde881408231d8184010da522a2950a9e4de`. Starting status was clean: PR1A/PR1B
were already tracked in this checkout, unlike the earlier addenda. No nested
AGENTS instructions were present. Migration inventory was `000` through
`034_product_magento_manual_names.sql`; the sole addition is
`035_export_templates.sql`. Historical migration bytes/runner are unchanged.

### Implemented files and contracts

- `server/migrations/035_export_templates.sql`: permanent families, one draft per
  family, immutable versions and a generation-based singleton selection. It
  initializes only legacy/null-version metadata and four permission records;
  Administrator propagation uses migration 028's existing trigger. No template,
  publication, synthetic actor/event, snapshot column or catalog capture is seeded.
- `server/src/services/export-templates/template.service.js`: family/list/detail,
  bounded incomplete-draft save, same-family from-version copying, explicit
  validation, read-only authoritative preview, publication/retries and selection CAS.
- `source-references.js`: closed source/operation registry and coherent repository
  reference checks. `draft-inputs.js`: narrowly isolated stored-product reads.
- `definition.js`: only adds `hashJsonData`, exposing the existing PR1B preflight
  and canonical hashing for incomplete drafts. Compiler/evaluator schemas and
  semantics, materializer and constant tables are unchanged.
- `server/src/routes/admin/export-templates.routes.js`, `admin.routes.js`,
  `endpoint-manifest.js`: eleven administrative routes under
  `/api/admin/export-templates`, including static sources/activation reads before
  `/:id`. `app.js` adds a parser limit of 272 KiB only for this namespace to carry
  the PR1B 256 KiB definition plus its command envelope; other route limits stay
  unchanged. No authentication middleware or access transaction was refactored.
- `audit-viewer.service.js`: concise template event fields and the exact public
  definition-hash exception; other secret/hash redaction and audit access remain.
- `server/test/export-template-persistence.test.js`, `route-manifest.test.js`:
  canonical-hash adaptation, incomplete-draft safety, source policies, bigint
  preconditions, audit filtering, complete routes and both preview permissions.
- `server/integration-test/12-export-templates.cases.js`, registered in the existing
  serialized `critical-flows.test.js`: fourteen PR2 PostgreSQL/API cases. Existing
  `02-migration-foundation`, `04-product-access-audit`, and `06-migration-upgrades`
  expectations now include four extra Administrator capabilities. Old checkpoint
  builders exclude 035 until their normal upgrade; no historical SQL is edited.
- Maintained docs: `PROJECT_CONTEXT.md`, `AUTH_RBAC.md`, `DATABASE_MIGRATIONS.md`,
  `EXPORTS.md`, and this appended record. The complete implemented route/body/
  permission matrix is in [Export-template administration](EXPORTS.md#export-template-administration-pr2).

Definition/source/list/detail/selection reads require `export_templates.view`.
Create/save/from-version/validate require `export_templates.manage`; test-preview
also requires `exports.view`. Publish and selection updates require respectively
`export_templates.publish` and `export_templates.activate`. These capabilities
are explicitly delegable, not new reserved permissions. HTTP tests delegate
each independently without `users.manage`, verify manage+exports preview, and
keep `audit.view` denied. Manager/Storekeeper/custom upgrade roles gain nothing.

Draft saves accept incomplete bounded plain JSON; unsupported evaluator/format is
storable but not publishable. PR1B structural/256 KiB limits apply, with NUL and
unpaired-surrogate rejection for JSONB. Drafts are marked as drafts. Hashes use
PR1B object-key canonicalization, not JSONB key order. Database storage has a
512 KiB text backstop allowing JSONB whitespace. Revision/hash preconditions use
decimal strings for bigint precision. Save checks stale revision before no-op
equality; unchanged definition/base preserves revision, actor/time and audit count.
From-version copies within the same family; changed base/data advances revision.
Composite FKs reject cross-family bases, and source revision has no FK to the
mutable current revision.

All mutations reuse `runAccessAdminMutation`: access advisory lock → post-lock
actor/specific-capability recheck → family → draft. Publication then checks a
completed source-revision publication **before** rejecting a newer current draft,
fully validates the stored draft and expected hash, reads repository evidence,
allocates the next version under the family lock, inserts actor/time/definition
and audits in one transaction. Matching retries retain the original attribution;
mismatching hashes conflict. A persisted hash mismatch fails without repair.
Publication UPDATE/DELETE/TRUNCATE, including metadata and constants, are rejected.
Family identity and state cannot be deleted/reset. Privileged test teardown uses
schema disposal; no immutability trigger is disabled.

Source validation uses one coherent SQL-statement snapshot on the publication
transaction client. Validation/test-preview use REPEATABLE READ READ ONLY across
draft, evidence and product loading. Semantic sources use historical SKU evidence
or current non-SKU metadata; informational sources require current non-SKU metadata.
Allowed semantic IDs need repository evidence, including archived historical
options, without interpreting SKU codes or labels. Categories, unresolved keys,
missing captured questions and duplicate current keys fail explicitly. Frozen
rules remain supplied data: publication never silently recaptures live rules.

Documented adaptation to section 6: PR1B aliases contain only `schemaId`, `key`,
and caller-authored text `evidence`. The repository has no durable cross-key
lineage that verifies equivalence. PR2 checks schema/category/key ownership and
returns `SOURCE_REFERENCE_UNRESOLVED` or `SOURCE_REFERENCE_UNSUPPORTED`, rather
than trusting the text claim. No supported verified alias lineage is invented;
the pure PR1B alias behavior and its tests remain intact. Registry/validation
success explicitly does not mean production acceptance.

Selection is metadata only: legacy/null at generation 1, unchanged by publication,
dedicated-capability CAS, supported-version/hash verification, no-op preservation,
and generation increments for A → B → A. Responses explicitly say `metadataOnly`
and `effectiveExporter: legacy`. Selection writes take access then singleton locks
and immutable-version reads, never product/revision/cursor locks. The four events
`export_template.created`, `.draft_updated`, `.published`, `.activated` share the
mutation transaction; failures, no-ops and retries do not emit success events.

Preview requires revision **and** hash plus 1–100 unique product IDs. Only stored
fields/answers/prices are loaded; unknown caller product/actor/provenance fields
are rejected. Missing products are reported explicitly. No snapshot token,
snapshot, audit write, price calculation, repair, revision, exposure or cursor
change is performed by validation/preview.

### Verification actually executed

The existing Node executable was checked before running tests:
`C:/Users/bohdan.bohelskyi/AppData/Local/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node.exe`,
**v20.20.2**. npm CLI at `C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js`
reported **10.9.0**. The prior process-local extensionless launcher and preload
guard method was reused from `%TEMP%/amber-pr2-node20`; every recorded test,
lint/npm and test-child process used that exact executable/version. Default
Node 22, persistent npm settings, packages/scripts, CI and Docker are unchanged.

Canonical Compose service definition was inspected: PostgreSQL 16 Alpine,
`127.0.0.1:55432`, fixed throwaway credentials, `tmpfs` data, no useful volume.
Only `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d postgres-test`
was started. Identity read confirmed database/user `amber_test` and PostgreSQL
**16.14**. Every integration process received both TEST_DATABASE_URL and
DATABASE_URL targeting that service; the established harness also sets the latter
before database-bound imports, and its subprocess helpers override only disposable
`*_test` database names on the same instance. No fallback instance was used.

Commands below ran from `server/` through verified Node 20 (`$node20`) and npm CLI
(`$npmCli`), with the guard and command-local PATH applied:

| Command/check | Final observed result |
| --- | --- |
| `& $node20 --test test/magento-v1-characterization.test.js test/magento-v1-categories.test.js test/magento-v1-goldens.test.js test/export-template-parity.test.js test/export-template-definition.test.js` before changes | **209/209**, comprising PR1A 83 + PR1B 126; zero skips/failures |
| `& $node20 --require ./test/setup-env.js --test test/export-template-persistence.test.js` | **8/8** |
| `& $node20 --test --test-concurrency=1 --test-name-pattern=PR2 integration-test/critical-flows.test.js` | **14/14 PR2 cases**; 138 unrelated cases intentionally filtered |
| `& $node20 $npmCli --script-shell='D:/Programs/Git/bin/bash.exe' test` | **481/481**, zero skips/failures; includes unchanged PR1A/PR1B suites |
| `& $node20 $npmCli --script-shell='D:/Programs/Git/bin/bash.exe' run lint` | Exit 0, zero errors; only the two pre-existing product-timeline unused-variable warnings |
| `& $node20 $npmCli --script-shell='D:/Programs/Git/bin/bash.exe' run test:integration` | **152/152**, zero skips/failures, PostgreSQL 16.14 |
| `git diff --check`, scoped tracked/untracked review | Passed; historical migrations, both export services/routes, mapper/serializer, client, dependencies and Compose unchanged |

Earlier runs identified the expected manifest/permission-count updates and missing
synthetic reference-fixture setup; those were corrected before the successful full
runs. Temporary Windows preload-path/log-name launch errors were corrected without
repository settings changes. One focused run had an HTTP fetch failure; subsequent
focused and complete runs passed on the same canonical instance. No test assertion,
immutability guard, output budget or parity difference was disabled. No verification
blocker remains. Client checks and Compose builds are not applicable because no
client or deployment files changed.

Persistence evidence includes draft → JSONB reload → compile/hash → publish →
JSONB version reload → compile/hash/evaluate for **all ten independent exact CSV
goldens**, using explicit synthetic repository-reference fixtures only in the
disposable DB. Independent connections and `pg_blocking_pids` barriers force
same-revision save, matching publish, both publish/edit orderings, and access
revocation/disablement races. Final rows/revisions/actors/version and audit counts
are asserted. Tests cover cross-family FK rejection, immutable publication
UPDATE/DELETE/TRUNCATE, completed retry after edits and by another actor, monotonic
versioning, unsupported/mismatching identities, metadata ABA, injected audit
rollback for all four mutations, authoritative preview inputs and no side effects.
Normal Magento and dedicated price snapshot CSVs remain byte-identical with
template selection metadata set. Fresh, actual 034 upgrade, old supported
checkpoint topology, failure rollback, repeat startup, and checksum/newline tests
all pass in the serialized suite.

### Oracle preservation and final boundaries

All eight HEAD blob SHA-256 values exactly match the preceding PR1B fingerprint
register. This committed checkout uses `core.autocrlf=true`, so working source-file
bytes have CRLF and do **not** share the earlier untracked LF-file SHA values.
Each working file was compared byte-for-byte with `git cat-file --filters HEAD:<path>`
and matched; CRLF→LF hashing also matches its HEAD blob and the historical register.
No oracle was rewritten. This source-checkout distinction does not normalize CSV
payload comparisons: all ten CSVs are compared as exact UTF-8 Buffers.

| PR1A artifact under `server/test/` | Actual unchanged CRLF working-file SHA-256 |
| --- | --- |
| `magento-v1-characterization.test.js` | `B884966F0C94CDF21BA759B8A4DDD9E4BC6889A3F301087A494AD61B96F234DF` |
| `magento-v1-categories.test.js` | `363723249F50AAA884B20DDB58FA776699571F81971939EBA0FD94EB63A86886` |
| `magento-v1-goldens.test.js` | `589CCF4B3F2E1C53759EB9137D89E9A99EA80A6D871CDE830D9853BB6E0CF37E` |
| `fixtures/magento-v1/contract.js` | `CEB7FF99E220CFF1F576D3266B0B8797380C071346E94ADA662B010D60BE6D4F` |
| `fixtures/magento-v1/expected-rows.js` | `BA083E0D59B1040C5C864FA21722B6213E900DE2760CE98D05687521379B14AD` |
| `fixtures/magento-v1/goldens.json` | `FC2DFFCE7C6CBFAD3F1D944F9B084A0423C3025F127872A9DB78749CD28D8A6B` |
| `fixtures/magento-v1/README.md` | `3F890D0910F95377FD67032B11AE67CDAF07230D60FCEF922ED7C02D8D8EED6A` |
| `fixtures/magento-v1/write-goldens.py` | `DAB8EE531B73EABB86CF74690A2927F6A40E0CEFD895FEC86DC0206B69DC3859` |

Only the started disposable service was stopped using
`docker compose -f docker-compose.yml -f docker-compose.local.yml stop postgres-test`
(exit 0). No main postgres/server/client service or persistent developer volume
was touched, and no useful-database/production/Magento operation occurred.
All changes are unstaged PR2 files on the original branch/HEAD; no staging,
commit, push, reset, clean, stash, merge, cherry-pick, rebase or branch switch.

PR3 snapshot binding and PR4 editor/controlled activation remain unimplemented.
The previously investigated missing recount fix remains a release prerequisite;
it was not reinvestigated or applied. Target catalog/alias lineage, frozen-rule
approval, KL.addit=0, narrow SV naming, the closed malformed-input difference
register, measurement units and fresh controlled Magento Check Data remain
acceptance prerequisites. PR2 completion is not rollout or Magento acceptance.

## PR3 addendum — opt-in published snapshot binding (2026-09-23)

This addendum supersedes the earlier statements that PR3 is unimplemented; all
earlier results above remain historical records. Scope is server PR3 only. The
client/editor, controlled selection in a useful environment, default dispatch
switch and Magento acceptance are not part of this change.

Actual initial checkout: `D:/Work/amber-sku-generator`, branch
`feature/magento-export-constructor`, HEAD
`b32555bacebb4e8e10e676f40470d49b9c9a93cf`, clean tracked/untracked status. Inventory
was 000–035, including committed `035_export_templates.sql`. No nested AGENTS.md
was present. No historical migration was edited; 036 was the next free number.

Before editing, the implementation checklist identified the existing public
preview/create routes, `getExportRows`/`resolveNewExportRange`, shared snapshot
coordinator, `establishProductSnapshotExposure`, PR2 `loadVersion`/`verifyVersion`
and source evidence, pure `evaluateBatch`, and the required `SESSION_SECRET`.
It separated request intent from effective binding and resolved range, and fixed
the order as access protection before RR; key/second lookup; activation; ascending
products; ascending revisions; new-mode cursor; parent/artifacts/audit. This was
an implementation checklist, not an additional approval or design phase.

### Implemented seams and invariants

- `036_export_snapshot_template_binding.sql` adds the nine nullable provenance/
  evidence columns and mechanical legacy discriminator documented in
  [the migration guide](DATABASE_MIGRATIONS.md). A complete/null check and composite
  publication FK enforce family/version/hash/evaluator/output/format identity;
  JSON intent/effective/range/cursor/selection evidence is checked for consistency.
  The replacement trigger retains every 031 payload, creator, confirmer and
  revision-evidence check. Old rows stay unattributed; normal confirmation works.
- `snapshot-binding.js` owns discriminator/intent normalization, tagged streaming
  canonical SHA-256, bounded purpose-separated HMAC tokens, strict signed claim
  parsing, shared completed-operation comparison and safe manifest provenance.
  Tokens bind full input hashes, not raw answers; issued timestamps are not
  operation identity. No process-random signing fallback or unsigned old token
  reuse exists. New creation TTL is 15 minutes; authentic matching completed
  retries bypass expiry and current-state checks.
- `published-capture.js` uses actual PR2 version verification and repository
  reference checks, without recapturing live visibility/requiredness. It binds
  all selected product facts, schema/reference evidence and the ordered legacy
  internal-column projection. Drafts, rates/matrices and revision/exposure-only
  changes are not mistaken for product-value changes. PR1 compiler, evaluator,
  projection, baseline definition, serializer and mapper remain unchanged.
- `export.service.js` remains the only normal-snapshot coordinator and store.
  Explicit `template-v1` capture uses RR; default legacy retains READ COMMITTED
  and its mapper. Both branches retain one idempotency namespace and artifacts.
  Captured exposure/revisions and confirmation logic are reused. SQL failures
  roll back before a fresh committed winner lookup. Only the actual key unique
  constraint is treated as a key collision; arbitrary 23505 is not masked.
- Authorization uses existing capabilities. Shared session access protection
  begins before RR, so an access-lock wait cannot freeze pre-revocation authority.
  It is held through capture and released on the same connection. Within RR,
  namespaced transaction key lock precedes second lookup, then selection, products,
  revisions and cursor. Access/activation writers keep their existing exclusive
  access boundary and never wait for product/export locks. Explicit active-version
  exceptions use protected selection evidence; non-active choices need activate.
  Completed retries need no activation authority. Downloads/confirmation remain
  independent of current evaluator, definitions and readiness.
- Existing public endpoints accept the opt-in fields and expose only safe
  manifest provenance. No new endpoint, cursor, queue, snapshot table, CSV column,
  artifact profile, filename or download URL is introduced. Legacy shapes stay
  unchanged. Existing creation audit adds contract/template/version IDs to its
  concise details; no new audit event type or repeated retry event is introduced.

The full implemented body/response examples, errors, signing coverage and retry
decision table are in [Exports — PR3](EXPORTS.md#published-export-snapshots-pr3).
New-mode template callers retain their original anchors (normally null) as intent;
preview-resolved anchors belong to immutable capture evidence. They must not add
returned anchors only at create. Existing legacy new-mode callers retain their
old requirement to send the returned anchors. No client was changed.

### Evidence by required boundary

`12-export-template-snapshots.cases.js` adds 20 cases to the serialized harness;
each case contains its stated sub-scenarios, not just an HTTP status assertion.

| Boundary | Actual evidence |
| --- | --- |
| Persistence/upgrade | Fresh suite plus actual 035 checkpoint with stored parent/artifact bytes, actor and captured revisions; injected 036 failure rolls back DDL/history; two subsequent startups; partial-null and mismatching composite FK rejection; immutable intent/version/hash/input evidence; successful legitimate confirmation |
| Authoritative preview/artifacts | Read-only state comparisons; all six groups in one parent; persisted baseline definitions for ten golden scenarios; stored and HTTP-downloaded UTF-8 Buffers; 105 represented products produce 210 rows with no admin-preview cap |
| Fingerprint invalidation | Final price, weight, complete answers including null/zero/blank, paired manual names, exclusion, SKU, category, schema link, internal catalog labels and unresolved source keys; bounded versus open upper range; cursor/new-range changes |
| Frozen/irrelevant state | Live requiredness/visibility and committed rate/matrix edits do not change frozen output; draft edits and revision-only changes do not stale a pin; explicit pin remains usable after selection changes with authority |
| Token/HTTP | Tampered, truncated, oversized, foreign-purpose and draft tokens; strict claim shapes; exact deterministic TTL boundary; separate process with stable configured secret; authentication, pending/disabled users, CSRF and delegated ordinary export permissions |
| Completed retry | Original snapshot after product/activation/cursor changes, confirmation and expiry; token omission; newer input/version evidence conflicts; cross-contract/profile/range/mode/explicit selection conflicts; original delegated creator and one generation event; child process with compiler deliberately unavailable still retries, downloads and confirms |
| Same-key concurrency | Independent pools plus `pg_blocking_pids` prove second request waits after establishing old RR; same binding and tokenless retry return one winner; same active intent with different effective binding conflicts; one parent, artifact set, original actor and one event |
| Cross-contract concurrency | Legacy-first and template-first race on one key; loser rolls back and conflicts, retaining exactly the winner's contract/artifacts/event |
| Capture concurrency | Product/name/price mutation first causes stale/serialization failure with no exposure; capture first stores coherent old bytes while mutation waits; activation-first/capture-first orderings; permission revoked while shared access lock is waiting is rejected before capture |
| Cursor/revisions | Normal confirmation versus new template creation in both orders; stable product → revisions → cursor ordering; no lost captured revisions or cursor regression; a held revision-row barrier and separately named Node/PostgreSQL processes force both newest-first and oldest-first price confirmations, with waiting backends verified through `pg_blocking_pids`; later normal/template confirmations retain revision 4 pending with confirmed high water 3 and one event/actor per snapshot |
| MVCC membership | New product commits after captured RR membership; first snapshot includes only its coherent original product, confirms only that cursor and leaves the inserted product unexposed and eligible for the next new preview |
| Atomicity | Parent insertion failure after exposure, second-artifact failure after first artifact insert, audit failure, and 64 MiB output-limit rejection all leave no partial parent/artifacts/exposure/audit; invalid represented product blocks the full two-product range |
| Stored reads | Downloads are read-only, remain identical after product/catalog changes, and confirmation never regenerates output; unsupported/unavailable current compiler cannot block stored operations |

### Golden-byte and oracle scope clarification

All ten original pure PR1 goldens still compare exact UTF-8 bytes through persisted
definitions in PR2, and all original PR1 unit oracle cases pass unchanged. Nine
golden scenarios can additionally be stored/downloaded byte-for-byte against the
literal original CSV. The tenth, `SV-escaping`, supplies `full_sku: " =SKU"` to the
pure evaluator. Existing migration 001 unconditionally trims SKU on INSERT, so
that exact raw product cannot be persisted through the authoritative database.
PR3's integration fixture therefore asserts the actual stored `=SKU` and adapts
**only those SKU occurrences** in its local expected Buffer; all other escaping,
Unicode, CRLF, quotes, manual subjects and output bytes remain compared exactly.
No oracle file, mapper, SKU trigger, database guard or expected-output register
was changed to conceal this distinction. This is a persistence-fixture constraint,
not a newly accepted evaluator/output difference. Literal 10/10 original CSV
identity at the storage boundary is not claimed.

The eight PR1A working-file SHA-256 values and canonical Git-blob SHA-256 values
match both PR1B/PR2 registers above. They were checked with SHA-256 and bytewise
`git cat-file --filters HEAD:<path>` comparison. All 36 historical migrations,
unchanged PR1/PR2 pure implementation/source files and the closed difference
register also match HEAD (53 protected files checked). Some historical migrations
are already LF files, so those match the raw blob rather than the CRLF checkout
filter; no file was rewritten and checksum policy is unchanged. CSV Buffer
comparisons do not normalize line endings.

### Runtime and verification environment

The prior user's absolute Node path does not exist in this Windows account. Its
same cache-relative executable exists at
`C:/Users/bohel/AppData/Local/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node.exe`
and reports **20.20.2**. The installed system npm CLI now reports 11.17.0, so an
official npm **10.9.0** archive was unpacked only into `%TEMP%/amber-pr3-node20`.
The prior method was reused: process-local PATH, extensionless Git Bash launcher,
and NODE_OPTIONS preload guard checking exact `process.execPath` and version in
every Node process, including npm/test/ESLint/Vite and integration subprocesses.
No system Node, persistent npm setting, project dependency or lockfile changed.

Only canonical `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d postgres-test`
was started. Identity query returned `amber_test`, user `amber_test`, PostgreSQL
**16.15** on the loopback-mapped 55432 service. Both TEST_DATABASE_URL and
DATABASE_URL were set before any tests/imports to the exact canonical throwaway
URL from AGENTS.md. Checkpoint subprocesses used the harness's disposable `_test`
databases on this same service. No alternative server, restored dump or useful
database was used.

### Commands and final observed results

The npm commands below used Node 20 explicitly, the temporary npm 10.9.0 CLI,
and `--script-shell='D:/Programs/Git/bin/bash.exe'` with the process-local guard.
Server commands ran from `server/`, client commands from `client/`.

| Command/check | Observed result |
| --- | --- |
| Baseline `node --require ./test/setup-env.js --test` with the three `magento-v1-*` oracle suites and three `export-template-*` PR1/PR2 suites | 217 passed, 0 failed/skipped, before implementation |
| Baseline `node --test --test-concurrency=1 --test-name-pattern=PR2 integration-test/critical-flows.test.js` | 14 passed, 138 unrelated cases intentionally filtered |
| `node --require ./test/setup-env.js --test test/export-snapshot-binding.test.js` | 5 passed, 0 failed/skipped; includes child-process verification and deterministic lifetime tests |
| `node --test --test-concurrency=1 --test-name-pattern=PR3 integration-test/critical-flows.test.js` | 20 passed, 152 unrelated cases intentionally filtered |
| Server `npm test` | 486 passed, 0 failed/skipped |
| Server `npm run lint` | Exit 0; only the two existing unused `sortOrder`/`sourceOrder` warnings at product-timeline.js:391 |
| Server `npm run test:integration` | 172 passed, 0 failed/skipped, including the original 152 and all 20 PR3 cases |
| Client `npm test` | 112 Node tests and 102 Vitest tests across 13 Vitest files passed; 0 failures/skips |
| Client `npm run lint` | Exit 0, no diagnostics |
| Client `npm run build` | Exit 0, Vite production build successful; no client source change or rollout |
| `git diff --check`, new-file whitespace checks and full scoped review | Passed; Git only reports normal LF→CRLF checkout warnings for the five new files |
| Protected SHA-256/byte checks | All eight oracle working/blob fingerprints unchanged; 53 protected files match HEAD, including all 36 historical migrations and closed differences |

Final full server runs followed the focused regressions and final code review.
Intermediate fixture issues (the pure escaping SKU's leading space and a test
query using the wrong matrix column) were corrected before these passing runs.
No oracle assertion, production invariant or evaluator budget was disabled.
No infrastructure blocker remains. There is no server build command. Docker
image build/Compose configuration checks were not applicable because deployment
files were unchanged. No restored-database, live activation, Magento Check Data
or import verification was run or claimed.

The only started disposable service was stopped with
`docker compose -f docker-compose.yml -f docker-compose.local.yml stop postgres-test`;
exit 0 and service status `Exited (0)` were verified. No other service/volume was
stopped, deleted or replaced. No useful database or production operation occurred.

Final repository state: same branch and HEAD as the baseline; 13 modified tracked
files and five new untracked files, all scoped to PR3 implementation, regression
coverage and maintained documentation. The index remains untouched. No staging,
commit, push, reset, clean, stash, merge, cherry-pick, rebase or branch switch.
Default export still uses the existing mapper and the dedicated price service is
unchanged. PR4/editor/client opt-in and operational activation stop at this boundary.
The missing recount fix and all previously documented business/target-catalog/
alias/frozen-rule/KL/SV/malformed-input/unit/Magento acceptance prerequisites remain;
they were neither reinvestigated nor implemented in PR3.
