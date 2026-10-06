const { randomUUID } = require('node:crypto');

async function getCatalogWorkflow(queryable) {
  const activation = await queryable.query('SELECT enabled FROM public_sku_activation WHERE singleton');
  const native = activation.rows[0]?.enabled === true;
  return { identityMode: native ? 'public_identity' : 'encoded_sku', serverGeneratedQuestionKeys: native };
}

async function resolveNewQuestionKey(key, queryable) {
  const supplied = String(key || '').trim();
  if (supplied) return supplied;
  if (!(await getCatalogWorkflow(queryable)).serverGeneratedQuestionKeys) {
    throw Object.assign(new Error('Потрібні key та назва'), { statusCode: 400 });
  }
  return `q_${randomUUID().replaceAll('-', '')}`;
}

module.exports = { getCatalogWorkflow, resolveNewQuestionKey };
