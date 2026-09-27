# Magento integration

The product sync preview and discovery client remain GET-only. A separate,
explicitly applied single-category command is documented below; it cannot write products.

The binding review CLI supports an explicit disabled-on-create status policy:
`approve --revision UUID --expected-revision N --actor-user-id ID --binding POLICY_REVIEW_ID --accept-review --reason "Create disabled; preserve update status" --policy initialize_create_only --create-value 2`.
This option is restricted to the base `product_online` ownership policy and is
stored in migration 041's existing policy evidence. Approved previews use native
status `2` on CREATE and omit status on UPDATE, preserving Magento's current value.
It does not approve inventory, websites, English store views or publish the draft.
Individual known label differences require explicit binding approval with a reason;
they never introduce a fuzzy mapping rule. SKU lookup remains exact; rename is unsupported.

Phase 1A provides an isolated **GET-only** connection and discovery layer for
Magento 2.4.6. It creates no HTTP routes, browser integration, outbox, schema cache,
or database migrations. Neither the client nor the probe imports PostgreSQL or
the existing product/export services. It performs no remote writes and does not
change save, recount, repricing, snapshots, acknowledgment, queues, or Held products.

## Server configuration

Set these only in the server process environment or the ignored root `.env`:

| Variable | Meaning |
| --- | --- |
| `MAGENTO_BASE_URL` | Store origin, e.g. `https://ambergalbin.store`; never `/admin/`, `/rest/`, a query, fragment, or embedded credentials. |
| `MAGENTO_CONSUMER_KEY` | Existing integration consumer key. |
| `MAGENTO_CONSUMER_SECRET` | Existing integration consumer secret. |
| `MAGENTO_ACCESS_TOKEN` | Existing integration access token. |
| `MAGENTO_ACCESS_TOKEN_SECRET` | Existing integration access token secret. |

All five absent/blank means `config.magento.configured === false`; application
startup remains valid. Any partial configuration fails closed. HTTPS is required;
explicit `localhost`, `127.0.0.1`, or `[::1]` HTTP origins are accepted only outside
`NODE_ENV=production`. Paths and URL normalization tricks are rejected.

Compose forwards these optional variables only to the server. Empty placeholders
are in [`.env.example`](../.env.example). Keep real credentials outside Git,
browser assets, `VITE_*`, command-line arguments, tickets, and captured logs.
The probe never needs credentials pasted into its command.

