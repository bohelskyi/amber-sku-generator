const { buildCsv } = require('../utils/csv');
const { isRuleMatched } = require('../utils/rules');

const PROFILE_VERSION = 'magento-products-v1';
const GROUPS = Object.freeze({
  BR: 'Браслети',
  NM: 'Намиста',
  KL: 'Кулони',
  CH: 'Чотки',
  AR: 'Картини',
  SV: 'Сувеніри',
});

// Exact worksheet headers, including the workbook's historic spelling.
const HEADERS = Object.freeze({
  BR: 'sku store_view_code name price decor_weight dovzhyna_brasletu_diuimiv categories attribute_set_code product_type product_websites product_online visibility qty is_in_stock old_product is_ownproduction typy_obrobky_burshtynu vyd_obrobky_kameniu faktura_namystyn kolir forma_namystyn typ_vykonannia short_description description meta_title meta_description'.split(' '),
  NM: 'sku store_view_code name price dovzhyna_namysta_tochna categories attribute_set_code product_type product_websites product_online visibility qty is_in_stock old_product is_ownproduction decor_weight dovzhyna_namysta typy_obrobky_burshtynu vyd_obrobky_kameniu faktura_namystyn kolir forma_namystyn typ_vykonannia dodatkovo_namysta short_description description meta_title meta_description'.split(' '),
  KL: 'sku store_view_code name price rozmir_iuvelirnoho_vyrobu categories attribute_set_code product_type product_websites product_online visibility qty is_in_stock old_product is_ownproduction decor_weight typy_obrobky_burshtynu vyd_obrobky_kameniu faktura_kulonu kolir vyd_kulonu kulony_dodatkovo short_description description meta_title meta_description'.split(' '),
  CH: 'sku store_view_code name price dovzhyna_namystyny diametr_namystyny dovzhyna_vyrobu categories attribute_set_code product_type product_websites product_online visibility qty is_in_stock old_product is_ownproduction vaha_vyrobu rozmir_kameniu typy_obrobky_burshtynu faktura_namystyn kolir forma_namystyn relihiina_prynalezhnist kilkist_namystyn short_description description meta_title meta_description'.split(' '),
  AR: 'sku store_view_code name price categories attribute_set_code product_type product_websites product_online visibility qty is_in_stock old_product is_ownproduction kartynyy rozmir_kartyny sklo dodatkovo_kartyny kartyny_pidsvitka short_description description meta_title meta_description'.split(' '),
  SV: 'sku store_view_code name price decor_weight rozmir_suveniriv categories attribute_set_code product_type product_websites product_online visibility qty is_in_stock old_product is_ownproduction suveniry vyd_statuetky tematyka_vyrobu vyd_ptakha vyd_roslyny vyd_symvoliky nastlni_ihry kamin_obrobka kamin_suvenirnyi kolir typy_obrobky_burshtynu fraction short_description description meta_title meta_description'.split(' '),
});

