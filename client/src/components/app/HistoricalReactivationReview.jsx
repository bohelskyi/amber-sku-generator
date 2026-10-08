import { useEffect } from 'react';
import { useAuth } from '../../auth/auth-context.js';
import { useHistoricalReactivation } from '../../hooks/useHistoricalReactivation.js';
import { historicalCapability, isStandardHistorical, historicalPrerequisiteLabels, historicalReasonLabels, historicalStateLabels } from '../../lib/historical-reactivation.js';
import { CopyAction } from '../ui/index.js';
import { WorkspaceDialog } from '../workspace/WorkspaceDialog.jsx';
import { historicalDeliveryBlockerLabels, historicalNameRepairRequest } from '../../lib/historical-name-review.js';
import { HistoricalNameBaselineReview } from './HistoricalNameBaselineReview.jsx';
import { HistoricalManualNameReview } from './HistoricalManualNameReview.jsx';
import { historicalManualNameRequest } from '../../lib/historical-manual-name-review.js';
import { historicalWeightRequest } from '../../lib/historical-weight-normalization-review.js';
import { HistoricalWeightNormalizationReview } from './HistoricalWeightNormalizationReview.jsx';
import './HistoricalReactivationReview.css';

const time = (value) => value ? new Date(value).toLocaleString('uk-UA') : 'Ще не підтверджено';
const reason = (code) => historicalReasonLabels[code] || 'Потрібна окрема перевірка перед новим рішенням.';

function CurrentPrerequisites({ item }) {
  if (!item.prerequisites.length) return null;
  return <div className="mt-3">
    <p className="font-semibold">Перевірені умови</p>
    <ul className="mt-2 space-y-1">{item.prerequisites.map((condition) => <li key={condition.code}>
      {condition.met ? 'Виконано: ' : 'Не виконано: '}
      {historicalPrerequisiteLabels[condition.code] || 'Додаткова умова поточного рішення'}
    </li>)}</ul>
  </div>;
}

function ReceiptItem({ item, flow }) {
  if (isStandardHistorical(item)) return <StandardReceiptItem item={item} flow={flow} />;
  const inspection = flow.inspections[item.intentId];
  const allConfirmed = Boolean(item.hiddenVerifiedAt && item.localActivatedAt && item.nativeConfirmedAt);
  return <li className="rounded border p-3">
    <p><strong className="break-all font-mono">{item.article}</strong>: {historicalStateLabels[item.state]}</p>
    {item.reasonCode && <p className="mt-2 text-amber-800">{reason(item.reasonCode)}</p>}
    <details className="historical-evidence"><summary>Докази виконання</summary>
    <dl className="mt-2 text-sm">
      <div><dt className="inline font-semibold">Прихований стан 2 перевірено: </dt><dd className="inline">{time(item.hiddenVerifiedAt)}</dd></div>
      <div><dt className="inline font-semibold">Локальну активацію цим рішенням підтверджено: </dt><dd className="inline">{time(item.localActivatedAt)}</dd></div>
      <div><dt className="inline font-semibold">Первісний UPDATE підтверджено: </dt><dd className="inline">{time(item.nativeConfirmedAt)}</dd></div>
    </dl>
    </details>
    {!allConfirmed && <p className="mt-2 text-sm">Це ще не підтвердження завершення всіх етапів доставки. Товар не вмикається для показу.</p>}
    {allConfirmed && <p className="mt-2 font-medium">Приховування, локальне рішення та UPDATE підтверджено. Новий бажаний стан — прихований 2.</p>}
    {item.state !== 'completed' && <button type="button" className="btn btn-outline mt-3"
      disabled={Boolean(flow.busyKind || flow.uncertain)} onClick={() => void flow.inspect(item)}>
      Перевірити прихований результат для {item.article}
    </button>}
    {inspection && <section className="mt-3 rounded border border-amber-200 p-3" aria-label={'Перевірка результату для ' + item.article}>
      <p>Очікуваний Magento ID: {inspection.expectedMagentoId || 'Не підтверджено'}.</p>
      <p>Спостережений Magento ID: {inspection.observedMagentoId || 'Не підтверджено'}.</p>
      <p>Спостережений стан: {inspection.observedStatus === 2 ? '2 — прихований' : inspection.observedStatus === 1 ? '1 — видимий' : 'Не підтверджено'}.</p>
      <p className="mt-2 text-sm">Це нова перевірка точного відповідника, а не доказ попередньої видимості до архівування. Повторний PUT не надсилається.</p>
      {!inspection.canConfirm ? <p className="mt-2 font-medium">Ця перевірка не дозволяє завершити локальне рішення.</p> : <>
        <label className="mt-3 flex min-h-[34px] items-start gap-2 py-2">
          <input type="checkbox" className="mt-1" disabled={Boolean(flow.busyKind || flow.uncertain)}
            checked={Boolean(flow.reconcileAcknowledged[item.intentId])}
            onChange={(event) => flow.setReconcileAcknowledged(item.intentId, event.target.checked)} />
          Підтверджую завершення лише локального рішення за перевіреним прихованим результатом для {item.article}.
        </label>
        <button type="button" className="btn btn-primary mt-2"
          disabled={Boolean(flow.busyKind || flow.uncertain || !flow.reconcileAcknowledged[item.intentId])}
          onClick={() => void flow.reconcile(item)}>Перевірити результат і завершити локальне рішення</button>
        <p className="mt-2 text-sm">Сервер знову прочитає точний відповідник і перевірить чинні права та дані. Повторного запису PUT до Magento не буде.</p>
      </>}
    </section>}
  </li>;
}

