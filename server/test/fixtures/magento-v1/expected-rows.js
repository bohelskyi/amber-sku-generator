// Reviewed expected cells, authored without executing/importing the exporter.
// Empty cells are supplied by the explicit ordered header lists, not production.
const headers = {
  BR: 'sku store_view_code name price decor_weight dovzhyna_brasletu_diuimiv categories attribute_set_code product_type product_websites product_online visibility qty is_in_stock old_product is_ownproduction typy_obrobky_burshtynu vyd_obrobky_kameniu faktura_namystyn kolir forma_namystyn typ_vykonannia short_description description meta_title meta_description'.split(' '),
  NM: 'sku store_view_code name price dovzhyna_namysta_tochna categories attribute_set_code product_type product_websites product_online visibility qty is_in_stock old_product is_ownproduction decor_weight dovzhyna_namysta typy_obrobky_burshtynu vyd_obrobky_kameniu faktura_namystyn kolir forma_namystyn typ_vykonannia dodatkovo_namysta short_description description meta_title meta_description'.split(' '),
  KL: 'sku store_view_code name price rozmir_iuvelirnoho_vyrobu categories attribute_set_code product_type product_websites product_online visibility qty is_in_stock old_product is_ownproduction decor_weight typy_obrobky_burshtynu vyd_obrobky_kameniu faktura_kulonu kolir vyd_kulonu kulony_dodatkovo short_description description meta_title meta_description'.split(' '),
  CH: 'sku store_view_code name price dovzhyna_namystyny diametr_namystyny dovzhyna_vyrobu categories attribute_set_code product_type product_websites product_online visibility qty is_in_stock old_product is_ownproduction vaha_vyrobu rozmir_kameniu typy_obrobky_burshtynu faktura_namystyn kolir forma_namystyn relihiina_prynalezhnist kilkist_namystyn short_description description meta_title meta_description'.split(' '),
  AR: 'sku store_view_code name price categories attribute_set_code product_type product_websites product_online visibility qty is_in_stock old_product is_ownproduction kartynyy rozmir_kartyny sklo dodatkovo_kartyny kartyny_pidsvitka short_description description meta_title meta_description'.split(' '),
  SV: 'sku store_view_code name price decor_weight rozmir_suveniriv categories attribute_set_code product_type product_websites product_online visibility qty is_in_stock old_product is_ownproduction suveniry vyd_statuetky tematyka_vyrobu vyd_ptakha vyd_roslyny vyd_symvoliky nastlni_ihry kamin_obrobka kamin_suvenirnyi kolir typy_obrobky_burshtynu fraction short_description description meta_title meta_description'.split(' '),
};
const common = {
  store_view_code: '', price: '1234.56', product_type: 'simple', product_websites: 'base',
  product_online: '2', visibility: 'Catalog, Search', qty: '1', is_in_stock: '1',
  old_product: 'No', is_ownproduction: 'Yes', short_description: '', description: '',
};
const en = { store_view_code: 'en', product_type: 'simple' };
const cases = [
  {
    id: 'BR', group: 'BR',
    base: { ...common, sku: 'BR-SYNTH-001', name: 'Браслет з натурального бурштину. Арт: BR-SYNTH-001',
      attribute_set_code: 'Браслети', decor_weight: '10.5', dovzhyna_brasletu_diuimiv: '16 см',
      categories: 'Default/Браслети,Default/Браслети/Браслети з цільного каменю бурштину,Default/Браслети/Браслети з полірованими намистинами,Default/Браслети/Браслети з прозорою фактурою намистин,Default/Браслети/Браслети світлого кольору,Default/Браслети/Браслети з намистинами: кулі,Default/Браслети/Класичні браслети',
      typy_obrobky_burshtynu: 'Натуральний', vyd_obrobky_kameniu: 'Полірований', faktura_namystyn: 'Прозора', kolir: 'Світлий', forma_namystyn: 'Куля', typ_vykonannia: 'Класичний',
      meta_title: 'Браслет з бурштину купити у виробника  | Amber Galbin',
      meta_description: 'Купити браслет з бурштину в Україні, широкий вибір ювелірних прикрас, вигідні ціни від виробника Amber Galbin, доставка по Україні. Телефонуйте або пишіть нам!' },
    english: { ...en, sku: 'BR-SYNTH-001', name: 'Natural amber bracelet. Art: BR-SYNTH-001', attribute_set_code: 'Браслети' },
  },
  {
    id: 'NM', group: 'NM',
    base: { ...common, sku: 'NM-SYNTH-001', name: 'Намисто з натурального бурштину. Арт: NM-SYNTH-001',
      attribute_set_code: 'Намиста', decor_weight: '10.5', dovzhyna_namysta_tochna: '40,0', dovzhyna_namysta: 'Чокер (35-40 см)',
      categories: 'Default/Намиста,Default/Намиста/Намиста з цільного каменю бурштину,Default/Намиста/Намиста з полірованими намистинами,Default/Намиста/Намиста з прозорою фактурою намистин,Default/Намиста/Намиста світлого кольору,Default/Намиста/Намиста з намистинами: кулі,Default/Намиста/Класичні намиста',
      typy_obrobky_burshtynu: 'Натуральний', vyd_obrobky_kameniu: 'Полірований', faktura_namystyn: 'Прозора', kolir: 'Світлий', forma_namystyn: 'Куля', typ_vykonannia: 'Класичний', dodatkovo_namysta: '',
      meta_title: 'Намисто з бурштину купити у виробника | Amber Galbin',
      meta_description: 'Купити намисто з бурштину у Рівному, широкий вибір ювелірних прикрас, вигідні ціни від виробника Amber Galbin, доставка по Україні. Телефонуйте або пишіть нам!' },
    english: { ...en, sku: 'NM-SYNTH-001', name: 'Natural amber necklace. Art: NM-SYNTH-001', attribute_set_code: 'Намиста',
      meta_title: 'Buy amber necklace from the manufacturer | Amber Galbin',
      meta_description: 'Buy amber necklaces in Rivne, a wide selection of jewelry, favorable prices from the manufacturer Amber Galbin, delivery across Ukraine. Call or write to us!' },
  },
  {
    id: 'KL', group: 'KL',
    base: { ...common, sku: 'KL-SYNTH-001', name: 'Кулон з натурального бурштину. Арт: KL-SYNTH-001',
      attribute_set_code: 'Кулони', decor_weight: '10.5', rozmir_iuvelirnoho_vyrobu: '4,2/2,7 см',
      categories: 'Default/Кулони,Default/Кулони/Кулони з цільного каменю бурштину,Default/Кулони/Кулони з полірованою поверхнею,Default/Кулони/Кулони з прозорою фактурою,Default/Кулони/Кулони світлого кольору,Default/Кулони/Природна форма кулона',
      typy_obrobky_burshtynu: 'Натуральний', vyd_obrobky_kameniu: 'Полірований', faktura_kulonu: 'Прозорий', kolir: 'Світлий', vyd_kulonu: 'Природня форма', kulony_dodatkovo: '',
      meta_title: 'Кулон з бурштину купити у Рівному | Amber Galbin',
      meta_description: 'Купити бурштиновий кулон у Рівному, широкий вибір ювелірних прикрас, вигідні ціни від виробника Amber Galbin, доставка по Україні. Телефонуйте або пишіть нам!' },
    english: { ...en, sku: 'KL-SYNTH-001', name: 'Natural amber pendant. Art: KL-SYNTH-001', attribute_set_code: 'Кулони', meta_title: 'Buy amber pendant in Rivne | Amber Galbin' },
  },
  {
    id: 'CH', group: 'CH',
    base: { ...common, sku: 'CH-SYNTH-001', name: 'Чотки з натурального бурштину. Арт: CH-SYNTH-001',
      attribute_set_code: 'Чотки', vaha_vyrobu: '10.5', dovzhyna_namystyny: '015.80', diametr_namystyny: '08.20', dovzhyna_vyrobu: '030.50', rozmir_kameniu: '015,80×08.20',
      categories: 'Default/Чотки,Default/Чотки/Чотки з цільного каменю бурштину,Default/Чотки/Чотки з прозорими намистинами,Default/Чотки/Чотки світлого кольору,Default/Чотки/Чотки з намистинами у формі кулі,Default/Чотки/Мусульманські чотки,Default/Чотки/Чотки на 30 намистин',
      typy_obrobky_burshtynu: 'Натуральний', faktura_namystyn: 'Прозора', kolir: 'Світлий', forma_namystyn: 'Куля', relihiina_prynalezhnist: 'Мусульманські', kilkist_namystyn: '30',
      meta_title: 'Чотки з бурштину купити у виробника  | Amber Galbin',
      meta_description: 'Купити чотки, вервицю з бурштину, широкий асортимент, ручна робота, ціни від виробника Amber Galbin, швидка доставка по Україні. Телефонуйте або пишіть нам!' },
    english: { ...en, sku: 'CH-SYNTH-001', name: 'Natural amber rosary. Art: CH-SYNTH-001', attribute_set_code: 'Чотки' },
  },
  {
    id: 'AR', group: 'AR',
    base: { ...common, sku: 'AR-SYNTH-001', name: 'Ікона з бурштину. Арт: AR-SYNTH-001', attribute_set_code: 'Картини',
      categories: 'Default/Картини,Default/Картини/Ікони', kartynyy: 'Ікони', rozmir_kartyny: '10×15', sklo: 'Без скла', dodatkovo_kartyny: '', kartyny_pidsvitka: '',
      meta_title: 'Ікони з бурштину від виробника | купити в Amber Galbin',
      meta_description: 'Купити ікони з бурштину від виробника Amber Galbin. Ручна робота підкреслює природну фактуру та красу бурштину. Картини з бурштину від Amber Galbin' },
    english: { ...en, sku: 'AR-SYNTH-001', name: 'Amber icon. Art: AR-SYNTH-001', attribute_set_code: 'Картини' },
  },
  {
    id: 'SV', group: 'SV',
    base: { ...common, sku: 'SV-SYNTH-001', name: 'Брелок з бурштину. Арт: SV-SYNTH-001', attribute_set_code: 'Сувеніри',
      decor_weight: '25', rozmir_suveniriv: '5 см', categories: 'Default/Сувеніри,Default/Сувеніри/Брелоки', suveniry: 'Брелоки',
      vyd_statuetky: '', tematyka_vyrobu: '', vyd_ptakha: '', vyd_roslyny: '', vyd_symvoliky: '', nastlni_ihry: '', kamin_obrobka: '', kamin_suvenirnyi: '', kolir: 'Світлий', typy_obrobky_burshtynu: 'Натуральний', fraction: '' },
    english: { ...en, sku: 'SV-SYNTH-001', name: 'Amber key chain. Art: SV-SYNTH-001', attribute_set_code: 'Сувеніри' },
  },
];

