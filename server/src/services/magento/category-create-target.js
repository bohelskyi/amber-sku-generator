// Closed reviewed actions, not a general category-tree builder.
const PARENT = 'Default/Кулони';
const PATH = `${PARENT}/З інклюзом`;
const SOURCE = 'KL.addit=value_id:1';
const TARGETS = Object.freeze([
  Object.freeze({ path: PATH, parent: PARENT, source: SOURCE, routeKey: 'KL:all', name: 'З інклюзом' }),
  Object.freeze({ path: 'Default/Камінь/Камінь сувенірний', parent: 'Default/Камінь',
    source: 'SV.souvenir=value_id:5', routeKey: 'SV.souvenir=value_id:5', name: 'Камінь сувенірний' }),
]);
module.exports = { PARENT, PATH, SOURCE, TARGETS };