const statusLabel = (value) => value === 1 ? '1 — увімкнено' : value === 2 ? '2 — вимкнено' : 'Не підтверджено';
const visibilityLabel = (value) => ({ 1: '1 — не показувати окремо', 2: '2 — каталог', 3: '3 — пошук', 4: '4 — каталог і пошук' })[value] || 'Не підтверджено';
function StandardReceiptItem({ item, flow }) {
  const inspection = flow.inspections[item.intentId];
  return <li className="rounded border p-3">
    <p><strong className="break-all font-mono">{item.article}</strong>: {item.state === 'queued' ? 'Нове рішення зареєстровано; доставка очікує виконання' : historicalStateLabels[item.state]}</p>
    <p className="mt-2">Операція: {item.deliveryMode.toUpperCase()}. Стан: {statusLabel(item.targetStatus)}. Видимість: {visibilityLabel(item.targetVisibility)}.</p>
    {item.reasonCode && <p className="mt-2 text-amber-800">{reason(item.reasonCode)}</p>}
    <details className="historical-evidence"><summary>Докази виконання</summary>
    <dl className="mt-2 text-sm">
      <div><dt className="inline font-semibold">Первісна задача доставки: </dt><dd className="inline break-all font-mono">{item.nativeJobId || 'Ще не зареєстровано'}</dd></div>
      <div><dt className="inline font-semibold">Magento ID за перевіреним результатом: </dt><dd className="inline">{item.confirmedRemoteProductId || 'Ще не підтверджено'}</dd></div>
      <div><dt className="inline font-semibold">Результат первісної доставки перевірено: </dt><dd className="inline">{time(item.deliveryVerifiedAt)}</dd></div>
      <div><dt className="inline font-semibold">Локальну активацію підтверджено: </dt><dd className="inline">{time(item.localActivatedAt)}</dd></div>
      <div><dt className="inline font-semibold">Підтвердження первісної задачі Magento: </dt><dd className="inline">{time(item.nativeConfirmedAt)}</dd></div>
    </dl>
    </details>
    <p className="mt-2 text-sm">Попереднє приховування не підтверджено. Це квитанція нового рішення, а не твердження про поточну видимість після інших змін.</p>
    {item.state === 'completed' ? <p className="mt-2 font-medium">Первісну доставку та окрему локальну активацію підтверджено.</p>
      : item.state !== 'cancelled' && <p className="mt-2">До перевіреного результату доставки товар залишається архівованим. Повторний запис не надсилається з цієї перевірки.</p>}
    {!['completed', 'cancelled'].includes(item.state) && <button type="button" className="btn btn-outline mt-3" disabled={Boolean(flow.busyKind || flow.uncertain)}
      onClick={() => void flow.inspect(item)}>Перевірити первісну доставку для {item.article}</button>}
    {inspection && <section className="mt-3 rounded border p-3" aria-label={'Перевірка первісної доставки для ' + item.article}>
      <p>Читаємо результат тієї самої задачі; повторний запис Magento не надсилається.</p>
      {inspection.canReconcile && <>
        <label className="mt-3 flex min-h-[44px] items-start gap-2 py-2"><input type="checkbox" className="mt-1" disabled={Boolean(flow.busyKind || flow.uncertain)}
          checked={Boolean(flow.reconcileAcknowledged[item.intentId])} onChange={(event) => flow.setReconcileAcknowledged(item.intentId, event.target.checked)} />Підтверджую локальне завершення за перевіреним результатом первісної доставки для {item.article}.</label>
        <button type="button" className="btn btn-primary mt-2" disabled={Boolean(flow.busyKind || flow.uncertain || !flow.reconcileAcknowledged[item.intentId])}
          onClick={() => void flow.reconcile(item)}>Записати перевірений результат і завершити локальне рішення</button>
      </>}
      {inspection.canContinue && <><p className="mt-2 font-medium">Залишилися ненадіслані дії. Потрібне окреме перевірене продовження первісної задачі {item.nativeJobId}; ця форма його не запускає.</p><CopyAction value={inspection.nativeJobId} label="Скопіювати номер первісної задачі доставки" buttonLabel="Копіювати номер задачі" compact /></>}
      {inspection.canCancel && <>
        <label className="mt-3 flex min-h-[44px] items-start gap-2 py-2"><input type="checkbox" className="mt-1" disabled={Boolean(flow.busyKind || flow.uncertain)}
          checked={Boolean(flow.cancelAcknowledged[item.intentId])} onChange={(event) => flow.setCancelAcknowledged(item.intentId, event.target.checked)} />Скасувати тільки первісне рішення для {item.article} до початку доставки.</label>
        <button type="button" className="btn btn-outline mt-2" disabled={Boolean(flow.busyKind || flow.uncertain || !flow.cancelAcknowledged[item.intentId])}
          onClick={() => void flow.cancel(item)}>Скасувати ненадіслане рішення</button>
        <p className="mt-2 text-sm">Сервер повторно перевірить відсутність відправлення. Розпочату або невизначену доставку скасування не повторює й не скидає.</p>
      </>}
      {!inspection.canCancel && !inspection.canReconcile && !inspection.canContinue && <p className="mt-2">Наразі доступне лише читання первісного результату.</p>}
    </section>}
  </li>;
}

