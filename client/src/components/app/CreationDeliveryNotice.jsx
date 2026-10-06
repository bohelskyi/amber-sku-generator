import { creationDeliveryState } from '../../lib/creation-delivery-readiness.js';
import './creation-delivery-notice.css';

const taskIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function taskReceiptState(receipt) {
  if (!receipt) return null;
  return taskIdPattern.test(receipt.taskId) && ['open', 'resolved', 'cancelled'].includes(receipt.state)
    && receipt.href === '/attention?integrationTask=' + receipt.taskId ? receipt : false;
}
function IntegrationRequestReceipt({ receipt }) {
  if (receipt === null) return null;
  if (!receipt) return <p className="mt-2" role="alert">Результат створення задачі ще не підтверджено. Перевірте стан цієї самої спроби.</p>;
  return <div className="creation-task-receipt" role="status">
    <p className="font-semibold">{receipt.state === 'open' ? 'Задачу Адміністратору створено' : receipt.state === 'resolved' ? 'Рішення за задачею позначено виконаним' : 'Задачу скасовано'}</p>
    <p className="mt-1 break-all font-mono text-xs">№ {receipt.taskId}</p>
    {typeof receipt.message === 'string' && <p className="mt-1">{receipt.message}</p>}
    <a className="btn btn-outline mt-2" href={receipt.href}>Відкрити задачу</a>
    <p className="mt-2">{receipt.state === 'resolved' ? 'Оновіть перевірку цього товару перед наступною дією.' : 'Після рішення Адміністратора оновіть перевірку.'} Створення задачі не підтверджує доставку в Magento.</p>
  </div>;
}

export default function CreationDeliveryNotice({ readiness, categoryCode, categoryLabel, permissions = [], saved = false, id,
  questionLabel, valueLabel, onRecheck, busy = false, onRequestIntegration, creatingRequest = false, requestReceipt }) {
  const state = creationDeliveryState(readiness, categoryCode);
  if (!state) return null;
  const receipt = taskReceiptState(requestReceipt);
  if (state.status !== 'configuration_required') return <div>
    <p id={id} className="text-sm text-slate-600" role="status">
      {saved && <strong>Перевірка на момент збереження: </strong>}
      {saved ? 'Товар збережено в Amber. ' : 'Дані товару перевірено. '}
      {state.status === 'no_native_upgrade_blocker' ? 'Для цієї характеристики не виявлено потреби оновлювати підтримку нових товарів; передавання товару в Magento перевіряється окремо.' : 'Передавання товару в Magento ще не перевірено.'}
    </p>
    <IntegrationRequestReceipt receipt={receipt}/>
  </div>;
  const canView = permissions.includes('export_templates.view');
  const canManage = permissions.includes('export_templates.manage');
  const guided = typeof onRequestIntegration === 'function';
  const requestLocked = busy || creatingRequest || receipt === false || Boolean(receipt && receipt.state !== 'cancelled');
  const valueMapping = ['deferred_value', 'source_value'].includes(state.kind);
  const categoryMapping = state.kind === 'category';
  const field = questionLabel || (state.questionKey === 'size' ? 'Розмір' : state.kind === 'native_upgrade' ? 'Додаткова ознака' : 'Характеристика');
  const reason = categoryMapping ? `Категорія «${categoryLabel || categoryCode}» не підключена в правилах`
    : state.kind === 'source_value' ? `«${field}»: значення «${valueLabel || readiness.valueId}» не має прив’язки в правилах`
    : state.kind === 'deferred_value' ? `«${field}»: значення «${valueLabel || readiness.valueId}» відкладено в правилах`
    : `Потрібне оновлення правил для «${field}»`;
  const reviewLink = canView && <a className="btn btn-outline" href={state.href} target="_blank" rel="noopener noreferrer">{valueMapping ? 'Перевірити значення та відповідність' : categoryMapping ? 'Перевірити підключення категорії' : canManage ? 'Підготувати підключення' : 'Переглянути потрібну зміну'} у новій вкладці</a>;
  return <section id={id} className="creation-delivery-notice text-sm" role="alert" aria-label="Передавання нового товару в Magento">
    {saved && <p className="mb-2 font-semibold">Перевірка на момент збереження</p>}
    <p className="font-semibold">{saved ? 'Збережено в менеджері. Доставку в Magento не підтверджено.' : 'Можна зберегти лише в менеджері.'}</p>
    <p className="creation-delivery-context">Для доставки в Magento вирішіть конфлікт:</p>
    <p className="creation-delivery-reason">{reason}</p>
    <div className="creation-delivery-actions">
      {guided && (!receipt || receipt.state === 'cancelled') && <button type="button" className="btn btn-primary" disabled={requestLocked}
        onClick={() => onRequestIntegration({ categoryCode, questionKey: state.questionKey,
          ...(categoryMapping ? {valueId:null} : valueMapping ? { valueId: readiness.valueId } : {}) })}>
        {creatingRequest ? 'Створюємо задачу…' : 'Сформувати задачу Адміністратору'}
      </button>}
      {!guided && reviewLink}

    </div>
    <IntegrationRequestReceipt receipt={receipt}/>
    {(!guided || receipt) && <details className="creation-delivery-details">
      <summary>Деталі</summary>
      {!canManage && !guided && <p className="mt-2">Потрібен користувач із правом керування інтеграцією.</p>}
      {guided && reviewLink}
      {onRecheck && <button type="button" className="btn creation-delivery-recheck" disabled={busy || creatingRequest} onClick={onRecheck}>Оновити перевірку</button>}
    </details>}
  </section>;
}