const V = Object.freeze({
  raw: { 1: 'Натуральний', 2: 'Формований' },
  processing: { 1: 'Полірований', 2: 'Шліфований' },
  beadTexture: { 1: 'Прозора', 2: 'Напівпрозора', 3: 'Матова',
    4: 'Прозора', 5: 'Напівпрозора', 6: 'Матова', 7: 'Пейзажна', 8: 'Змішана' },
  pendantTexture: { 1: 'Прозорий', 2: 'Напівпрозорий', 3: 'Матовий',
    4: 'Прозорий', 5: 'Напівпрозорий', 6: 'Матовий', 7: 'Пейзажний' },
  color4: { 1: 'Світлий', 2: 'Темний', 3: 'Пейзажний', 4: 'Комбінований' },
  color3: { 1: 'Світлий', 2: 'Темний', 3: 'Пейзажний' },
  klColor: { 1: 'Світлий', 2: 'Темний' },
  svColor: { 1: 'Світлий', 2: 'Темний', 3: 'Комбінований', 4: 'Пейзажний' },
  beadShape: { 1: 'Куля', 2: 'Бочка', 3: 'Оливка', 4: 'Сегменти',
    5: 'Галька', 6: 'Геометрія', 7: 'Змішана' },
  chShape: { 1: 'Куля', 2: 'Бочка', 3: 'Оливка' },
  brStyle: { 1: 'Класичний', 2: 'Комбінований', 3: 'Комбінований',
    4: 'Комбінований', 5: 'Шамбала' },
  nmStyle: { 1: 'Класичний', 2: 'Комбінований', 3: 'Комбінований',
    4: 'Комбінований' },
  nmExtra: { 0: '', 1: 'З підвісками', 2: 'Дитяче' },
  klType: { 1: 'Природня форма', 2: 'Коло', 3: 'Овал', 4: 'Серце',
    5: 'Капля', 6: 'Хрест' },
  klAddit: { 1: 'Інклюз' },
  chReligion: { 1: 'Мусульманські', 2: 'Християнські' },
  chCount: { 0: '30', 1: '33', 2: '39', 3: '45', 4: '51',
    5: '66', 6: '75', 7: '99', 9: '?' },
  arType: { 1: 'Ікони', 2: 'Пейзажі', 3: 'Панно', 4: 'Символіка',
    5: 'Натюрморти', 6: 'Портрети', 7: 'Мозаїка' },
  arGlass: { 1: 'Зі склом' },
  arAdditional: { 1: 'На полотні', 2: 'На бархаті' },
  arBacklight: { 1: 'З підсвіткою' },
  svSouvenir: { 1: 'Статуетки', 2: 'Настільні ігри', 3: 'Ручки',
    4: 'Письмові набори', 5: 'Камінь сувенірний', 6: 'Брелоки',
    7: 'Лампи', 8: 'Скриньки', 9: 'Годинники' },
  // These IDs follow the deployed catalog's semantic answers, not the workbook SKU positions.
  svStatuette: { 1: 'Тварини', 2: 'Дерева та квіти', 3: 'Військова техніка',
    4: 'Зодіаки', 5: 'Символіка', 6: 'Вітрильники', 7: 'Авто' },
  svTheme: { 1: 'Ссавці', 2: 'Птахи', 3: 'Риби', 4: 'Плазуни',
    5: 'Земноводні', 6: 'Безхребетні' },
  svBird: { 1: 'Орел', 2: 'Пава', 3: 'Сова', 4: 'Сокіл',
    5: 'Фазан', 6: 'Лелека', 7: 'Фенікс' },
  svPlants: { 1: 'Дерева', 2: 'Квіти', 3: 'Ікебана' },
  svSymbolic: { 1: 'Українська', 2: 'Військова', 3: 'Спортивна',
    4: 'Професійна', 5: 'Релігійна', 6: 'Корпоративна' },
  svGames: { 1: 'Шахи', 2: 'Нарди', 3: 'Доміно', 4: 'Шашки/дама' },
  svStoneProcessing: { 0: 'Необроблений', 1: 'Полірований' },
  svAdditionalStone: { 1: 'З інклюзом', 2: 'На підставці' },
});