function ReviewItem({ item, flow, standard }) {
  const sku = item.article || item.inputSku;
  const eligible = item.disposition === 'eligible';
  const selected = Boolean(item.article && flow.selected.includes(item.article));
  const locked = Boolean(flow.busyKind || flow.uncertain || flow.batchId || flow.pendingOperation || flow.nameReview);
  const namesRequest = historicalNameRepairRequest(item);
  const manualNamesRequest = historicalManualNameRequest(item);
  const weightRequest = historicalWeightRequest(item);
  const name = typeof item.currentName === 'string' && item.currentName.trim() ? item.currentName : null;
  return <li className={`historical-product${selected ? ' is-selected' : ''}`}>
    <div className="historical-product-heading">
      <label className="historical-product-identity">
        <input type="checkbox" aria-label={'Обрати ' + sku} disabled={locked || !eligible || flow.expired || flow.needsFinalReview}
          checked={selected} onChange={(event) => flow.select(item.article, event.target.checked)} />
        <span><strong className="break-all font-mono">{sku}</strong>
          <span className="historical-product-name">{name || 'Назву не підтверджено'}</span></span>
      </label>
      <span className={`historical-product-status${eligible ? '' : ' needs-review'}`}>
        {flow.normalizedWeights.includes(sku) ? 'Формат ваги виправлено' : flow.savedManualNames.includes(sku) ? 'Назви збережено' : eligible ? flow.needsFinalReview ? 'Потрібна нова перевірка' : 'Можна відновити' : item.disposition === 'skipped' ? 'Пропущено' : 'Потребує уваги'}
      </span>
    </div>
    {flow.savedManualNames.includes(sku) ? <p className="historical-product-outcome">Товар залишається архівованим. Перед відновленням перевірте список заново.</p> : eligible ? <p className="historical-product-outcome">{standard
      ? item.deliveryMode === 'create'
        ? 'У Magento товар не знайдено. Створимо його під тим самим артикулом, вимкненим для продажу.'
        : `Оновимо наявний товар у Magento. Він залишиться ${item.targetStatus === 1 ? 'увімкненим' : 'вимкненим'}; видимість — ${({ 1: 'не показувати окремо', 2: 'каталог', 3: 'пошук', 4: 'каталог і пошук' })[item.targetVisibility]}.`
      : 'Оновимо наявний товар у Magento й вимкнемо його для продажу.'}</p>
      : <p className="historical-product-outcome">{reason(item.reasonCode)}</p>}
    {!flow.savedManualNames.includes(sku) && item.deliveryBlockerCodes?.length > 0 && <ul className="mt-2 space-y-1 text-sm text-amber-800">{item.deliveryBlockerCodes.map(code => <li key={code}>{historicalDeliveryBlockerLabels[code] || code}</li>)}</ul>}
    {namesRequest && !flow.nameReview && (flow.canReviewNames
      ? <button type="button" className="btn btn-outline mt-3" disabled={locked} onClick={() => void flow.reviewNames(item)}>Перевірити назви Magento</button>
      : <p className="mt-2 text-sm">Прийняття назв потребує також чинного права на створення експорту.</p>)}
    {flow.savedManualNames.includes(sku) && <p className="mt-2 text-sm font-medium">Назви збережено. Потрібна фінальна перевірка відновлення.</p>}
    {manualNamesRequest && !flow.savedManualNames.includes(sku) && <p className="mt-2 text-sm">Потрібна ручна українська й англійська назва цього сувеніра.</p>}
    {manualNamesRequest && !flow.savedManualNames.includes(sku) && !flow.nameReview && (flow.canReviewNames
      ? <button type="button" className="btn btn-outline mt-3" disabled={locked} onClick={() => void flow.completeManualNames(item)}>Ввести ручну UA/EN назву</button>
      : <p className="mt-2 text-sm">Збереження ручної назви потребує також чинного права на створення експорту.</p>)}
    {weightRequest && !flow.normalizedWeights.includes(sku) && <p className="mt-2 text-sm">Вагу записано з комою: {item.weightNormalization.sourceWeight} → {item.weightNormalization.targetWeight} г. Потрібна згода на виправлення формату.</p>}
    {weightRequest && !flow.normalizedWeights.includes(sku) && !flow.nameReview && (flow.canNormalizeWeights
      ? <button type="button" className="btn btn-outline mt-3" disabled={locked} onClick={() => void flow.reviewWeight(item)}>Перевірити формат ваги</button>
      : <p className="mt-2 text-sm">Виправлення формату ваги потребує чинних прав на перерахунок і експорт.</p>)}
    {flow.normalizedWeights.includes(sku) && <p className="mt-2 text-sm">Виправлено лише формат ваги. Перед відновленням потрібна свіжа перевірка.</p>}
    {flow.nameReview && flow.nameReview.request.productId === item.productId && (flow.nameReview.request.intent === 'historical-weight-normalization'
      ? <HistoricalWeightNormalizationReview flow={flow} /> : flow.nameReview.request.intent === 'historical-create'
      ? <HistoricalManualNameReview flow={flow} /> : <HistoricalNameBaselineReview flow={flow} />)}
    {eligible && standard && item.deliveryMode === 'create' && <label className="historical-create-consent">
      <input type="checkbox" aria-label={'Окремо дозволити CREATE ' + item.article}
        disabled={locked || !selected || flow.expired || flow.needsFinalReview} checked={flow.selectedCreate.includes(item.article)}
        onChange={(event) => flow.selectCreate(item.article, event.target.checked)} />
      <span>Дозволяю створити цей товар у Magento вимкненим для продажу.</span>
    </label>}
    <details className="historical-evidence"><summary>Дані й перевірки</summary>
      <div className="mt-2 space-y-1 text-sm">
        <p>Попередня видимість і виключення з експорту невідомі.</p>
        {item.remoteProductId && <p>Точний Magento ID: {item.remoteProductId}. Спостережений стан: {statusLabel(item.observedRemoteStatus)}.</p>}
        {eligible && <p>{standard ? item.deliveryMode.toUpperCase() : 'UPDATE'}. Новий стан: {statusLabel(item.targetStatus)}.{standard && ` Видимість: ${visibilityLabel(item.targetVisibility)}.`}</p>}
        {item.currentPriceUah != null && <p>Чинна ціна: {item.currentPriceUah} ₴.</p>}
        {item.category && <p>Категорія: {item.category}.</p>}
        {item.currentWeight != null && <p>Вага: {item.currentWeight} г.</p>}
        {item.currentRoute && <p>Маршрут доставки: {item.currentRoute}.</p>}
        {item.currentBusinessExclusion && <p>Бізнес-виключення: {item.currentBusinessExclusion}. Окремі бізнес-рішення не скасовуються автоматично.</p>}
      </div>
      <CurrentPrerequisites item={item} />
    </details>
  </li>;
}

