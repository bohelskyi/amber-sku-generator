# Wave 1: UX and runtime cleanup

Wave 1 is deployed in production via PR #19 at `daf627fc2458e5215cbf52735a8f186a3777361f` (operator receipt 2026-10-01). The following sections retain the implementation/review boundaries and historical checks; pre-production or uncommitted wording describes that earlier stage. Wave 2 H0 is a separate implementation.

This work implements A–G of the approved two-wave plan. Wave 2 remains a separate review boundary: H0 → H1 → H2 → H4 → H3a → H3b. No integration editor, v4 contract, generic Magento mutation primitive, or published binding change belongs to Wave 1. The accepted manual corrections require forward migration 049 for shared-authority names, bounded discovery and captured repricing obligations.

## Review boundaries

| Phase | Reviewable scope |
| --- | --- |
| A | nginx runtime DNS, static config tests, isolated replacement smoke, operations documentation |
| B | shared route registry, compact daily navigation and separate account controls, permission-aware route entry and supporting reads |
| C | direct-first recount, separate optional requests, accurate public/internal identifiers, preview permission union with unchanged mutation guards |
| D | three-way full-name reconciliation, bounded GET-only discovery, explicit conflict preview/apply, durable common baseline, existing permissions |
| E | lineage revision terminology, current-product sync status, safe actionable projection, recorded name/information audit events |
| F | authoritative delivery gate, disabled product CSV creation, retained history/session evidence and price export, template copy |
| G | shared styles, copy, read-only catalog controls, keyboard order controls, loading/error states, built-client browser smoke |

These are proposed commit boundaries for later review; this work does not itself authorize staging, committing, pushing, deployment, or Wave 2.

## Navigation inventory and disposition

| Surface | Disposition |
| --- | --- |
| Products, repricing, synchronization problems, settings | Daily navigation; one destination per viewport |
| Repricing | Daily workflow; unchanged manual UAH prices preserved, explicit automatic opt-in, real committed batch/Magento progress |
| Correction requests | Daily compatibility entry only for request-only users; otherwise retained deep links |
| Product timeline | Secondary history; public article identifies the product, internal SKU identifies revisions |
| Correction report/CSV | Retained immutable historical evidence; reachable from timeline |
| Catalog/pricing | Retained configuration workspace; catalog mutations require the existing management permission |
| Export templates | Compatibility deep links; table/check/versions retained, immutable publication and complex rules unchanged |
| Users, roles, audit | Grouped administration; existing permissions unchanged |
| Export overview | Delivery-aware entry; no retired product CSV creation when the gate is false or unknown |
| Own/shared/invitations | Retained beneath the work-exports section; membership, stored results and confirmation retain their guards |
| Price export | Separate valid stream, unaffected by product delivery retirement |
| Historical files | Retained downloads of original stored artifacts; no regeneration implied |
| Magento integration editor | Wave 2; no placeholder claims of new-category readiness |

## Copy dictionary

| Meaning | Ukrainian presentation |
| --- | --- |
| Public identity | Артикул |
| Internal identity | Внутрішній SKU |
| Recount | Переоблік / Застосувати переоблік |
| Request | Запит на виправлення / Передати зміни на розгляд |
| Pending / syncing / synced | Очікує синхронізації / Синхронізується / Синхронізовано |
| Generic attention | Потребує уваги; retain the server's safe reason |
| Name conflict | Назву змінено і в Amber, і в Magento. Виберіть актуальну. |
| Historical row | Попередня версія товару |

Technical identifiers, schema fields, Main/EN, immutable historical CSV descriptions, price-export terminology and genuine legacy public-identity transitions remain meaningful. Do not replace them indiscriminately.

## Acceptance boundaries

- Automated authorization, stale-token, current identity, session recovery, stored-artifact and cutover tests must pass with the required client/server checks.
- `scripts/test-nginx-dns.mjs` exercises a built nginx image on its own disposable network. It uses no database or Magento, requires a different replacement address, and verifies unchanged client/container/process identity. The bounded recovery assertion starts after the replacement is ready plus two seconds; it does not promise service availability while the sole upstream is absent. The old literal-host negative control must fail to reach the replacement.
- `scripts/test-client-browser.mjs` exercises the built client with local fixture APIs in an installed Chromium/Edge. It checks 320/390/768/1024/1440/1920px, visible route uniqueness, body overflow, compact header height, native keyboard links, retired delivery state, reviewed name conflict and refreshed status. It records screenshots outside the repository. This is fixture-based browser acceptance, not live OIDC or Magento acceptance.
- Genuine browser 200% zoom, screen-reader use, and business acceptance with real authorized accounts remain manual review items. No production deployment or golden-data mutation is needed for these regression checks.
- New Amber category readiness is an explicit Wave 2 requirement. It must say “Категорія ще не готова до Magento” until its separate schema/binding/remote dependencies are ready; it must not add a new database prohibition to ordinary product save.

## Acceptance correction verification — 2026-10-01

Base remains `df2ccd3ac030add6ec7820845a54c2512fb29626` on `feature/magento-integration`; all changes remain uncommitted. Node 20.20.2 and canonical disposable PostgreSQL 16 were used. Current final results are recorded below after the complete acceptance suite finishes; earlier Wave 1 results are not substituted for this rework.

| Check | Result |
| --- | --- |
| Server unit suite | 768 passed |
| Server lint | Passed; two existing presenter warnings, no errors |
| Canonical disposable PostgreSQL integration | 363 passed; postgres-test stopped afterward |
| Client Node / Vitest suites | 158 / 343 passed |
| Client lint and Vite build | Passed |
| Compose config and client image build | Passed |
| Built nginx syntax and isolated DNS replacement | Passed; distinct upstream address, same running client/processes; old configuration negative control reproduced failure |
| Built-client Edge fixture smoke | Passed at 320/390/768/1024/1440/1920px; all daily routes visible, no document overflow, keyboard focus, retired CSV gate, token-reviewed name conflict and pending status refresh |
| Diff whitespace | Passed |

Manual golden acceptance remains: live OIDC/session behavior; daily work with actual permission sets and real device/zoom/screen reader; direct recount under all supported pricing modes; name baselines and all three-way cases against real UA/EN store views; discovery cadence; actual repricing batch progression and exact rollback. Automated checks use only mocked Magento, isolated nginx fixtures, local browser fixture APIs and canonical disposable PostgreSQL. No golden/production mutation, commit, push or Wave 2 work was performed.
