import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../auth/auth-context.js';
import { isActualAdministrator } from '../../auth/auth-model.js';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Button, ConfirmDialog, Notice, TechnicalDisclosure } from '../ui/index.js';
import MagentoControlledActions from '../workspace/MagentoControlledActions.jsx';
import MagentoRecoveryHistory from './MagentoRecoveryHistory.jsx';
import { nextAction, problemRepairUrl } from './sync-problem-presentation.js';
import { decisionReason, missingRecoveryEvidence, selectedEvidence, verifiedRecoveryFacts } from './recovery-presentation.js';

const guidance = {
  prior_exposure: 'Знайдемо цей артикул у Magento. Якщо товар уже є в магазині, ви зможете підтвердити це й перейти до оновлення його даних.',
  stable_recount_exposure: 'Звіримо товар після переобліку з поточним товаром Magento. Підтвердження дозволить оновити цю версію зі сталим артикулом.',
  historical_recount_exposure: 'Перевіримо поточний товар і всі попередні артикули. Якщо старі артикули відсутні, запропонуємо дозволити оновлення наявного товару.',
  release_exclusion: 'Перевіримо окреме виключення цього товару із синхронізації. Для його зняття потрібна ваша підстава.',
};
const decisionActions = { prior_exposure: 'Підтвердити наявність товару', stable_recount_exposure: 'Дозволити оновлення після переобліку', release_exclusion: 'Зняти виключення із синхронізації' };
decisionActions.historical_recount_exposure = 'Підтвердити товар і дозволити оновлення';
const decisionEffects = { prior_exposure: 'Підтвердження збереже в Amber факт наявності цього товару в магазині. Далі ви зможете перевірити й окремо підтвердити його оновлення.',
  stable_recount_exposure: 'Підтвердження узгодить цю версію після переобліку й дозволить її подальшу автоматичну синхронізацію.',
  release_exclusion: 'Підтвердження зніме окреме виключення цього товару. Далі перевірте його готовність до синхронізації.' };
decisionEffects.historical_recount_exposure = 'Amber узгодить історію для поточної версії й поставить її оновлення в чергу. Оновлюватиметься наявний товар Magento з цим артикулом. Старі версії та записи переобліку залишаться збереженими.';

