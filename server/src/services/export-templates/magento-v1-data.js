// Audited Magento v1 literal data. No evaluator or legacy mapper dependency.
const GROUPS = Object.freeze({
  BR: 'Браслети',
  NM: 'Намиста',
  KL: 'Кулони',
  CH: 'Чотки',
  AR: 'Картини',
  SV: 'Сувеніри',
});

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
    typy_obrobky_burshtynu: ['raw_type', 'raw'],
    vyd_obrobky_kameniu: ['processing', 'processing'],
    faktura_namystyn: ['texture', 'beadTexture'],
    kolir: ['color', 'color4'],
    forma_namystyn: ['shape', 'beadShape'],
    typ_vykonannia: ['style', 'brStyle'],
  },
  NM: {
    typy_obrobky_burshtynu: ['raw_type', 'raw'],
    vyd_obrobky_kameniu: ['processing', 'processing'],
    faktura_namystyn: ['texture', 'beadTexture'],
    kolir: ['color', 'color4'],
    forma_namystyn: ['shape', 'beadShape'],
    typ_vykonannia: ['style', 'nmStyle'],
    dodatkovo_namysta: ['extra', 'nmExtra'],
  },
  KL: {
    typy_obrobky_burshtynu: ['raw_type', 'raw'],
    vyd_obrobky_kameniu: ['processing', 'processing'],
    faktura_kulonu: ['texture', 'pendantTexture'],
    kolir: ['color', 'klColor'],
    vyd_kulonu: ['type', 'klType'],
    kulony_dodatkovo: ['addit', 'klAddit'],
  },
  CH: {
    typy_obrobky_burshtynu: ['raw_type', 'raw'],
    faktura_namystyn: ['texture', 'beadTexture'],
    kolir: ['color', 'color3'],
    forma_namystyn: ['shape', 'chShape'],
    relihiina_prynalezhnist: ['religion', 'chReligion'],
    kilkist_namystyn: ['count', 'chCount'],
  },
  AR: {
    kartynyy: ['type', 'arType'],
    rozmir_kartyny: ['size', 'arSize'],
    sklo: ['glass', 'arGlass'],
    dodatkovo_kartyny: ['additional', 'arAdditional'],
    kartyny_pidsvitka: ['backlight', 'arBacklight'],
  },
  SV: {
    suveniry: ['souvenir', 'svSouvenir'],
    vyd_statuetky: ['statuette', 'svStatuette'],
    tematyka_vyrobu: ['2', 'svTheme'],
    vyd_ptakha: ['bird', 'svBird'],
    vyd_roslyny: ['plants', 'svPlants'],
    vyd_symvoliky: ['symbolic_stat', 'svSymbolic'],
    nastlni_ihry: ['table_games', 'svGames'],
    kamin_obrobka: ['stone_processing', 'svStoneProcessing'],
    kamin_suvenirnyi: ['additional_stone', 'svAdditionalStone'],
    kolir: ['color', 'svColor'],
    typy_obrobky_burshtynu: ['material', 'raw'],
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

const AR_SIZE = Object.freeze({
  1: '10×15', 2: '15×20', 3: '15×40', 4: '20×20', 5: '20×30',
  6: '30×30', 7: '30×40', 8: '30×50', 9: '30×60', 10: '40×40',
  11: '40×60', 12: '40×80', 13: '50×50', 14: '50×70', 15: '60×80',
  16: '60×90', 17: '80×80', 18: '70×100', 19: '70×140',
  20: '80×120', 21: '22×26', 22: '110×50', 23: '40×100',
  24: '100×100', 25: '120×150', 26: '120×180',
  27: '110×60', 28: '15×15',
});
function freezeData(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeData);
    Object.freeze(value);
  }
  return value;
}
module.exports = freezeData({ GROUPS, HEADERS, V, ATTRIBUTE, SEO, AR_NAMES, AR_SIZE });
