// Investigation limits are operator-independent hard caps, not mapper rules.
const PLANS = Object.freeze([
  { id: 'sv_stone', category: 'SV', key: 'souvenir', value: '5', scan: 40, attempts: 40, found: 20 },
  { id: 'ch_dimensions', category: 'CH', required: ['bead_length', 'bead_width'], scan: 40, attempts: 40, found: 10 },
  { id: 'ar_28', category: 'AR', key: 'size', value: '28', scan: 40, attempts: 40, found: 40 },
  ...['29', '30', '31'].map((value) => ({ id: `ar_${value}`, category: 'AR', key: 'size', value,
    scan: 3, attempts: 3, found: 3 })),
  { id: 'kl_inclusion', category: 'KL', key: 'addit', value: '1', scan: 40, attempts: 40, found: 10 },
  { id: 'sv_subtype', category: 'SV', scan: 100, attempts: 40, found: 10 },
  ...['BR', 'NM', 'KL', 'CH', 'AR'].map((category) => ({ id: `scope_${category}`, category,
    scan: 10, attempts: 10, found: 2 })),
].map((p) => Object.freeze({ required: [], ...p })));
const SIZE_CASES = Object.freeze(['28', '29', '30', '31'].map((valueId) =>
  Object.freeze({ category: 'AR', key: 'size', valueId, target: 'rozmir_kartyny' })));
module.exports = { PLANS, SIZE_CASES };
