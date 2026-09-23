// Hand-specified synthetic inputs and expected tables. No production imports.
const dictionaries = {
  raw: { 1: 'Натуральний', 2: 'Формований' },
  processing: { 1: 'Полірований', 2: 'Шліфований' },
  beadTexture: { 1: 'Прозора', 2: 'Напівпрозора', 3: 'Матова', 4: 'Прозора', 5: 'Напівпрозора', 6: 'Матова', 7: 'Пейзажна', 8: 'Змішана' },
  pendantTexture: { 1: 'Прозорий', 2: 'Напівпрозорий', 3: 'Матовий', 4: 'Прозорий', 5: 'Напівпрозорий', 6: 'Матовий', 7: 'Пейзажний' },
  color4: { 1: 'Світлий', 2: 'Темний', 3: 'Пейзажний', 4: 'Комбінований' },
  color3: { 1: 'Світлий', 2: 'Темний', 3: 'Пейзажний' },
  klColor: { 1: 'Світлий', 2: 'Темний' },
  svColor: { 1: 'Світлий', 2: 'Темний', 3: 'Комбінований', 4: 'Пейзажний' },
  beadShape: { 1: 'Куля', 2: 'Бочка', 3: 'Оливка', 4: 'Сегменти', 5: 'Галька', 6: 'Геометрія', 7: 'Змішана' },
  chShape: { 1: 'Куля', 2: 'Бочка', 3: 'Оливка' },
  brStyle: { 1: 'Класичний', 2: 'Комбінований', 3: 'Комбінований', 4: 'Комбінований', 5: 'Шамбала' },
  nmStyle: { 1: 'Класичний', 2: 'Комбінований', 3: 'Комбінований', 4: 'Комбінований' },
  nmExtra: { 0: '', 1: 'З підвісками', 2: 'Дитяче' },
  klType: { 1: 'Природня форма', 2: 'Коло', 3: 'Овал', 4: 'Серце', 5: 'Капля', 6: 'Хрест' },
  klAddit: { 1: 'Інклюз' },
  chReligion: { 1: 'Мусульманські', 2: 'Християнські' },
  chCount: { 0: '30', 1: '33', 2: '39', 3: '45', 4: '51', 5: '66', 6: '75', 7: '99', 9: '?' },
  arType: { 1: 'Ікони', 2: 'Пейзажі', 3: 'Панно', 4: 'Символіка', 5: 'Натюрморти', 6: 'Портрети', 7: 'Мозаїка' },
  arSize: { 1: '10×15', 2: '15×20', 3: '15×40', 4: '20×20', 5: '20×30', 6: '30×30', 7: '30×40', 8: '30×50', 9: '30×60', 10: '40×40', 11: '40×60', 12: '40×80', 13: '50×50', 14: '50×70', 15: '60×80', 16: '60×90', 17: '80×80', 18: '70×100', 19: '70×140', 20: '80×120', 21: '22×26', 22: '110×50', 23: '40×100', 24: '100×100', 25: '120×150', 26: '120×180', 27: '110×60', 28: '15×15' },
  arGlass: { 1: 'Зі склом' },
  arAdditional: { 1: 'На полотні', 2: 'На бархаті' },
  arBacklight: { 1: 'З підсвіткою' },
  svSouvenir: { 1: 'Статуетки', 2: 'Настільні ігри', 3: 'Ручки', 4: 'Письмові набори', 5: 'Камінь сувенірний', 6: 'Брелоки', 7: 'Лампи', 8: 'Скриньки', 9: 'Годинники' },
  svStatuette: { 1: 'Тварини', 2: 'Дерева та квіти', 3: 'Військова техніка', 4: 'Зодіаки', 5: 'Символіка', 6: 'Вітрильники', 7: 'Авто' },
  svTheme: { 1: 'Ссавці', 2: 'Птахи', 3: 'Риби', 4: 'Плазуни', 5: 'Земноводні', 6: 'Безхребетні' },
  svBird: { 1: 'Орел', 2: 'Пава', 3: 'Сова', 4: 'Сокіл', 5: 'Фазан', 6: 'Лелека', 7: 'Фенікс' },
  svPlants: { 1: 'Дерева', 2: 'Квіти', 3: 'Ікебана' },
  svSymbolic: { 1: 'Українська', 2: 'Військова', 3: 'Спортивна', 4: 'Професійна', 5: 'Релігійна', 6: 'Корпоративна' },
  svGames: { 1: 'Шахи', 2: 'Нарди', 3: 'Доміно', 4: 'Шашки/дама' },
  svStoneProcessing: { 0: 'Необроблений', 1: 'Полірований' },
  svAdditionalStone: { 1: 'З інклюзом', 2: 'На підставці' },
};

