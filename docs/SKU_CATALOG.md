# SKU and catalog

## Authority and data model

The server is authoritative for catalog validation, SKU generation, pricing context, preview, save, and decode. Client-supplied calculated SKU or price fields are never trusted.

The editable catalog consists of `categories`, `questions`, and `options`. The empty-database seed supplies initial defaults only; a deployed PostgreSQL catalog may differ from `server/data_config.js`.

Questions may be option-based or free text, required or optional, included in the SKU or informational, and conditionally visible. Options carry:

- semantic `value_id`, used by answers, rules, and pricing;
- digit-only `sku_code`, encoded into the SKU;
- a label, visibility/hide rules, and archive state.

Never conflate `value_id` with `sku_code`. Contextual labels may share a value/code only when they retain the same semantic meaning.

## Catalog invariants

- A category code becomes immutable once products, reserved SKUs, or published schemas establish its use. Name, weight behavior, and hidden-question behavior remain editable.
- Live SKU questions/options are a draft. Publish a new schema version for future products rather than mutating historical structure.
- A used option's semantic `value_id` cannot be changed. Archive it instead of deleting or reinterpreting history.
- A published schema cannot map one SKU code to different semantic values within the same question.
- Duplicate `(category_code, question.key)` writes are serialized by a transaction advisory lock and rejected. Existing legacy duplicates are not automatically cleaned because that requires an explicit data decision.
- Active/visible required SKU and non-SKU questions fail closed. Hidden, archived, or invalid options never become valid for new products.
- Numeric `0` is data, not a general empty sentinel.

## Schema versions and encoding

`publishSkuSchema()` captures an immutable snapshot in `sku_schema_versions`, `sku_schema_questions`, and `sku_schema_options`, then makes it the one active schema for the category.

Successful publication stores the authenticated local application user in nullable `published_by_user_id` and appends one `sku_schema.published` audit event for the created schema-version record in the same advisory-lock transaction. Event details contain only category code and version; historical and startup-captured V1 schemas remain unattributed and do not receive synthesized events.

- V1 has no marker, preserving pre-versioning SKUs.
- V2+ uses a compact marker such as `BR2/`.
- Decode also recognizes the short-lived historical `Vn-` marker.
- Questions encode in `sku_index` order with configured separators.
- Archived or currently hidden options remain in historical snapshots so old identifiers can decode.

Weight categories append rounded weight. Non-weight categories allocate a per-base sequence padded to at least three digits. Corrections or explicit variants use `-NNN` when the proposed SKU is already reserved.

## Permanent reservation

`sku_registry` is the permanent uniqueness ledger. Product inserts normalize and reserve the exact identifier. Archive and correction never release a SKU, because a historical identifier must never later identify another product.

Sequence allocation, variation resolution, and exact reservation are serialized and backed by database uniqueness/trigger protections. Preserve the existing lock order and final reservation check.

## Calibration

For seeded categories containing `raw_type`, startup ensures a required non-SKU `is_calibrated` question visible for natural material (`raw_type=1`). Its three numeric states are distinct:

- `0`: not calibrated;
- `1`: calibrated;
- `2`: semi-calibrated.

Never coerce this field to boolean. Preview-token compatibility treats missing calibration and `0` alike while preserving `1` and `2` distinctly; ordinary visible required-field validation still rejects a missing answer.

Decode reports calibration as known, stored, unknown, or not applicable. Price display is hidden only when calibration is unknown and the selected calculation actually depends on it.

## Authoritative preview and save

`buildProductPreview()` validates category/schema ownership, required weight, visible questions, option existence, visibility, and archive state. Depending on `skip_hidden_sku_questions`, hidden SKU questions are omitted from encoding or represented through the historical placeholder model.

Preview returns a `previewToken` binding normalized answers/calibration, weight, schema version, base SKU and mode, raw and rounded automatic prices, and effective exchange-rate context. Save requires the schema-version ID and token, then rebuilds preview inside its transaction. Any real answer, weight, schema, pricing, or rate change causes a stale-preview conflict.

Save locks sequence allocation when required, validates a positive automatic or independently supplied manual final price, reserves the exact SKU, and stores answer/schema/pricing metadata. Stored details preserve pre-rounding `calculatedPriceUah`, rounded `autoPriceUah`, and optional exact `manualPriceUah`; `products.total_price_uah` is the chosen final price. New products store the authenticated local user in nullable `created_by_user_id` and append one `product.created` audit event before that same transaction commits. Historical rows remain unattributed.

Archiving retains the existing product row and permanent SKU reservation, sets nullable `archived_by_user_id`, excludes the product from export, and appends one `product.archived` event in the same transaction. A missing or already archived SKU remains a failed/no-op path and does not create a success event.

## Decode and legacy compatibility

Decode finds the category by longest prefix, resolves the historical schema marker, parses encoded answers and suffix/variation, and overlays stored product context only where required for compatibility. Stored answers are accepted only when they reproduce the SKU; arbitrary stored details cannot redefine an identifier.

For known products, decode reports the stored historical final UAH value instead of recalculating from current pricing. Older rows have explicit compatibility fallbacks for missing calculated/automatic fields, but a manual final price must not be invented as an automatic result.

Historical placeholder `0` or a missing stored value can represent an omitted SKU question only when no genuine zero option exists and reconstruction still reproduces the identifier. A configured zero option remains real data. Unknown codes fail with structured diagnostics.

`ensureLegacySkuSchemas()` creates V1 snapshots and links unversioned products during upgrade. For categories with products, it combines stored answer keys with currently required SKU keys so later draft structure is not retroactively imposed on old identifiers.

Legacy products with `total_price_uah=0` retain that stored value and `legacy_uah_price_unset=true`; see [`PRICING.md`](PRICING.md). They remain decodable and recountable, while new products still require a positive final price.
