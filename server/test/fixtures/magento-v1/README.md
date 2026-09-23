# Magento Products v1 — independent PR1A contract

Synthetic test assets only. No acceptance download, real product, restored dump,
live catalog, credentials, translation service or database is used. A passing
characterization records existing behavior; it does not approve questionable
business behavior. PR1B and the old/new evaluator parity gate remain open.

## Provenance and independence

Audited checkout: `feature/magento-export-constructor`,
`1bed5d2311761b603d7857949d576aeee9e831b8`, initially clean. The accepted six-group
implementation is present. Phase 0's `fa8570c` is historical, not this checkout.
Recent recount fix `7c803dc` is **absent**: `git merge-base --is-ancestor 7c803dc HEAD`
returns 1; `isOptionalPlaceholderAnswer` and its new recount tests are absent.
Older placeholder handling exists, but is not evidence that this recent fix landed.
No branch switch, merge or recount edit was made.

`contract.js` contains hand-specified synthetic answers, 41 semantic bindings and
31 literal dictionaries (30 V dictionaries plus AR sizes). Every entry is tested
as both a number and a string: 157 distinct dictionary entries, 196 entries when
counted at every group binding, 392 binding/value checks. CH count 9 and texture 8
intentionally produce category errors despite successful attribute mapping.
The flat synthetic catalog explicitly makes every declared question present,
optional and visible; allowed IDs come from these independent literal tables.
Its labels, SKU codes and archive flags deliberately disagree with output text.
Individual tests override question existence, rules, requiredness and size IDs.
This catalog is not a representation or approval of a deployed catalog.

`expected-rows.js` contains complete ordered headers and explicitly authored
expected base/EN cells for six groups and four extra cases. Absent properties mean
empty cells; `common`/`en` only share expected constants. Alternative cases reuse
reviewed expected cells, not mapper results. The category tests hold explicit
phrase tables and replace one expected path at a time; no second full mapper is
implemented. No fixture imports production constants or computes expected output
from product inputs.

Review performed against Phase 0 sections 3.1–3.5 and Appendices A–C **and** current
`magento-products-v1.js`, `csv.js`, `rules.js`, caller selection and manifest code.
All 164 ordered header positions and all 41 bindings were rechecked. A separate
read-only inventory comparison confirmed the independently specified tables match
all 30 current V dictionaries; actual AR output tests cover all 28 fixed sizes.
That audit did not write expected data and is not an oracle dependency.

`goldens.json` holds ten complete UTF-8 CSV strings with explicit escaped record
separators and embedded CR/LF. JSON source checkout line endings cannot change the
decoded expected bytes. Expected cells were authored first, then encoded offline
with Python's standard CSV writer using `write-goldens.py`; this tool never reads
production code or actual mapper output. Formula-neutralized expected cells in
the escaping fixture are explicitly authored, not classified by a copied rule.
The complete JSON was reviewed for headers, all cells, quotes, Ukrainian/×,
significant spaces, sparse EN, no BOM and no final newline. No golden was captured
from the exporter. The test compares UTF-8 Buffers directly and never regenerates,
parses/reserializes or normalizes actual CSV to pass.

## Verified behavior and compatibility register

Test names below are stable search terms in the three `magento-v1-*.test.js` files.
`goldens` means `magento-v1-goldens.test.js`; other names identify the test directly.

