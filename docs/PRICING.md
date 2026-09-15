# Pricing

## Authoritative calculation

The server pricing service is authoritative. `pricing.service.js` is its entry point; calculation, context loading, read models, and administration commands live under `server/src/services/pricing/`. Calculation selects matching active scenarios by priority, resolves one- or two-dimensional matrix axes (including composite axes and weight bands), and applies matching modifiers.

Supported modes are:

- `per_gram_usd`: the positive matrix value is USD per gram and requires weight plus a usable USD/UAH rate.
- `fixed_uah`: the positive matrix value is raw automatic UAH before marketing rounding and can work without the exchange-rate provider.
- `category_default`: resolves according to current category/scenario context.

The empty-catalog seed creates formed and natural-calibrated scenarios for `CH`, `BR`, `NM`, and `KL`, plus a quality modifier. `uncalibratedPrices` exists in `data_config.js` but is not consumed by the current seed path; never assume those rows exist in PostgreSQL.

## Matrices and modifiers

A matrix cell is either a strictly positive decimal or absent:

- blank/missing input deletes the row and means no automatic price;
- zero and negative values are invalid and rejected by UI validation, service/API validation, and database constraints;
- zero must never be silently converted to null or another price.

Scenario, matrix, modifier, weight-band, rules, and schema changes are part of authoritative pricing context and stale existing previews. Pricing edits require `pricing.manage`; `pricing.view` is sufficient for read-only matrices/modifiers.

## Automatic and manual UAH pricing

Automatic calculation preserves separate meanings:

- `calculatedPriceUah`: raw result before marketing rounding;
- `autoPriceUah`: authoritative automatic result in stored details, marketing-rounded when enabled for the category;
- `totalPriceUah`/`products.total_price_uah`: chosen final price, automatic or manual;
- `manualPriceUah`: optional independently supplied manual result.

Marketing rounding selects its tier from the unrounded amount and then rounds: values through 100 are unchanged, then nearest 10 below 300, 50 below 5,000, 100 below 25,000, 500 below 100,000, and 1,000 thereafter. Never pre-round before selecting the tier. Preserve raw and selected automatic values through save, recount, repricing, audit payloads, and historical decode.

Each category has `marketing_rounding_enabled` (default `1`). Setting it to `0` skips marketing rounding for both automatic price modes; the selected automatic UAH amount uses the existing two-decimal storage scale, while `calculatedPriceUah` remains the raw calculation. The choice also applies to fixed-UAH prices when the exchange rate is unavailable. It does not turn automatic pricing into a manual override. The category setting participates in pricing-context fingerprints, so outstanding product/correction previews and repricing drafts become stale when it changes, even if the selected amount is unchanged. Existing product history is not rewritten; eligible active products change through the normal repricing workflow.

If no scenario, matrix cell, or usable automatic UAH result exists, preview exposes no positive automatic price. Save or correction then requires a separately parsed and validated positive manual UAH price. Those manual prices are user input, are excluded from the stale-preview pricing context, are revalidated at transactional write time, are not marketing-rounded, and retain decimals at the UAH storage scale. Invalid, non-finite, zero, or negative final prices fail closed.

Historical decode prefers stored calculated, automatic, manual, and final fields. Compatibility fallback for older products must not recalculate history from current configuration or treat a manual final price as an automatic result.

Correction requests may store a protected custom USD-per-gram basis. This value is always USD/gram and bypasses matrices and modifiers. Its final UAH price uses target weight, the authoritative rate, and the request's explicit rounding choice. Completed products retain the basis and provenance as automatic pricing. Exact manual UAH decisions remain manual and independent of automatic context and exchange rates; when normal automatic pricing is available, its raw and selected results remain in `calculatedPriceUah` and `autoPriceUah` as the historical baseline while `manualPriceUah` and `totalPriceUah` hold the exact manual decision.

The separate in-place price-change command uses the same persistence meanings. Automatic mode recalculates the unchanged existing product from its stored answers, calibration, category, and weight using the current authoritative pricing context and the category's normal marketing-rounding setting. It clears `manualPriceUah` and `customUsdPerGramBasis`, stores the normal calculated/automatic/final fields, and fails closed when no positive automatic UAH result exists. Its preview token binds the complete product state, pricing-context fingerprint, rate dependency, and result; apply recalculates transactionally, and an unchanged final UAH price is a no-op.

For Manual UAH the command recomputes the normal automatic baseline and stores no synthetic custom-USD basis. Its explicit marketing-rounding checkbox defaults off: off stores the validated two-decimal input exactly, while on applies the same authoritative tier algorithm to that input and stores the rounded final result in both `manualPriceUah` and `total_price_uah`. The immutable audit decision retains the entered amount and rounding flag alongside the authoritative final pricing evidence. The preview token binds the input, flag, product state, and final rounded result; apply recalculates them transactionally, and no-op comparison uses the final result.

For USD/gram, behavior is unchanged: the command stores the positive input as `price_per_gram` and in `customUsdPerGramBasis`, derives `total_price`, raw/selected UAH, `uah_rate`, and rate metadata server-side, and clears the manual price. The command preserves unrelated product details and removes obsolete repricing-batch ownership metadata because the in-place write supersedes that applied payload. It never treats `total_price`, `price_per_gram`, `uah_rate`, `calculatedPriceUah`, `autoPriceUah`, or `manualPriceUah` as a different unit or concept.

The same three modes are available to price-change requests. Request previews and completion share the direct command's calculation and preview-token semantics. Manual UAH price requests persist their explicit rounding flag; recount Manual UAH remains exact and keeps its prior validation. A pending request is calculation evidence only and cannot change the product or export state.

## Numeric storage and legacy zero prices

Relevant PostgreSQL scales include weight `NUMERIC(14,3)`, product USD/final values `(18,4)`, UAH `(18,2)`, exchange rates `(18,6)`, matrix prices `(18,4)`, and modifier factors `(12,6)`. The `pg` driver returns `NUMERIC` as strings; services convert to JavaScript `Number` at calculation/API boundaries. Full PostgreSQL arbitrary precision is therefore not preserved near JavaScript safe-integer limits; normal business-scale behavior is covered, but no explicit maximum business value is encoded.

Migration `016` deleted zero matrix cells as absent pricing and grandfathered existing products with `total_price_uah=0`. Those products retain zero plus `legacy_uah_price_unset=true`. Do not convert the stored zero to null: null could select today's automatic price and falsify history. The flag relaxes checks only for grandfathered rows. New saves/corrections still require a strictly positive final price, while legacy zero-price products remain decodable, recountable, and editable.

## NBU exchange-rate behavior

The USD/UAH provider uses the official NBU JSON endpoint with:

- four-second request timeout;
- 256 KiB response limit;
- status/JSON/payload validation;
- two retries after the initial attempt with bounded backoff;
- `NBU_RATE_OVERRIDE` for deterministic tests or controlled environments.

Successful rates are cached for the current Kyiv date. Concurrent retrieval is deduplicated inside one Node process. Last-known-good data persists in `exchange_rate_cache`, where conditional upsert ensures an older replica cannot overwrite a newer fetch.

When live retrieval fails, a cached/persisted rate may be returned with explicit stale source, age, and error metadata. The default maximum stale age is seven days and is configurable through `NBU_MAX_STALE_MS`; older fallback fails closed.
