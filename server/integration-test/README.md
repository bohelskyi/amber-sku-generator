# PostgreSQL integration suite

`critical-flows.test.js` is the suite's only Node test entrypoint. It loads the numbered `*.cases.js` domain modules in order, and those modules share the destructive setup and server lifecycle in `suite-context.js`.

This structure is deliberate:

- the primary database name must end in `_test`;
- schema reset, migrations, fixtures, and server startup happen once per run;
- domain cases retain their established order and shared state;
- intentional race tests still use independent clients or processes;
- `npm run test:integration` also pins Node's test-file concurrency to one as defense in depth.

Do not add another `*.test.js` file that targets the same database. New cases should go into the appropriate ordered `*.cases.js` module. A separately discovered entrypoint is safe only when it provisions and validates its own isolated disposable database.
