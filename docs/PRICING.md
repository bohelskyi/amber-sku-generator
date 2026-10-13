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

The pricing workspace reads its category, question, option-label, condition, and axis metadata from `GET /api/admin/pricing/config`. This projection requires `pricing.view` and deliberately omits catalog mutability and SKU-schema publication state. The existing product-creation `/api/config` and catalog-administration `/api/admin/config` permission boundaries remain unchanged.

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

Business calculation and first-sync readers use only the persisted
`exchange_rate_cache` snapshot. They never call NBU or write the cache. The
background currency runtime refreshes once per period beginning at **04:00
Europe/Kyiv**, with a one-minute scheduling tolerance and startup catch-up. The
period follows Kyiv civil time, including DST; it is not a fixed UTC interval.
Before 04:00, the preceding period remains current. A successful weekend read
can retain an older official `rate_date`; refresh scheduling uses `fetched_at`,
not equality between the quote date and today's date. Requests explicitly name
the Kyiv calendar date. Malformed dates and future quote dates are rejected.

Migration `078_daily_exchange_rate_refresh.sql` adds only durable attempt/retry
metadata. One updater holds a PostgreSQL session advisory lock, rechecks due
state, and records the next permitted attempt before HTTP. Failed or interrupted
attempts are retried no earlier than 15 minutes later, including across restarts
and replicas. No transaction spans the NBU call. A short transaction publishes
the successful cache value and clears failure state together. Failure never
changes the last successful rate or its `fetched_at`. The normal older-fetch
overwrite guard remains in place. `NBU_RATE_OVERRIDE` retains deterministic
controlled-environment behavior and disables background refresh; it is not a
production default.

An overdue snapshot returns `source: last_known_good`, `stale: true`, its actual
age and a bounded failure/pending reason. Current snapshots retain `source: nbu`
for compatibility with existing price evidence. Pricing, recount, price-change
and repricing previews show a warning tied to the rate used by that preview.
The existing maximum age is unchanged: seven days by default, configurable via
`NBU_MAX_STALE_MS`. Missing, invalid or expired snapshots fail closed for
rate-dependent calculations without a foreground HTTP fallback. Independent
fixed/manual UAH paths retain their existing availability. A configured maximum
shorter than the daily interval can deliberately make rate-dependent pricing
unavailable until the next refresh; it does not increase polling frequency.

Each operation receives its own captured observation, and expiry is rechecked
when that observation is used, even if it was fresh when captured. Initial age
and future checks use the PostgreSQL read clock. Private process-local evidence
binds the exact returned snapshot; later checks add the greater of monotonic or
host-wall elapsed time from before the read. A fixed DB/host clock offset cannot
reject a valid snapshot, and a clock rollback cannot extend its lifetime.
Previously consumed age remains a private lower bound and keeps advancing.
Mutations invalidate that evidence; clones/public clock fields cannot carry it.
Background refresh changes no product, draft, price, audit receipt or Magento job. Committed
prices and pending delivery payloads keep their existing economic evidence.
Unapplied previews/drafts still use ordinary stale-token validation: a changed
rate can require a new review. This is not permission to pin an old rate through
a later unreviewed price change or to reprice products during delivery.
