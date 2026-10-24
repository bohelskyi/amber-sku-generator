// Display text only: these messages do not determine actions or retry eligibility.
const messages = Object.freeze({
  DURABLE_REMOTE_ID_REQUIRED: Object.freeze({
    title: 'Не підтверджено ідентичність товару Magento',
    detail: 'В Amber немає збереженого підтвердження, який товар Magento відповідає цьому артикулу.',
    nextStep: 'Передайте артикул відповідальному за інтеграцію для перевірки ідентичності й попередньої доставки.',
  }),
  FIRST_SYNC_HISTORY_REVIEW_REQUIRED: Object.freeze({
    title: 'Потрібна перевірка історії товару',
    detail: 'Перед першим отриманням полів потрібно перевірити попередню історію товару.',
    nextStep: 'Перегляньте наведені причини; якщо доступного рішення немає, передайте їх відповідальному за інтеграцію.',
  }),
  FIRST_SYNC_HISTORY_COMPONENT_UNSUPPORTED: Object.freeze({
    title: 'Потрібне окреме узгодження історії',
    detail: 'Історія або стан товару не відповідають умовам цієї перевірки.',
    nextStep: 'Передайте товар відповідальному за інтеграцію для окремого узгодження історії.',
  }),
  LOCAL_EVIDENCE_CHANGED: Object.freeze({
    title: 'Дані Amber змінилися під час перевірки',
    detail: 'Перевірений стан уже не актуальний.',
    nextStep: 'Повторіть перевірку й перегляньте новий результат перед підтвердженням.',
  }),
  PREDECESSOR_NOT_RETIRED: Object.freeze({
    title: 'Попередню версію ще не виведено з обігу',
    detail: 'Історія не підтверджує завершення попередньої версії товару.',
    nextStep: 'Передайте її відповідальному оператору для перевірки стану й зв’язків між версіями.',
  }),
  EXPOSURE_RECONCILIATION_CONFLICT: Object.freeze({
    title: 'Не вдалося підтвердити історію доставки',
    detail: 'Поточні дані не дозволяють зберегти це рішення щодо попередньої доставки.',
    nextStep: 'Прочитайте актуальний стан і перевірте підставу рішення заново.',
  }),
  UPDATE_NOT_SENDABLE: Object.freeze({
    title: 'Оновлення товару ще не готове',
    detail: 'Товар поки не можна оновити в Magento.',
    nextStep: 'Перегляньте наведені нижче причини, виправте доступні дані або відповідності й повторіть перевірку.',
  }),
  PRODUCT_EVALUATION_NOT_READY: Object.freeze({
    title: 'Дані товару не готові до синхронізації',
    detail: 'Amber не може сформувати повні дані для Magento.',
    nextStep: 'Перевірте зазначені поля товару та їхні правила.',
  }),
});

export function problemCodePresentation(code) {
  return typeof code === 'string' && Object.hasOwn(messages, code) ? messages[code] : null;
}

export function problemCodeExplanation(code) {
  const message = problemCodePresentation(code);
  return message ? `${message.title}. ${message.detail} ${message.nextStep}` : null;
}