const ATTRIBUTE = Object.freeze({
  BR: {
    typy_obrobky_burshtynu: ['raw_type', V.raw],
    vyd_obrobky_kameniu: ['processing', V.processing],
    faktura_namystyn: ['texture', V.beadTexture],
    kolir: ['color', V.color4],
    forma_namystyn: ['shape', V.beadShape],
    typ_vykonannia: ['style', V.brStyle],
  },
  NM: {
    typy_obrobky_burshtynu: ['raw_type', V.raw],
    vyd_obrobky_kameniu: ['processing', V.processing],
    faktura_namystyn: ['texture', V.beadTexture],
    kolir: ['color', V.color4],
    forma_namystyn: ['shape', V.beadShape],
    typ_vykonannia: ['style', V.nmStyle],
    dodatkovo_namysta: ['extra', V.nmExtra],
  },
  KL: {
    typy_obrobky_burshtynu: ['raw_type', V.raw],
    vyd_obrobky_kameniu: ['processing', V.processing],
    faktura_kulonu: ['texture', V.pendantTexture],
    kolir: ['color', V.klColor],
    vyd_kulonu: ['type', V.klType],
    kulony_dodatkovo: ['addit', V.klAddit],
  },
  CH: {
    typy_obrobky_burshtynu: ['raw_type', V.raw],
    faktura_namystyn: ['texture', V.beadTexture],
    kolir: ['color', V.color3],
    forma_namystyn: ['shape', V.chShape],
    relihiina_prynalezhnist: ['religion', V.chReligion],
    kilkist_namystyn: ['count', V.chCount],
  },
  AR: {
    kartynyy: ['type', V.arType],
    rozmir_kartyny: ['size', null],
    sklo: ['glass', V.arGlass],
    dodatkovo_kartyny: ['additional', V.arAdditional],
    kartyny_pidsvitka: ['backlight', V.arBacklight],
  },
  SV: {
    suveniry: ['souvenir', V.svSouvenir],
    vyd_statuetky: ['statuette', V.svStatuette],
    tematyka_vyrobu: ['2', V.svTheme],
    vyd_ptakha: ['bird', V.svBird],
    vyd_roslyny: ['plants', V.svPlants],
    vyd_symvoliky: ['symbolic_stat', V.svSymbolic],
    nastlni_ihry: ['table_games', V.svGames],
    kamin_obrobka: ['stone_processing', V.svStoneProcessing],
    kamin_suvenirnyi: ['additional_stone', V.svAdditionalStone],
    kolir: ['color', V.svColor],
    typy_obrobky_burshtynu: ['material', V.raw],
  },
});

const SEO = Object.freeze({
  BR: { uaTitle: 'Браслет з бурштину купити у виробника  | Amber Galbin',
    uaDescription: 'Купити браслет з бурштину в Україні, широкий вибір ювелірних прикрас, вигідні ціни від виробника Amber Galbin, доставка по Україні. Телефонуйте або пишіть нам!' },
  NM: { uaTitle: 'Намисто з бурштину купити у виробника | Amber Galbin',
    uaDescription: 'Купити намисто з бурштину у Рівному, широкий вибір ювелірних прикрас, вигідні ціни від виробника Amber Galbin, доставка по Україні. Телефонуйте або пишіть нам!',
    enTitle: 'Buy amber necklace from the manufacturer | Amber Galbin',
    enDescription: 'Buy amber necklaces in Rivne, a wide selection of jewelry, favorable prices from the manufacturer Amber Galbin, delivery across Ukraine. Call or write to us!' },
  KL: { uaTitle: 'Кулон з бурштину купити у Рівному | Amber Galbin',
    uaDescription: 'Купити бурштиновий кулон у Рівному, широкий вибір ювелірних прикрас, вигідні ціни від виробника Amber Galbin, доставка по Україні. Телефонуйте або пишіть нам!',
    enTitle: 'Buy amber pendant in Rivne | Amber Galbin' },
  CH: { uaTitle: 'Чотки з бурштину купити у виробника  | Amber Galbin',
    uaDescription: 'Купити чотки, вервицю з бурштину, широкий асортимент, ручна робота, ціни від виробника Amber Galbin, швидка доставка по Україні. Телефонуйте або пишіть нам!' },
});

const AR_NAMES = Object.freeze({
  1: ['Ікона з бурштину', 'Amber icon'],
  2: ['Картина з бурштину пейзаж', 'Amber landscape painting'],
  3: ['Панно з бурштину', 'Amber panel'],
  4: ['Картина з бурштину символіка', 'Amber symbolic painting'],
  5: ['Картина з бурштину натюрморт', 'Amber still life painting'],
  6: ['Портрет з бурштину', 'Amber portrait'],
  7: ['Мозаїка з бурштину', 'Amber mosaic'],
});

