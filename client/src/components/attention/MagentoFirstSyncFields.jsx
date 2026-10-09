import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../auth/auth-context.js';
import { isActualAdministrator } from '../../auth/auth-model.js';
import { api } from '../../lib/api.js';
import { Button, ConfirmDialog, Notice, Pagination, StatusBadge, TechnicalDisclosure } from '../ui/index.js';

const root = '/admin/magento-integration/first-sync';
const bindingIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const statuses = new Set(['imported', 'equal', 'optional_empty', 'pending_outward_confirmation', 'conflict', 'unknown', 'review_required']);
const reasons = {
  REMOTE_READ_UNKNOWN: 'Значення Magento не підтверджено. Повторіть читання перед рішенням.',
  LOCAL_VALUE_UNKNOWN: 'Значення Amber не підтверджено. Відсутність даних не означає порожнє поле.',
  NAME_ALREADY_RECEIVED_USE_ORDINARY_RECONCILIATION: 'Назву цією мовою вже отримано один раз. Подальші зміни перевіряються за звичайними правилами назв.',
  FIELD_ALREADY_RECEIVED_USE_ORDINARY_RECONCILIATION: 'Поле вже отримано один раз. Подальші зміни перевіряються за звичайними правилами синхронізації.',
  MAPPING_NOT_PROVEN: 'Відповідність цього поля не підтверджено.',
  NAME_SCOPE_UNSUPPORTED: 'Отримання назви для цього магазину або мови не підтримується.',
  NORMALIZED_VALUES_EQUAL: 'Підтверджені значення збігаються після нормалізації.',
  EMPTY_LOCAL_VALID_REMOTE: 'Amber не має значення; підтверджене значення Magento можна отримати.',
  FIRST_REMOTE_NAME_AUTHORITATIVE: 'Під час першого отримання назва Magento має пріоритет окремо для кожної мови. Рішення діє один раз.',
  REQUIRED_FIELD_EMPTY: 'Обов’язкове поле порожнє.',
  BOTH_EMPTY_OPTIONAL: 'Необов’язкове поле порожнє в обох системах.',
  REMOTE_EMPTY_LOCAL_POPULATED: 'Magento не має значення, Amber має. Порожнє значення не стирає дані Amber.',
  POPULATED_VALUES_DIFFER: 'Обидві системи мають різні значення. Оберіть джерело для цього поля.',
  POPULATED_OPTION_VALUES_DIFFER: 'Обидві системи мають різні варіанти характеристики. Оберіть джерело для цього поля.',
  REVERSE_OPTION_AMBIGUOUS: 'Варіанту Magento відповідає більше одного варіанта Amber. Автоматичне отримання недоступне.',
  REVERSE_OPTION_NOT_PROVEN: 'Зворотну відповідність варіанта Magento до Amber не підтверджено.',
  EMPTY_LOCAL_UNIQUE_REMOTE_OPTION: 'Порожньому полю Amber відповідає один підтверджений варіант Magento.',
  LOCAL_FORWARD_OPTION_EQUAL: 'Варіант Amber підтверджено відповідає поточному варіанту Magento.',
  LOCAL_FORWARD_OPTION_NOT_PROVEN: 'Передачу варіанта Amber у Magento не підтверджено.',
  DERIVED_PROSPECTIVE_INPUTS_NOT_PROVEN: 'Джерела для обчислюваного поля ще не підтверджено.',
  DERIVED_CANONICAL_SOURCE_EMPTY: 'Джерело обчислюваного поля порожнє.',
  DERIVED_FORWARD_EQUAL: 'Обчислене значення Amber збігається з Magento.',
  DERIVED_FORWARD_MISMATCH: 'Обчислене значення Amber відрізняється від Magento. Отримання назад потребує перевірки джерел.',
  FIRST_SYNC_IDENTITY_CHANGED: 'Змінилася підтверджена ідентичність товару. Потрібна нова перевірка.',
  FIRST_SYNC_UNFINISHED_WORK: 'Для товару є незавершена дія. Спочатку узгодьте її результат.',
  FIRST_SYNC_HISTORY_REVIEW_REQUIRED: 'Історія товару потребує окремої перевірки перед першим отриманням.',
  FIRST_SYNC_ORIGIN_REVIEW_REQUIRED: 'Є історія передачі до іншого Magento. Потрібна окрема перевірка.',
  PHOTO_URL_IMPORT_NOT_IMPLEMENTED: 'Отримання фото за URL не підтримується цією дією.',
  FIELD_BINDING_NOT_APPROVED: 'Правило цього поля не погоджено.',
  FIELD_POLICY_NOT_APPROVED: 'Політика цього поля не погоджена.',
  LOCALIZED_CANONICAL_SETTER_NOT_PROVEN: 'Збереження значення цією мовою в Amber не підтверджено.',
  STORE_SCOPE_ATTRIBUTE_UNSUPPORTED: 'Отримання характеристики для цього магазину не підтримується.',
  REMOTE_VALUE_TYPE_UNSUPPORTED: 'Тип значення Magento не підтримується для отримання.',
  IMMUTABLE_CHARACTERISTIC_VERSION_IMPORT_UNSUPPORTED: 'Отримання цієї версії характеристики не підтримується зі збереженням її історії.',
  HISTORICAL_IDENTITY_CHARACTERISTIC_IMPORT_UNSUPPORTED: 'Отримання характеристики історичної ідентичності потребує окремої перевірки.',
  PRICE_CURRENCY_UAH_NOT_PROVEN: 'Валюту ціни Magento не підтверджено як UAH.',
  FIRST_SYNC_CANONICAL_PRICE_REVIEW_REQUIRED: 'Нова вага або характеристика змінює кінцеву ціну. Спочатку потрібне окреме цінове рішення.',
  FIRST_SYNC_CANONICAL_PRICE_FIRST_REOBSERVE_REQUIRED: 'Спочатку узгодьте ціну й повторіть перевірку перед отриманням ваги або характеристик.',
  FIRST_SYNC_CANONICAL_PRICE_MODE_UNPROVEN: 'Чинний режим ціни не підтверджено. Потрібне окреме цінове рішення.',
  FIRST_SYNC_LEGACY_SKU_CORRECTION_REQUIRED: 'Ця характеристика керує історичним SKU. Потрібне явне виправлення адміністратором зі збереженням попередньої версії.',
  FIRST_SYNC_LEGACY_MISSING_ONLY_REVIEW_REQUIRED: 'Legacy SV можна доповнити лише доведено відсутніми полями. Нуль або вже заповнене значення потребує окремого виправлення.',
  FIRST_SYNC_LEGACY_WEIGHT_IDENTITY_REVIEW_REQUIRED: 'Нова вага не відтворює повний історичний SKU. Потрібен окремий підтверджений перерахунок.',
  FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN: 'Історичну SKU-схему або єдине значення артикула не підтверджено. Потрібне окреме виправлення адміністратором.',
  FIRST_SYNC_CANONICAL_NATIVE_VERSION_REQUIRED: 'Для історичного SKU потрібна окрема перевірка ваги та характеристик зі збереженням його значення.',
  FIRST_SYNC_CANONICAL_TARGET_UNAVAILABLE: 'Характеристика архівована, прихована або відсутня в чинній чи історичній конфігурації.',
  FIRST_SYNC_CANONICAL_DEPENDENT_ANSWER_HIDDEN: 'Нове значення приховує вже вибрану залежну характеристику. Потрібна окрема перевірка.',
  FIRST_SYNC_CANONICAL_FORWARD_UNPROVEN: 'Передачу нового значення за чинним правилом Magento не підтверджено.',
  FIRST_SYNC_CANONICAL_CALIBRATION_REVIEW_REQUIRED: 'Калібрування потребує окремої перевірки обох збережених відповідей.',
  FIRST_SYNC_CANONICAL_WEIGHT_REQUIRED: 'Чинна або історична конфігурація вимагає додатної ваги.',
  FIRST_SYNC_CANONICAL_ANSWER_UNAVAILABLE: 'Залежний варіант характеристики недоступний у чинній або історичній конфігурації.',
  FIRST_SYNC_CANONICAL_ANSWER_REQUIRED: 'Після зміни бракує обов’язкової залежної характеристики.',
  FIRST_SYNC_CANONICAL_RATE_REQUIRED: 'Курс для перевірки чинного цінового рішення не підтверджено.',
  CANONICAL_WEIGHT_ANSWER_INCOHERENT: 'Вага та її відповідь у характеристиках Amber не узгоджені.',
  OUTWARD_POLICY_NOT_AUTHORITATIVE: 'Чинну політику передачі цього поля не підтверджено.',
};
const invalidKinds = {
  PRESENCE_VALUE_MISMATCH: 'Позначка заповнення суперечить значенню',
  UNIT_MISMATCH: 'Одиниця виміру не відповідає правилу',
  DECIMAL_INVALID_OR_SCALE_EXCEEDED: 'Число має непідтримуваний формат або точність',
  DECIMAL_OUT_OF_RANGE: 'Число виходить за дозволені межі',
  BOOLEAN_INVALID: 'Логічне значення має непідтримуваний формат',
  OPTION_INVALID: 'Варіант характеристики має непідтримуваний формат',
  TEXT_INVALID: 'Текст має непідтримуваний формат',
};
const labels = { kolir: 'Колір', name: 'Назва', nameUA: 'Назва UA', description: 'Опис', weight: 'Вага', decor_weight: 'Вага вставки', vaha_vyrobu: 'Вага виробу', price: 'Ціна', rozmir_suveniriv: 'Розмір сувеніру', kamin_obrobka: 'Обробка каменю' };
const statusLabels = { imported: 'Готове до отримання', equal: 'Значення збігаються', optional_empty: 'Необов’язкове, порожнє', pending_outward_confirmation: 'Потрібне підтвердження передачі', conflict: 'Потрібне рішення', unknown: 'Дані не підтверджено', review_required: 'Потрібна перевірка' };
const fieldLabel = (field) => `${labels[field.target] || field.target} · ${field.scope === 'all' ? 'UA / основний магазин' : field.scope === 'en' ? 'EN' : field.scope}`;
function reasonText(code) {
  if (Object.hasOwn(reasons, code)) return reasons[code];
  const match = /^(LOCAL|REMOTE)_(.+)$/.exec(code);
  if (match && Object.hasOwn(invalidKinds, match[2])) return `${invalidKinds[match[2]]} у ${match[1] === 'LOCAL' ? 'Amber' : 'Magento'}.`;
  return 'Причина потребує окремого технічного уточнення. Код наведено в деталях.';
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function boundedText(value, limit = 160) { return typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127); }
function validValue(state) {
  if (!object(state) || typeof state.known !== 'boolean') return false;
  if (!state.known) return !Object.hasOwn(state, 'value') && (!Object.hasOwn(state, 'present') || state.present === false);
  if (typeof state.present !== 'boolean') return false;
  if (!Object.hasOwn(state, 'value')) return !state.present;
  return state.value === null || typeof state.value === 'boolean' || typeof state.value === 'number' && Number.isFinite(state.value)
    || typeof state.value === 'string' && state.value.length <= 4096;
}
function valueText(state) {
  if (!state.known) return 'Дані не підтверджено';
  if (!state.present) return Object.hasOwn(state, 'value') && state.value != null && state.value !== '' ? `Позначено як порожнє; фактичне значення: ${String(state.value)}` : 'Не заповнено';
  return state.value === '' ? '"" (порожній текст)' : String(state.value);
}
function checkedPreview(data, sku) {
  if (!object(data) || data.sku !== sku || !['first', 'ordinary', 'create', 'review'].includes(data.mode)
    || typeof data.complete !== 'boolean' || typeof data.readyForOutbound !== 'boolean'
    || !Array.isArray(data.fields) || data.fields.length > 500 || !Array.isArray(data.blockers) || data.blockers.length > 1000
    || data.coverage != null && !object(data.coverage)
    || data.mode === 'first' && (typeof data.previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(data.previewToken))) throw new Error('Відповідь перевірки не підтверджує товар і поля. Повторіть перевірку.');
  const seen = new Set();
  for (const field of data.fields) {
    if (!object(field) || typeof field.target !== 'string' || typeof field.scope !== 'string' || !identifier.test(field.target) || !identifier.test(field.scope)
      || !boundedText(field.status) || !boundedText(field.reason) || !validValue(field.local) || !validValue(field.remote)
      || typeof field.canAcceptRemote !== 'boolean' || typeof field.canKeepLocal !== 'boolean'
      || field.received !== undefined && typeof field.received !== 'boolean') throw new Error('Відповідь містить непідтверджені значення полів. Повторіть перевірку.');
    const key = JSON.stringify([field.target, field.scope]);
    if (seen.has(key)) throw new Error('Перевірка повторює те саме поле. Повторіть перевірку.');
    seen.add(key);
  }
  if (data.blockers.some((item) => !object(item) || !boundedText(item.code)
    || item.target !== undefined && (typeof item.target !== 'string' || !identifier.test(item.target)) || item.scope !== undefined && (typeof item.scope !== 'string' || !identifier.test(item.scope)))) throw new Error('Причини обмежень не підтверджено. Повторіть перевірку.');
  return data;
}
function checkedReceipt(data, request) {
  const receipt = data?.receipt;
  if (!object(data) || ['sku', 'target', 'scope', 'choice'].some((key) => data[key] !== request[key])
    || typeof data.readyForOutbound !== 'boolean' || typeof data.complete !== 'boolean' || !object(receipt)
    || typeof receipt.sessionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(receipt.sessionId)
    || typeof receipt.revision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(receipt.revision)
    || typeof receipt.alreadyApplied !== 'boolean'
    || !(request.choice === 'keep_local' ? ['pending_outward_confirmation'] : ['imported', 'name_received']).includes(receipt.state)) throw new Error('Збереження поля не підтверджено квитанцією. Перевірте актуальний стан перед повторною дією.');
  return data;
}