// Explicit alternate cases, reusing only already specified expected cells.
cases.push({ id: 'KL-hidden-zero', group: 'KL', answers: { addit: 0 },
  questions: { addit: { required: 1, visible_if_json: { raw_type: 2 } } },
  base: { ...cases[2].base, categories: 'Default/Кулони,Default/Кулони/Кулони з цільного каменю бурштину,Default/Кулони/Кулони з полірованою поверхнею,Default/Кулони/Кулони з прозорою фактурою,Default/Кулони/Кулони світлого кольору,Default/Кулони/Природна форма кулона,Default/Кулони/З інклюзом' }, english: { ...cases[2].english } });
cases.push({ id: 'AR-mosaic', group: 'AR', answers: { type: 7, size: 28, glass: 1, additional: 2, backlight: 1 },
  base: { ...cases[4].base, name: 'Мозаїка з бурштину. Арт: AR-SYNTH-001', categories: 'Default/Картини,Default/Картини/Мозаїка', kartynyy: 'Мозаїка', rozmir_kartyny: '15×15', sklo: 'Зі склом', dodatkovo_kartyny: 'На бархаті', kartyny_pidsvitka: 'З підсвіткою',
    meta_title: 'Мозаїка з бурштину від виробника | купити в Amber Galbin',
    meta_description: 'Купити декоративну мозаїку з бурштину від виробника Amber Galbin. Ручне оформлення підкреслює природну фактуру бурштину. Картини з бурштину від Amber Galbin' },
  english: { ...cases[4].english, name: 'Amber mosaic. Art: AR-SYNTH-001' } });