function hasAnswer(answers, key) {
  return answers[key] !== undefined && answers[key] !== null
    && String(answers[key]).trim() !== '';
}

function optionValue(product, answers, questions, field, key, values, errors) {
  const question = questions.get(key);
  if (!question) {
    errors.push({ field, message: `В каталозі немає питання ${key}.` });
    return '';
  }
  if (!isRuleMatched(question.visible_if_json, answers)) return '';
  if (!hasAnswer(answers, key)) {
    if (Number(question.required) === 1) {
      errors.push({ field, message: `Немає відповіді ${key}.` });
    }
    return '';
  }
  const value = String(answers[key]);
  if (values === null) {
    const known = question.options.some((option) => String(option.value_id) === value);
    if (!known) errors.push({ field, message: `Невідоме value_id ${value} для ${key}.` });
    // The published painting-size value is a fixed Magento value only after mapping below.
    return known ? (AR_SIZE[value] || '') : '';
  }
  if (!Object.hasOwn(values, value)) {
    errors.push({ field, message: `Немає Magento-мапінгу для ${key}=${value}.` });
    return '';
  }
  return values[value];
}

const AR_SIZE = Object.freeze({
  1: '10×15', 2: '15×20', 3: '15×40', 4: '20×20', 5: '20×30',
  6: '30×30', 7: '30×40', 8: '30×50', 9: '30×60', 10: '40×40',
  11: '40×60', 12: '40×80', 13: '50×50', 14: '50×70', 15: '60×80',
  16: '60×90', 17: '80×80', 18: '70×100', 19: '70×140',
  20: '80×120', 21: '22×26', 22: '110×50', 23: '40×100',
  24: '100×100', 25: '120×150', 26: '120×180',
  27: '110×60', 28: '15×15',
});

function requiredText(answers, key, field, errors, required = true) {
  const value = hasAnswer(answers, key) ? String(answers[key]).trim() : '';
  if (!value && required) errors.push({ field, message: `Немає відповіді ${key}.` });
  return value;
}

function magentoDecimal(value, field, errors) {
  if (!value) return '';
  if (!/^\d+(?:[.,]\d+)?$/.test(value) || !Number.isFinite(Number(value.replace(',', '.')))) {
    errors.push({ field, message: 'Некоректне числове значення для Magento.' });
    return '';
  }
  return value.replace(',', '.');
}

function rawName(group, answers, sku, errors, product) {
  if (group === 'AR') {
    const pair = AR_NAMES[String(answers.type)];
    if (!pair) {
      errors.push({ field: 'name', message: 'Немає назви для AR.type.' });
      return ['', ''];
    }
    return [`${pair[0]}. Арт: ${sku}`, `${pair[1]}. Art: ${sku}`];
  }
  if (group === 'SV') {
    const manualUa = typeof product?.magento_name_subject_ua === 'string'
      ? product.magento_name_subject_ua.trim() : '';
    const manualEn = typeof product?.magento_name_subject_en === 'string'
      ? product.magento_name_subject_en.trim() : '';
    if (manualUa && manualEn) {
      return [`${manualUa} з бурштину. Арт: ${sku}`,
        `Amber ${manualEn}. Art: ${sku}`];
    }
    if (String(answers.souvenir) === '6') {
      return [`Брелок з бурштину. Арт: ${sku}`, `Amber key chain. Art: ${sku}`];
    }
    errors.push({ field: 'name', code: 'manual_name_required',
      message: 'Потрібна збережена українська та англійська назва товару.' });
    return ['', ''];
  }
  const raw = String(answers.raw_type);
  if (raw !== '1' && raw !== '2') {
    errors.push({ field: 'name', message: 'Немає мапінгу raw_type для назви.' });
    return ['', ''];
  }
  const noun = { BR: ['Браслет', 'bracelet'], NM: ['Намисто', 'necklace'],
    KL: ['Кулон', 'pendant'], CH: ['Чотки', 'rosary'] }[group];
  return [
    `${noun[0]} з ${raw === '1' ? 'натурального' : 'формованого'} бурштину. Арт: ${sku}`,
    `${raw === '1' ? 'Natural' : 'Pressed'} amber ${noun[1]}. Art: ${sku}`,
  ];
}

