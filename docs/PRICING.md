# Pricing

## Authoritative calculation

`pricing.service.js` is authoritative. It selects matching active scenarios by priority, resolves one- or two-dimensional matrix axes (including composite axes and weight bands), and applies matching modifiers.

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
- `autoPriceUah`: rounded authoritative automatic result in stored details;
- `totalPriceUah`/`products.total_price_uah`: chosen final price, automatic or manual;
- `manualPriceUah`: optional independently supplied manual result.

Marketing rounding selects its tier from the unrounded amount and then rounds: values through 100 are unchanged, then nearest 10 below 300, 50 below 5,000, 100 below 25,000, 500 below 100,000, and 1,000 thereafter. Never pre-round before selecting the tier. Preserve raw and rounded values through save, recount, repricing, audit payloads, and historical decode.

If no scenario, matrix cell, or usable automatic UAH result exists, preview exposes no positive automatic price. Save or correction then requires a separately parsed and validated positive manual UAH price. Manual prices are user input, are excluded from the stale-preview pricing context, are revalidated at transactional write time, are not marketing-rounded, and retain decimals at the UAH storage scale. Invalid, non-finite, zero, or negative final prices fail closed.

Historical decode prefers stored calculated, automatic, manual, and final fields. Compatibility fallback for older products must not recalculate history from current configuration or treat a manual final price as an automatic result.

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