| Behavior / status | Evidence and expected assertion | Later decision or evidence gap |
| --- | --- | --- |
| Ordinary: six group headers, constants, base then EN, sparse EN | `independent complete fields and UTF-8 golden` for BR/NM/KL/CH/AR/SV; all 164 headers and every cell, `No`/`Yes`, both `simple` and same attribute set | Magento interpretation/import not tested |
| Ordinary: semantic IDs, not SKU codes or labels | `every semantic dictionary entry` (41 named tests), `live catalog labels/options`; exact fields for 392 number/string cases | Current non-AR option membership/archive state is ignored |
| Ordinary: BR/NM material, processing, texture, color, shape, style, NM extra | Category-only phrase tests compare complete ordered paths; natural/pressed names, extra 0/1/2, BR Shambala and distinct mixed-shape wording | No inferred measurement conversion |
| Quirk: NM bands and nonnumeric text | `NM bands`; each endpoint, fractional gaps, comma input, hex/exponent, arbitrary/NaN/Infinity text | Nonnumeric text passes unchanged; numeric gaps reject |
| Ordinary/quirk: KL dimensions and opaque identity | `KL current/legacy dimensions`; pedant-only, exact-only, priority, null/blank fallback, zero, arbitrary text, legacy/compact version and variation SKUs | No SKU decoding; informational-edit key limitations remain outside mapper |
| Quirk: KL addit zero | `KL addit` matrix and `KL-hidden-zero` full golden | Omitted/null/blank: no extra path, empty attribute; visible required absence errors. Present numeric/string 0: always adds `Default/Кулони/З інклюзом`; visible: `kulony_dodatkovo` unmapped error, no artifact; hidden: empty attribute, ready even if required. Present 1: same path; visible attribute `Інклюз`, hidden blank. Business approval unresolved |
| Ordinary/quirk: CH mappings and numbers | Dictionary/path tests, `CH invalid numeric`, `CH preserves`; count 0=`30`, count 9=`?` plus category error; texture 8=`Змішана` plus category error and provisional `undefined` path | Raw `rozmir_kameniu` retains comma spelling; calibration 0/1/2/3 remains untouched |
| Ordinary: AR names/category/SEO and attributes | `AR seven type branches`, all dictionary entries, `AR-mosaic` golden; 28 dimensions use × | Mosaic description intentionally differs |
| Quirk: AR size/glass postchecks | `AR size requires`, `AR absent glass`; known-but-unmapped size produces mapping error, unknown size produces two ordered errors on one field; hidden present size still fails | Missing glass defaults to `Без скла` without clearing prior required/missing-question errors; visible zero unmapped, hidden zero blank |
| Ordinary/quirk: SV dictionary/subtype paths, literal key `2` | All 11 SV bindings, category routing and dependent-question tests | Flat catalog can allow simultaneous subtypes; not a product-creation validity claim |
| Ordinary: Stone within SV; answer weight | `SV-stone` golden; fraction below/at/above all ten thresholds, different product weight, non-Stone blank fraction | No separate group or measurement conversion |
| Quirk: narrow SV automatic naming | `SV only key chain auto-names`; souvenir 6 only; all eight others still `manual_name_required` with concrete subtypes | Approved additional names remain a business decision |
| Ordinary/quirk: manual pair precedence | Same test and `SV-escaping` golden; pair trimmed, interior spaces kept, wins for key chain; partial/nonstring/whitespace pair falls back as a whole | DB constraints normally prevent malformed pairs; pure behavior alone is characterized |
| Ordinary/quirk: final price/history | `final stored price`; exact 1234.56, 2000.00→2000, Number precision/coercions; invalid/nonpositive/legacy zero yields exact price error and input stays unchanged | No fallback to calculated/auto/manual evidence; no financial representation change |
| Quirk: optional placeholder versus genuine zero | KL addit 0 unmapped when visible, AR glass 0 likewise; NM extra 0 empty but valid, CH count 0=`30`, SV processing 0=`Необроблений`; inputs not mutated | Export has no placeholder provenance inference; recent recount fix absent here |
| Quirk: current live catalog rules | `live catalog`, `all 41 question-existence`, dependent questions, hidden attributes/category/name tests | Future frozen rules differ deliberately; target live rules have not been inspected |
| Quirk: source-key references | `current source-key references`; renamed `2` question yields missing-question error, renamed optional answer silently blank; schema ID does not supply an alias | No frozen source identity/alias resolution implemented; real rename lineage unresolved |
| Quirk: malformed rules/coercion | `legacy malformed rules`; malformed JSON, scalar/array roots visible, malformed logical branches hidden, Number equality; object free text and array semantic IDs are coerced | Proposed strict publication/type rejection is not existing behavior |
| Ordinary/quirk: serialization | Dedicated exact-byte serializer test + escaping golden; embedded comma/quote/CR/LF, empty cells, spaces, decimal spelling | Formula sigils after space/tab/CR get apostrophe; after leading LF or NBSP do not. Numeric negative differs from string negative; do not claim universal spreadsheet protection |
| Ordinary: comparator sensitivity | Seven deliberately corrupt strings fail: constant, header, missing EN, decimal, CRLF, trailing LF, BOM | Small self-check, no source mutation framework |
| Quirk: provisional ordering/readiness | `already-selected interleaved`, `readiness preserves`; first **ready** group encounter, input order retained, product vs 2×row counts, invalid products omitted from artifacts but errors retained | Not a selector or snapshot approval. No deduplication of fields or repeated products. Stored manifest order differs |
| Quirk: missing SKU and free text | `required free text`; no separate SKU nonblank check; text fields do not use question gates | Pure permissiveness, not DB/API validation approval |

## Future and external boundaries

No evaluator, validator, frozen rules, aliases, publication, persistence, activation
or old/new parity comparison exists in PR1A. Future diagnostics such as
`QUESTION_MISSING` are **not** asserted as existing codes: most legacy errors have
only field/message, with existing lowercase `manual_name_required` preserved.

Selection/ranges/exclusions, locks, snapshot whole-range rejection, immutable
downloads, exposure, idempotency, confirmation and cursors belong to
`export.service.js` and existing `server/integration-test/11-magento-products.cases.js`
and `11-exports-schemas.cases.js`. The caller orders by product ID; pure inputs are
already selected. Stored manifest retrieval sorts BR/NM/KL/CH/AR/SV; the mapper's
provisional Map follows first ready encounter. No database/API/concurrency claims
are established by these new pure tests. Catalog loading/duplicate database rows
are not exercised; only already-built synthetic Maps are passed.

Remaining acceptance gaps: target live catalog and rename lineage, measurement
units, business approval of quirks/frozen rules, actual Magento Check Data/import,
and future evaluator differential parity. Historical Phase 0 verification and
operator acceptance remain historical evidence, not reruns.

## Reproduction

With Node 20 on PATH, from `server/`:

```text
node --test test/magento-v1-characterization.test.js test/magento-v1-categories.test.js test/magento-v1-goldens.test.js
npm test
npm run lint
```

Node 20 on Windows does not expand the package script's `test/*.test.js` itself.
Use an installed Git Bash for **this invocation only**, e.g. this checkout used:

```powershell
npm.cmd --script-shell='D:/Programs/Git/bin/bash.exe' test
```

Equivalent explicit-file full run in PowerShell (no configuration edits):

```powershell
$testFiles = @(Get-ChildItem -LiteralPath test -Filter '*.test.js' | ForEach-Object { $_.FullName })
node --require ./test/setup-env.js --test @testFiles
```

Offline golden authoring, only after reviewing expected cell changes, from root:

```text
python server/test/fixtures/magento-v1/write-goldens.py
git diff -- server/test/fixtures/magento-v1/goldens.json
```

Python is standard-library-only and is not required to run tests. Never replace
expected rows/goldens with mapper output. For untracked files, inspect contents or
`git diff --no-index -- /dev/null <file>`; normal `git diff` omits them.