function numericWeight(value, field, errors) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    errors.push({ field, message: 'Немає додатної ваги для Magento.' });
    return '';
  }
  return String(n);
}

function fraction(weight) {
  const n = Number(weight);
  const bounds = [2, 5, 10, 20, 50, 100, 200, 300, 500, 1000];
  const names = ['0-2', '2-5', '5-10', '10-20', '20-50', '50-100',
    '100-200', '200-300', '300-500', '500-1000'];
  const i = bounds.findIndex((bound) => n < bound);
  return i < 0 ? '1000+' : names[i];
}

function necklaceBand(raw, errors) {
  if (!raw) return '';
  const n = Number(raw.replace(',', '.'));
  if (!Number.isFinite(n)) return raw;
  if (n >= 19 && n <= 35) return 'Колар (30-35 см)';
  if (n > 35 && n <= 42) return 'Чокер (35-40 см)';
  if (n >= 43 && n <= 49) return 'Принцеса (43-48 см)';
  if (n >= 50 && n <= 65) return 'Матіне (50-63 см)';
  if (n >= 66 && n <= 91) return 'Опера (66-91 см)';
  if (n >= 92 && n <= 180) return 'Роуп (120-180 см)';
  errors.push({ field: 'dovzhyna_namysta', message: 'Довжина не має затвердженого діапазону.' });
  return '';
}