Authentication uses all four credentials with OAuth 1.0a, version `1.0`,
HMAC-SHA256, a fresh cryptographic nonce, and Unix seconds. It does not use a
standalone Bearer token. The signer applies RFC3986 encoding, sorts encoded
key/value pairs (including duplicate query parameters), and separates the signing
base URL from the query. See [Adobe OAuth authentication](https://developer.adobe.com/commerce/webapi/get-started/authentication/gs-authentication-oauth).

## Read interface

[`createMagentoClient`](../server/src/services/magento/client.js) takes parsed
server configuration, with optional `storeCode`, injected `fetchImpl`, and
`timeoutMs` (10 seconds by default, maximum 60 seconds). The centralized prefix is
`{origin}/rest/{storeCode}/V1/`; `all` is Magento's reserved global scope, not an
assumption about an installed store-view code. An operator may select a known
store-view code explicitly. No website, attribute-set, attribute, or option IDs
are hard-coded.

| Method | GET resource below `/V1/` |
| --- | --- |
| `getWebsites()` | `store/websites` |
| `getStoreGroups()` | `store/storeGroups` |
| `getStoreViews()` | `store/storeViews` |
| `getStoreConfigs()` | `store/storeConfigs` |
| `getCategoryTree(rootCategoryId)` | `categories?rootCategoryId=...` |
| `listAttributeSets(page = 1)` | `products/attribute-sets/sets/list` |
| `getAttributeSet(id)` | `products/attribute-sets/{id}` |
| `getAttributeSetAttributes(id)` | `products/attribute-sets/{id}/attributes` |
| `listProductAttributes(page = 1)` | `products/attributes` |
| `getProductAttribute(code)` | `products/attributes/{code}` |
| `getProductAttributeOptions(code)` | `products/attributes/{code}/options` |
| `findProductBySku(sku)` | `products` with an exact `sku` search filter |
| `getProductBySkuPathDiagnostic(sku)` | `products/{encodedSku}`; path behavior characterization only |

These resources follow the Magento 2.4.6
[Catalog routes](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Catalog/etc/webapi.xml)
and [Store routes](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Store/etc/webapi.xml).
List methods send `searchCriteria[pageSize]=100` and an explicit current page.
They return the actual JSON metadata for future server-side discovery/binding
work; they do not persist it or reinterpret Amber semantic `value_id` values.
The supported product lookup sends one `searchCriteria[filter_groups][0][filters][0]`
filter with `field=sku`, the unmodified requested SKU as `value`, and
`condition_type=eq`, plus `pageSize=2` and `currentPage=1`. It returns one
product only when the response has `total_count=1` and its sole item has the
exact requested SKU. Zero results return `MAGENTO_PRODUCT_NOT_FOUND`; multiple
exact results return `MAGENTO_PRODUCT_AMBIGUOUS`; mismatched or inconsistent
responses fail closed.
The existing template evaluator and Magento v1 CSV mapper remain unchanged.
Future bindings and a REST payload adapter must stay separate from those semantic
identities; future synchronization still requires a local transaction, durable
outbox, worker, read-after-write verification, and exact acknowledgment.

Only named GET methods are exposed. There is no public arbitrary URL/request
method, request body, or mutation method. Redirects are rejected without following
them; there are no automatic retries. AbortController bounds headers and body
reads, JSON content type/parsing is explicit, and each response is limited to
8 MiB. Integration errors expose fixed `MAGENTO_*` codes/messages and, when
available, a numeric HTTP status. Raw bodies, remote messages, underlying errors,
URLs, headers, OAuth signatures, and credentials are not included in errors/logs.

## Operator probe

After code review and deployment, run inside the server environment:

```sh
docker compose exec server npm run magento:probe
docker compose exec server npm run magento:probe -- --sku "KL3/11131351005"
```

For a direct server checkout, run the same npm commands from `server/` without
the `docker compose exec server` prefix. `npm run magento:probe -- --help` lists
options without connecting. The probe loads root `.env` without overriding the
process environment and requires no database/OIDC configuration.

Default output uses the existing structured JSON logger: configured yes/no,
website/group/view/config counts, attribute-set count (up to 20 numeric IDs), and
total product-attribute count. It paginates lists up to 100 pages/10,000 records,
rejecting inconsistent totals, duplicate identities, or premature empty pages.
It does not dump raw records. Unconfigured is a successful diagnostic with
`configured: false`; invalid config, failed requests, unexpected response shapes,
or exceeded bounds exit nonzero.

Optional `--attribute-set ID` reads that set's assigned attribute count.
Optional `--attribute CODE` reads metadata and option count. Each flag may repeat
up to 20 times; use discovered IDs/codes, not assumed mapper IDs. Option counts
include any empty-choice entries Magento returns. `--store-code CODE` chooses
scope. No options or sets are modified.

Only an explicit `--sku` triggers one product lookup, after discovery. Its output
contains the requested SKU, exact returned-SKU match, numeric product ID,
attribute-set ID, and status. A mismatching returned SKU fails the probe. Remote
names, labels, custom attributes, headers, and raw responses are never printed;
there is no `--json` raw-dump mode. Failure output is fixed and sanitized.

The first production probe found that ordinary SKU `SV112423003` succeeds through
`GET /V1/products/:sku`, while the encoded path
`GET /V1/products/KL3%2F11131351005` returns HTTP 401 during Magento 2.4.6
OAuth signature validation. The supported lookup therefore uses
`GET /V1/products` with an exact SKU query filter. The slash stays in the Amber
SKU and travels only in the query value. This is a Magento compatibility
workaround, not an Amber SKU rewrite; SKU rename/update is not implemented.

The path-specific diagnostic method still characterizes URL encoding:
`KL3/11131351005` becomes one path segment `KL3%2F11131351005`. The signer
remains unchanged. For both routes, the exact serialized URL is signed and
passed to fetch.

### Verified live Phase 1A evidence

The operator's completed read-only probe of Magento 2.4.6 reported 2 websites,
2 store groups, 4 store views, 3 store configs, 10 product attribute sets and
141 product attributes. Discovered attribute-set IDs were
`141, 4, 142, 154, 152, 144, 143, 145, 151, 150`; these numbers alone do not
establish any Amber category correspondence.

Normal SKU `SV112423003` resolved to product ID `3085`, attribute-set ID `151`,
status `1`. Slash SKU `KL3/11131351005` successfully resolved through the exact
query-based lookup to product ID `5509`, attribute-set ID `144`, status `1`.
The path-based route remains diagnostic only. This is operator-supplied live
evidence, not a production call made by the automated tests or schema-audit
implementation work. Unit tests continue to use synthetic credentials and
injected fetch only. Neither SKU rewriting nor signer changes are needed.

## Read-only schema audit

With the same five Magento environment variables configured, run from `server/`:

```sh
npm run magento:schema-audit
npm run magento:schema-audit -- --store-code en --output /secure/evidence/schema-audit.json
```

Use `en` only if discovery establishes it is the intended live store-view code;
the default scope is Magento's reserved `all`. The audit does not infer which
view is Main or EN. `--help` makes no network requests. In the deployed server:

```sh
docker compose exec server npm run magento:schema-audit
```

The default artifact is repository-root
`.artifacts/magento/schema-audit-<UTC timestamp>.json`, already ignored by Git.
In a container this path is inside the container; copy it to durable operational
storage before replacing the container, or use an explicit mounted output path.
`--output` accepts an explicit path (relative paths resolve from the working
directory). Parent directories are created; existing files are never overwritten.
Only a successfully completed audit is written. The concise structured console
summary includes the path, schema counts, exact set-match count and diagnostic
counts, not schema labels or options. No artifact is automatically committed.
These files are **operational evidence, not repository configuration**; keep
explicit output paths outside tracked source files.

[`schema-audit.js`](../server/src/services/magento/schema-audit.js) owns discovery,
normalization, consistency checks and comparison. The CLI only handles arguments,
configuration, artifact writing and summary/error logging. It reuses the Phase 1A
named GET-only client and never requests product records, imports PostgreSQL,
persists bindings, or modifies Magento. There are no migrations, outbox, rename,
save/recount/repricing/export changes or evaluator business-rule changes.

The report contains:

- `storeTopology`: website IDs/codes/names/default groups, group website/root
  category/default store/name/code, and view website/group/code/name/active state
  where exposed. No raw store configs or URLs are retained.
- `attributeSets`: actual IDs and exact names, optional sort/entity metadata, and
  assigned attribute codes for every set.
- `attributes`: allowlisted identity, label, input/backend type, scope,
  required/unique/user-defined/visible/search/filter flags where exposed. Every
  select/multiselect has its actual options and option count (including the empty
  choice), with opaque string `value`, exact `label`, `isEmpty`, and optional sort
  order/default flag. Only value `""` is empty; numeric/string zero remains data.
  Boolean attributes and every existing mapper target also have their options
  queried, including custom sources; empty lists on text fields are not label
  mismatches. Magento core internal EAV attributes can legitimately return
  `frontend_input: null` (for example, the 2.4.6
  [Downloadable attribute setup](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Downloadable/Setup/Patch/Data/InstallDownloadableAttributes.php)
  defines an empty input). The audit retains that `null` in the normalized schema.

  Product metadata follows the Magento 2.4.6 service-contract return types:
  `is_filterable`, `is_filterable_in_search`, `is_visible`, and `is_user_defined`
  accept JSON booleans or contract-permitted `null`; `is_required` accepts only a
  JSON boolean when present. Fields such as `is_unique`, `is_searchable`, and
  `is_visible_on_front` are `string|null` in those interfaces and remain strings
  here. Contract-permitted nulls are omitted from the bounded report. See
  [Catalog EAV attribute](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Catalog/Api/Data/EavAttributeInterface.php)
  and [EAV attribute](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Eav/Api/Data/AttributeInterface.php).
- `mapperSources` and `mapperAttributes`: code-backed source question keys/product
  fields, every target column, group/row use, existence by exact attribute code,
  input type, option availability, set membership, dictionary output evidence and
  source IDs. Headers and values come from the existing materialized system
  definition; no second long target/dictionary list is maintained.
- `mapperAttributeSetComparison`: BR/NM/KL/CH/AR/SV and SV's conditional Камінь
  output names matched **exactly** to actual Magento set names. Zero/multiple
  matches remain missing/ambiguous; numeric IDs and fuzzy names are never guessed.
- `optionComparisons`: exact output-label candidates, separate Amber `amberValueId`
  and Magento `candidateOptionIds`, duplicate labels, unmatched mapper values,
  extra Magento options and explicit empty choices. Options themselves are stored
  once in `attributes`. Literal and numeric-band labels are also inspected.
- `unmappedMagentoAttributes` and `diagnostics`: unused attribute codes and stable
  review codes `ATTRIBUTE_SET_NOT_FOUND`, `ATTRIBUTE_SET_AMBIGUOUS`,
  `ATTRIBUTE_NOT_FOUND`, `ATTRIBUTE_FRONTEND_INPUT_MISSING`,
  `ATTRIBUTE_NOT_IN_EXPECTED_SET`,
  `OPTION_LABEL_AMBIGUOUS`, `MAPPER_VALUE_NOT_IN_MAGENTO`,
  `MAGENTO_OPTION_UNMAPPED`.

An attribute can be valid schema while lacking metadata needed to assess an Amber
mapper target. `ATTRIBUTE_FRONTEND_INPUT_MISSING` flags an existing mapper target
with null input metadata for review; unrelated internal attributes do not cause
that finding or abort discovery.

Differences have severity `review`, not an automatic error classification. CSV
control fields (routing, website, product status/type and inventory columns) are
included by literal name but their absence does not assert a missing EAV
attribute; this is not a CSV-to-REST field adapter. Exact matching does not trim,
translate or case-fold labels. Blank mapper output never binds to an empty option.
Duplicate labels retain all candidate option IDs. Dynamic text is marked and is
not enumerated: “unmapped” means absent from the code-backed finite output values,
not proof that no product could emit it. All possible output branches are
inspected without running business conditions; membership findings, particularly
SV versus Камінь, need operator review.

Label matches are **proposals/evidence, never semantic bindings**. Amber remains
authoritative for question/value meaning. The future boundary is Amber semantic
question/value → explicit Magento binding → installation-specific attribute code
and option ID; the template evaluator retains business transformations. This audit
reads no deployed Amber catalog, saved draft or publication. Its empty-catalog
materialization inspects code syntax only and makes no claim that dictionary IDs
are approved current/historical Amber values. Persistent-binding design still needs
that source evidence, the actual intended template/publication, operator-confirmed
store roles/locales, and decisions for missing/duplicate labels and set membership.

Ordering is deterministic and schema strings are preserved. The artifact omits
raw responses/headers, credentials and unrelated customer/product data. Reflected
OAuth credentials or Authorization text in allowed schema strings fail closed
instead of being redacted into misleading evidence. Malformed shapes, conflicting
attribute identities/metadata, duplicate IDs or inconsistent pagination fail the
audit with sanitized errors and no new artifact. Lists are bounded to 100 pages
of 100 records, options to 10,000 per attribute, aggregate options and memberships
to 100,000 each, and compact report JSON to 64 MiB (pretty-printed files are larger).
Failure logs now identify the audit `stage` and `entityType`, with a safe numeric
`entityId`, strict `entityCode`, parent `attributeSetId` or bounded `index` when
available. Attribute metadata validation can add a fixed `field` name and a
`valueShape` category (`missing`, `null`, `string`, `number`, `boolean`, `array` or
`object`). Nullable optional Magento fields remain optional; the audit does not
substitute an attribute-detail response for the global list. These fields
localize a malformed response without accepting it or
printing Magento labels, names, messages, payloads, URLs or OAuth data. The log
does not contain a partial audit artifact; a failure still exits nonzero.
Remote schema changes during sequential GETs cannot be made into an atomic
snapshot; repeat the audit during a stable configuration window if needed.

Production cutover through 039/040 and selector v1 activation are already complete
according to the Phase 1A brief. This probe performs no cutover, PostgreSQL writes,
queue draining, export confirmation, or Held-product actions. Do not rerun cutover
as part of deploying or probing this integration.

## Read-only binding evidence audit

After reviewing/deploying the implementation, run manually from `server/` in the
configured server environment (existing database configuration plus the five
Magento variables above):

```sh
npm run magento:binding-evidence-audit
npm run magento:binding-evidence-audit -- --template-version selected
npm run magento:binding-evidence-audit -- --template-version 12 --output /secure/evidence/binding-evidence.json
```

The default audits the code-backed system mapper against the current database
catalog, matching default export dispatch. `--template-version selected` audits
the selected immutable publication; a numeric ID explicitly chooses a publication.
Its stored hash/evaluator/output identity is verified before use. The report also
records activation metadata: selection alone does not switch the default exporter.
Drafts are not treated as publications. `--help` connects to neither service.

The CLI writes a new repository-root
`.artifacts/magento/binding-evidence-audit-<UTC timestamp>.json`, never overwrites,
and prints only a bounded count summary and artifact path. Artifacts are ignored
operational evidence, not configuration or fixtures to commit. The existing live
schema-audit artifact is useful for operator review but is not an implementation
input; each binding audit discovers the live schema again.

The dedicated `binding-evidence-*` services read current `questions`/`options`,
published `sku_schema_versions`/questions/options, export-template activation and
an explicitly requested publication, stored product answers, and prior export
exposure used only to prioritize samples. Local reads use one repeatable-read
`READ ONLY` transaction; the CLI connection also defaults to read-only. No startup,
migration, seed, lifecycle mutation or advisory-lock path runs. The transaction
finishes before remote reads. Current/published presence, option archive and
visibility rules, question kind and version evidence stay separate. Presence does
not mean that a conditionally visible value is available for every product.

Semantic `value_id`, encoded `sku_code`, Amber labels, evaluated output strings,
and Magento option IDs/labels are retained as distinct evidence. Actual product
outputs use the existing compiled evaluator and source-support projection.
Definitions and dictionaries are introspected, not copied into an alternate
mapper. `templateReachability` distinguishes blocked entries from conditional
possibilities; it is not a claim that every dictionary entry occurs in a product.

Mapping strategies distinguish:

- `semantic_option`: finite semantic dictionary outputs with exact option
  candidates and current/historical semantic provenance;
- `dynamic_exact_label_option`: information/product data needs a future dynamic
  option resolver; a finite semantic binding table cannot represent its domain;
- `numeric_band_option`: the evaluator generates a range label before option
  resolution, including its existing outside-range behavior;
- `scalar`: text/number output needs no option binding;
- `constant_option`: an enumerated option output has no Amber semantic identity;
- `transport_control`: CSV routing/inventory fields, visibility, and native
  boolean metadata require a future REST translation. These do not produce
  ordinary missing-EAV/semantic-option diagnostics merely because their CSV
  spelling differs. The report describes translation requirements without
  implementing a write adapter.

Route analysis follows the actual `attribute_set_code` expression, including the
SV stone decision, plus captured question visibility and output conditions. It
conservatively distinguishes provably inapplicable targets from possible outputs.
Unknown conditions remain possible. Only evaluated populated sample fields produce
`ATTRIBUTE_NOT_IN_SELECTED_SET`; failed product evaluations are explicitly
provisional. Neither the five SV fields of interest nor any attribute-set ID is
assumed to require membership.

Up to three deterministic active local candidates per template route are tried,
preferring prior export exposure, uncorrected and exportable products. Exposure
does not prove Magento import. The audit uses exact query-based SKU GETs and
stops at the first found counterpart per route. No Magento product enumeration
occurs. Samples retain local identity, predicted/actual set, status/visibility,
only relevant native values, resolved option labels and evaluator output. Two
found products from distinct categories at most also receive GETs under active
`ua`/`en`; inactive `ru` is not sampled. Scope differences are review evidence;
equal `all`/`ua` values do not prove that a blank CSV store-view row targets `ua`.

`knownCases` explicitly inspects `KL.addit=1`, `AR.size=28`, and `CH.count=9`
using fresh catalog/schema/mapper/option observations and total/current stored
answer usage counts. KL's operator-reported option `6047` is reread as evidence,
never installed as a binding. Exact matches remain proposals. Single-edit or
adjacent-letter spelling candidates are review-only; different measurements or
counts are not spelling drift. No label or `?` value is corrected or reinterpreted.

Stable review diagnostics include `AMBER_CURRENT_VALUE_NOT_IN_MAGENTO`,
`AMBER_HISTORICAL_VALUE_NOT_IN_MAGENTO`, `LABEL_DRIFT_REVIEW_REQUIRED`,
`MAGENTO_OPTION_WITHOUT_AMBER_SEMANTIC`, `DYNAMIC_OPTION_RESOLVER_REQUIRED`,
`ATTRIBUTE_NOT_IN_SELECTED_SET`, `ATTRIBUTE_NOT_APPLICABLE_TO_SELECTED_SET`,
`PRODUCT_ATTRIBUTE_SET_MISMATCH`, `MAGENTO_PRODUCT_NOT_FOUND`,
`STORE_SCOPE_VALUE_MISMATCH`, and `SEMANTIC_IDENTITY_AMBIGUOUS`. Additional codes
identify missing local samples/scopes, unavailable attribute/set metadata,
unevaluable products, product value differences, and Amber values without an
enumerated mapper output. Magento-only options on dynamic targets are marked
`dynamic_coverage_unknown`, not asserted to be broken mappings.

The snapshot limits current/historical joined metadata and schema-version reads
to 50,000 rows each, route plans to 24, and the complete compact JSON to 64 MiB.
Existing Magento schema limits still apply. Malformed remote product shapes and
reflected credentials/OAuth data fail closed, with fixed sanitized errors and no
artifact. Usage counts inspect stored semantic answers; they do not infer IDs
from SKU digits or claim decoded historical equivalence. Remote observations are
sequential and cannot provide a cross-system atomic snapshot.

No PostgreSQL or Magento mutation, binding persistence, migration, export change,
sync/outbox, rename, retry worker or UI is introduced. Persistent bindings and any
migration 041 require a later review of the generated evidence, chosen template,
store-role semantics, dynamic resolution policies, historical identity cases,
label drift/missing options and genuinely populated SV membership gaps.

### Bounded compatibility evidence mode

After reviewing binding evidence, operators can investigate the six observed
compatibility questions without creating bindings or choosing write policies:

```sh
cd server
npm run magento:compatibility-evidence-audit
# Same entrypoint; publication/output options remain available:
npm run magento:binding-evidence-audit -- --mode compatibility
npm run magento:compatibility-evidence-audit -- --template-version selected
```

This mode reuses the binding audit's database snapshot, catalog/publication
evidence, compiled evaluator, fresh schema discovery, exact query-based SKU GET
client, redaction checks and exclusive artifact writer. Its ignored, immutable
output is `.artifacts/magento/compatibility-evidence-audit-<UTC timestamp>.json`
at repository root. It is operational evidence, never repository configuration.
`--help` performs no external reads. Do not run the live audit as an automated test.

Candidates are ordered by ascending local product ID. Current means `active`
with no correction successor and a nonblank SKU, following the existing
product-information meaning of active/uncorrected. Limits
are fixed in code and cannot be raised through CLI arguments:

| Investigation | Local candidate cap | Exact SKU attempt cap | Found cap |
| --- | ---: | ---: | ---: |
| SV stored `souvenir=5` | 40 | 40 | 20 |
| CH with both stored bead dimensions | 40 | 40 | 10 |
| AR stored `size=28` | 40 | 40 | 40 |
| AR stored `size=29`, `30`, `31`, each | 3 | 3 | 3 |
| KL stored `addit=1` | 40 | 40 | 10 |
| SV subtype, requiring both actual evaluated outputs and ready evaluation | 100 | 40 | 10 |
| Store ownership, each of BR/NM/KL/CH/AR | 10 | 10 | 2 |

At most 319 candidate rows are loaded. There are at most 259 all-scope product
lookup attempts plus 20 `ua`/`en` GETs (279 product GETs total before cache reuse).
Found and not-found lookups are cached across investigations. Existing schema
GET limits are separate. Magento is never remotely enumerated. Each investigation
reports eligible local counts, examined/skipped candidates, attempts, found and
not-found counts, unexamined counts and its stopping reason. AR usage counts
include all stored products and current products separately, independent of the
bounded witness sample. A cap or missing sample limits the conclusion; it does
not establish absence across the full catalog.

The report records SV predicted sets from actual evaluation, actual set
distribution (including observed 151/154/other IDs), eight selected field values,
resolved option labels, membership in both sets, and field-presence patterns.
Those reported IDs are observations to investigate, never route rules. CH
comparisons distinguish `exact`, `numeric_equivalent`, `rounded`, `different`,
and unavailable/non-numeric evidence. Rounding means only that the observed
number equals the nearest integer of the local number; no rounding policy is
approved. Direct/reversed dimension orientation is separate from size-text
orientation; equal axes remain ambiguous.

AR sizes 28–31 retain semantic IDs, current/published `sku_code` and labels,
usage counts, enumerated mapper outputs/reachability, actual evaluated witnesses
and live options. Current-label candidates without enumerated mapper output are
explicitly distinct evidence, not invented output. Alternative size observations
search only `name`, `meta_title`, `description` and `short_description` for the
enumerated size text (normalizing multiplication separators), retaining matching
field names rather than dumping those texts. No match is not proof that no other
representation exists. KL reports agreement/exceptions to the operator-reported
6047/`Інзклюз` convention. SV subtype aggregates exact, mismatch and unresolved
comparisons; branch eligibility is evaluated, not reimplemented.

Store observations retain only `name`, `meta_title`, `meta_description`,
`description` and `short_description` under `all` and active `ua`/`en`. Equality,
English differences, template matches and nonempty Magento values differing
from template output are `field_ownership_evidence`, not automatic errors.
REST GET equality cannot prove whether a store-view value is an explicit
override or inherited from global scope. Non-ready evaluator outputs remain
provisional. Unknown option IDs and ambiguous set names do not become matches.

No database/Magento writes, mapper changes, persistence or migration 041 are
introduced. Attribute-set convention, dimension orientation, missing sizes,
label drift, subtype repairs, store-field ownership and persistent binding design
remain decisions for a later review of this evidence.

## Phase 1B.2a: persistent binding foundation

Migration [`041_magento_binding_revisions.sql`](../server/migrations/041_magento_binding_revisions.sql)
adds installation-specific, versioned bindings. It contains schema only: no live
IDs, credentials, template seeds, default policies or approved decisions. Nothing
contacts Magento during migration/startup. The earlier audit descriptions above
describe their read-only phases; their artifacts remain evidence, not configuration.
**No Magento write path, product synchronization, outbox, retry worker or client UI
exists in this foundation.** Exports, evaluator output, SKU allocation, pricing,
recount and repricing do not read the binding tables.

### Persistence and immutable identity

| Table | Responsibility |
| --- | --- |
| `magento_binding_revisions` | Installation key and SHA-256 origin identity; exact immutable template publication identity; schema/topology fingerprints and observation time/scope; draft counter, publication version, local-user attribution and timestamps. |
| `magento_binding_schema_sets` | Observed installation set ID and display name. |
| `magento_binding_schema_attributes` | Observed code, installation attribute ID and allowlisted metadata. |
| `magento_binding_schema_options` | Observed option ID and label, scoped to its attribute. Empty-choice observations are retained but cannot be bound. |
| `magento_binding_schema_members` | Observed set/attribute membership. |
| `magento_binding_schema_stores` | Normalized website/group/view topology; no configs, URLs or credentials. |
| `magento_binding_routes` | Stable Amber semantic predicates/key, evaluator-predicted set name as evidence, explicit enabled scope, independently chosen set ID, review state and bounded evidence. |
| `magento_binding_attributes` | Route/row/evaluator target, strategy, EAV attribute code or distinct native transport target, and review state. |
| `magento_binding_options` | Explicit semantic or evaluated-output source identity, chosen option ID and review state. |
| `magento_binding_field_policies` | Separate ownership decision and review state; global scope or a foreign key to the observed store-view ID/code. |

Composite foreign keys pin the complete template ID/version/hash/evaluator/output/
format tuple to one `export_template_versions` row. Creation requires an existing
publication; implicit capture of today's system mapper is deliberately unsupported.
An operator must explicitly prepare/review/publish a template first. The definition
is reused from that immutable publication, never reconstructed from labels.

The service accepts an explicit normalized GET-schema observation and records its
time, scope, deterministic fingerprint and detached normalized rows. It verifies
the stored observation fingerprint again on read/publication. A changed observation
or template requires a new draft; draft binding updates cannot replace either.
The caller supplies a stable installation key and a validated origin; only its hash
is retained, and a key cannot be reused for another origin through the service.
Moving an installation's origin needs a later explicit migration/identity decision.

All binding children have revision-scoped primary/unique keys and restrictive
foreign keys. Option source-kind checks require semantic group/question/integer
`value_id` **or** evaluated domain/output identity. Cross-revision parents and
wrong-attribute option IDs are rejected by composite foreign keys. Duplicate
semantic identities, evaluated identities, target use within a route/row, and
effective field-policy scope are rejected. Nullable candidate IDs do not weaken
source uniqueness: semantic and evaluated source shapes have exhaustive checks and
separate partial unique indexes. An option's nullable attribute must still equal
its parent's attribute. Nonnullable generated reference columns close the composite-FK
NULL escape in both directions, including later draft-parent changes; their empty
sentinel cannot be an observed attribute code.

**Intentional semantic many-to-one is supported.** Within the same attribute binding
(pinned revision/template, route, evaluator row and target), multiple semantic IDs
may explicitly select the same Magento option only when the frozen evaluator proves
the same exact evaluated output for each. Each source retains its own row and
provenance. Remote-label coincidence proves nothing. Database guards reject shared
option IDs for different outputs or nonsemantic sources, and reject one evaluated
output selecting conflicting options. Source uniqueness independently rejects one
semantic identity selecting two options. Cross-row mappings cannot acquire conflicting
policies for the same effective route/target/store scope.

### Lifecycle and service contract

[`binding.service.js`](../server/src/services/magento/binding.service.js) exposes:

| Operation | Contract |
| --- | --- |
| `createDraft(input, options)` | `{installationKey, origin, templateVersionId, observedAt, schema}`. Creates a new UUID, draft counter `1`, observed schema and all derived routes disabled/review-required, with no chosen set, attribute, option or ownership policy. No network calls. |
| `getRevision(id, options)` | Coherent repeatable-read view of identity, bindings and detached schema observation. |
| `updateDraft(id, input, options)` | `{expectedRevision, bindings}` atomically replaces the four decision collections (`routes`, `attributes`, `options`, `policies`), advances the draft counter and audits. Incomplete/review-required decisions may be saved; malformed identities cannot. |
| `validateDraft(id, options)` | Read-only structural/publication diagnostics plus server-derived route/attribute/option requirements and the checked draft counter. Works for stored publications too. |
| `publishDraft(id, input, options)` | `{expectedRevision, expectedCurrentId}`; use explicit `null` when no current publication exists. Validates the locked draft and creates its immutable publication state atomically. |
| `getCurrentPublished(installationKey, options)` | Highest published version for that installation, or `null`. This is binding metadata, not activation of a synchronizer or exporter. |
| `listRevisions(installationKey, options)` | History with derived `superseded` lifecycle for older publications. |

Counters are decimal strings. Mutations require `options.mutationContext` with the
local application-user ID and optional request ID. Following existing template
conventions, create/update recheck `export_templates.manage` and publication rechecks
`export_templates.publish` using the existing access-admin transaction boundary.
These internal methods are not HTTP endpoints. Read methods require a trusted
server caller; any future routes must add view authorization, active-user and CSRF
boundaries. `databasePool` is an optional server/test dependency, never client input.

The lifecycle is **draft → published → superseded by a later publication**.
Supersession is computed from version order, without updating the earlier row.
Changes use a new draft (explicit creation with the intended observation/template).
There is no clone convenience operation in this phase. Publication increments the
draft counter once, allocates the next per-installation version and retains all
reviewed decisions and observations unchanged.

Lock order is the existing access-admin advisory lock → active actor/permission
recheck → shared lifecycle gate → installation advisory lock for create/publish →
revision row lock. Updates take the same access boundary then the revision lock.
The installation key is hashed deterministically from
`amber_magento_binding:<installationKey>`. Hash collisions only serialize unrelated
installations. No binding operation takes an installation lock after a revision lock;
each mutation locks at most one revision. Versions are installation-wide complete
snapshots, not separate concurrent publications per route/store. The unique
installation/version constraint backs allocation; the greatest published version is
the sole current publication, with no mutable current flag.
Publication revalidates source evidence and complete coverage while locked, checks
the caller's current-publication ID, and commits publication attribution and
`magento_binding.published` together. Audit failure rolls back the publication.
Concurrent publications of separate drafts based on the same current revision
produce one winner and a conflict; identical completed retries return the original
receipt without a second audit event, even after supersession. Competing updates
use the expected draft counter; stale work never overwrites the winner.

Database triggers reject UPDATE/DELETE of every published revision and child,
late child INSERTs, parent reassignment, revision counter regression, and TRUNCATE.
Child writers lock the parent row, serializing even direct SQL against publication.
Option decision writes require Read Committed isolation, as used by the mutation
boundary: after a parent-lock wait, the cardinality guard must see the preceding
writer's committed rows. Other isolation levels reject option writes instead of
checking an old snapshot. Read-only validation still uses Repeatable Read.
Schema observation UPDATE/DELETE is rejected in drafts too. There is no deletion
workflow; test teardown drops only disposable schemas. These protections do not
replace server-side semantic/coverage validation.

### Routes, option identities and ownership

Routes are derived from the pinned evaluator's semantic predicates, sorted into
stable keys such as `SV.souvenir=value_id:5` and
`SV.souvenir!=value_id:5`; an unconditional group uses `BR:all`.
The database recomputes the key from the group and canonical predicate conjunction;
predicate or template-array ordering cannot assign a different identity to that
same conjunction. The key survives read/update/publication unchanged.
The audit array index (`SV:5`) and CSV set name never participate in route identity.
Unsupported or duplicate route analysis fails closed. The chosen set ID is separate
from the recorded `evaluatorSetName` evidence (SQL `evaluator_set_name`), derived from
the pinned template's historical `attribute_set_code` output. The service verifies
that evidence but never requires it to name the chosen REST set. Binding creation
never changes export output. Set names and option labels are display evidence only.

An attribute binding identifies the stable route, evaluator row (`base`/`english`)
and target. Supported strategies are `scalar`, `semantic_option`,
`dynamic_exact_label_option`, `numeric_band_option`, `constant_option` and
`transport_control`, derived using existing mapper introspection and observed input
types. This phase preserves the evaluator target's attribute code; arbitrary EAV
target renaming is rejected. Native/CSV transport controls instead have a separate
`transportTarget`, with no EAV code or option binding. This declares a future adapter
decision; it does not translate or send a REST payload.

Semantic options use **Amber group + question key + `valueId`**. Optional
`skuCodeEvidence` is display evidence and never participates in identity or lookup.
The server checks authoritative current non-SKU or historical SKU semantic evidence
on publication. `optionId` is always a separate opaque Magento identity.

Evaluated options have `sourceKind: "evaluated"`, `domainKey`, `outputKey`, and
`evaluatedOutput`, with no Amber value fields. The domain hash binds the complete
frozen definition and route-group/row/target expression; the output key is the exact
evaluator output string. It is **not** a Magento label match. Numeric bands retain
the existing evaluator's intervals/outside behavior; dynamic sizes can explicitly
bind individual output strings. Every such mapping is ID-based and reviewable.
`unknownOutputPolicy: "block"` is mandatory: an open dynamic domain is never claimed
fully enumerated, and future consumers must block unlisted outputs without choosing
an option by label. Finite numeric-band outputs require a complete set of explicit
approved or blocked decisions.
An enabled dynamic binding requires at least one explicit output decision; this
reviewed list does not establish coverage of every current or future product.
Mixed/unknown semantic output domains cannot be approved; the whole attribute may
instead be explicitly blocked. Arbitrary target renaming and unprovable mixed-domain
transformations remain deferred. Neither restriction rejects a proven semantic
many-to-one collapse.

Ownership policies are separate from identity and do not execute updates:

- `authoritative_create_update`: proposed future Amber ownership on both operations;
- `initialize_create_only`: proposed initialization only;
- `magento_managed`: preserve the remotely managed value;
- `blocked`: an explicit decision that the field/scope is unsupported or unmanaged
  by this binding; future resolution must fail closed if it requires that field.

Every potentially populated enabled attribute/control requires an explicitly
reviewed policy and store scope. A final `blocked` policy uses review state `blocked`;
the other final policies use `approved`. Proposed/review-required policies remain
unresolved. `all` represents the explicit global context, not a wildcard over view
rows; it has no store ID. Other codes must identify an observed active store view,
with a composite FK pinning its ID/code/kind to this revision's observation. No
Main→UA or EN role is inferred. Multiple
policies may target distinct scopes; competing row writes to the same target/scope
are rejected by a database unique key as well as service validation. Policy changes
in a new draft never redefine semantic option identities. Policies are not
automatically approved, including merchandising fields.

### Review and fail-closed publication

Route, attribute, option and policy review states are `proposed`, `review_required`,
`approved` (in draft) and `blocked`. Evidence permits only bounded notes, diagnostic
codes, artifact hashes, sample counts and candidate IDs. Candidate labels, sample
agreement and supplied notes cannot approve a row or substitute for an ID.
`proposed` and `review_required` are undecided. `approved` authorizes an explicit
identity/policy in the snapshot. **`blocked` is a reviewed refusal, not an unresolved
candidate:** it can publish without inventing a missing Magento ID. Future product
resolution must reject a product requiring a blocked decision; this phase implements
no resolver, sync or writes. Nothing converts existing candidates to blocked or
approved automatically.

Publication derives potentially populated targets and finite output requirements
from the exact template and conservative route analysis. It does not trust a caller's
`required` flag. Missing rows, unresolved/review-required IDs or policies, incompatible
strategies, absent observed schema IDs, missing set membership and invalid source
identity all block. Optionality alone is not proof that a mapping is unreachable.
Disabled routes and descendants of an explicitly blocked route/attribute may retain
unresolved decisions because their entire ancestor scope is excluded. Other required
decisions must be approved or explicitly blocked. A blocked option does not exclude
other options or excuse their review. Existing template source
validation remains conservative across the full publication, even for disabled groups.

Unenumerated semantic values may be recorded as review-required with null
`evaluatedOutput` and null `optionId` (for example AR current-only sizes). They cannot
be approved, and review-required entries still prevent enabled-scope publication.
They may be explicitly blocked if the source belongs to the evaluator target and
the semantic ID exists in current or historical Amber evidence. Only such refusals
may use current-only SKU identity; approved SKU mappings still require historical
published identity. An arbitrary group/question/value claim or a known output hidden
behind a null placeholder is rejected. Dynamic sources cannot use these semantic
placeholders. The Phase 1B.2b CLI below derives these candidates without approving them.

### Explicit, read-only drift comparison

[`binding-drift.js`](../server/src/services/magento/binding-drift.js) provides pure
`compareSchema(revision, observation)` and explicit
`compareRevision(id, config, options)`. The latter reads a coherent stored revision,
checks the configured origin hash before any request, and runs the existing bounded
GET-only schema audit in the recorded observation scope. It requests no products,
writes no database rows and never revises an approval or a published snapshot.

Diagnostics include missing sets/attributes/options, changed attribute ID/type/scope,
lost set membership, changed set/attribute names, option-label drift, store-topology
drift and schema-fingerprint drift. Missing/replaced IDs have `missing_identity`
severity; fingerprint changes alone are review evidence, not identity replacement.
**Same attribute and option IDs + changed label means identity unchanged**;
the diagnostic preserves that ID and both observed labels. A replacement option with
the old label cannot repair a missing approved ID. A replaced attribute ID does not
lend its old option identities to its replacement. Fingerprints use normalized,
deterministically ordered observations and include option labels/topology. Sequential
GETs are not an atomic remote snapshot; this is explicit comparison, not monitoring.

### Compatibility findings constraining later phases

The supplied production observations below were collected before this implementation.
They were **not rerun**. Bounded samples establish review evidence, not universal
catalog rules or approval:

| Case | Observed evidence and required decision |
| --- | --- |
| SV stone (`souvenir=5`) | The evaluator predicts `154 / Камінь`; all 20 found sampled products used `151 / Сувеніри`, none used 154. Fields included `decor_weight`, `rozmir_suveniriv`, `suveniry`, `kamin_obrobka`, `kamin_suvenirnyi`, `kolir`, `typy_obrobky_burshtynu`, `fraction`; several are absent from set 154. Production convention strongly favors 151 in this sample, but **neither set is approved**. Keep the route decision review-required. |
| CH dimensions | 10/10 sampled products reverse the current evaluator's `bead_length → dovzhyna_namystyny`, `bead_width → diametr_namystyny`. Preserve Amber meaning; historical remote reversal and malformed spreadsheet-like `rozmir_kameniu` values are legacy compatibility evidence, not transformations to imitate. Future corrections need a separate policy. |
| AR size 28 | Semantic `value_id=28`, label `15x15`, mapper output `15×15`; two current products, neither found remotely, and no option candidate. Keep unresolved. |
| AR sizes 29–31 | Current-only semantic values, zero current usage, no historical published presence, no enumerated mapper output and no remote candidate. Do not invent bindings. |
| KL inclusion | Amber `addit=1` means `Є інклюз`; output `Інклюз`; observed `kulony_dodatkovo` option `6047 / Інзклюз`. Yet all 10 sampled existing products had the field unset/null. 6047 remains candidate evidence requiring explicit review. |
| SV subtype | The bounded local scan found no ready witness. Mappings remain unresolved; absence of a witness proves no broader conclusion. |
| Store/merchandising | `all` and `ua` often agree, `en` has localized values; equality does not prove inheritance. Names often match BR/NM/KL/CH templates but not universally (notably AR). SEO and description fields often contain richer maintained remote content. Do not choose template overwrite policies from these observations. |

Live IDs above document one installation and are never migration seeds. The Phase
1B.2b CLI below discovers candidates from current GET evidence; explicit approvals,
blocked decisions and field/store ownership remain operator actions. Admin routes,
successor cloning and any synchronization writer remain deferred. Implementation
verification uses synthetic bindings in disposable PostgreSQL; it does not create or
publish production bindings or perform Magento writes.

## Single-product synchronization dry run

Sync eligibility is reported separately in `syncEligibility` and the CLI summary.
An active, current product with an exact existing Magento SKU may UPDATE despite
the legacy `hold/prior_exposure` route and its `unknown` business marker/projected
export flag. This exception never applies to CREATE. Archived/corrected products,
successor-linked predecessors, retired lifecycle rows, explicit business exclusion,
intentional-exclusion holds, persisted independent-exclusion evidence and recount
compatibility exclusions still block all operations. Other unresolved holds or
unexplained exclusions remain fail-closed. The preview reads the authoritative
typed lifecycle signals without changing them or the old export queue selectors;
the exact reason and unchanged legacy state remain in the artifact.

The next executable milestone is [`magento:sync-preview`](../server/scripts/magento-sync-preview.js).
It creates a concrete future ProductRepository-shaped payload and a readable report
for **one real Amber product**, using live GETs only. It does not create exports,
acknowledge delivery, change product/lifecycle state, approve bindings, run migrations,
or call any Magento mutation. There is no `--apply` flag. The earlier foundation's
no-resolver description refers to that historical phase; this command now consumes
its existing binding model without changing migration 041.

Run manually from the configured server checkout:

```sh
cd server
npm run magento:sync-preview -- --sku "KL3/11131351005"
# Alternatively select exactly one local ID:
npm run magento:sync-preview -- --product-id 1234
# Explicit draft or published binding, with its pinned template:
npm run magento:sync-preview -- --sku "KL3/11131351005" --binding-revision "<revision UUID>"
# Explicit immutable template, without a binding revision:
npm run magento:sync-preview -- --sku "KL3/11131351005" --template-version "<publication UUID>"
```

The same command can run through `docker compose exec server npm run ...`.
Default dispatch uses the existing system mapper; selection/activation metadata does
not silently choose a publication or binding. `--binding-revision` explicitly selects
a draft or publication, verifies installation origin and observation scope, and uses
its exact immutable template. If both revision and template are supplied, they must
agree. IDs are UUIDs. `--store-code CODE` selects the observed REST scope (default
`all`); it does not translate the evaluator's base row into an English row or approve
base/EN store ownership. `--help` connects to neither database nor Magento.

The cohesive pipeline is:

1. Select one Amber row by parameterized exact SKU or ID and reject duplicate SKUs.
   Read product answers, final stored price, catalog, historical support inputs,
   optional binding revision and pinned template in one repeatable-read **read-only**
   transaction. Finish that snapshot before remote reads. No startup/seed path runs.
2. Evaluate with the existing compiled template evaluator; introspect its sources,
   routes and Phase 1B.2a requirements. Evaluator failures become blockers while
   available values continue through the preview.
3. Discover the live bounded Magento schema, compare persisted observation drift,
   resolve route/attribute/option identities, and exact-query the unmodified SKU.
   One found counterpart means `UPDATE`; a verified zero result means `CREATE`.
4. GET the category tree for each distinct discovered store-group root. Resolve
   template paths and compare current native assignments. Build the REST-shaped
   candidate, semantic diff, preservation decisions, warnings and blockers.
5. Exclusively create repository-root
   `.artifacts/magento/sync-preview-<SKU-safe>-<UTC>.json`. Slash/unsafe filename
   characters become underscores; the actual SKU remains unchanged. Existing files
   are never overwritten. Artifacts are ignored operational evidence. In a container,
   copy the file out before replacing the container.

The terminal summary includes product, CREATE/UPDATE, set ID/name/authority, option
and category counts, preserved/changed fields, warnings, explicit blockers,
SENDABLE YES/NO and the artifact path. A successfully produced blocked preview exits
0; invalid selection, unsafe/malformed evidence, connectivity/schema failure or an
existing artifact exits 1 with a sanitized error. Category-tree access failures are
reported as blockers while the attribute preview continues. Raw product records,
unrelated attribute values, credentials, headers and tokens are not retained.

### Resolution and authority

Attribute sets are independent of catalog categories. The report includes Amber
group/semantic route, evaluator-predicted name, exact live set-name matches, persisted
decision, selected candidate and current product set. Without an approved route, an
exact matching set is only `candidate_only` and blocks sendability. For SV souvenir 5,
the earlier 20/20 set-151 observation is explicitly historical review evidence; it
never selects 151 or overrides today's evaluator/persisted route.

Persisted `approved`, `blocked`, `review_required` and `proposed` states are retained.
Live IDs must still exist; selected-route identity/metadata/label drift requires
review. A missing approved option is not repaired by a replacement label match.
Without approval, the existing exact-label/spelling-evidence resolver may populate
a candidate option ID, always labelled `candidate_only`. Empty/ambiguous/missing
options stay unresolved. Scalar, semantic, dynamic exact-label, numeric-band and
native transport strategies reuse the evaluator and binding contract. Semantic
`value_id`, `sku_code` evidence and Magento IDs remain separate.

Every base output field reports sources, evaluated value, strategy, attribute code/ID,
option ID/label, current value/resolved label, authority, set applicability and change
status. Blank outputs do not clear remote fields. KL inclusion typo evidence stays
candidate-only without persisted approval. AR unsupported sizes block sendability
without invented IDs. CH uses current Amber dimensions and size text; historical
reversal/malformed remote size is a legacy mismatch. Comparisons distinguish exact,
numeric-equivalent formatting, rounded legacy values and semantic differences.

### Taxonomy and safe preservation

#### Explicit KL inclusion category action

`magento:category` supports only `Default/Кулони/З інклюзом`, with the reviewed
source `KL.addit=value_id:1`. It does not change the frozen export evaluator's
legacy presence expression. The product preview offers this action for value 1.
The six existing KL paths retain their individually approved identities.

Run from `server/` to inspect the live exact parent/child lookup and intended POST:

```powershell
npm run magento:category -- --revision 4d563554-bfe3-4d01-9df5-225aa5b61d48 --path "Default/Кулони/З інклюзом"
```

Without `--apply` this performs GETs only and changes no local binding. To explicitly
create/bind, add `--apply --expected-revision <current-counter> --actor-user-id <local-user-id>`.
It requires a draft for the configured origin/all scope, an approved KL route,
category ownership, and the approved full-path parent identity. Missing or ambiguous
parents/children fail closed; no leaf matching, arbitrary names or recursive trees.
The operation uses Magento's [category repository POST contract](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Catalog/etc/webapi.xml):
`{category:{parent_id:<live exact ID>,name:"З інклюзом",is_active:true,include_in_menu:false}}`.
It creates an active category outside navigation; it assigns no products.

Remote dispatch requires the existing `export_templates.publish` capability;
binding persistence uses `export_templates.manage`. An immutable
`magento_category.create_attempted` audit record commits before POST, keyed by
origin/full path and serialized by the existing access-admin database lock.
Concurrent callers sharing this database, even on different revisions, cannot
dispatch the operation twice. A second precheck precedes the sole POST. A fresh
GET of the complete hierarchy must verify the created/existing ID and parent before
the exact category binding is approved in migration 041's existing evidence.
Successful retries return the existing ID without another POST or binding update.

A timeout, crash, failed verification or local save failure never causes an automatic
POST retry. Rerun performs an exact GET lookup and can bind a verified existing child.
If a prior attempt exists but the child is still absent, it stops with
`MAGENTO_CATEGORY_PREVIOUS_ATTEMPT_UNRESOLVED`; there is no force/reset flag.
This favors preventing duplicate dispatch over retrying an uncertain write. Magento
does not supply a full-path conditional-create/idempotency contract; independent
admin tools or another Amber database are outside this lock. Do not concurrently
create this path through another writer. Ambiguous results always remain blocked.
No category deletion, product write, binding publication or export-state change occurs.

Category paths are compared by complete root-to-node hierarchy with per-segment
trim/NFC normalization, preserving case and spelling. There are no leaf-name matches,
guessed root aliases or category-to-attribute-set rules. Duplicate full paths stay
ambiguous; missing required paths block an authoritative taxonomy update without
discarding the remaining preview. IDs are Magento installation identities. The
category transport binding can now hold explicitly reviewed category-ID evidence
under migration 041's bounded JSON evidence contract. Approved paths become
authoritative only when the fresh full-path lookup remains unique with the same ID.
Changed or missing identities block the category operation. Ownership remains separate.

Current assignments use `extension_attributes.category_links` (IDs and positions),
with `custom_attributes.category_ids` as read evidence when links are absent. Missing
assignment evidence is unknown, not empty. Contradictory representations fail closed.
Positions follow Magento's [CategoryLinkInterface](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Catalog/Api/Data/CategoryLinkInterface.php)
`int|null` contract: negative ordering positions are valid and retained exactly.
Null/omitted positions remain unknown and block the category payload without aborting
the other preview domains. Category IDs still require positive identities.
The report shows requested/current paths, intersection, additions, hypothetical
full-ownership removals and Magento-only categories. By default those extras are
`preserve_by_safe_preview`; candidate links are the union, retaining their positions.
New links have provisional position 0. When positions/assignments are unknown, the
category payload is omitted. Only an approved persisted `authoritative_create_update`
policy for the category target allows a full replacement candidate; unresolved IDs
still block sending it.

Existing `description`, `short_description`, `meta_title` and `meta_description`
are omitted from the update payload unless an explicit approved field policy permits
Amber ownership. A different existing `name` is likewise preserved and produces
`ownership_review_required`; both values remain in the diff. Approved
`magento_managed` and update-time `initialize_create_only` policies preserve fields;
blocked policies never produce mutations. New products use the evaluated name and
show optional template merchandising content separately pending ownership. These
fallbacks are preview behavior only and are never persisted as approved policies.

### Candidate payload and sendability

`candidatePayload.product` is the exact currently constructible future REST-shaped
product object. It may contain candidate IDs or fields requiring review; its presence
is **not approval to send**. Required unresolved values are omitted and diagnosed.
`sendability` separately reports `{sendable, scope: "complete_sync_plan", blockers}`;
top-level `sendable`/`blockers` mirror it. Warnings describe preserved content,
formatting differences and legacy remote evidence, not approval failures.

`sendability.operations` contains `coreProduct`, `categories`, `inventory`, `websites`
and `storeViews`, each with its own `sendable` and `blockers`; `sendability.overall`
retains the complete-plan result. Blockers carry an `operation`. Product exclusion
and non-current-product blockers apply to `all` operations; category and transport
blockers do not affect core readiness. The core operation includes its
exact `candidatePayload` with category links omitted; the category operation reports
its separate `candidateLinks`. The top-level payload remains the combined inspection
candidate. These are planning results, not executable operations or approvals.

Required EAV fields use live `apply_to` metadata and the candidate product type:
an empty list applies to all types, and missing metadata never exempts a required
field. Downloadable/Bundle-only requirements therefore do not block a simple product.
The report includes `requiredAttributes` with applicability evidence. This follows
Magento's [product-type applicability contract](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Catalog/Model/Product/Type/AbstractType.php).
Fixed mapper literals such as `old_product=No` and `is_ownproduction=Yes` use the
observed standard [Boolean source](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Eav/Model/Entity/Attribute/Source/Boolean.php)
and verified live option values `0`/`1`, independent of translated labels. This is
native control translation, not an Amber semantic option binding. Unknown sources,
missing native values, semantic answers and candidate-only options keep their review
boundaries; field ownership still applies to changed controls.

`AMBER_PRODUCT_EXCLUDED` includes the exact blocking predicate. `syncEligibility`
retains the product's persisted export state (business exclusion, route/hold reason
and recount compatibility), read in the same read-only Amber snapshot. An unknown
business marker remains visible even when the exact-SKU prior-exposure UPDATE
exception applies; no historical state or export eligibility is changed.