export function HistoricalReactivationReview({
  open, config, onClose, onReceipt, onDirtyChange, onBusyChange, apiClient, createRequestId,
}) {
  const auth = useAuth();
  const flow = useHistoricalReactivation({ auth, config, open, onReceipt, apiClient, createRequestId });
  useEffect(() => { onDirtyChange?.(flow.dirty); }, [flow.dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(Boolean(open && (flow.busyKind || flow.uncertain))); }, [open, flow.busyKind, flow.uncertain, onBusyChange]);
  useEffect(() => () => { onDirtyChange?.(false); onBusyChange?.(false); }, [onDirtyChange, onBusyChange]);
  if (!open) return null;
  const standard = flow.receipt ? isStandardHistorical(flow.receipt) : config?.historicalReactivation?.protocol === 'standard-rest-v1';
  const createsReady = !isStandardHistorical(flow.review) || flow.review.items.filter((item) => flow.selected.includes(item.article) && item.deliveryMode === 'create').every((item) => flow.selectedCreate.includes(item.article));
  const missing = flow.review?.items.filter((item) => item.reasonCode === 'HISTORICAL_PRODUCT_NOT_FOUND').length || 0;
  const formLocked = Boolean(flow.busyKind || flow.uncertain || flow.batchId || flow.pendingOperation || flow.nameReview);
  const input = <div>
    <label htmlFor="historical-reactivation-skus" className="font-semibold">Точні артикули, по одному в рядку</label>
    <textarea id="historical-reactivation-skus" className="input mt-2 min-h-[96px] font-mono" rows={4}
      value={flow.text} disabled={formLocked} onChange={(event) => flow.editText(event.target.value)} />
    {!flow.uncertain && !flow.batchId && <button type="button" className={`btn ${flow.review ? 'btn-outline' : 'btn-primary'} mt-3`}
      disabled={Boolean(formLocked || !flow.text.trim())} onClick={() => void flow.preview()}>
      {flow.busyKind === 'preview' ? 'Перевіряємо товари…' : flow.needsFinalReview ? 'Перевірити перед відновленням' : flow.review ? 'Оновити перевірку' : 'Перевірити товари'}
    </button>}
    {!flow.review && <p className="mt-2 text-sm text-slate-500">Перевірка ще не відновлює товари.</p>}
  </div>;
  return <WorkspaceDialog title="Відновлення товарів" className="historical-restore-dialog" busy={flow.locked} onClose={onClose}>
    <header><h2 className="text-xl font-semibold">Відновлення товарів</h2>
      <p className="mt-1 text-sm text-slate-500">Оберіть товари й погодьте, як їх відновити.</p></header>
    {!flow.allowed ? <p role="alert" className="text-red-700">{!historicalCapability(config) ? 'Історичне відновлення ще недоступне. Скористайтеся звичайним відновленням, якщо для нього є підтверджена історія.' : 'Потрібен Адміністратор із чинними правами на товари, історію та інтеграцію.'}</p> : <>
      {flow.operation && !flow.receipt && <section className="rounded border p-3" aria-label="Прогрес перевірки">
        <p role="status" className="font-semibold">{flow.operation.kind === 'confirm' ? 'Повторна перевірка перед відновленням' : 'Перевірка переліку'}: {({ queued: 'у черзі', running: 'виконується', ready: 'готово', failed: 'завершено з помилкою', unknown: 'читаємо стан' })[flow.operation.state]}.</p>
        {flow.operation.progress && <p>Перевірено: {flow.operation.progress.completed} з {flow.operation.progress.total}.</p>}
        <p className="mt-2 break-all font-mono">{flow.operation.operationId}</p>
        {flow.pendingOperation && <>
          <p className="mt-2 text-sm">Можна закрити вікно й повернутися. Результат зберігається; повторне підтвердження не надсилається.</p>
          <button type="button" className="btn btn-outline mt-2" disabled={Boolean(flow.busyKind)} onClick={() => void flow.refresh()}>Прочитати прогрес цієї самої операції</button>
        </>}
      </section>}
      {!flow.receipt && (flow.review ? <details className="historical-evidence historical-input"><summary>Артикули для перевірки ({flow.review.skus.length})</summary><div className="mt-3">{input}</div></details> : input)}
      {flow.review && !flow.receipt && <section aria-label="Перевірений склад історичного рішення">
        <div className="historical-review-summary">
          <p className="font-semibold">{flow.needsFinalReview ? 'Попередня перевірка — готових' : 'Можна відновити'}: {flow.review.counts.eligible}. Потребують уваги: {flow.review.counts.blocked}.{flow.review.counts.skipped > 0 && ` Пропущено: ${flow.review.counts.skipped}.`}</p>
          {flow.review.counts.eligible > 1 && <button type="button" className="btn btn-outline" disabled={formLocked || flow.expired || flow.needsFinalReview}
            onClick={flow.selectEligible}>Обрати всі дозволені ({flow.review.counts.eligible})</button>}
        </div>
        {missing > 0 && <p className="mt-2 text-sm">Не знайдено у Manager: {missing}. Ці артикули не відновлюватимуться.</p>}
        <p className="historical-unknown-history">Попередній стан цих товарів невідомий. Відновлення використає поточні дані.</p>
        {flow.needsFinalReview && <p role="status" className="mt-2 text-sm font-medium">{flow.weightReviewChanged ? 'Формат ваги перевірявся. Перед відновленням прочитайте актуальні дані.' : 'Назви редагувалися. Завершіть введення назв.'} Натисніть «Перевірити перед відновленням». Перевіримо весь список і відповідники Magento. Після перевірки заново оберіть товари та погодьте відновлення.</p>}
        {flow.expired && !flow.needsFinalReview && <p role="alert" className="mt-2 text-amber-800">Перевірка застаріла. Оновіть її перед відновленням.</p>}
        <ul className="mt-3 space-y-3">{flow.review.items.map((item, index) => <ReviewItem key={item.inputSku + ':' + index} item={item} flow={flow} standard={isStandardHistorical(flow.review)} />)}</ul>
        <details className="historical-evidence"><summary>Умови відновлення та історія</summary>
          <p className="mt-2 text-sm">{flow.needsFinalReview ? 'Попередня перевірка вже не дозволяє відновлення.' : `Перевірка чинна до ${time(flow.review.reviewExpiresAt)}.`} Перед підтвердженням сервер повторно перевірить дані та відповідники. До підтвердженої доставки товар залишається архівованим у Manager.</p>
          {standard ? <p className="mt-2 text-sm">Стандартний REST Magento може створити або оновити товар. Тип запису не захищений від паралельних зовнішніх змін. Для кожного створення потрібна окрема згода.</p>
            : <p className="mt-2 text-sm">Дозволено лише UPDATE точного існуючого відповідника. CREATE, новий артикул, зміна історичного SKU та автоматична публікація правил не допускаються. Новий стан — прихований 2; показ товару потребуватиме окремого перевіреного рішення.</p>}
        </details>
      </section>}
      {flow.batchId && <section className="rounded border p-3" aria-label="Номер історичного рішення">
        <p className="font-semibold">{flow.uncertain ? 'Чекаємо підтвердження результату' : 'Відновлення зареєстроване'}</p>
        <button type="button" className="btn btn-outline mt-3" disabled={Boolean(flow.busyKind)} onClick={() => void flow.refresh()}>Перевірити стан цього самого рішення</button>
        <details className="historical-evidence"><summary>Номер операції</summary>
          <p className="mt-2 break-all font-mono">{flow.batchId}</p>
          <CopyAction value={flow.batchId} label="Скопіювати номер історичного рішення" buttonLabel="Копіювати номер операції" compact />
          <p className="mt-2 text-sm">Збережіть цей номер, щоб після закриття або перезавантаження прочитати стан того самого рішення.</p>
        </details>
      </section>}
      {flow.uncertain && <p role="alert" className="text-amber-800">Результат ще не підтверджено. Список і номер операції збережені. Перевірте стан; повторне відновлення не надсилатиметься.</p>}
      {flow.receipt && <section aria-label="Підтвердження історичного рішення">
        <h3 className="font-semibold">Результати відновлення</h3>
        <details className="historical-evidence"><summary>Правила й історія цієї операції</summary>
          <p className="mt-2 text-sm">Ці записи підтверджують нове рішення. Попередня видимість невідома; поточний стан після інших змін Magento потребує свіжої перевірки.</p>
          {standard ? <p className="mt-2 text-sm">Ця операція використовує стандартну доставку Magento. Створення потребувало окремої згоди; стан нового товару — вимкнений. Для наявного товару зберігаються перевірені стан і видимість.</p>
            : <p className="mt-2 text-sm">Дозволений лише UPDATE точного існуючого відповідника Magento. CREATE, новий артикул, зміна історичного SKU та автоматична публікація правил не допускаються. Новий бажаний стан — прихований 2.</p>}
        </details>
        <ul className="mt-3 space-y-3">{flow.receipt.items.map((item) => <ReceiptItem key={item.intentId} item={item} flow={flow} />)}</ul>
        {flow.canReset && <button type="button" className="btn btn-outline mt-3"
          disabled={Boolean(flow.busyKind)} onClick={flow.reset}>Новий перелік для окремої перевірки</button>}
      </section>}
      {!flow.batchId && <details className="historical-evidence">
        <summary>Знайти попередню операцію</summary>
        <label className="mt-2 block" htmlFor="historical-reactivation-lookup">Номер операції UUID</label>
        <input id="historical-reactivation-lookup" className="input mt-2 font-mono" value={flow.lookupId}
          disabled={formLocked} onChange={(event) => flow.setLookupId(event.target.value)} />
        <button type="button" className="btn btn-outline mt-3" disabled={Boolean(formLocked || !flow.lookupId.trim())}
          onClick={() => void flow.refresh()}>Прочитати стан рішення</button>
      </details>}
    </>}
    {flow.nameNotice && <p role="status" className="text-sm">{flow.nameNotice}</p>}
    {flow.error && <p role="alert" className="text-red-700">{flow.error}</p>}
    <footer className="historical-restore-footer">
      {flow.allowed && flow.review && !flow.receipt && <>
        <section aria-label="Точні обрані учасники">
          <p className="font-semibold">Обрано: {flow.selected.length}{flow.selected.length === 1 && <span className="ml-2 break-all font-mono font-normal">{flow.selected[0]}</span>}</p>
          {flow.selected.length > 1 ? <details className="historical-evidence"><summary>Переглянути обрані артикули</summary><ul className="mt-2 font-mono">{flow.selected.map((sku) => <li key={sku} className="break-all">{sku}</li>)}</ul></details>
            : !flow.selected.length && <p className="mt-1 text-sm text-slate-500">Оберіть товари у списку.</p>}
        </section>
        <label className="historical-decision-consent"><input type="checkbox"
          disabled={formLocked || !flow.selected.length || flow.expired || flow.needsFinalReview} checked={flow.acknowledged}
          onChange={(event) => flow.setAcknowledged(event.target.checked)} />
          <span>{isStandardHistorical(flow.review) ? 'Погоджую відновлення вибраних товарів за поточними даними. Попередній стан невідомий.' : 'Погоджую оновлення вибраних товарів у Magento й вимкнення для продажу. Попередній стан невідомий.'}</span>
        </label>
        {!createsReady && <p className="text-sm" role="status">Дозвольте створення кожного вибраного відсутнього товару.</p>}
        {!flow.review.counts.eligible && <p className="text-sm">Спочатку усуньте причини, зазначені у списку, і повторіть перевірку.</p>}
      </>}
      <div className="historical-restore-actions">
        <button type="button" className="btn btn-outline" aria-label="Закрити історичне рішення" disabled={flow.locked} onClick={onClose}>Закрити</button>
        {flow.allowed && flow.needsFinalReview && !flow.receipt && <button type="button" className="btn btn-primary"
          disabled={formLocked} onClick={() => void flow.repeatAfterNames()}>Перевірити перед відновленням</button>}
        {flow.allowed && flow.review && !flow.receipt && !flow.uncertain && !flow.batchId && !flow.needsFinalReview && <button type="button" className="btn btn-primary"
          disabled={Boolean(formLocked || !flow.selected.length || !flow.acknowledged || !createsReady || flow.expired)}
          onClick={() => void flow.confirm()}>Відновити вибране ({flow.selected.length})</button>}
      </div>
    </footer>
  </WorkspaceDialog>;
}