function categoryPaths(group, answers, attrs, errors) {
  const base = `Default/${GROUPS[group]}`;
  if (group === 'AR') {
    return [base, `${base}/${attrs.kartynyy}`].join(',');
  }
  if (group === 'SV') {
    if (String(answers.souvenir) === '5') {
      const stone = 'Default/Камінь';
      return [stone, `${stone}/${attrs.suveniry}`,
        attrs.kamin_obrobka ? `${stone}/${attrs.kamin_obrobka}` : ''].filter(Boolean).join(',');
    }
    return [base, `${base}/${attrs.suveniry}`,
      attrs.vyd_statuetky ? `${base}/${attrs.suveniry}/${attrs.vyd_statuetky}` : '',
      attrs.nastlni_ihry ? `${base}/${attrs.suveniry}/${attrs.nastlni_ihry}` : '']
      .filter(Boolean).join(',');
  }
  const raw = String(answers.raw_type);
  const material = { 1: 'цільного каменю', 2: 'формованого' }[raw];
  if (!material) errors.push({ field: 'categories', message: 'Немає категорії для raw_type.' });
  if (group === 'BR' || group === 'NM') {
    const noun = GROUPS[group];
    const surface = { 1: 'полірованими', 2: 'шліфованими' }[String(answers.processing)];
    const texture = { 1: 'прозорою', 2: 'напівпрозорою', 3: 'матовою',
      4: 'прозорою', 5: 'напівпрозорою', 6: 'матовою',
      7: 'пейзажною', 8: 'змішаною' }[String(answers.texture)];
    const color = { 1: 'світлого', 2: 'темного', 3: 'пейзажного',
      4: 'комбінованого' }[String(answers.color)];
    const shape = { 1: 'кулі', 2: 'бочки', 3: 'оливки', 4: 'сегменти',
      5: 'галька', 6: 'геометрія', 7: group === 'BR' ? 'змішана форма' : 'змішані форми' }[String(answers.shape)];
    const style = String(answers.style) === '1' ? `Класичні ${noun.toLowerCase()}`
      : String(answers.style) === '5' && group === 'BR' ? 'Шамбала'
        : `Комбіновані ${noun.toLowerCase()}`;
    if (![surface, texture, color, shape].every(Boolean)) {
      errors.push({ field: 'categories', message: 'Немає мапінгу однієї з характеристик категорії.' });
    }
    return [base, `${base}/${noun} з ${material} бурштину`,
      `${base}/${noun} з ${surface} намистинами`,
      `${base}/${noun} з ${texture} фактурою намистин`,
      `${base}/${noun} ${color} кольору`,
      `${base}/${noun} з намистинами: ${shape}`,
      `${base}/${style}`,
      group === 'NM' && String(answers.extra) === '1' ? `${base}/Намиста з підвісками` : ''
    ].filter(Boolean).join(',');
  }
  if (group === 'KL') {
    const surface = { 1: 'полірованою', 2: 'шліфованою' }[String(answers.processing)];
    const texture = { 1: 'прозорою', 2: 'напівпрозорою', 3: 'матовою',
      4: 'прозорою', 5: 'напівпрозорою', 6: 'матовою',
      7: 'пейзажною' }[String(answers.texture)];
    const color = { 1: 'світлого', 2: 'темного' }[String(answers.color)];
    const shape = { 1: 'Природна форма кулона', 2: 'Форма: коло',
      3: 'Форма: овал', 4: 'Форма: серце', 5: 'Форма: крапля',
      6: 'Форма: хрест' }[String(answers.type)];
    if (![surface, texture, color, shape].every(Boolean)) {
      errors.push({ field: 'categories', message: 'Немає мапінгу однієї з характеристик категорії.' });
    }
    return [base, `${base}/Кулони з ${material} бурштину`,
      `${base}/Кулони з ${surface} поверхнею`,
      `${base}/Кулони з ${texture} фактурою`,
      `${base}/Кулони ${color} кольору`, `${base}/${shape}`,
      hasAnswer(answers, 'addit') ? `${base}/З інклюзом` : ''].filter(Boolean).join(',');
  }
  const texture = { 1: 'прозорими', 2: 'напівпрозорими', 3: 'матовими',
    4: 'прозорими', 5: 'напівпрозорими', 6: 'матовими',
    7: 'пейзажними' }[String(answers.texture)];
  const color = { 1: 'світлого', 2: 'темного', 3: 'пейзажного' }[String(answers.color)];
  const shape = { 1: 'кулі', 2: 'бочки', 3: 'оливки' }[String(answers.shape)];
  const religion = { 1: 'Мусульманські', 2: 'Християнські' }[String(answers.religion)];
  const count = V.chCount[String(answers.count)];
  if (![texture, color, shape, religion, count].every(Boolean) || count === '?') {
    errors.push({ field: 'categories', message: 'Немає мапінгу однієї з характеристик категорії.' });
  }
  return [base, `${base}/Чотки з ${material} бурштину`,
    `${base}/Чотки з ${texture} намистинами`,
    `${base}/Чотки ${color} кольору`,
    `${base}/Чотки з намистинами у формі ${shape}`,
    `${base}/${religion} чотки`,
    count !== '?' ? `${base}/Чотки на ${count} намистин` : ''
  ].filter(Boolean).join(',');
}

function paintingSeo(type, suffix) {
  const subjects = { 1: ['Ікони', 'ікони'], 2: ['Пейзажі', 'пейзажі'],
    3: ['Панно', 'панно'], 4: ['Символіка', 'картини із символікою'],
    5: ['Натюрморти', 'натюрморти'], 6: ['Портрети', 'портрети'],
    7: ['Мозаїка', 'декоративну мозаїку'] };
  const subject = subjects[String(type)];
  if (!subject) return '';
  if (suffix === 'title') {
    return `${subject[0]} з бурштину від виробника | купити в Amber Galbin`;
  }
  if (String(type) === '7') {
    return 'Купити декоративну мозаїку з бурштину від виробника Amber Galbin. Ручне оформлення підкреслює природну фактуру бурштину. Картини з бурштину від Amber Galbin';
  }
  return `Купити ${subject[1]} з бурштину від виробника Amber Galbin. Ручна робота підкреслює природну фактуру та красу бурштину. Картини з бурштину від Amber Galbin`;
}

