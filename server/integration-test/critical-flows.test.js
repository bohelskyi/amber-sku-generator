// Keep all destructive PostgreSQL cases behind one Node test entrypoint.
// The ordered domain modules share one fixture lifecycle and therefore cannot race schema resets.
require('./suite-context');

for (const modulePath of [
  './01-platform-boundary.cases',
  './02-migration-foundation.cases',
  './03-authentication-sessions.cases',
  './04-product-access-audit.cases',
  './05-recount.cases',
  './05-product-price-change.cases',
  './06-migration-upgrades.cases',
  './07-catalog-pricing.cases',
  './08-products-pricing.cases',
  './09-corrections-drafts.cases',
  './10-repricing.cases',
  './11-exports-schemas.cases',
  './11-magento-products.cases',
  './12-rbac-audit.cases',
  './12-export-templates.cases',
  './12-export-template-snapshots.cases',
  './12-export-template-editor.cases',
  './12-export-sessions.cases',
  './12-export-grid.cases',
  './12-export-source-support.cases',
  './12-export-ux3.cases',
  './12-export-ux4.cases',
  './13-sqlite-import.cases',
]) {
  require(modulePath);
}
