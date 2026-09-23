const { GROUPS, HEADERS, V, ATTRIBUTE, SEO, AR_NAMES, AR_SIZE } = require('./magento-v1-data');
const { LIMITS, validateDefinition, validateJsonData } = require('./definition');
const { fail } = require('./input-projection');

const literal = (value) => ({ op: 'literal', value });
const ref = (id) => ({ op: 'ref', id });
const source = (id) => ({ op: 'source', id });
const semantic = (input) => ({ op: 'semanticKey', input });
const present = (input) => ({ op: 'present', input, policy: 'answer-v1' });
const text = (input, trim = true, format = 'scalar-v1') => ({ op: 'text', input, trim, format, onAbsent: 'empty' });
const eq = (left, value) => ({ op: 'eq', left, right: literal(value) });
const not = (input) => ({ op: 'not', input });
const all = (...items) => ({ op: 'all', items });
const when = (condition, yes, no = literal('')) => ({ op: 'when', if: condition, then: yes, else: no });
const lookup = (input, table, otherwise = literal('')) => ({ op: 'lookup', input, table, otherwise });
const interpolate = (template, slots) => ({ op: 'interpolate', template, slots });
const join = (items) => ({ op: 'join', items, delimiter: ',', omitEmpty: true });
const error = (field, message, code) => ({ op: 'error', field,
  message: typeof message === 'string' ? literal(message) : message, ...(code ? { code } : {}) });
const requireValue = (condition, value, diagnostic) => ({ op: 'require', if: condition, value, error: diagnostic });
const numberText = (input, field, message) => ({ op: 'numberText', input,
  format: 'js-number-positive-v1', error: error(field, message) });
const categoryError = () => error('categories', 'Немає мапінгу однієї з характеристик категорії.');
const table = (values) => Object.fromEntries(values.map((value, i) => [String(i + 1), value]));
function catalogProperty(object, key) {
  if (!object || typeof object !== 'object') fail('TEMPLATE_INVALID', 'Catalog object required');
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) fail('TEMPLATE_INVALID', 'Catalog accessor forbidden');
  return descriptor.value;
}

