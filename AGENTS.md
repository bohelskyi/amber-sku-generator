# AGENTS.md

## Start here

1. Read this file and `PROJECT_CONTEXT.md` completely before changing anything.
2. Read the domain document(s) relevant to the task.
3. Inspect the current code, migrations, and tests in scope; they are authoritative when documentation is stale.
4. Check `git status --short` before editing and preserve unrelated user changes.

### Which doc to read

| Task area | Required context |
| --- | --- |
| Authentication, RBAC, users, access states | [`docs/AUTH_RBAC.md`](docs/AUTH_RBAC.md) |
| SKU generation, schemas, catalog | [`docs/SKU_CATALOG.md`](docs/SKU_CATALOG.md) |
| Pricing, matrices, modifiers, exchange rates | [`docs/PRICING.md`](docs/PRICING.md) |
| Product recount and correction requests | [`docs/RECOUNT_CORRECTIONS.md`](docs/RECOUNT_CORRECTIONS.md) |
| Repricing drafts, apply, rollback | [`docs/REPRICING.md`](docs/REPRICING.md) |
| Export snapshots and CSV | [`docs/EXPORTS.md`](docs/EXPORTS.md) |
| Database and migrations | [`docs/DATABASE_MIGRATIONS.md`](docs/DATABASE_MIGRATIONS.md) |
| Deployment, health, backup, restore | [`docs/OPERATIONS.md`](docs/OPERATIONS.md) |

## Engineering rules

- Make the smallest scoped change that solves the reproduced problem.
- Add focused regression coverage for behavior changes. Do not make unrelated refactors during a localized fix.
- Treat the server and PostgreSQL as authoritative for authentication, authorization, SKU generation, validation, pricing, and workflow state. React permission checks are presentation only.
- Preserve existing authentication, active-user, permission, CSRF, transaction, lock-ordering, idempotency, and final-state revalidation boundaries.
- Use parameterized SQL. Validate unavoidable dynamic identifiers against a strict allowlist or pattern.
- Concurrency tests must create a real race with independent connections/processes where needed and assert final database state, not only response codes.
- Do not change production data, migrations, dependencies, or configuration unless the task explicitly requires it.
- Never commit `.env`, tokens, passwords, database dumps, backups, SQLite files, or other secrets.
- Never introduce a production authentication bypass or expose OIDC tokens/client secrets to React or browser storage.

## Migration rules

- Migrations `000`–`028` are immutable history. Never edit an already-applied migration; add the next forward migration.
- Preserve checksum and line-ending canonicalization. Never rewrite stored checksums to hide a mismatch.
- Keep each migration transactional and safe for fresh, known upgrade/checkpoint, repeated-startup, and rollback paths as applicable.
- Migration DDL uses a dedicated no-query-timeout connection. Runtime DDL is not a substitute for migrations.
- PostgreSQL integration tests are destructive and must target only a disposable database whose name ends in `_test`.

## Business and security guardrails

- All business routes, including historically named `public.routes.js`, remain authenticated and active-user gated. Unsafe business methods retain synchronizer-token CSRF validation.
- `/health/live`, `/health/ready`, and OIDC login/callback entry points remain outside the business authentication boundary. Unauthenticated APIs return JSON `401`, not OIDC redirects.
- OIDC identity is immutable `issuer` + `sub`; never use mutable profile claims as identity and never write OIDC `sub` into actor fields.
- Server preview/save/recount/repricing calculations remain authoritative and fail closed.
- Never reuse a SKU, mutate a published SKU schema, reinterpret a used semantic option value, or boolean-normalize calibration state `2`.
- Preserve positive-or-absent matrix pricing, separate calculated/automatic/manual price meanings, and legacy zero-price compatibility.
- Preserve target-based recount validation, application-user correction ownership with legacy capability-token compatibility, atomic repricing, and immutable/monotonic export behavior.
- Follow the relevant domain document before changing any of these invariants.

## Required verification

Run the narrow regression first, then all applicable checks before handoff:

```text
cd server
npm test

set TEST_DATABASE_URL to a disposable database ending in _test
npm run test:integration

cd ../client
npm test
npm run lint
npm run build

cd ..
git diff --check
git status --short
```

There is no separate server lint/build command. For deployment-image changes, also run `docker compose build`; validate Compose changes with `docker compose config`.

CI uses Node 20 and PostgreSQL 16 and runs server unit/integration tests plus client test/lint/build.

## Operational safety

- Keep real credentials out of commands that will be committed or documented.
- Do not point integration tests, restores, imports, or destructive scripts at production, staging, or any database containing useful data.
- `scripts/postgres-restore.sh` is destructive: verify the dump and exact target, and use its explicit `--confirm` flow.
- Keep backups outside the repository and restore-test them in a disposable environment.
- Preserve graceful SIGTERM/SIGINT shutdown and PostgreSQL pool closure.

## Windows PostgreSQL integration testing:
- Do not assume host port 5432 belongs to the Docker Compose PostgreSQL service.
- Prefer a dedicated disposable PostgreSQL 16 test instance on a non-conflicting loopback port.
- Use fixed throwaway credentials and a database ending in _test.
- Never derive test connectivity by guessing from a running developer/prod-like PostgreSQL volume.
- If the canonical disposable test instance cannot start, stop and report the infrastructure failure instead of trying multiple alternative database environments.

Canonical Windows integration-test environment:

docker compose -f docker-compose.yml -f docker-compose.local.yml up -d postgres-test

TEST_DATABASE_URL:
postgresql://amber_test:amber_test_local_only@127.0.0.1:55432/amber_test

Run from server/:
npm run test:integration

Afterward:
docker compose -f docker-compose.yml -f docker-compose.local.yml stop postgres-test

Do not fall back to another PostgreSQL instance if this environment fails.
Report the infrastructure failure instead.