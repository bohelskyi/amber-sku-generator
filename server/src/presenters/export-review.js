const { finalizeCsvValue } = require('../utils/csv');

// Observational only: never consumed by capture, hashing, readiness or serialization.
// A column target is used only when the evaluator/mapper identifies an emitted header.
function reviewProduct(product, position, mapped, headers, observation) {
  const issues = (observation?.issues || mapped.errors).map((issue) => ({
    ...issue,
    target: issue.target || (headers.includes(issue.field)
      ? { kind: 'column', column: issue.field } : { kind: 'row' }),
  }));
  const ready = mapped.errors.length === 0;
  return ['base', 'english'].map((side, rowIndex) => {
    const values = observation?.rows?.[side] || mapped[side];
    return {
      productId: Number(product.id), sku: String(product.full_sku), productPosition: position,
      ordinal: (position - 1) * 2 + rowIndex + 1,
      language: rowIndex ? 'en' : 'main', readiness: ready ? 'ready' : 'attention',
      issues: issues.filter((issue) => !issue.target.language || issue.target.language === (rowIndex ? 'en' : 'main')),
      cells: headers.map((column) => {
        const targeted = issues.some((issue) => (issue.target.column === column || issue.target.columns?.includes(column))
          && (!issue.target.language || issue.target.language === (rowIndex ? 'en' : 'main')));
        // An error placeholder is not a valid empty output. Unvisited cells stay unknown.
        if (!values || (observation && !Object.hasOwn(values, column)) || (!ready && targeted)) {
          return { state: 'not-evaluated', value: null };
        }
        const value = finalizeCsvValue(values[column] ?? '');
        return { state: ready ? (value === '' ? 'blank' : 'final') : 'provisional', value };
      }),
    };
  });
}

function reviewCollector(outputContract, outputBytes = 64 * 1024 * 1024) {
  const files = new Map(); let bytes = 0;
  return {
    add(product, position, mapped, headers, groupName, observation) {
      const rows = reviewProduct(product, position, mapped, headers, observation);
      bytes += Buffer.byteLength(JSON.stringify(rows));
      if (bytes > outputBytes) {
        const error = new Error('Diagnostic review UTF-8 limit exceeded');
        error.code = 'EVALUATION_LIMIT'; error.statusCode = 422; throw error;
      }
      if (!files.has(mapped.group)) files.set(mapped.group, {
        groupCode: mapped.group, groupName: groupName || mapped.group, headers,
        fileName: headers.length ? `amber-magento-${mapped.group}-${outputContract}.csv` : null,
        profileVersion: outputContract, rows: [],
      });
      files.get(mapped.group).rows.push(...rows);
    },
    result: () => ({ version: 'export-review-v1', files: [...files.values()] }),
  };
}
module.exports = { reviewProduct, reviewCollector };
