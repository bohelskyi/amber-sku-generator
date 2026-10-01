// Recount preserves subjects. The shared full-name baseline is bound to the
// public identity and survives replacement of the internal product revision.
function inheritRecountNames(source) {
  return { ua: source.magento_name_subject_ua ?? null,
    en: source.magento_name_subject_en ?? null, reviewRequired: false };
}
module.exports = { inheritRecountNames };