cases.push({ id: 'SV-stone', group: 'SV', answers: { souvenir: 5, stone_processing: 0, additional_stone: 1, weight: '1000.000' },
  product: { magento_name_subject_ua: ' Камінь ', magento_name_subject_en: ' stone ' },
  base: { ...cases[5].base, name: 'Камінь з бурштину. Арт: SV-SYNTH-001', attribute_set_code: 'Камінь', decor_weight: '1000', suveniry: 'Камінь сувенірний', kamin_obrobka: 'Необроблений', kamin_suvenirnyi: 'З інклюзом', fraction: '1000+', categories: 'Default/Камінь,Default/Камінь/Камінь сувенірний,Default/Камінь/Необроблений' },
  english: { ...cases[5].english, name: 'Amber stone. Art: SV-SYNTH-001', attribute_set_code: 'Камінь' } });
cases.push({ id: 'SV-escaping', group: 'SV', answers: { size: ' =1,2 "см"\r\n далі ' },
  product: { full_sku: ' =SKU', magento_name_subject_ua: ' @Сова, "ніч"\r\n крило ', magento_name_subject_en: ' owl, "night"\r\n wing ' },
  base: { ...cases[5].base, sku: ' =SKU', name: '@Сова, "ніч"\r\n крило з бурштину. Арт:  =SKU', rozmir_suveniriv: '=1,2 "см"\r\n далі' },
  english: { ...cases[5].english, sku: ' =SKU', name: 'Amber owl, "night"\r\n wing. Art:  =SKU' } });

module.exports = { headers, cases };
