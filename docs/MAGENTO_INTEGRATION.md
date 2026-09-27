# Magento integration Phase 1A

This phase provides an isolated **GET-only** connection and discovery layer for
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

Unit tests use synthetic credentials and injected fetch only. They prove query
construction, exact-response validation, and signing alignment, **not production
success of the query lookup**. After deployment, repeat the read-only SKU probe
to establish that Magento accepts this query on the actual installation. Do not
work around failures by rewriting SKUs or writing test products.

Production cutover through 039/040 and selector v1 activation are already complete
according to the Phase 1A brief. This probe performs no cutover, PostgreSQL writes,
queue draining, export confirmation, or Held-product actions. Do not rerun cutover
as part of deploying or probing this integration.