// Materialization consumes an explicit captured catalog, never a database/default catalog.
// Helpers below build JSON syntax; no helper accepts or evaluates a product.
function materializeMagentoV1(catalog) {
  if (!(catalog instanceof Map)) fail('TEMPLATE_INVALID', 'Explicit catalog Map required');
  const d = { formatVersion: 1, evaluatorVersion: 'magento-declarative-1', outputContract: 'magento-products-v1',
    sources: {}, tables: { ...V, arSize: AR_SIZE }, questionContracts: {}, bindings: [], groups: [] };
  for (const field of ['full_sku', 'total_price_uah', 'weight', 'magento_name_subject_ua', 'magento_name_subject_en']) {
    d.sources[field] = { kind: 'product', field, type: field === 'full_sku' ? 'text' : 'scalar' };
  }
  d.bindings.push({ id: 'sku', group: '*', value: text(source('full_sku'), false) });
  d.tables.materialCategory = table(['цільного каменю', 'формованого']);
  d.tables.materialUa = table(['натурального', 'формованого']);
  d.tables.materialEn = table(['Natural', 'Pressed']);
  d.tables.surfaceBead = table(['полірованими', 'шліфованими']);
  d.tables.surfacePendant = table(['полірованою', 'шліфованою']);
  d.tables.textureBead = table(['прозорою', 'напівпрозорою', 'матовою', 'прозорою', 'напівпрозорою', 'матовою', 'пейзажною', 'змішаною']);
  d.tables.texturePendant = table(['прозорою', 'напівпрозорою', 'матовою', 'прозорою', 'напівпрозорою', 'матовою', 'пейзажною']);
  d.tables.textureRosary = table(['прозорими', 'напівпрозорими', 'матовими', 'прозорими', 'напівпрозорими', 'матовими', 'пейзажними']);
  d.tables.colorCategory = table(['світлого', 'темного', 'пейзажного', 'комбінованого']);
  d.tables.colorPendant = table(['світлого', 'темного']);
  d.tables.colorRosary = table(['світлого', 'темного', 'пейзажного']);
  d.tables.shapeBR = table(['кулі', 'бочки', 'оливки', 'сегменти', 'галька', 'геометрія', 'змішана форма']);
  d.tables.shapeNM = table(['кулі', 'бочки', 'оливки', 'сегменти', 'галька', 'геометрія', 'змішані форми']);
  d.tables.shapeCH = table(['кулі', 'бочки', 'оливки']);
  d.tables.shapeKL = table(['Природна форма кулона', 'Форма: коло', 'Форма: овал', 'Форма: серце', 'Форма: крапля', 'Форма: хрест']);
  d.tables.arNameUa = Object.fromEntries(Object.entries(AR_NAMES).map(([key, pair]) => [key, pair[0]]));
  d.tables.arNameEn = Object.fromEntries(Object.entries(AR_NAMES).map(([key, pair]) => [key, pair[1]]));
  d.tables.arSeoSubject = table(['ікони', 'пейзажі', 'панно', 'картини із символікою', 'натюрморти', 'портрети', 'декоративну мозаїку']);
  const nouns = { BR: ['Браслет', 'bracelet'], NM: ['Намисто', 'necklace'], KL: ['Кулон', 'pendant'], CH: ['Чотки', 'rosary'] };
  for (const [group, name] of Object.entries(GROUPS)) {
    const questions = catalog.get(group);
    if (questions !== undefined && !(questions instanceof Map)) fail('TEMPLATE_INVALID', 'Catalog group must be a Map');
    const profile = { route: group, name, columns: [...HEADERS[group]], evaluate: [], rows: [] };
    const base = {};
    const english = {};
    const answer = (key, kind = 'semantic') => {
      if (!/^[A-Za-z0-9_]+$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) {
        fail('TEMPLATE_INVALID', 'Unsupported answer key');
      }
      const id = `${group}.${key}`;
      if (!Object.hasOwn(d.sources, id)) d.sources[id] = { kind, category: group, key,
        type: 'scalar', provenance: 'supplied-stored-answers-v1', aliases: [] };
      return source(id);
    };
    const key = (k) => semantic(answer(k));
    const bind = (id, value, eager = false) => {
      const reference = ref(`${group}.${id}`);
      d.bindings.push({ id: reference.id, group, value });
      if (eager) profile.evaluate.push(reference);
      return reference;
    };
    const cell = (field, value) => { base[field] = bind(field, value, true); return base[field]; };
    const attr = (field) => ref(`${group}.${field}`);
    function capturedRule(raw) {
      if (raw === null || raw === undefined || raw === '') return {};
      let r = raw;
      if (typeof r === 'string') {
        if (Buffer.byteLength(r) > LIMITS.definitionBytes) fail('TEMPLATE_INVALID', 'Catalog rule byte limit');
        try { r = JSON.parse(r); } catch { fail('TEMPLATE_INVALID', 'Malformed catalog JSON'); }
      }
      validateJsonData(r);
      const active = new Set();
      function convert(v, depth = 1) {
        if (!v || typeof v !== 'object' || Array.isArray(v) || depth > LIMITS.depth || active.has(v)) {
          fail('TEMPLATE_INVALID', 'Malformed catalog rule');
        }
        active.add(v);
        const clauses = [];
        for (const k in v) {
          if (!Object.hasOwn(v, k)) fail('TEMPLATE_INVALID', 'Inherited catalog rule');
          if (clauses.length >= LIMITS.children) fail('TEMPLATE_INVALID', 'Catalog rule branches');
          const descriptor = Object.getOwnPropertyDescriptor(v, k);
          if (!Object.hasOwn(descriptor, 'value')) fail('TEMPLATE_INVALID', 'Catalog rule accessor');
          const value = descriptor.value;
          const result = {};
          if (k === '$and' || k === '$or') {
            if (!Array.isArray(value) || value.length > LIMITS.children) fail('TEMPLATE_INVALID', 'Malformed catalog logical rule');
            result[k] = value.map((branch) => convert(branch, depth + 1));
          } else {
            const values = Array.isArray(value) ? value : [value];
            if (values.length > LIMITS.children || values.some((x) => x !== null
              && (!['string', 'number', 'boolean'].includes(typeof x) || (typeof x === 'number' && !Number.isFinite(x))))) {
              fail('TEMPLATE_INVALID', 'Malformed catalog scalar');
            }
            result[answer(k).id] = value;
          }
          clauses.push(result);
        }
        active.delete(v);
        // Legacy short-circuit order is semantic: capture it in an ordered array,
        // so canonical object-key sorting cannot make a hidden source execute.
        return clauses.length > 1 ? { $and: clauses } : clauses[0] || {};
      }
      return convert(r);
    }
    for (const [field, [storageKey, dictionary]] of Object.entries(ATTRIBUTE[group])) {
      const src = answer(storageKey);
      const q = questions?.get(storageKey);
      const required = q === undefined ? 0 : catalogProperty(q, 'required');
      const options = q === undefined ? [] : catalogProperty(q, 'options');
      if (![0, 1, '0', '1'].includes(required) || !Array.isArray(options) || options.length > LIMITS.tableEntries) {
        fail('TEMPLATE_INVALID', 'Malformed captured question');
      }
      const allowed = [];
      for (let i = 0; i < options.length; i++) {
        const value = catalogProperty(catalogProperty(options, String(i)), 'value_id');
        if (!['string', 'number'].includes(typeof value)
          || (typeof value === 'number' && !Number.isFinite(value))) fail('TEMPLATE_INVALID', 'Malformed option ID');
        allowed.push(String(value));
      }
      if (new Set(allowed).size !== allowed.length) fail('TEMPLATE_INVALID', 'Duplicate captured option ID');
      const contract = `${group}.${storageKey}`;
      d.questionContracts[contract] = { source: src.id, exists: q !== undefined,
        required: Number(required) === 1,
        rule: capturedRule(q === undefined ? null : catalogProperty(q, 'visible_if_json')), allowed };
      let value = lookup(semantic(src), dictionary, error(field,
        interpolate(`Немає Magento-мапінгу для ${storageKey}={value}.`, { value: semantic(src) })));
      if (group === 'AR' && storageKey === 'size') {
        value = when({ op: 'in', input: semantic(src), values: allowed }, lookup(semantic(src), dictionary),
          error(field, interpolate('Невідоме value_id {value} для size.', { value: semantic(src) })));
      }
      cell(field, { op: 'questionValue', question: contract, value,
        missingQuestion: error(field, `В каталозі немає питання ${storageKey}.`),
        missingAnswer: error(field, `Немає відповіді ${storageKey}.`) });
      if (group === 'AR' && storageKey === 'size') {
        bind('sizePostcheck', requireValue(not(all(present(src), eq(attr(field), ''))), literal(''),
          error(field, interpolate('Немає Magento-мапінгу для size={value}.', { value: semantic(src) }))), true);
      }
    }
    const sku = ref('sku');
    let uaName;
    let enName;
    if (group === 'AR') {
      const ua = bind('nameSubjectUa', lookup(key('type'), 'arNameUa'));
      const en = bind('nameSubjectEn', lookup(key('type'), 'arNameEn'));
      bind('nameCheck', requireValue(present(ua), literal(''), error('name', 'Немає назви для AR.type.')), true);
      uaName = when(present(ua), interpolate('{subject}. Арт: {sku}', { subject: ua, sku }));
      enName = when(present(en), interpolate('{subject}. Art: {sku}', { subject: en, sku }));
    } else if (group === 'SV') {
      const ua = bind('manualUa', text(source('magento_name_subject_ua'), true, 'string-only-v1'));
      const en = bind('manualEn', text(source('magento_name_subject_en'), true, 'string-only-v1'));
      const pair = bind('manualPair', all(present(ua), present(en)));
      const automatic = bind('automaticName', eq(key('souvenir'), '6'));
      bind('nameCheck', requireValue({ op: 'any', items: [pair, automatic] }, literal(''),
        error('name', 'Потрібна збережена українська та англійська назва товару.', 'manual_name_required')), true);
      uaName = when(pair, interpolate('{subject} з бурштину. Арт: {sku}', { subject: ua, sku }),
        when(automatic, interpolate('Брелок з бурштину. Арт: {sku}', { sku })));
      enName = when(pair, interpolate('Amber {subject}. Art: {sku}', { subject: en, sku }),
        when(automatic, interpolate('Amber key chain. Art: {sku}', { sku })));
    } else {
      const valid = bind('nameValid', { op: 'in', input: key('raw_type'), values: ['1', '2'] });
      bind('nameCheck', requireValue(valid, literal(''), error('name', 'Немає мапінгу raw_type для назви.')), true);
      uaName = when(valid, interpolate(`${nouns[group][0]} з {material} бурштину. Арт: {sku}`,
        { material: lookup(key('raw_type'), 'materialUa'), sku }));
      enName = when(valid, interpolate(`{material} amber ${nouns[group][1]}. Art: {sku}`,
        { material: lookup(key('raw_type'), 'materialEn'), sku }));
    }
    base.sku = sku;
    base.store_view_code = literal('');
    base.name = bind('nameUa', uaName);
    cell('price', numberText(source('total_price_uah'), 'price', 'Немає додатної збереженої фінальної ціни UAH.'));
    const root = `Default/${name}`;
    const path = (template, slots = {}) => interpolate(`${root}/${template}`, slots);
    let paths;
    if (group === 'AR') {
      paths = [literal(root), path('{type}', { type: attr('kartynyy') })];
    } else if (group === 'SV') {
      const regular = join([literal(root), path('{type}', { type: attr('suveniry') }),
        when(present(attr('vyd_statuetky')), path('{type}/{subtype}', { type: attr('suveniry'), subtype: attr('vyd_statuetky') })),
        when(present(attr('nastlni_ihry')), path('{type}/{game}', { type: attr('suveniry'), game: attr('nastlni_ihry') }))]);
      const stone = join([literal('Default/Камінь'), interpolate('Default/Камінь/{type}', { type: attr('suveniry') }),
        when(present(attr('kamin_obrobka')), interpolate('Default/Камінь/{processing}', { processing: attr('kamin_obrobka') }))]);
      cell('categories', when(eq(key('souvenir'), '5'), stone, regular));
    } else {
      const phrase = (id, storageKey, dictionary) => bind(`category.${id}`, lookup(key(storageKey), dictionary, literal('undefined')));
      const material = phrase('material', 'raw_type', 'materialCategory');
      bind('materialCheck', requireValue(not(eq(material, 'undefined')), literal(''), error('categories', 'Немає категорії для raw_type.')), true);
      let surface;
      if (group !== 'CH') surface = phrase('surface', 'processing', group === 'KL' ? 'surfacePendant' : 'surfaceBead');
      const texture = phrase('texture', 'texture', group === 'CH' ? 'textureRosary' : group === 'KL' ? 'texturePendant' : 'textureBead');
      const color = phrase('color', 'color', group === 'CH' ? 'colorRosary' : group === 'KL' ? 'colorPendant' : 'colorCategory');
      const shape = phrase('shape', group === 'KL' ? 'type' : 'shape', `shape${group}`);
      const valid = [surface, texture, color, shape].filter((v) => v !== undefined).map((v) => not(eq(v, 'undefined')));
      let religion; let count;
      if (group === 'CH') {
        religion = phrase('religion', 'religion', 'chReligion');
        count = phrase('count', 'count', 'chCount');
        valid.push(not(eq(religion, 'undefined')), not(eq(count, 'undefined')), not(eq(count, '?')));
      }
      bind('categoryCheck', requireValue(all(...valid), literal(''), categoryError()), true);
      paths = [literal(root), path(`${name} з {material} бурштину`, { material })];
      if (group === 'BR' || group === 'NM') {
        d.tables[`style${group}`] = { 1: `Класичні ${name.toLowerCase()}`, ...(group === 'BR' ? { 5: 'Шамбала' } : {}) };
        paths.push(path(`${name} з {surface} намистинами`, { surface }), path(`${name} з {texture} фактурою намистин`, { texture }),
          path(`${name} {color} кольору`, { color }), path(`${name} з намистинами: {shape}`, { shape }),
          path('{style}', { style: lookup(key('style'), `style${group}`, literal(`Комбіновані ${name.toLowerCase()}`)) }));
        if (group === 'NM') paths.push(when(eq(key('extra'), '1'), literal(`${root}/Намиста з підвісками`)));
      } else if (group === 'KL') {
        // Named legacy expression: presence (including 0), NOT a business-approved inclusion rule.
        const legacyInclusionPresence = bind('legacyInclusionPresence', present(answer('addit')));
        paths.push(path('Кулони з {surface} поверхнею', { surface }), path('Кулони з {texture} фактурою', { texture }),
          path('Кулони {color} кольору', { color }), path('{shape}', { shape }),
          when(legacyInclusionPresence, literal(`${root}/З інклюзом`)));
      } else {
        paths.push(path('Чотки з {texture} намистинами', { texture }), path('Чотки {color} кольору', { color }),
          path('Чотки з намистинами у формі {shape}', { shape }), path('{religion} чотки', { religion }),
          when(not(eq(count, '?')), path('Чотки на {count} намистин', { count })));
      }
    }
    if (paths) cell('categories', join(paths));
    base.attribute_set_code = group === 'SV' ? when(eq(key('souvenir'), '5'), literal('Камінь'), literal(name)) : literal(name);
    for (const [field, value] of Object.entries({ product_type: 'simple', product_websites: 'base', product_online: '2',
      visibility: 'Catalog, Search', qty: '1', is_in_stock: '1', old_product: 'No', is_ownproduction: 'Yes', short_description: '', description: '' })) {
      base[field] = literal(value);
    }
    const weight = (src, field) => cell(field, numberText(src, field, 'Немає додатної ваги для Magento.'));
    const requiredText = (storageKey, field) => when(present(answer(storageKey, 'information')),
      text(answer(storageKey, 'information')), error(field, `Немає відповіді ${storageKey}.`));
    if (['BR', 'NM', 'KL'].includes(group)) weight(source('weight'), 'decor_weight');
    if (group === 'BR') cell('dovzhyna_brasletu_diuimiv', requiredText('braclet_size', 'dovzhyna_brasletu_diuimiv'));
    if (group === 'NM') {
      cell('dovzhyna_namysta_tochna', requiredText('neckle_size', 'dovzhyna_namysta_tochna'));
      cell('dovzhyna_namysta', { op: 'numericBand', input: attr('dovzhyna_namysta_tochna'), format: 'first-comma-number-v1',
        onInvalid: 'input', outside: error('dovzhyna_namysta', 'Довжина не має затвердженого діапазону.'),
        bands: [[19, 35, true, 'Колар (30-35 см)'], [35, 42, false, 'Чокер (35-40 см)'], [43, 49, true, 'Принцеса (43-48 см)'],
          [50, 65, true, 'Матіне (50-63 см)'], [66, 91, true, 'Опера (66-91 см)'], [92, 180, true, 'Роуп (120-180 см)']]
          .map(([min, max, minInclusive, value]) => ({ min, max, minInclusive, maxInclusive: true, value })) });
    }
    if (group === 'KL') cell('rozmir_iuvelirnoho_vyrobu', text({ op: 'firstPresent',
      items: [answer('pedant_size', 'information'), answer('exact_size', 'information')], policy: 'answer-v1' }));
    if (group === 'CH') {
      const fields = [['bead_length', 'dovzhyna_namystyny'], ['bead_width', 'diametr_namystyny'], ['rosary_length', 'dovzhyna_vyrobu']];
      for (const [storageKey, field] of fields) bind(`raw.${field}`, requiredText(storageKey, field), true);
      weight(source('weight'), 'vaha_vyrobu');
      const length = ref('CH.raw.dovzhyna_namystyny'); const width = ref('CH.raw.diametr_namystyny');
      cell('rozmir_kameniu', when(all(present(length), present(width)), interpolate('{length}×{width}', { length, width })));
      for (const [, field] of fields) cell(field, { op: 'decimalText', input: ref(`CH.raw.${field}`), format: 'unsigned-comma-dot-v1',
        error: error(field, 'Некоректне числове значення для Magento.') });
    }
    if (group === 'AR') base.sklo = when(present(answer('glass')), attr('sklo'), literal('Без скла'));
    if (group === 'SV') {
      weight(answer('weight', 'information'), 'decor_weight');
      cell('rozmir_suveniriv', requiredText('size', 'rozmir_suveniriv'));
      cell('fraction', when(all(eq(key('souvenir'), '5'), present(attr('decor_weight'))), {
        op: 'numericBand', input: attr('decor_weight'), format: 'number-v1', onInvalid: 'error', outside: literal('1000+'),
        bands: [2, 5, 10, 20, 50, 100, 200, 300, 500, 1000].map((max, i, bounds) => ({
          min: null, max, minInclusive: true, maxInclusive: false, value: `${i === 0 ? 0 : bounds[i - 1]}-${max}` })) }));
    }
    if (SEO[group]) {
      base.meta_title = literal(SEO[group].uaTitle);
      base.meta_description = literal(SEO[group].uaDescription);
      if (SEO[group].enTitle) english.meta_title = literal(SEO[group].enTitle);
      if (SEO[group].enDescription) english.meta_description = literal(SEO[group].enDescription);
    } else if (group === 'AR') {
      const title = bind('seoTitle', lookup(key('type'), 'arType'));
      const subject = bind('seoSubject', lookup(key('type'), 'arSeoSubject'));
      base.meta_title = when(present(title), interpolate('{title} з бурштину від виробника | купити в Amber Galbin', { title }));
      base.meta_description = when(present(subject), when(eq(key('type'), '7'),
        literal('Купити декоративну мозаїку з бурштину від виробника Amber Galbin. Ручне оформлення підкреслює природну фактуру бурштину. Картини з бурштину від Amber Galbin'),
        interpolate('Купити {subject} з бурштину від виробника Amber Galbin. Ручна робота підкреслює природну фактуру та красу бурштину. Картини з бурштину від Amber Galbin', { subject })));
    }
    Object.assign(english, { sku, store_view_code: literal('en'), name: bind('nameEn', enName),
      attribute_set_code: base.attribute_set_code, product_type: literal('simple') });
    profile.rows = [{ id: 'base', default: '', cells: base }, { id: 'english', default: '', cells: english }];
    d.groups.push(profile);
  }
  // Detach every table, rule, ID array and row from the catalog and module literals.
  validateDefinition(d);
  return JSON.parse(JSON.stringify(d));
}

module.exports = { materializeMagentoV1 };