function ProductResync({ productId, categoryCode, onSaved }) {
  const [data, setData] = useState(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const alive = useRef(true); const flight = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function open() {
    if (flight.current) return;
    flight.current = true; setBusy(true); setError('');
    try {
      const result = await api.get(`/admin/magento-integration/categories/${encodeURIComponent(categoryCode)}`);
      if (alive.current) setData(result.data);
    } catch (cause) { if (alive.current) setError(errorText(cause)); }
    finally { flight.current = false; if (alive.current) setBusy(false); }
  }
  return <section className="space-y-3" aria-label="Оновлення цього товару в Magento">
    <p>Далі перевірте зміни для цього товару й підтвердьте їх надсилання.</p>
    {!data && <Button busy={busy} onClick={open}>Переглянути оновлення товару</Button>}
    {error && <Notice tone="error">{error}</Notice>}
    {data && <MagentoControlledActions revision={data.revision} currentPublishedId={data.currentPublishedId} categoryCode={categoryCode}
      singleProductId={productId} kind="broader_resync" onApplied={() => onSaved?.()} />}
  </section>;
}

const kinds = {
  prior_exposure: 'Підтвердити раніше доставлений товар',
  stable_recount_exposure: 'Узгодити доставку після переобліку зі сталим артикулом',
  historical_recount_exposure: 'Дозволити оновлення поточного товару',
  replacement: 'Підтвердити заміну попередніх версій',
  unexposed_first_delivery: 'Дозволити першу доставку недоставленої версії',
  generated_first_delivery: 'Узгодити першу доставку з історичними файлами',
  release_exclusion: 'Зняти окреме виключення з доставки',
};
const domains = { coreProduct: 'Основні дані товару', productCreate: 'Створення товару', categories: 'Категорії',
  categoryLinks: 'Категорії', categoryLinkDelete: 'Прибрати з попередньої категорії', categoryLinkSave: 'Додати до категорії',
  inventory: 'Залишки', websites: 'Вебсайти', storeViews: 'Мовні версії', sharedName: 'Спільна назва', customAttributes: 'Характеристики', price: 'Ціна' };
const states = { not_sent: 'Ще не надіслано', dispatched: 'Надіслано, потрібне підтвердження', verified: 'Результат підтверджено' };
const blockerText = {
  HISTORICAL_ARTICLE_STILL_PRESENT: 'У Magento також є один із попередніх артикулів. Спочатку потрібно визначити, що робити зі старим товаром; автоматично його не видаляємо.',
  LIFECYCLE_EVIDENCE_UNAVAILABLE: 'Збережені файли або записи переобліку містять неповні дані. Їх потрібно перевірити за звітом історії.',
  CUTOVER_BASELINE_UNVERIFIED: 'Не знайдено повного підтвердження переходу старої версії на нову синхронізацію. Збережіть звіт історії для перевірки цих записів.',
  MAGENTO_HISTORY_TOO_LARGE: 'Історія завелика для перевірки на цьому екрані. Збережіть звіт для окремого розбору.',
  MAGENTO_SYNC_PREVIOUS_DISPATCH_UNRESOLVED: 'Надіслана зміна не збігається з очікуваним результатом. Її повторне надсилання заборонене.',
  MAGENTO_SYNC_AMBER_CHANGED: 'Товар в Amber змінився після підготовки початкової операції.',
  MAGENTO_SYNC_BINDING_CHANGED: 'Налаштування інтеграції змінилися після підготовки операції.',
  MAGENTO_SYNC_READ_FAILED: 'Не вдалося достовірно прочитати стан Magento. Повторіть перевірку після відновлення доступу.',
  MAGENTO_SYNC_VERIFIED_RESULT_CHANGED: 'Результат раніше підтвердженого кроку змінився в Magento. Початкову операцію не можна безпечно продовжити.',
  LIFECYCLE_NOT_HELD_TERMINAL: 'Поточний стан або історія товару не дозволяють виконати це рішення.',
  LIFECYCLE_SUCCESSOR_REQUIRED: 'Це рішення призначене для товару, створеного через переоблік.',
  LIFECYCLE_UNEXPOSED_EVIDENCE_REQUIRED: 'Немає підтвердження, що попередню версію ще не доставляли.',
  LIFECYCLE_RETAINED_FILE_EVIDENCE_REQUIRED: 'Потрібні точні підтвердження збережених історичних файлів.',
  LIFECYCLE_EXCLUSION_NOT_PRESENT: 'Окремого виключення з доставки немає.',
  LIFECYCLE_LEGACY_DELIVERY_RETIRED: 'Цей сценарій належить до історичної доставки файлами та недоступний після переходу на Magento.',
  PRODUCT_NOT_CURRENT: 'Ця версія товару вже не є поточною. Відкрийте актуальну версію товару.',
  CORRECTION_LINEAGE: 'Товар має історію переобліку. Потрібна перевірка доставки його поточної версії.',
  ACTIVE_CORRECTION_REQUEST: 'Є незавершений історичний запит. Спочатку завершіть або відхиліть його в історичних запитах.',
  ACTIVE_CORRECTION_OR_DELETION: 'Є незавершений історичний запит або видалення товару. Спочатку перевірте початкову операцію.',
  HOLD_NOT_HISTORICALLY_AMBIGUOUS: 'Поточна причина утримання не потребує такого підтвердження історії.',
  EXCLUSION_OR_UNKNOWN_POLICY: 'Товар виключений із доставки або причина виключення не підтверджена. Потрібне окреме рішення щодо виключення.',
  RECOUNT_COMPATIBILITY_EXCLUSION: 'Залишилося історичне виключення після переобліку. Його потрібно узгодити до доставки.',
  SKU_RESERVATION_CONFLICT: 'Історія резервування ідентичності суперечить поточному товару. Автоматичне виправлення заблоковане.',
  CORRECTION_LINEAGE_CONFLICT: 'Історія зв’язків між попередніми версіями суперечлива. Потрібно перевірити історію товару.',
  PUBLIC_IDENTITY_CHANGED: 'Попередня та поточна версії мають різні публічні ідентичності. Цей спосіб узгодження не підходить.',
  MAGENTO_PRODUCT_NOT_FOUND: 'За цим артикулом товар не знайдено в Magento. Підтвердити попередню доставку неможливо.',
  MAGENTO_LOOKUP_ERROR: 'Magento не вдалося прочитати. Відновіть доступ і повторіть перевірку.',
  UNFINISHED_SYNC_WORK: 'Спочатку перевірте результат незавершеної операції доставки вище.',
  DURABLE_REMOTE_ID_REQUIRED: 'Немає збереженого підтвердження ідентичності товару Magento.',
  CURRENT_PUBLIC_BINDING_REQUIRED: 'Потрібні чинні опубліковані налаштування інтеграції.',
  PREDECESSOR_NOT_RETIRED: 'Попередня версія ще не виведена з обігу. Перевірте історію товару.',
  STABLE_RECOUNT_NOT_TERMINAL: 'Потрібна актуальна завершальна версія товару після переобліку.',
  UPDATE_NOT_SENDABLE: 'Поточні дані або відповідності ще не дозволяють оновити товар. Виправте інші показані проблеми товару.',
  LOCAL_EVIDENCE_CHANGED: 'Дані Amber змінилися під час перевірки. Прочитайте актуальний стан і повторіть перевірку.',
  CUTOVER_PREPARING: 'Триває контрольований перехід способу доставки. Рішення тимчасово недоступне.',
  STABLE_PUBLIC_SKU_NOT_ACTIVE: 'Сталі публічні артикули ще не активовані для цього встановлення.',
  MAGENTO_DELIVERY_CUTOVER_REQUIRED: 'Це рішення доступне після завершення переходу на пряму доставку Magento.',
  MAGENTO_SYNC_PUBLISHED_CURRENT_BINDING_REQUIRED: 'Поточні опубліковані налаштування інтеграції змінилися або недоступні. Перевірте їх перед новим переглядом операції.',
  MAGENTO_SYNC_BUSY: 'Інша операція вже працює з цим товаром. Дочекайтеся її завершення та повторіть перевірку.',
  MAGENTO_RECOVERY_REVIEW_STALE: 'Початкова операція або дані Magento змінилися. Повторіть перевірку перед застосуванням.',
  MAGENTO_LIFECYCLE_REVIEW_STALE: 'Історія доставки змінилася. Прочитайте актуальні підтвердження й перевірте рішення заново.',
  EXPOSURE_RECONCILIATION_CONFLICT: 'Підтвердження історії вже не відповідають поточному товару. Потрібна нова перевірка.',
  INSUFFICIENT_PERMISSION: 'Ваші дозволи змінилися. Цю дію має виконати оператор із потрібним доступом.',
};
const errorText = (failure) => {
  const details = failure?.response?.data;
  return blockerText[details?.code] || (typeof details?.error === 'string' && /[А-Яа-яІіЇїЄєҐґ]/u.test(details.error)
    ? details.error : 'Не вдалося отримати підтверджений результат. Прочитайте стан початкової операції.');
};
const displayValue = (value) => value === null || value === undefined || value === '' ? 'Не задано' : String(value);
function RemainingChanges({ changes }) {
  return <dl className="sync-recovery-changes">{changes.map((change, index) => <div key={`${change.ordinal}-${index}`}>
    <dt>{change.label}</dt><dd><span>Зараз: {displayValue(change.before)}</span><strong>Після дії: {displayValue(change.after)}</strong></dd>
  </div>)}</dl>;
}

function EvidenceForm({ requirements, evidence, setEvidence, disabled }) {
  const update = (kind, index, disposition) => setEvidence((previous) => ({ ...previous,
    [kind]: previous[kind].map((item, itemIndex) => itemIndex === index
      ? { ...item, disposition, evidence: selectedEvidence(disposition) } : item) }));
  const confirm = (kind, disposition, checked) => setEvidence(previous => ({ ...previous,
    [kind]: { disposition: checked ? disposition : '', evidence: checked ? selectedEvidence(disposition) : '' } }));
  return <div className="sync-human-evidence">
    <h4>Що потрібно підтвердити вам</h4>
    <p className="sync-problem-guidance">Ці обставини система не може встановити самостійно. Виберіть лише відомий вам результат.</p>
    {requirements.historicalConfirmation && <label className="sync-recovery-attestation"><input type="checkbox" disabled={disabled}
      checked={evidence.confirmation?.disposition === 'current_update_only'} onChange={event => setEvidence(previous => ({ ...previous,
        confirmation: { disposition: event.target.checked ? 'current_update_only' : '', evidence: '' } }))} />
      <span>Старі версії більше не використовуються; для поточного товару немає окремої заборони синхронізації чи незавершеного імпорту старих файлів.</span></label>}
    {requirements.oldSkus.map((sku, index) => <fieldset key={sku}><legend>Попередній артикул: {sku}</legend>
      <label>Що ви підтверджуєте<select className="input" disabled={disabled} value={evidence.oldSkus[index]?.disposition || ''}
        onChange={event => update('oldSkus', index, event.target.value)}>
        <option value="">Оберіть відомий вам результат</option><option value="verified_absent">Відсутність у Magento перевірена</option>
        <option value="retired_reconciled">Попередню версію виведено з обігу та узгоджено</option></select></label>
    </fieldset>)}
    {requirements.files.map((file, index) => <fieldset key={file}><legend>Старий файл {index + 1}</legend>
      <label>Чи може цей файл ще потрапити в імпорт?<select className="input" disabled={disabled} value={evidence.files[index]?.disposition || ''}
        onChange={event => update('files', index, event.target.value)}>
        <option value="">Оберіть відомий вам результат</option><option value="quarantined_do_not_import">Ні — вилучено з подальшого імпорту</option>
        <option value="consumed_and_reconciled">Уже імпортовано, результат узгоджено</option></select></label>
      <p className="sync-problem-guidance">Ідентифікатор файлу: <span className="font-mono break-all">{file}</span>. Якщо його доля невідома, залиште питання без відповіді.</p>
    </fieldset>)}
    {requirements.externalHistory && <label className="sync-recovery-attestation"><input type="checkbox" disabled={disabled}
      checked={Boolean(evidence.externalHistory?.evidence)} onChange={event => confirm('externalHistory', 'resolved', event.target.checked)} />
      <span>Зовнішню історію цього товару узгоджено.</span></label>}
    {requirements.exclusionResolution && <label>Підстава для зняття виключення із синхронізації<textarea className="input" disabled={disabled}
      value={evidence.exclusionResolution?.evidence || ''} maxLength={2000}
      onChange={event => setEvidence(previous => ({ ...previous, exclusionResolution: { ...previous.exclusionResolution, evidence: event.target.value } }))} /></label>}
    {requirements.redeliveryEvidence && <label className="sync-recovery-attestation"><input type="checkbox" disabled={disabled}
      checked={Boolean(evidence.redeliveryAuthorization?.evidence)} onChange={event => confirm('redeliveryAuthorization', 'authorized', event.target.checked)} />
      <span>Я маю підтверджений дозвіл на повторну доставку цього товару.</span></label>}
  </div>;
}
function initialEvidence(requirements) {
  return { oldSkus: requirements.oldSkus.map((sku) => ({ sku, disposition: '', evidence: '' })),
    ...(requirements.historicalConfirmation ? { confirmation: { disposition: '', evidence: '' } } : {}),
    files: requirements.files.map((snapshotId) => ({ snapshotId, disposition: '', evidence: '' })),
    ...(requirements.externalHistory ? { externalHistory: { disposition: 'resolved', evidence: '' } } : {}),
    ...(requirements.exclusionResolution ? { exclusionResolution: { disposition: requirements.exclusionDisposition, evidence: '' } } : {}),
    ...(requirements.redeliveryEvidence ? { redeliveryAuthorization: { disposition: 'authorized', evidence: '' } } : {}),
  };
}

export function MagentoRecovery({ productId, categoryCode, onSaved, guided = false, onTechnicalEvidence }) {
  const auth = useAuth();
  const { permissions, principalLifetime } = auth;
  const canRead = (permissions.includes('export_templates.publish') || permissions.includes('exports.reconcile')) && principalLifetime?.valid !== false;
  const [record, setRecord] = useState(null);
  const [review, setReview] = useState(null);
  const [lifecycle, setLifecycle] = useState(null);
  const [historyInspection, setHistoryInspection] = useState(null);
  const [kind, setKind] = useState('prior_exposure');
  const [evidence, setEvidence] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const [nextStep, setNextStep] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  const [confirmation, setConfirmation] = useState(null);
  const [pendingLifecycle, setPendingLifecycle] = useState(null);
  const alive = useRef(false);
  const principalRef = useRef(principalLifetime);
  useEffect(() => { principalRef.current = principalLifetime; }, [principalLifetime]);
  const locked = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const valid = () => alive.current && principalRef.current === principalLifetime && principalLifetime?.valid !== false;
  const run = async (operation) => {
    if (locked.current || !canRead) return;
    locked.current = true; setBusy(true); setError('');
    try { await operation(); }
    catch (failure) { if (valid()) { setError(errorText(failure)); setReview(null);
      if (failure.response?.status === 409 || failure.response?.status === 422) { setLifecycle(null); setPendingLifecycle(null); } } }
    finally { locked.current = false; if (valid()) { setBusy(false); setConfirmation(null); } }
  };
  const open = () => run(async () => {
    const { data } = await api.get(`/admin/magento-recovery/products/${productId}`);
    if (valid()) { setRecord({ ...data, owner: principalLifetime }); setKind(data.lifecycle?.suggestedKind || 'prior_exposure');
      setNextStep(data.nextAction || null); setReview(null); setLifecycle(null); setHistoryInspection(null); setReceipt(''); setPendingLifecycle(null); }
    if (!valid() || !guided) return;
    // One explicit check reads the original case and its recommended preview.
    // Recording the result or sending remaining steps still requires confirmation.
    if (data.actions.jobRecovery && permissions.includes('export_templates.publish') && data.job && !['succeeded', 'superseded'].includes(data.job.state)) {
      const inspected = await api.post(`/admin/magento-recovery/jobs/${data.job.id}/inspect`, {});
      if (valid()) { setReview(inspected.data); setRecord((previous) => ({ ...previous, job: inspected.data.job })); }
    } else if (data.actions.lifecycleRecovery && permissions.includes('exports.reconcile') && !data.lifecycle?.blocker
      && data.history?.hasRecount && !data.history.stableRecount && !data.history.historicalRecount && !data.lifecycle?.legacyDeliveryEnabled && data.history.complete) {
      const inspected = await api.post(`/admin/magento-recovery/products/${productId}/history-inspect`, {});
      if (valid()) { setHistoryInspection(inspected.data); if (!inspected.data.stale) setRecord(previous => ({ ...previous, history: inspected.data.history })); }
    } else if (data.actions.lifecycleRecovery && permissions.includes('exports.reconcile') && !data.lifecycle?.blocker
      && data.lifecycle?.suggestedKind && !data.nextAction) {
      const preview = await api.post(`/admin/magento-recovery/products/${productId}/lifecycle-preview`, { kind: data.lifecycle.suggestedKind });
      if (valid()) { setLifecycle(preview.data); setEvidence(preview.data.requiredEvidence ? initialEvidence(preview.data.requiredEvidence) : null); }
    }
  });
  const inspect = () => run(async () => {
    setReview(null); setReceipt('');
    const { data } = await api.post(`/admin/magento-recovery/jobs/${record.job.id}/inspect`, {});
    if (valid()) { setReview(data); setRecord((previous) => ({ ...previous, job: data.job })); }
  });
  const applyJob = (action) => run(async () => {
    const { data } = await api.post(`/admin/magento-recovery/jobs/${record.job.id}/${action}`, {
      review: review.review, reviewHash: review.reviewHash, reason: decisionReason(action, reason),
    });
    if (valid()) { setRecord((previous) => ({ ...previous, job: data.job })); setReview(null);
      setReceipt(action === 'reconcile' ? 'Перевірений результат записано в Amber. Змін до Magento не надсилали.' : 'Початкову операцію опрацьовано. Перевірте актуальний стан доставки.'); onSaved?.(); }
    if (guided && valid()) {
      try {
        const fresh = await api.get(`/admin/magento-recovery/products/${productId}`);
        if (valid()) { setRecord({ ...fresh.data, owner: principalLifetime }); setNextStep(fresh.data.nextAction || null); setKind(fresh.data.lifecycle?.suggestedKind || 'prior_exposure'); setLifecycle(null); setReceipt('Перевірений результат операції збережено. Нижче показано наступний доступний крок.'); }
      } catch { if (valid()) setError('Результат збережено, але наступний крок не вдалося прочитати. Оновіть перевірку товару.'); }
    }
  });
  const inspectHistory = () => run(async () => {
    const { data } = await api.post(`/admin/magento-recovery/products/${productId}/history-inspect`, {});
    if (valid()) { setHistoryInspection(data); if (!data.stale) setRecord(previous => ({ ...previous, history: data.history })); }
  });
  const previewLifecycle = (selectedKind = kind) => run(async () => {
    setKind(selectedKind); setLifecycle(null); setReceipt('');
    const { data } = await api.post(`/admin/magento-recovery/products/${productId}/lifecycle-preview`, { kind: selectedKind });
    if (valid()) { setLifecycle(data); setEvidence(data.requiredEvidence ? initialEvidence(data.requiredEvidence) : null); }
  });
  const applyLifecycle = () => run(async () => {
    const reviewedEvidence = lifecycle?.requiredEvidence?.historicalConfirmation
      ? { files: evidence.files, confirmation: { ...evidence.confirmation, evidence: decisionReason(lifecycle.review.kind, reason) } } : evidence;
    const input = pendingLifecycle || { review: lifecycle.review, reviewHash: lifecycle.reviewHash, reason: decisionReason(lifecycle.review.kind, reason), ...(reviewedEvidence ? { evidence: reviewedEvidence } : {}) };
    setPendingLifecycle(input);
    const { data } = await api.post(`/admin/magento-recovery/products/${productId}/lifecycle-apply`, input);
    if (valid()) { setPendingLifecycle(null); setLifecycle(null); setNextStep(data.nextAction || null); setReceipt('Рішення щодо історії доставки збережено в Amber. Синхронізацію підтверджує окремий стан Magento.'); onSaved?.(); }
  });
  useEffect(() => {
    onTechnicalEvidence?.(canRead && record && record.owner === principalLifetime ? {
      job: record.job, history: record.history, lifecycle: record.lifecycle,
      jobReview: review, lifecycleReview: lifecycle, historyInspection,
    } : null);
  }, [canRead, historyInspection, lifecycle, onTechnicalEvidence, principalLifetime, record, review]);
  if (!canRead) return <Notice>Перевірку початкової операції виконує відповідальний оператор із дозволом на відновлення доставки.</Notice>;
  const opened = record && record.owner === principalLifetime;
  const unfinishedJob = Boolean(record?.lifecycle?.blocker || (record?.job && !['succeeded', 'superseded'].includes(record.job.state)));
  const availableKinds = record?.lifecycle?.availableKinds || [record?.lifecycle?.suggestedKind || 'prior_exposure'];
  const canRecoverJob = record?.actions.jobRecovery && permissions.includes('export_templates.publish');
  const canRecoverLifecycle = record?.actions.lifecycleRecovery && permissions.includes('exports.reconcile');
  const historyMode = record?.history?.hasRecount && !record.history.stableRecount && !record.history.historicalRecount && !record.lifecycle?.legacyDeliveryEnabled && !unfinishedJob && !nextStep;
  const evidenceComplete = !evidence || (lifecycle?.requiredEvidence?.historicalConfirmation
    ? evidence.confirmation?.disposition === 'current_update_only' && evidence.files.every(item => item.disposition && item.evidence.trim().length >= 3)
    : [...evidence.oldSkus, ...evidence.files, ...['externalHistory', 'exclusionResolution', 'redeliveryAuthorization'].map((key) => evidence[key]).filter(Boolean)]
    .every((item) => item.disposition && item.evidence.trim().length >= 3));
  const blockers = [...(review?.blockers || []).map((item) => item.code), ...(lifecycle?.blockers || [])];
  const missingEvidence = missingRecoveryEvidence(lifecycle?.requiredEvidence, evidence);
  const verifiedFacts = verifiedRecoveryFacts(lifecycle);
  const lifecycleReason = decisionReason(lifecycle?.review?.kind || kind, reason);
  const reasonRequired = lifecycle && !decisionReason(lifecycle.review.kind);
  const disabledReason = pendingLifecycle ? 'Потрібно отримати результат початкового рішення.' : busy ? 'Триває перевірка.'
    : missingEvidence[0] || (reasonRequired && lifecycleReason.length < 3 ? 'Вкажіть підставу для цього рішення.' : '');
  return <section className="sync-recovery" aria-label="Контрольоване відновлення доставки">
    {!guided && <h3>Перевірка й відновлення доставки</h3>}
    {!opened && <>{!guided && <p className="sync-problem-guidance">Перегляньте початкову операцію та доступні кроки. Читання збереженої операції не надсилає змін у Magento.</p>}
      <Button variant={guided ? 'primary' : 'secondary'} size="compactMd" onClick={open} busy={busy}>{guided ? 'Перевірити товар у Magento' : 'Відкрити перевірку доставки'}</Button>
      {guided && <p className="sync-problem-guidance">Покажемо, що зупинило товар і який наступний крок доступний.</p>}</>}
    {error && (!record || opened) && <Notice tone="error">{error}</Notice>}
    {guided && opened && error && !pendingLifecycle && <Button busy={busy} onClick={open}>Оновити перевірку товару</Button>}
    {receipt && opened && <Notice tone="success">{receipt}</Notice>}
    {opened && nextStep?.kind === 'await_delivery' && <Notice tone="info">Оновлення цього товару поставлено в чергу. Натисніть «Оновити» на сторінці, щоб побачити результат синхронізації.</Notice>}
    {opened && nextStep?.kind === 'review_history' && <Notice tone="info"><p>Виключення поточного товару знято. Тепер потрібно повторно перевірити його історію переобліку.</p>
      <Button size="compactMd" busy={busy} onClick={open}>Перевірити наступний крок</Button></Notice>}
    {opened && nextStep?.kind === 'reviewed_resync' && <Notice tone="info"><p>Історію перевірено. Далі потрібен окремий перегляд відправлення цього товару.</p>
      {isActualAdministrator(auth) && ['export_templates.manage', 'export_templates.publish', 'exports.view'].every((permission) => permissions.includes(permission))
        ? categoryCode ? <ProductResync productId={productId} categoryCode={categoryCode} onSaved={onSaved} /> : <Link className="underline" to={`/admin/magento/administrator?productId=${productId}&action=broader_resync&returnTo=${encodeURIComponent(`/attention?problem=${productId}`)}`}>Перевірити відправлення виправленого товару</Link>
        : <p>Цей крок виконує Адміністратор із дозволами на публікацію інтеграції та перегляд доставки.</p>}</Notice>}
    {opened && nextStep?.kind === 'configuration_required' && <Notice tone="warning">Перед відправленням потрібно завершити налаштування інтеграції.{permissions.includes('export_templates.view') && <> <Link className="underline" to="/admin/magento">Відкрити інтеграцію Magento</Link></>}</Notice>}
    {opened && record && <>
      {canRecoverJob && record.job && (!guided || unfinishedJob) && <>
        <p className="sync-problem-guidance">Спочатку прочитайте фактичний результат у Magento. Уже надіслані кроки не повторюються.</p>
        <ol className="sync-recovery-steps">{(review?.steps || record.job.steps).map((step) => <li key={step.ordinal}><span>{step.ordinal + 1}. {domains[step.domain] || 'Зміна даних товару'}</span><span>{states[step.state] || 'Стан невідомий'}{typeof step.matches === 'boolean' ? step.matches ? ' · збігається' : ' · не підтверджено' : ''}</span></li>)}</ol>
        <Button size="compactMd" onClick={inspect} busy={busy}>Перевірити результат у Magento</Button>
        {review && <p className="sync-problem-guidance">Перевірено: {new Date(review.observedAt).toLocaleString('uk-UA')}. Перевірка не надсилала змін.</p>}
        {review?.unsentChanges?.length > 0 && <section><h4 className="sync-next-heading">Що ще зміниться в Magento</h4><RemainingChanges changes={review.unsentChanges} /></section>}
        {review?.canContinue && !review.unsentChanges?.length && <Notice tone="warning">Деталі ненадісланих змін недоступні. Повторіть перевірку перед продовженням.</Notice>}
      </>}
      {canRecoverJob && !record.job && (!guided || !canRecoverLifecycle) && <Notice>Немає збереженого завдання доставки для цього товару.</Notice>}
      {record.history && !unfinishedJob && (historyMode || lifecycle?.blockers?.some(code => ['PUBLIC_IDENTITY_CHANGED', 'CORRECTION_LINEAGE_CONFLICT', 'EXCLUSION_OR_UNKNOWN_POLICY', 'RECOUNT_COMPATIBILITY_EXCLUSION'].includes(code))) && <MagentoRecoveryHistory
        history={historyInspection?.history || record.history} inspection={historyInspection} busy={busy} onInspect={canRecoverLifecycle && !pendingLifecycle ? inspectHistory : null}
        canViewHistory={permissions.includes('history.view')} onReleaseExclusion={canRecoverLifecycle && availableKinds.includes('release_exclusion') && !lifecycle && !pendingLifecycle ? () => previewLifecycle('release_exclusion') : null} />}
      {canRecoverLifecycle && record.lifecycle && !unfinishedJob && availableKinds.length > 0 && (!historyMode || lifecycle) && (!receipt || guided && !nextStep) && <>
        {!guided && <p className="font-semibold">{kinds[kind]}</p>}
        {verifiedFacts.length > 0 && <section aria-label="Що перевірила система"><h4>Що перевірила система</h4><dl className="sync-verified-facts">{verifiedFacts.map(fact => <div key={fact.key}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl></section>}
        {(!guided || !lifecycle) && <p className="sync-problem-guidance">{guidance[kind] || 'Перевіримо попередні версії та збережені файли цього товару. Виберіть підтверджений результат для кожного запису нижче.'}</p>}
        {availableKinds.length > 1 && <Button size="compactMd" disabled={busy || Boolean(pendingLifecycle)} onClick={() => setAdvanced((value) => !value)}>Інші рішення щодо історії</Button>}
        {advanced && <label>Рішення щодо історії доставки<select className="input" disabled={busy || Boolean(pendingLifecycle)} value={kind} onChange={(event) => { setKind(event.target.value); setLifecycle(null); setEvidence(null); }}>
          {availableKinds.map((value) => <option key={value} value={value}>{kinds[value]}</option>)}</select></label>}
        {!guided && <p className="sync-problem-guidance">Попередня перевірка може прочитати Magento. Вона не змінює товари й не знімає утримання.</p>}
        {(!guided || !lifecycle) && <Button size="compactMd" disabled={Boolean(pendingLifecycle)} busy={busy} onClick={() => previewLifecycle()}>{guided ? 'Повторити перевірку товару' : 'Перевірити можливість рішення'}</Button>}
        {lifecycle?.eligible && <Notice tone="info">{guided ? decisionEffects[lifecycle.review.kind] || 'Перевірка пройшла. Запишіть, що перевірили, і підтвердьте рішення нижче.' : `Перевірка дозволяє розглянути рішення «${kinds[lifecycle.review.kind]}». Підтвердження збереже це рішення щодо доставки; воно може дозволити подальшу автоматичну синхронізацію.`}</Notice>}

        {kind === 'historical_recount_exposure' && lifecycle?.review.payload.sync && <div className="space-y-2">

          {lifecycle.review.payload.sync.oldArticles?.filter(item => item.status !== 'not_found').map(item => <p key={item.sku}><strong>{item.sku}</strong>: {item.status === 'found' ? `також є в Magento · №${item.id}` : 'не вдалося перевірити; повторіть перевірку після відновлення доступу'}.</p>)}
        </div>}
        {lifecycle?.eligible && lifecycle.requiredEvidence && evidence && <EvidenceForm requirements={lifecycle.requiredEvidence} evidence={evidence} setEvidence={setEvidence} disabled={busy || Boolean(pendingLifecycle)} />}
      </>}
      {canRecoverLifecycle && record.lifecycle && unfinishedJob && <p className="sync-problem-guidance">Спочатку завершіть перевірку початкової операції{canRecoverJob ? ' вище' : ' з оператором, який має дозвіл на відновлення завдань'}. Рішення щодо історії не замінює підтвердження надісланих змін.</p>}
      {canRecoverLifecycle && record.lifecycle && !unfinishedJob && availableKinds.length === 0 && !nextStep && !historyMode && <Notice>Для поточного стану немає окремого дозволеного рішення щодо історії доставки. Перевірте актуальну причину в товарі.</Notice>}
      {blockers.length > 0 && <Notice tone="warning"><p>Застосування заблоковане:</p><ul className="list-disc pl-5">{blockers.map((code, index) => <li key={index}>{blockerText[code] || 'Наявних підтверджень недостатньо для цього рішення. Передайте опис проблеми відповідальному за інтеграцію; дію не застосовано.'}</li>)}</ul></Notice>}
      {lifecycle?.blockers?.includes('UPDATE_NOT_SENDABLE') && <section className="space-y-3" aria-label="Що виправити перед підтвердженням">
        <h4 className="sync-next-heading">Спочатку виправте налаштування для цього товару</h4>
        {lifecycle.review.payload.sync?.problems?.map((problem,index) => <div key={index}>
          <p>{problem.message || 'Перевірте відповідність цього поля.'}</p>
          {permissions.includes('export_templates.view') && <Link className="btn btn-outline btn-compact-md"
            to={problemRepairUrl(problem,{ productId,category: categoryCode },`/attention?problem=${productId}`)}>{nextAction(problem)}</Link>}
        </div>)}
        <p>Після виправлення поверніться сюди й повторіть перевірку товару.</p>
        <Button busy={busy} disabled={Boolean(pendingLifecycle)} onClick={() => previewLifecycle()}>Повторити перевірку після виправлення</Button>
      </section>}
      {(review?.canReconcile || review?.canContinue || lifecycle?.eligible || pendingLifecycle) && <label>{reasonRequired ? 'Підстава рішення' : 'Коментар (необов’язково)'}<textarea className="input" value={reason} maxLength={1600} disabled={busy || Boolean(pendingLifecycle)} onChange={(event) => setReason(event.target.value)} placeholder={reasonRequired ? 'Поясніть підставу саме цього рішення' : 'Додатковий контекст для історії товару'} /></label>}
      <div className="sync-recovery-action-bar"><div className="sync-recovery-actions">
        {canRecoverJob && review?.canReconcile && <Button size="compactMd" busy={busy} onClick={() => setConfirmation('reconcile')}>Підтвердити перевірений результат</Button>}
        {canRecoverJob && review?.canContinue && review.unsentChanges?.length > 0 && <Button size="compactMd" busy={busy} onClick={() => setConfirmation('continue')}>Переглянути продовження операції</Button>}
        {canRecoverLifecycle && lifecycle?.eligible && !pendingLifecycle && <Button variant={kind === 'historical_recount_exposure' ? 'primary' : 'secondary'} size="compactMd" busy={busy} aria-describedby={disabledReason ? `recovery-disabled-${productId}` : undefined} disabled={lifecycleReason.length < 3 || !evidenceComplete} onClick={() => setConfirmation('lifecycle')}>{guided ? decisionActions[lifecycle.review.kind] || 'Переглянути підтвердження' : 'Переглянути рішення щодо доставки'}</Button>}
        {canRecoverLifecycle && pendingLifecycle && <Button size="compactMd" busy={busy} onClick={applyLifecycle}>Отримати результат початкового рішення</Button>}
      </div>{disabledReason && lifecycle?.eligible && !pendingLifecycle && <p id={`recovery-disabled-${productId}`} className="sync-action-disabled" role="status">{disabledReason}</p>}</div>
      {!onTechnicalEvidence && <TechnicalDisclosure summary="Дані перевірки доставки для підтримки"><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify({ jobId: record.job?.id, lifecycle: record.lifecycle, review: review?.review || lifecycle?.review, blockers }, null, 2)}</pre></TechnicalDisclosure>}
    </>}
    <ConfirmDialog open={Boolean(opened && confirmation && (confirmation === 'lifecycle' ? canRecoverLifecycle : canRecoverJob))} title={confirmation === 'continue' ? 'Продовжити початкову операцію Magento?' : confirmation === 'lifecycle' ? guided ? `${decisionActions[lifecycle?.review.kind] || 'Зберегти підтвердження'}?` : 'Зберегти рішення щодо доставки?' : 'Підтвердити перевірений результат?'}
      confirmLabel={confirmation === 'continue' ? 'Надіслати лише ненадіслані кроки' : 'Зберегти підтверджене рішення'} busy={busy}
      onClose={() => setConfirmation(null)} onConfirm={() => confirmation === 'lifecycle' ? applyLifecycle() : applyJob(confirmation)}>
      <p>{confirmation === 'continue' ? 'Ця дія записує зміни в Magento. Сервер повторно перевірить початковий план і виконає лише його ненадіслані кроки. Якщо фактичні дані змінилися, дію буде зупинено.'
        : confirmation === 'lifecycle' ? guided && decisionEffects[lifecycle?.review.kind] ? `${decisionEffects[lifecycle.review.kind]} Сервер повторно перевірить товар і ваші повноваження.` : `Рішення: ${kinds[lifecycle?.review.kind] || ''}. Сервер повторно перевірить історію та повноваження. Збережене рішення може дозволити подальшу автоматичну доставку.`
          : 'Amber запише результати вже виконаних кроків після повторної перевірки. Ця дія не надсилає змін до Magento.'}</p>
      <p className="mt-3">{decisionReason(confirmation === 'lifecycle' ? lifecycle?.review.kind : confirmation, reason)}</p>
      {confirmation === 'continue' && review?.unsentChanges?.length > 0 && <RemainingChanges changes={review.unsentChanges} />}
    </ConfirmDialog>
  </section>;
}
