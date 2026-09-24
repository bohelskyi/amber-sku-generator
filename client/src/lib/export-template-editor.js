// Structural editing only. Compilation, hashes, evaluation and readiness belong
// to the server. No defaults are inserted while opening or saving a definition.
export const copyDefinition = (value) => JSON.parse(JSON.stringify(value));
export function slotNameError(name, slots, previous) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) return 'Назва: 1–64 латинських літер, цифр або _, без службових імен.';
  if (name !== previous && Object.hasOwn(slots, name)) return 'Підстановка з такою назвою вже існує.';
  return '';
}
export function renameSlot(node, previous, name) {
  const error = slotNameError(name, node.slots, previous);
  if (error || !Object.hasOwn(node.slots, previous)) throw new Error(error || 'Невідома підстановка.');
  return { ...node, template: node.template.split(`{${previous}}`).join(`{${name}}`),
    slots: Object.fromEntries(Object.entries(node.slots).map(([key, value]) => [key === previous ? name : key, value])) };
}
export function removeSlot(node, name) {
  if (node.template.includes(`{${name}}`)) throw new Error(`Спочатку явно вилучіть {${name}} з тексту.`);
  return { ...node, slots: Object.fromEntries(Object.entries(node.slots).filter(([key]) => key !== name)) };
}
export function replaceAt(value, path, replacement) {
  if (!path.length) return replacement;
  const [key, ...tail] = path;
  const next = Array.isArray(value) ? [...value] : { ...value };
  next[key] = replaceAt(value[key], tail, replacement);
  return next;
}
export function moveItem(items, index, delta) {
  const next = [...items];
  if (index + delta < 0 || index + delta >= next.length) return next;
  [next[index], next[index + delta]] = [next[index + delta], next[index]];
  return next;
}
export function consumers(definition, kind, id) {
  const found = new Set();
  function visit(node, path, seen = new Set()) {
    if (!node || typeof node !== 'object') return;
    if ((kind === 'table' && node.op === 'lookup' && node.table === id)
      || (kind === 'ref' && node.op === 'ref' && node.id === id)) found.add(path);
    if (node.op === 'ref' && !seen.has(node.id)) {
      const binding = definition.bindings?.find((b) => b.id === node.id);
      if (binding) visit(binding.value, path, new Set([...seen, node.id]));
    }
    Object.values(node).forEach((child) => visit(child, path, seen));
  }
  for (const group of definition.groups || []) {
    for (const row of group.rows || []) for (const [column, node] of Object.entries(row.cells || {})) {
      visit(node, `${group.route} / ${row.id === 'english' ? 'EN' : 'база'} / ${column}`);
    }
    for (const node of group.evaluate || []) visit(node, `${group.route} / перевірка готовності`);
  }
  return [...found];
}
export function parseProductIds(text) {
  const values = text.trim().split(/[\s,;]+/);
  if (!text.trim() || values.length > 100 || values.some((v) => !/^[1-9]\d*$/.test(v)
    || Number(v) > 2147483647) || new Set(values.map(Number)).size !== values.length) {
    throw new Error('Вкажіть від 1 до 100 різних додатних ID товарів через кому або пробіл.');
  }
  return values.map(Number);
}
export const protectedCells = new Set(['sku', 'store_view_code', 'product_type']);
export const operationLabels = {
  literal: 'Постійне значення', source: 'Збережене джерело', ref: 'Спільне правило',
  text: 'Текстове подання', present: 'Наявність значення', semanticKey: 'Семантичний ID',
  lookup: 'Таблиця відповідностей', firstPresent: 'Перше наявне значення', when: 'Умова',
  eq: 'Дорівнює', in: 'Входить до переліку', all: 'Усі умови', any: 'Будь-яка умова',
  not: 'Заперечення', catalogRule: 'Правило видимості', questionValue: 'Контракт питання',
  numberText: 'Додатне число', decimalText: 'Десяткове число', numericBand: 'Числові діапазони',
  interpolate: 'Назва або шлях із підстановками', join: 'Об’єднання', require: 'Обов’язкова перевірка', error: 'Діагностика',
};
export const fieldLabels = {
  value: 'Значення', input: 'Вхід', if: 'Якщо', then: 'Тоді', else: 'Інакше',
  otherwise: 'Запасне значення', left: 'Ліва частина', right: 'Права частина',
  template: 'Текст із підстановками', slots: 'Оголошені підстановки', items: 'Послідовність',
  values: 'Допустимі значення', bands: 'Діапазони', min: 'Нижня межа', max: 'Верхня межа',
  minInclusive: 'Включати нижню межу', maxInclusive: 'Включати верхню межу', outside: 'Поза діапазонами',
  trim: 'Прибирати крайні пробіли', delimiter: 'Роздільник', omitEmpty: 'Пропускати порожні',
  required: 'Обов’язкове', exists: 'Питання було в каталозі', rule: 'Зафіксована видимість',
  allowed: 'Зафіксовані семантичні ID', error: 'Помилка', message: 'Повідомлення',
  missingQuestion: 'Відсутнє питання', missingAnswer: 'Відсутня відповідь',
  sku: 'Артикул', name: 'Назва товару', categories: 'Категорії Magento', price: 'Ціна',
  meta_title: 'SEO заголовок', meta_description: 'SEO опис', attribute_set_code: 'Набір атрибутів',
  product_websites: 'Вебсайти магазину', product_online: 'Статус публікації товару', visibility: 'Видимість товару',
  qty: 'Кількість на складі', is_in_stock: 'Наявність на складі', old_product: 'Архівний товар', is_ownproduction: 'Власне виробництво',
  dodatkovo_namysta: 'Додаткові характеристики намиста', kulony_dodatkovo: 'Додаткові характеристики кулона',
  product_type: 'Тип товару', store_view_code: 'Мова вітрини', description: 'Опис', short_description: 'Короткий опис',
  decor_weight: 'Вага', vaha_vyrobu: 'Вага виробу', dovzhyna_brasletu_diuimiv: 'Довжина браслета',
  dovzhyna_namysta_tochna: 'Точна довжина намиста', dovzhyna_namysta: 'Діапазон довжини намиста',
  rozmir_iuvelirnoho_vyrobu: 'Розмір кулона', dovzhyna_namystyny: 'Довжина намистини',
  diametr_namystyny: 'Діаметр намистини', dovzhyna_vyrobu: 'Довжина виробу', rozmir_kameniu: 'Розмір каменю',
  rozmir_kartyny: 'Розмір картини', rozmir_suveniriv: 'Розмір сувеніра', typy_obrobky_burshtynu: 'Тип бурштину',
  vyd_obrobky_kameniu: 'Обробка каменю', faktura_namystyn: 'Фактура намистин', faktura_kulonu: 'Фактура кулона',
  kolir: 'Колір', forma_namystyn: 'Форма намистин', typ_vykonannia: 'Стиль виконання', vyd_kulonu: 'Вид кулона',
  relihiina_prynalezhnist: 'Релігійна приналежність', kilkist_namystyn: 'Кількість намистин', kartynyy: 'Тип картини',
  sklo: 'Скло', dodatkovo_kartyny: 'Додаткові характеристики картини', kartyny_pidsvitka: 'Підсвітка картини',
  suveniry: 'Тип сувеніра', vyd_statuetky: 'Вид статуетки', tematyka_vyrobu: 'Тематика виробу',
  vyd_ptakha: 'Вид птаха', vyd_roslyny: 'Вид рослини', vyd_symvoliky: 'Вид символіки', nastlni_ihry: 'Настільна гра',
  kamin_obrobka: 'Обробка сувенірного каменю', kamin_suvenirnyi: 'Сувенірний камінь', fraction: 'Фракція',
  nameUa: 'Українська назва', nameEn: 'Англійська назва', nameValid: 'Умова формування назви',
  nameCheck: 'Перевірка назви', material: 'Матеріал', texture: 'Фактура', surface: 'Поверхня', color: 'Колір',
  shape: 'Форма', count: 'Кількість', religion: 'Приналежність', categoryCheck: 'Перевірка категорії',
  materialCheck: 'Перевірка матеріалу', full_sku: 'Повний артикул', total_price_uah: 'Збережена фінальна ціна, грн',
  weight: 'Збережена вага', magento_name_subject_ua: 'Збережена ручна назва UA', magento_name_subject_en: 'Збережена ручна назва EN',
};