function mapProduct(product, catalog = new Map()) {
  const group = String(product.category || '');
  if (!HEADERS[group]) {
    return { group, sku: product.full_sku, errors: [
      { field: 'attribute_set_code', message: 'Немає Magento-профілю для категорії.' },
    ] };
  }
  const answers = product.details?.answers && typeof product.details.answers === 'object'
    ? product.details.answers : {};
  const questions = catalog.get(group) || new Map();
  const errors = [];
  const sku = String(product.full_sku || '');
  const attrs = {};
  for (const [field, [key, values]] of Object.entries(ATTRIBUTE[group])) {
    attrs[field] = optionValue(product, answers, questions, field, key, values, errors);
    if (group === 'AR' && field === 'rozmir_kartyny' && hasAnswer(answers, key) && !attrs[field]) {
      errors.push({ field, message: `Немає Magento-мапінгу для size=${answers[key]}.` });
    }
  }
  const [uaName, enName] = rawName(group, answers, sku, errors, product);
  const price = Number(product.total_price_uah);
  if (!Number.isFinite(price) || price <= 0) {
    errors.push({ field: 'price', message: 'Немає додатної збереженої фінальної ціни UAH.' });
  }
  const base = {
    sku,
    store_view_code: '',
    name: uaName,
    price: Number.isFinite(price) && price > 0 ? String(price) : '',
    categories: categoryPaths(group, answers, attrs, errors),
    attribute_set_code: group === 'SV' && String(answers.souvenir) === '5'
      ? 'Камінь' : GROUPS[group],
    product_type: 'simple',
    product_websites: 'base',
    product_online: '2',
    visibility: 'Catalog, Search',
    qty: '1',
    is_in_stock: '1',
    old_product: 'No',
    is_ownproduction: 'Yes',
    short_description: '',
    description: '',
    ...attrs,
  };
  if (['BR', 'NM', 'KL'].includes(group)) {
    base.decor_weight = numericWeight(product.weight, 'decor_weight', errors);
  }
  if (group === 'BR') {
    base.dovzhyna_brasletu_diuimiv = requiredText(
      answers, 'braclet_size', 'dovzhyna_brasletu_diuimiv', errors
    );
  }
  if (group === 'NM') {
    base.dovzhyna_namysta_tochna = requiredText(
      answers, 'neckle_size', 'dovzhyna_namysta_tochna', errors
    );
    base.dovzhyna_namysta = necklaceBand(base.dovzhyna_namysta_tochna, errors);
  }
  if (group === 'KL') {
    // Historical KL products can have only exact_size; current catalog uses pedant_size.
    const dimensionKey = hasAnswer(answers, 'pedant_size') ? 'pedant_size' : 'exact_size';
    base.rozmir_iuvelirnoho_vyrobu = requiredText(
      answers, dimensionKey, 'rozmir_iuvelirnoho_vyrobu', errors, false
    );
  }
  if (group === 'CH') {
    base.dovzhyna_namystyny = requiredText(answers, 'bead_length', 'dovzhyna_namystyny', errors);
    base.diametr_namystyny = requiredText(answers, 'bead_width', 'diametr_namystyny', errors);
    base.dovzhyna_vyrobu = requiredText(answers, 'rosary_length', 'dovzhyna_vyrobu', errors);
    base.vaha_vyrobu = numericWeight(product.weight, 'vaha_vyrobu', errors);
    base.rozmir_kameniu = base.dovzhyna_namystyny && base.diametr_namystyny
      ? `${base.dovzhyna_namystyny}×${base.diametr_namystyny}` : '';
    for (const field of ['dovzhyna_namystyny', 'diametr_namystyny', 'dovzhyna_vyrobu']) {
      base[field] = magentoDecimal(base[field], field, errors);
    }
  }
  if (group === 'AR' && !hasAnswer(answers, 'glass')) base.sklo = 'Без скла';
  if (group === 'SV') {
    base.decor_weight = numericWeight(answers.weight, 'decor_weight', errors);
    base.rozmir_suveniriv = requiredText(answers, 'size', 'rozmir_suveniriv', errors);
    base.fraction = String(answers.souvenir) === '5' && base.decor_weight
      ? fraction(base.decor_weight) : '';
  }
  if (SEO[group]) {
    base.meta_title = SEO[group].uaTitle;
    base.meta_description = SEO[group].uaDescription;
  } else if (group === 'AR') {
    base.meta_title = paintingSeo(answers.type, 'title');
    base.meta_description = paintingSeo(answers.type, 'description');
  }
  const english = { sku, store_view_code: 'en', name: enName,
    attribute_set_code: base.attribute_set_code, product_type: 'simple' };
  if (SEO[group]?.enTitle) english.meta_title = SEO[group].enTitle;
  if (SEO[group]?.enDescription) english.meta_description = SEO[group].enDescription;
  return { group, sku, errors, base, english };
}

