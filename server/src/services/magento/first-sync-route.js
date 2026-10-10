const { own } = require('../export-templates/input-projection');

// Both field projection and currency evidence must select the same semantic
// route. Missing or malformed input cannot establish a negative predicate.
function productRoutePlans(plans, product) {
  return plans.filter(plan => plan.amberGroup === own(product, 'category')
    && plan.predicates.every(predicate => {
      const value = own(own(own(product, 'details'), 'answers'), predicate.questionKey);
      return ['string', 'number'].includes(typeof value) && /^(0|-?[1-9][0-9]*)$/.test(String(value))
        && Number.isSafeInteger(Number(value)) && (String(value) === predicate.valueId) === predicate.equal;
    }));
}

module.exports = { productRoutePlans };
