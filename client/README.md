# Amber SKU Manager client

This directory contains the React 19/Vite client for Amber SKU Manager. The Express server remains authoritative for authentication, permissions, SKU generation, validation, pricing, and workflow state; client permission checks only control presentation.

## Local development

Install the locked dependencies and start Vite:

```bash
npm ci
npm run dev
```

Use `VITE_API_BASE_URL` only for the public API origin when it differs from `/api`. Never place credentials or other secrets in a `VITE_*` variable because Vite includes those values in the browser bundle.

For direct local OIDC development, the repository documentation uses `http://localhost:5173` for the client and `http://localhost:5000/api/auth/callback` for the server callback. Use `localhost` consistently.

## Verification

```bash
npm test
npm run lint
npm run build
```

`npm test` runs the Node-based pure behavior tests followed by the jsdom/Vitest rendered component and workflow tests. The production build is emitted to `dist/` and served by nginx in the checked-in container topology.

See the root [`PROJECT_CONTEXT.md`](../PROJECT_CONTEXT.md), [`README.md`](../README.md), and domain documents under [`docs/`](../docs/) for architecture, permissions, deployment, and business invariants.