async function loadMagentoCatalog(queryable) {
  const rows = await queryable.query(
    `SELECT q.category_code, q.key, q.required, q.visible_if_json,
            o.value_id
     FROM questions q
     LEFT JOIN options o ON o.question_id = q.id
     WHERE q.category_code = ANY($1::text[])
     ORDER BY q.category_code, q.id, o.id`,
    [Object.keys(GROUPS)]
  );
  const catalog = new Map();
  for (const row of rows.rows) {
    if (!catalog.has(row.category_code)) catalog.set(row.category_code, new Map());
    const questions = catalog.get(row.category_code);
    if (!questions.has(row.key)) {
      questions.set(row.key, { required: row.required,
        visible_if_json: row.visible_if_json, options: [] });
    }
    if (row.value_id !== null) questions.get(row.key).options.push({ value_id: row.value_id });
  }
  return catalog;
}

function buildMagentoPayload(products, catalog, { review = false } = {}) {
  const byGroup = new Map();
  const errors = [];
  const collector = review ? require('../presenters/export-review').reviewCollector(PROFILE_VERSION) : null;
  let position = 0;
  for (const product of products) {
    const mapped = mapProduct(product, catalog);
    collector?.add(product, ++position, mapped, HEADERS[mapped.group] || [], GROUPS[mapped.group]);
    if (mapped.errors.length) {
      errors.push({ productId: Number(product.id), sku: mapped.sku,
        group: mapped.group, fields: mapped.errors });
    } else {
      if (!byGroup.has(mapped.group)) byGroup.set(mapped.group, []);
      byGroup.get(mapped.group).push(mapped);
    }
  }
  const artifacts = [];
  for (const [group, items] of byGroup) {
    const headers = HEADERS[group];
    const rows = [headers];
    for (const item of items) {
      rows.push(headers.map((field) => item.base[field] ?? ''));
      rows.push(headers.map((field) => item.english[field] ?? ''));
    }
    artifacts.push({ groupCode: group, groupName: GROUPS[group],
      profileVersion: PROFILE_VERSION, productCount: items.length,
      rowCount: items.length * 2,
      fileName: `amber-magento-${group}-${PROFILE_VERSION}.csv`,
      csvContent: buildCsv(rows) });
  }
  return { representedCount: products.length, readyCount: products.length - errors.length,
    errors, artifacts, ...(collector ? { review: collector.result() } : {}) };
}

module.exports = {
  ATTRIBUTE,
  GROUPS,
  HEADERS,
  PROFILE_VERSION,
  V,
  buildMagentoPayload,
  loadMagentoCatalog,
  mapProduct,
};
