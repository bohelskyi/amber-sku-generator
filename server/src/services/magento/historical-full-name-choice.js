const c = require('./binding-contract');
const { validPair } = require('../export-templates/effective-product-names');
const MAX_FULL_NAME_LENGTH = 255;
function fullNameChoice(input) {
  const mode = input.nameMode ?? 'template';
  if (!['template', 'full'].includes(mode)
    || mode === 'template' && (Object.hasOwn(input, 'fullNameUa') || Object.hasOwn(input, 'fullNameEn'))) {
    throw c.error(422, 'HISTORICAL_FULL_NAME_INVALID', 'Виберіть назви за шаблоном або обидві повні назви.');
  }
  const values = mode === 'full' ? { all: input.fullNameUa, en: input.fullNameEn } : null;
  if (values && (!validPair(values) || Object.values(values).some(value => value.length > MAX_FULL_NAME_LENGTH))) {
    throw c.error(422, 'HISTORICAL_FULL_NAME_INVALID', 'Вкажіть обидві повні назви до 255 символів без керівних символів.');
  }
  return { mode, values };
}
function nameOverride(generated, choice) {
  if (!validPair(generated)) throw c.error(409, 'HISTORICAL_MANUAL_NAMES_UNAVAILABLE', 'Шаблон не підтвердив обидві назви.');
  return choice.mode === 'full' ? { generated, values: choice.values } : null;
}
module.exports = { fullNameChoice, nameOverride, MAX_FULL_NAME_LENGTH };
