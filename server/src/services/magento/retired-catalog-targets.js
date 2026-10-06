const c = require('./binding-contract');

// Recorded cleanup, not a remote availability cache. Match the exact old ID,
// code and option against used binding rows; unused frozen schema is history.
const SQL = `SELECT DISTINCT a.revision_id,a.binding_key,a.route_key,a.row_id,a.target,
  a.attribute_code,s.attribute_id::text,d.kind,d.id AS cleanup_id,d.verified_at,
  d.intent#>>'{command,target,optionId}' AS option_id
  FROM magento_binding_attributes a
  JOIN magento_binding_routes r ON r.revision_id=a.revision_id AND r.route_key=a.route_key
  JOIN magento_binding_schema_attributes s ON s.revision_id=a.revision_id AND s.code=a.attribute_code
  JOIN magento_remote_catalog_deletions d ON d.origin_hash=$1 AND d.state='verified'
    AND d.intent#>>'{command,target,attributeCode}'=a.attribute_code
    AND d.intent#>>'{command,target,attributeId}'=s.attribute_id::text
  WHERE a.revision_id=ANY($2::text[]) AND r.enabled AND r.review_state <>'blocked'
    AND a.review_state <>'blocked'
    AND (d.kind='attribute_delete_remote' OR EXISTS (SELECT 1 FROM magento_binding_options o
      WHERE o.revision_id=a.revision_id AND o.binding_key=a.binding_key
        AND o.option_id=d.intent#>>'{command,target,optionId}' AND o.review_state <>'blocked'))
  ORDER BY a.revision_id,a.binding_key,d.id`;
function availability(rows = []) {
  return { state: rows.length ? 'retired_targets' : 'no_recorded_cleanup', publicationBlocked: rows.length > 0,
    resources: rows.map((row) => ({ categoryCode: row.route_key.split(/[.:]/)[0], rowId: row.row_id,
      bindingKey: row.binding_key, target: row.target, attributeCode: row.attribute_code, attributeId: row.attribute_id,
      optionId: row.kind === 'option_delete_remote' ? row.option_id : null,
      cleanupId: row.cleanup_id, deletedAt: row.verified_at })) };
}
async function read(client, originHash, ids) {
  if (!ids.length) return new Map();
  const rows = (await client.query(SQL, [originHash, ids])).rows;
  return new Map(ids.map((id) => [id, availability(rows.filter((row) => row.revision_id === id))]));
}
function assertAvailable(revision) {
  if (revision.catalogAvailability?.publicationBlocked) throw c.error(409, 'MAGENTO_BINDING_RETIRED_RESOURCE',
    'Чернетка посилається на вже видалені тестові ресурси Magento. Збережіть її як історію та підготуйте нову від чинної публікації.',
    { resources: revision.catalogAvailability.resources });
}
module.exports = { SQL, availability, read, assertAvailable };