const correctionReasons = new Set(['FIRST_SYNC_CANONICAL_CALIBRATION_REVIEW_REQUIRED', 'FIRST_SYNC_LEGACY_SKU_CORRECTION_REQUIRED', 'FIRST_SYNC_LEGACY_MISSING_ONLY_REVIEW_REQUIRED', 'FIRST_SYNC_LEGACY_WEIGHT_IDENTITY_REVIEW_REQUIRED', 'FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN']);
function FieldPanel({ sku, onChange, principalLifetime, canRecount }) {
  const [preview, setPreview] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [decision, setDecision] = useState(null);
  const [operation, setOperation] = useState(null);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(0);
  const flight = useRef(null);
  const sequence = useRef(0);
  useEffect(() => () => { ++sequence.current; flight.current?.abort(); flight.current = null; }, [principalLifetime]);
  const visible = (value) => value?.actor === principalLifetime ? value : null;
  const plan = visible(preview)?.data;
  const saved = visible(receipt)?.data;
  const selected = visible(decision);
  const busy = Boolean(visible(operation));
  const currentError = visible(error)?.text;
  const active = () => principalLifetime?.valid !== false;
  async function request(kind, body, complete) {
    if (flight.current || !active()) return;
    const controller = new AbortController(); flight.current = controller;
    const version = ++sequence.current;
    setOperation({ actor: principalLifetime, kind }); setError(null); setPreview(null); setReceipt(null); setDecision(null);
    const current = () => sequence.current === version && !controller.signal.aborted && active();
    try {
      let command = body;
      if (kind === 'preview') {
        // Recorded problems may refer to a superseded publication. Resolve it on every explicit read.
        const { data } = await api.get('/admin/magento-integration', { signal: controller.signal });
        if (!current()) return;
        if (typeof data?.currentPublishedId !== 'string' || !bindingIdPattern.test(data.currentPublishedId)) {
          throw new Error('Чинну опубліковану версію правил не підтверджено. Оновіть перевірку або зверніться до налаштувань інтеграції.');
        }
        command = { ...body, bindingRevisionId: data.currentPublishedId };
      }
      const { data } = await api.post(`${root}/${kind}`, command, { signal: controller.signal });
      if (current()) complete(data, current, command.bindingRevisionId);
    } catch (cause) {
      if (current()) setError({ actor: principalLifetime, text: boundedText(cause?.response?.data?.error, 1000) ? cause.response.data.error : cause?.message || 'Дію не підтверджено. Повторіть перевірку актуального стану.' });
    } finally { if (current()) { flight.current = null; setOperation(null); } }
  }
  function review() {
    setPage(0);
    request('preview', { sku }, (data, _current, bindingRevisionId) => setPreview({ actor: principalLifetime, bindingRevisionId, data: checkedPreview(data, sku) }));
  }
  function apply() {
    if (!selected || !plan || busy || !active()) return;
    const body = { sku, bindingRevisionId: visible(preview).bindingRevisionId, previewToken: plan.previewToken, target: selected.field.target, scope: selected.field.scope, choice: selected.choice };
    request('apply', body, (data, isCurrent) => {
      const checked = checkedReceipt(data, body);
      setReceipt({ actor: principalLifetime, data: checked });
      try { Promise.resolve(onChange?.(checked)).catch(() => { if (isCurrent()) setError({ actor: principalLifetime, text: 'Рішення збережено, але пов’язаний огляд не оновився. Оновіть перевірку полів.' }); }); }
      catch { if (isCurrent()) setError({ actor: principalLifetime, text: 'Рішення збережено, але пов’язаний огляд не оновився. Оновіть перевірку полів.' }); }
    });
  }
  const fields = plan?.fields.slice(page * 50, (page + 1) * 50) || [];
  return <section className="card space-y-4 p-5" aria-label={`Перше отримання полів ${sku}`}>
    <div><h2 className="font-semibold">Перше отримання полів</h2><p className="text-sm break-words">Артикул: <strong>{sku}</strong></p></div>
    <p className="text-sm">Перевірка читає актуальні поля за чинними правилами незалежно від збереженої діагностики. Вона не змінює дані й не запускає синхронізацію. Збереження рішення для поля та доставка виконуються окремо.</p>
    <Button size="compactMd" busy={busy} disabled={!active()} onClick={review}>{busy ? visible(operation)?.kind === 'apply' ? 'Зберігаємо рішення поля…' : 'Читаємо актуальні поля…' : saved ? 'Перевірити поля після рішення' : 'Перевірити актуальні поля'}</Button>
    {currentError && <Notice tone="error">{currentError}</Notice>}
    {saved && <Notice tone="success"><p>{saved.receipt.alreadyApplied ? 'Це рішення вже було збережено.' : 'Рішення для поля збережено.'} {fieldLabel(saved)}</p>
      <p>{saved.choice === 'keep_local' ? 'Значення Amber залишено. Передачу в Magento ще потрібно виконати звичайною захищеною синхронізацією та підтвердити читанням.' : saved.receipt.state === 'name_received' ? 'Назву цією мовою отримано один раз. Подальші зміни обробляються за звичайними правилами назв.' : 'Значення Magento отримано в Amber для цього поля.'}</p>
      <p>Ця квитанція підтверджує локальне рішення. Стан доставки товару не підтверджено.</p>
      <TechnicalDisclosure summary="Квитанція рішення">{() => <pre className="overflow-auto text-xs">{JSON.stringify(saved.receipt, null, 2)}</pre>}</TechnicalDisclosure>
    </Notice>}
    {plan?.mode === 'ordinary' && <Notice tone="info">Одноразове отримання вже завершено або товар має підтверджену передачу. Застосовуються звичайні правила синхронізації та узгодження назв.</Notice>}
    {plan?.mode === 'create' && <Notice tone="info">Товару з цим точним артикулом у Magento немає. Отримувати поля немає звідки; створення виконується окремою звичайною синхронізацією.</Notice>}
    {plan?.mode === 'review' && <Notice tone="warning">Перше отримання недоступне до перевірки наведених причин.</Notice>}
    {plan?.blockers.length > 0 && <Notice tone="warning"><ul className="space-y-2">{plan.blockers.map((blocker, index) => <li key={index}>{blocker.target && <strong>{fieldLabel({ target: blocker.target, scope: blocker.scope || 'all' })}: </strong>}{reasonText(blocker.code)}</li>)}</ul></Notice>}
    {plan?.mode === 'first' && <div className="space-y-2 text-sm"><p>Під час збереження порожні підтверджені поля заповнюються автоматично за погодженими правилами; назви отримуються один раз окремо для кожної мови. Рішення нижче стосується одного вибраного поля.</p><p>{plan.complete ? 'Одноразове отримання всіх передбачених полів підтверджено.' : 'Одноразове отримання ще не завершене для всіх передбачених полів.'} {plan.readyForOutbound ? 'Попередня перевірка полів дозволяє перейти до окремої перевірки доставки.' : 'Перед доставкою залишаються непідтверджені поля або рішення.'}</p></div>}
    {fields.map((field) => {
      const available = plan.mode === 'first' && statuses.has(field.status) && !field.received;
      return <section key={JSON.stringify([field.target, field.scope])} className="space-y-2 rounded-xl border border-slate-200 p-4" aria-label={fieldLabel(field)}>
        <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{fieldLabel(field)}</h3><StatusBadge tone={field.received ? 'success' : field.status === 'conflict' || field.status === 'review_required' || field.status === 'unknown' ? 'warning' : 'neutral'}>{field.received ? 'Отримано один раз' : statusLabels[field.status] || 'Потрібне уточнення стану'}</StatusBadge></div>
        <dl className="grid gap-3 sm:grid-cols-2"><div><dt className="text-sm font-semibold">Поточне Amber</dt><dd className="whitespace-pre-wrap break-words text-sm">{valueText(field.local)}</dd></div><div><dt className="text-sm font-semibold">Поточне Magento</dt><dd className="whitespace-pre-wrap break-words text-sm">{valueText(field.remote)}</dd></div></dl>
        <p className="text-sm">{reasonText(field.reason)}</p>
        {canRecount && !field.received && correctionReasons.has(field.reason) && <a className="btn btn-outline" href={`/products/open?article=${encodeURIComponent(sku)}&action=recount&returnTo=${encodeURIComponent('/attention')}`}>Переглянути виправлення адміністратором</a>}
        {plan.mode === 'first' && !field.received && <div className="flex flex-wrap gap-2"><Button size="compactMd" disabled={busy || !available || !field.canAcceptRemote} onClick={() => setDecision({ actor: principalLifetime, field, choice: 'accept_remote' })} aria-label={`Отримати значення Magento: ${fieldLabel(field)}`}>Отримати значення Magento</Button><Button size="compactMd" disabled={busy || !available || !field.canKeepLocal} onClick={() => setDecision({ actor: principalLifetime, field, choice: 'keep_local' })} aria-label={`Залишити значення Amber: ${fieldLabel(field)}`}>Залишити значення Amber</Button></div>}
        <TechnicalDisclosure summary="Причина й підтвердження поля">{() => <pre className="overflow-auto text-xs">{JSON.stringify({ target: field.target, scope: field.scope, status: field.status, reason: field.reason, received: field.received, blockers: plan.blockers.filter((blocker) => blocker.target === field.target && (!blocker.scope || blocker.scope === field.scope)) }, null, 2)}</pre>}</TechnicalDisclosure>
      </section>;
    })}
    {plan?.fields.length > 50 && <Pagination label="Сторінки полів першого отримання" busy={busy} hasPrevious={page > 0} hasNext={(page + 1) * 50 < plan.fields.length} onPrevious={() => setPage(page - 1)} onNext={() => setPage(page + 1)} summary={`Сторінка ${page + 1} · полів ${plan.fields.length}`} />}
    {plan && <TechnicalDisclosure summary="Межі перевірки й технічні причини">{() => <pre className="overflow-auto text-xs">{JSON.stringify({ mode: plan.mode, blockers: plan.blockers, coverage: plan.coverage }, null, 2)}</pre>}</TechnicalDisclosure>}
    <ConfirmDialog open={Boolean(selected)} title={selected ? `Підтвердити поле: ${fieldLabel(selected.field)}` : 'Підтвердити поле'} confirmLabel="Зберегти рішення цього поля" busy={busy} onClose={() => setDecision(null)} onConfirm={apply}>
      {selected && <div className="space-y-3"><p className="text-sm">Артикул: <strong>{sku}</strong></p><p>Значення Amber перед рішенням: <strong className="whitespace-pre-wrap break-words">{valueText(selected.field.local)}</strong></p><p>Значення Amber після рішення: <strong className="whitespace-pre-wrap break-words">{valueText(selected.choice === 'accept_remote' ? selected.field.remote : selected.field.local)}</strong></p>
        <p>{selected.choice === 'keep_local' ? 'Дані Amber зберігаються. Це рішення очікуватиме окремої захищеної передачі та підтвердження Magento.' : 'Обране рішення отримує підтверджене значення Magento в Amber для зазначеного поля й мови.'}</p><p className="text-sm">Порожні підтверджені поля та перші назви також обробляються за погодженими правилами отримання. Інші заповнені конфлікти потребують власного рішення.</p></div>}
    </ConfirmDialog>
  </section>;
}

export default function MagentoFirstSyncFields(props) {
  const auth = useAuth();
  if (!isActualAdministrator(auth) || auth.principalLifetime?.valid !== true
    || !['export_templates.view', 'export_templates.manage', 'export_templates.publish', 'exports.view'].every((permission) => auth.permissions?.includes(permission))
    || !boundedText(props.sku, 256) || props.sku !== props.sku.trim()) return null;
  return <FieldPanel key={JSON.stringify([props.sku, props.bindingRevisionId, auth.principalLifetime?.id])} {...props} principalLifetime={auth.principalLifetime} canRecount={auth.permissions?.includes('products.decode') && auth.permissions?.includes('products.recount')} />;
}
