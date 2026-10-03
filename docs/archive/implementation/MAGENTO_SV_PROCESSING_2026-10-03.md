# Missing SV processing answer and Magento mapping browsing

## Confirmed evidence and conclusion

The operator supplied read-only evidence for product `1368`, public article
`SV5111010`, category `SV`, schema ID `6`: `details.answers.stone_processing`
is **absent**, not numeric `0`, string `"0"`, or JSON null. The processing-key
search found only `additional_stone: 1` and no historical processing alias.
After name and size repairs, readiness reports only `kamin_obrobka`.
The published correspondence separately approves semantic `value_id=0`,
`sku_code=0`, route `SV.souvenir=value_id:5`, Magento option `6040`.

The exact remaining blocker is a missing authoritative product answer, before
binding resolution. This is not a truthiness loss of a supplied zero. The binding
can resolve zero, but there is no product semantic identity to resolve.

This is incomplete persisted evaluator input. It is **not demonstrated to be an
accepted historical encoding of zero**. The actual internal `full_sku`/`base_sku`
and immutable schema-6 question/option definitions were not supplied. A schema
database ID and a displayed label cannot establish their meaning. No production
database or real Magento was accessed. Whether that exact historical SKU could
independently prove zero remains unverified; no automatic reconstruction was added.

## Complete path and presentation discrepancy

1. `magento/sync-preview-db.js` supplies the stored product and raw
   `details.answers` to the planner. It does not pass the product-detail decoded
   answer map or the recount form's initial answers.
2. `export-templates/input-projection.js:readSource()` reads the exact answer
   key. Only explicit schema-bound declared aliases can supply alternatives.
   Absent processing yields `undefined`.
3. `export-templates/evaluate.js` preserves real numeric zero; `semanticKey`
   uses exact string identity for finite numbers/strings. The current contract
   accepts numeric `0` and canonical string `"0"`. Padded `"00"` and `" 0 "`
   are not canonical semantic keys. No normalization was changed.
4. `magento/binding-evidence-products.js:evaluate()` returns the processing
   evaluation error as issue field `kamin_obrobka`;
   `magento/sync-preview.js` emits `PRODUCT_EVALUATION_NOT_READY`. An approved
   zero correspondence does not turn that missing input into a semantic value.
5. `magento/integration-readiness.js:semanticReadiness()` builds correspondence
   rows from catalog/schema options and bindings, independently of a concrete
   product's answers. Its “Не оброблений камінь” / approved row proves a configured
   mapping, not that product 1368 supplied zero.
6. `product/product-decode.js:projectStoredProduct()` uses the product's own
   historical schema and normalized **stored answers**, without reconstructing
   answers from internal SKU text. Missing processing becomes `value_id:null`,
   `is_placeholder:true`, “Не обрано”. Normal Product Detail hides placeholders.
7. Before this fix, recount's client `getDecodedAnswerMap()` and server
   `buildProductAnswerContext()` converted every null decoded placeholder to `0`.
   That preselected the current real unprocessed-stone option, showing its label,
   even though nothing had supplied that semantic identity. It also made an
   operator's explicit selection of zero appear unchanged to recount validation.

Steps 6–7 are reproduced with a synthetic historical schema containing the
processing question. The supplied production evidence does not include schema
6's definition or the exact screen payload, so attribution of the observed
product label to that specific placeholder path remains conditional. The
catalog correspondence's independence from product answers and the missing raw
evaluator input are established independently of that limitation.

The existing `decodeStoredSkuAnswers()` can decode SKU code `0` to semantic
identity `0` when an exact schema and complete reconstruction establish it.
Synthetic tests preserve that distinction and demonstrate that an encoded code
cannot be supplied as a different semantic answer. This does not certify schema 6.

## Scoped fix and safe operator repair

Only SV stored-history processing placeholders whose persisted key is absent
remain absent in recount initialization and server source context. Existing
numeric zero, other historical decoded values, and other placeholder behavior
remain unchanged. There is no evaluator, planner, binding, SKU-generation,
pricing, migration, permissions, or Magento-write change.

An authorized operator opens the existing **Виправити характеристики** recount
workflow, explicitly selects the processing option based on verified product
facts, reviews the target SKU/characteristic/price preview, and applies through
the existing recount command (or the existing correction-request workflow where
direct apply is unavailable). No selection is inferred or preapproved. When the
operator selects zero, the reviewed change is absent → `0`, and the successor
stores semantic zero. Missing/unmapped input still fails closed.

Processing is not an allowed field of the informational in-place completion
command. Recount retains its existing successor/history/reservation behavior and
current target-schema validation. Stable public identity depends on the existing
activation state. The operator must review the actual preview and pricing
decision; this task does not apply a repair or enqueue any production write.
The confirmed published binding must remain unchanged.

## Regression coverage

Synthetic tests cover numeric semantic zero; `sku_code=0` independently of semantic
identity; canonical string `"0"`; semantic one → `6039`; exact stone route; zero →
`6040`; absent/null/blank/unknown/padded inputs failing closed; boolean rejection;
historical code-zero decode; a distinct encoded code not becoming an answer;
schema-bound alias acceptance only in its declared schema; and stored projection
versus raw evaluator input. The exact supplied absence is reproduced as an absent
JSON key, including its null historical projection and approved structural row.

Client/server recount tests prove absence stays unselected, explicit zero becomes
a real change, genuine zero remains zero, and unrelated categories retain their
behavior. The disposable PostgreSQL case removes processing from a saved product
while keeping its internal SKU, checks that only `kamin_obrobka` fails, proves
preview leaves database state unchanged, applies a reviewed zero selection,
checks stored successor zero/readiness/price, and preserves absent source history.
Repeated unchanged-zero recount remains rejected.

Mapping tests cover question/option/source-key/target-code search, including
`Не оброблений камінь` and `kamin_obrobka`; collapsed grouping; 20-header and
50-value DOM bounds; lazy technical details; contextual product/problem links;
exact target filter and clearing; approved/refused values outside default issues;
and no browsing-triggered decisions or writes.

## Browsing and verification

The full view remains secondary. Groups are collapsed by default and only one
group can expand. Search filters before rendering; pagination bounds group headers
and mounted values. Readiness navigation carries an exact Magento field filter
and includes relevant approved correspondence without opening unrelated rows.
Technical details still mount only when explicitly opened.

Completed checks:

- Narrow server regression: **52 passed** (planner/projection plus answer context).
- Focused client recount Node: **23 passed**; focused client Vitest: **33 passed**.
- Full server unit: **846 passed**; server lint passes with two existing unused
  variable warnings in `product-timeline.js`.
- Canonical disposable PostgreSQL suite: **417 passed**; focused SV case also
  passes. `postgres-test` was stopped afterward; no alternative database used.
- Full client Node: **166 passed**; Vitest: **551 passed across 57 files**.
- Client lint and production build pass.
- Local Edge fixture passes at desktop/mobile widths; **0 runtime errors,
  0 external requests, 0 unexpected fixture requests, 0 unexpected writes**.
- `git diff --check` passes. No dependencies, configuration, or migrations changed.

Implementation files: `MagentoMappingBrowser.jsx`, `MagentoCategoryDetail.jsx`,
`ProductMagentoAttention.jsx`, `SyncProblemsPage.jsx`, client `product-recount.js`,
server `product/product-answers.js`. Their focused client/server tests, the
`sv-create` PostgreSQL case/worker, and `test-magento-workspace-browser.mjs` changed.
Domain documentation records the scoped recount and browsing contracts.