Native translations include attribute-set ID, simple `type_id`, numeric price/status,
and visibility (`Catalog, Search` → 4). Options use live Magento values. CSV routing,
website and stock columns never become fake custom attributes. Category links use
the native extension contract. See Magento 2.4.6's
[Catalog REST routes](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Catalog/etc/webapi.xml),
[product category/website extensions](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Catalog/etc/extension_attributes.xml)
and [stock extension](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/CatalogInventory/etc/extension_attributes.xml).

Inventory, websites and EN now have separate GET-only operation previews in
`transport` and `sendability.operations.<domain>.plan`. Missing evidence or unapproved
bindings/policies block that operation without hiding the core payload. The preview never writes; the separate durable CLI below requires a published binding
and explicit `--apply`. Sendability alone never dispatches a mutation.

- **Inventory:** approved `qty` and `is_in_stock` identities with
  `initialize_create_only` policies initialize CREATE with quantity 1 and in-stock
  status. UPDATE always preserves every current source quantity/status, including
  zero/out-of-stock; it has no inventory mutation payload. Reads use MSI
  `GET inventory/stock-resolver/website/base`,
  `GET inventory/get-sources-assigned-to-stock-ordered-by-priority/:stockId`, and
  exact-SKU `GET inventory/source-items` search criteria. The report distinguishes
  physical source inventory from reservation-adjusted salable quantity; no reservation
  is changed or inferred. CREATE needs one uniquely resolved enabled source, no orphan
  source items, and approved initialization policies. Ambiguous sources, truncated or
  malformed responses, and failed reads remain blockers. See the
  [MSI source contracts](https://github.com/magento/inventory/blob/1.2.6/InventoryApi/etc/webapi.xml)
  and [stock resolver](https://github.com/magento/inventory/blob/1.2.6/InventorySalesApi/etc/webapi.xml).
- **Websites:** approve `product_websites` and `authoritative_create_update` ownership.
  Live exact website codes must retain their IDs from the binding schema observation.
  Current assignments come from product `extension_attributes.website_ids`. The plan
  ensures required membership with individual `ProductWebsiteLinkRepositoryInterface.save`
  payloads for missing IDs, preserving every additional assignment. It never replaces
  the whole website list. An existing `base` membership produces no operation.
- **EN:** resolve the active exact `en` store view and verify its pinned ID and
  website/group identity. UPDATE reads the same exact SKU via `/rest/en/V1/products`
  search criteria and requires the same product ID. Only produced non-empty values
  with approved identities and `authoritative_create_update` ownership enter the
  scoped diff. Only live store-scoped text/textarea attributes in the selected set
  are supported; unknown/global scopes fail closed. Empty/undefined/whitespace values
  and unproduced fields are preserved. SKU, set, type and store code are identity/
  routing controls with `magento_managed` EN policies; global writes and rename are
  excluded from the EN payload. Unchanged fields are omitted. The current KL frozen
  template produces EN name and `meta_title`; it does not produce `meta_description`,
  so that Magento value remains untouched.

Use `magento:bindings approve-exact` with explicit group/row/targets for resolved
identities, then individual `approve --binding POLICY_REVIEW_ID --policy POLICY
--accept-review --reason "..."` decisions. These reuse migration 041 and the normal
actor/CAS/audit checks; no new revision or publication is required. Validate the same
draft and run `npm run magento:sync-preview -- --sku "KL3/11131351005"
--binding-revision <UUID>` from `server/`. The immutable artifact is still only a plan,
not a durable job, transaction, acknowledgment or cross-system atomic snapshot.

## Phase 1B.2b binding bootstrap and explicit review

Run these commands from `server/`. `magento:bindings` uses the existing migration 041
services, active local-user permission checks, transaction-coupled audit events,
optimistic revision checks and immutable publication guards. No migration or Magento
write API is added. CLI access is trusted local administration with database access;
`--actor-user-id` identifies the existing local application user, never an OIDC subject.
Mutations require `export_templates.manage`; publication requires
`export_templates.publish`. Freezing a system template requires both capabilities.

Bootstrap reads the current catalog, evaluator and bounded real product samples in
a read-only snapshot, discovers live Magento schema and category trees through named
GETs, derives candidates through the existing mapper/requirements/option evidence
logic, and creates a **new** draft with its candidate rows in one transaction.
`--sku` adds one exact product witness; it does not change eligibility or exclusion.
System mode freezes a dedicated immutable template publication because 041 requires
a publication FK. It uses the existing historical source-support policy for AR.size
29–31 and NM.extra numeric-zero placeholders; these are not promoted to supported
semantic identities. Catalog, source evidence and the exact SKU witness are captured
in one read-only snapshot. Normal publication source validation remains mandatory.
Template family/draft, publication, binding candidates and their audit events share
one authorized transaction and all roll back on any precommit failure. No template
activation or binding approval is performed. Existing revisions are never reused or
overwritten by bootstrap. Alternatively pass an existing template version UUID.
Migration 041 must already be installed through the normal migration runner;
bootstrap checks this before any remote request or local mutation and never applies DDL.

Exact set names, attribute codes and unique option labels become `proposed`.
Scalar and native-control identities are included. Missing options become `blocked`;
ambiguous/drift candidates remain `review_required`. KL inclusion stays review-required
even if a future schema label becomes exact. The known SV souvenir route conflict
also stays review-required. Numeric question keys outside 041's semantic-key contract
are retained as an explicitly blocked attribute with source evidence, not renamed.
No Amber semantic ID is replaced by a Magento ID or inferred from `sku_code`.

Category decisions are typed `evidence.categories` entries on each category transport
binding. They contain complete requested/normalized paths, live candidate paths/IDs
and individual review states. They inherit draft CAS, attribution and publication
immutability. Unknown paths stay blocked; ambiguous paths stay review-required.
Category/dynamic output evidence covers evaluated ready product samples (three per
route plus an optional exact SKU), not every hypothetical product combination. An
unobserved category or dynamic output still fails closed in preview. Evidence exceeds
041's bounded JSON capacity only by failing explicitly, never truncating candidates.

Ownership policies are separate review-required preservation suggestions. Exact
batch approval never approves policies, including `product_online` ownership. An
explicit policy decision needs a policy, review acknowledgment and reason. Single
drift-candidate approval likewise needs `--accept-review --reason`; missing or
ambiguous identities cannot be approved without resolved evidence. `block` records
an explicit unsupported decision. An approved binding identity does not make an
excluded product, missing category, or deferred transport operation sendable.

Example PowerShell workflow (replace `$actor` with your active local user ID):

```powershell
$actor = <LOCAL_USER_ID>
$draft = npm run --silent magento:bindings -- bootstrap --installation amber --template-version system --group KL --sku "KL3/11131351005" --actor-user-id $actor --json | ConvertFrom-Json
npm run magento:bindings -- review --revision $draft.id --group KL

# Explicit bounded identity approval; no inclusion, category or ownership approval.
$draft = npm run --silent magento:bindings -- approve-exact --revision $draft.id --expected-revision $draft.revision --actor-user-id $actor --group KL --row base --targets "attribute_set_code,typy_obrobky_burshtynu,vyd_obrobky_kameniu,faktura_kulonu,kolir,vyd_kulonu,rozmir_iuvelirnoho_vyrobu,decor_weight" --json | ConvertFrom-Json

# Individual identity: use its opaque review ID, not a manually entered Magento ID.
# npm run magento:bindings -- approve --revision $draft.id --expected-revision $draft.revision --actor-user-id $actor --binding "<REVIEW_ID>"
# Explicit policy choice (never implied by identity approval):
# npm run magento:bindings -- approve --revision $draft.id --expected-revision $draft.revision --actor-user-id $actor --binding "<POLICY_REVIEW_ID>" --policy magento_managed --accept-review --reason "Preserve maintained Magento content"
# npm run magento:bindings -- block --revision $draft.id --expected-revision $draft.revision --actor-user-id $actor --binding "<REVIEW_ID>" --reason "Explicitly unsupported pending review"

npm run magento:bindings -- validate --revision $draft.id
# Publish only after validation succeeds and all enabled-route decisions are reviewed.
npm run magento:bindings -- publish --revision $draft.id --expected-revision $draft.revision --expected-current none --actor-user-id $actor
npm run magento:sync-preview -- --sku "KL3/11131351005" --binding-revision $draft.id
```

Use the returned revision counter after every edit. `review` prints it; `--json`
returns machine-readable receipts with `ok: true`. On failure stdout contains only
`{"ok":false}`, sanitized error codes/diagnostics go to stderr, and the process exits 1.
Check `$LASTEXITCODE` and `$draft.ok` before using the returned ID. `--expected-current none` asserts there is no
current binding publication; when replacing one, supply its explicit revision UUID.
`validate` exits 2 for incomplete drafts and lists diagnostics; publication fails
closed. The bounded KL approval above is intentionally partial: it does not resolve
other fields, English rows, inclusion, taxonomy or ownership. Sync preview accepts
the **draft immediately**; publication is not necessary for useful approved evidence.

Automated verification uses injected Magento responses and disposable PostgreSQL only.
It does not execute a live preview. No binding approval, production write or commit is
part of this milestone.


## Durable product-sync jobs ? migration 042

`magento:sync` is the first explicit apply worker. Install migration 042 through the
normal migration runner/startup before using it. It neither publishes bindings nor
runs runtime DDL. The existing `magento:sync-preview` remains GET-only.

From `server/`, with an active local user possessing `export_templates.publish`:

```powershell
# Requires this same UUID to have been explicitly published; a validated draft is rejected.
npm run magento:sync -- --sku "KL3/11131351005" --binding-revision 4d563554-bfe3-4d01-9df5-225aa5b61d48 --actor-user-id 1
# Explicit first apply (reuses the bound job):
npm run magento:sync -- --sku "KL3/11131351005" --binding-revision 4d563554-bfe3-4d01-9df5-225aa5b61d48 --actor-user-id 1 --apply
# Reconcile/resume one durable job without replacing its plan:
npm run magento:sync -- --job <JOB_UUID> --actor-user-id 1 --apply
```

Without `--apply`, the CLI performs live GET discovery/preview and persists the
reviewable exact operations (`--json` includes them). It performs no Magento mutation.
Both enqueue and apply require the installation's current published immutable binding;
a later publication makes an older pending job blocked. Actor checks use the existing
access-admin boundary. The CLI is trusted local administration, not a new HTTP API.

`magento_sync_jobs` stores the product/SKU, origin hash and installation key, exact
publication/hash, authoritative product/lifecycle state hash, immutable intended
operations/hash, minimized baseline and preservation hashes. It records actor,
attempt count, structured failure, remote product ID and final acknowledgement time.
`magento_sync_steps` records each operation's committed dispatch marker and verified
completion. Database triggers prohibit rewriting intent, deleting evidence, resetting
a dispatch or altering success. Audit events commit with queue/step/state transitions.
No credentials, authorization headers or full remote response bodies are persisted.

The planner is **the existing sync-preview evaluator and resolver**. Each attempt
rebuilds its intended operations using current Amber inputs, live schema/category
identities and the immutable original comparison baseline. This prevents our own
partial writes from changing the bound intent. A changed intended plan or loss of
sendability blocks apply. Fresh exact-SKU GETs check identity and each operation's
remote preconditions. Magento-managed fields are omitted and preservation hashes
are checked, including media, unknown attributes/extensions, update inventory and
unproduced scoped EN content. Final acknowledgement also verifies unchanged EN
values and required website memberships, not merely fields sent in the last request.

UPDATE revalidation restores native timestamp evidence omitted by the minimized
baseline: `created_at` must match its original preservation hash, while Magento-owned
`updated_at` is read fresh because saves can advance it. Neither enters a write payload.
Live required-field validation still rejects missing timestamps; changed creation time
still fails preservation. This also supports existing immutable jobs without rewriting
their baseline, intent or plan hash, including retries after verified partial writes.

Operations run in this order, skipping writes already verified as satisfied:

1. Core product repository save; CREATE must have native status 2. UPDATE may not
   contain status at all. SKU rename is unsupported.
2. The planner's exact category links/positions, via a separate product save.
3. MSI source initialization for CREATE only; UPDATE never resets inventory.
4. Individual additive website memberships; never a complete replacement list.
5. Nonempty EN scoped fields, with blanks and unproduced fields preserved.

Product saves use Magento 2.4.6's
[POST repository save](https://github.com/magento/magento2/blob/2.4.6/app/code/Magento/Catalog/Model/ProductRepository.php)
contract, which resolves an existing SKU before merging data. This avoids encoded
slash product-update paths and preserves omitted status. Categories use its extension
contract; MSI and website operations use their named native endpoints. The writer
has no arbitrary URL/method or delete API, follows no redirect and never retries HTTP.

Enqueue is idempotent for installation/product/publication/Amber state, including
completed retries. A partial unique index prevents competing unfinished SKU jobs.
Apply uses a per-installation/SKU PostgreSQL session lock (duplicate apply returns
`MAGENTO_SYNC_BUSY`), access/lifecycle/publication coordination and product then
lifecycle row locks. These retain local state and publication through remote dispatch;
ledger commits use an independent connection so dispatch evidence survives crashes.
No export/cutover state or legacy queue cursor is advanced.

States are `queued -> running -> succeeded`, or `retryable`, `blocked`, `uncertain`.
A read failure before dispatch can retry safely. Every dispatch marker commits
**before** the HTTP mutation. A crash, timeout, rejected response or verification
mismatch leaves that marker in place. Rerun only reads to reconcile that step: if
its intended result is verified, it advances and can execute later unsent operations;
otherwise it remains unresolved and sends nothing again. There is no force/reset or
automatic uncertain-write retry. Unfinished stale/uncertain jobs require operator
review; the CLI does not discard them to enqueue a replacement. Success requires a
fresh final GET proving all authoritative intended state and preservation checks.

This is not a cross-system transaction: completed remote steps are not rolled back.
Magento's APIs do not provide conditional writes or a cross-client idempotency key.
PostgreSQL coordinates workers using this Amber database; independent Magento admin
writers or another database are outside that lock. Use an exclusive operator window
for the first apply. Read verification detects conflicts but cannot undo an external
race. Encoded-SKU website endpoints can still be rejected by an installation; such a
response is uncertain until exact membership is verified, never silently replayed.
