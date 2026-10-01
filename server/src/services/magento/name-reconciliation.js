const { stableJson } = require('../export-exposure/evidence');

const same = (first, second) => stableJson(first) === stableJson(second);

// Compare field values, never product timestamps. A review only authorizes the
// exact two observed sides; it is not a substitute for a confirmed baseline.
function reconcileNames(baseline, amber, remote, resolution = null) {
  if (same(amber, remote)) return { action: 'confirm' };
  if (resolution && same(resolution.amber, amber) && same(resolution.remote, remote)) {
    return { action: 'send_amber' };
  }
  if (!baseline) return { action: 'baseline_required' };
  if (same(amber, baseline)) return { action: 'accept_external' };
  if (same(remote, baseline)) return { action: 'send_amber' };
  return { action: 'conflict' };
}

function applyNameOverride(mapped, product) {
  const generated = { ...(typeof mapped.base?.name === 'string' ? { all: mapped.base.name } : {}),
    ...(typeof mapped.english?.name === 'string' ? { en: mapped.english.name } : {}) };
  const override = product.magento_name_override;
  if (override && same(override.generated, generated)) {
    if (typeof override.values?.all === 'string') mapped.base.name = override.values.all;
    if (typeof override.values?.en === 'string') mapped.english.name = override.values.en;
  }
  return generated;
}

module.exports = { reconcileNames, applyNameOverride, same };