// [stored answer key, expected output field, independent dictionary name]
const attributes = {
  BR: [['raw_type', 'typy_obrobky_burshtynu', 'raw'], ['processing', 'vyd_obrobky_kameniu', 'processing'], ['texture', 'faktura_namystyn', 'beadTexture'], ['color', 'kolir', 'color4'], ['shape', 'forma_namystyn', 'beadShape'], ['style', 'typ_vykonannia', 'brStyle']],
  NM: [['raw_type', 'typy_obrobky_burshtynu', 'raw'], ['processing', 'vyd_obrobky_kameniu', 'processing'], ['texture', 'faktura_namystyn', 'beadTexture'], ['color', 'kolir', 'color4'], ['shape', 'forma_namystyn', 'beadShape'], ['style', 'typ_vykonannia', 'nmStyle'], ['extra', 'dodatkovo_namysta', 'nmExtra']],
  KL: [['raw_type', 'typy_obrobky_burshtynu', 'raw'], ['processing', 'vyd_obrobky_kameniu', 'processing'], ['texture', 'faktura_kulonu', 'pendantTexture'], ['color', 'kolir', 'klColor'], ['type', 'vyd_kulonu', 'klType'], ['addit', 'kulony_dodatkovo', 'klAddit']],
  CH: [['raw_type', 'typy_obrobky_burshtynu', 'raw'], ['texture', 'faktura_namystyn', 'beadTexture'], ['color', 'kolir', 'color3'], ['shape', 'forma_namystyn', 'chShape'], ['religion', 'relihiina_prynalezhnist', 'chReligion'], ['count', 'kilkist_namystyn', 'chCount']],
  AR: [['type', 'kartynyy', 'arType'], ['size', 'rozmir_kartyny', 'arSize'], ['glass', 'sklo', 'arGlass'], ['additional', 'dodatkovo_kartyny', 'arAdditional'], ['backlight', 'kartyny_pidsvitka', 'arBacklight']],
  SV: [['souvenir', 'suveniry', 'svSouvenir'], ['statuette', 'vyd_statuetky', 'svStatuette'], ['2', 'tematyka_vyrobu', 'svTheme'], ['bird', 'vyd_ptakha', 'svBird'], ['plants', 'vyd_roslyny', 'svPlants'], ['symbolic_stat', 'vyd_symvoliky', 'svSymbolic'], ['table_games', 'nastlni_ihry', 'svGames'], ['stone_processing', 'kamin_obrobka', 'svStoneProcessing'], ['additional_stone', 'kamin_suvenirnyi', 'svAdditionalStone'], ['color', 'kolir', 'svColor'], ['material', 'typy_obrobky_burshtynu', 'raw']],
};

const answers = {
  BR: { raw_type: 1, processing: 1, texture: 1, color: 1, shape: 1, style: 1, braclet_size: ' 16 см ' },
  NM: { raw_type: 1, processing: 1, texture: 1, color: 1, shape: 1, style: 1, extra: 0, neckle_size: ' 40,0 ' },
  KL: { raw_type: 1, processing: 1, texture: 1, color: 1, type: 1, pedant_size: ' 4,2/2,7 см ' },
  CH: { raw_type: 1, texture: 1, color: 1, shape: 1, religion: 1, count: 0, bead_length: ' 015,80 ', bead_width: '08.20', rosary_length: '030,50', is_calibrated: 3 },
  AR: { type: 1, size: 1 },
  SV: { souvenir: 6, material: 1, color: 1, weight: '25.000', size: ' 5 см ' },
};

// Synthetic flat catalog: all 41 questions exist, optional, visible; IDs explicit
// in dictionaries, intentionally unrelated sku_code/label. Tests override gates.
function catalog() {
  return new Map(Object.entries(attributes).map(([group, entries]) => [group,
    new Map(entries.map(([key, , dictionary]) => [key, {
      required: 0, visible_if_json: null,
      options: Object.keys(dictionaries[dictionary]).map((value_id) => ({
        value_id, sku_code: '987', label: 'Synthetic label, not export text', archived: true,
      })),
    }]))]));
}

function product(group, answerOverrides = {}, productOverrides = {}) {
  return {
    id: 1, category: group, full_sku: `${group}-SYNTH-001`,
    weight: '10.500', total_price_uah: '1234.56',
    details: { answers: { ...answers[group], ...answerOverrides },
      calculatedPriceUah: 900, autoPriceUah: 950, manualPriceUah: 999 },
    ...productOverrides,
  };
}

module.exports = { dictionaries, attributes, answers, catalog, product };
