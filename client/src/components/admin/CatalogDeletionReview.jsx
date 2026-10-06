import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

const ACKNOWLEDGEMENTS = [
  ['ackBothCatalogs','Видалити саме вибрану характеристику або один варіант з активних каталогів Manager і Magento.'],
  ['ackHistoryPreserved','Історичні конфігурації товарів, внутрішні SKU, постійні артикули та опубліковані знімки залишаються.'],
  ['ackExternalDependenciesReviewed','Я перевірив зовнішні шаблони, правила, категорії та інші залежності Magento, яких REST не показує.'],
  ['ackMagentoMaintenanceWindow','На час дії зупинено паралельні зміни цього атрибута та його товарів у Magento.'],
  ['ackOrdinaryAttribute','Це звичайний власний атрибут; я окремо перевірив, що він не є swatch або спеціальним джерелом.'],
];
const BLOCKERS = {
  REMOTE_ONLY_OWNED_ATTRIBUTE_PROOF_REQUIRED:'Немає точного підтвердження, що цей звичайний атрибут створено через Manager.',
  REMOTE_ONLY_OWNED_OPTION_PROOF_REQUIRED:'Немає точного підтвердження створення цього варіанта через Manager.',
  REMOTE_ONLY_ARCHIVE_REQUIRED:'Спочатку архівуйте точну локальну характеристику або варіант.',
  REMOTE_ONLY_FOREIGN_OPTION:'Атрибут містить чужий або непідтверджений варіант. Видалення всього атрибута заблоковано.',
  LOCAL_PRODUCTS_DEPEND_ON_TARGET:'Збережений товар використовує точне значення характеристики.',
  LOCAL_PRICING_DEPENDS_ON_TARGET:'Правило ціни використовує цю характеристику.',
  LOCAL_PRODUCTS_DEPEND_ON_CATEGORY:'Категорія має товари, включно з історією. Для цього випадку використайте архівування.',
  LOCAL_PRICING_REVIEW_REQUIRED:'Потрібно розв’язати залежності ціноутворення.',
  LOCAL_RULES_DEPEND_ON_QUESTION:'Інші характеристики або варіанти мають умови з цим ключем.',
  ACTIVE_TEMPLATE_DEPENDENCY:'Є залежність у поточному шаблоні або чернетці.',
  BINDING_DEPENDENCY:'Поточна відповідність або чернетка Magento використовує атрибут. Спершу опублікуйте переглянутого наступника.',
  SHARED_REMOTE_RESOURCE:'Magento ресурс використовується іншою категорією або значенням.',
  MAGENTO_PRODUCTS_DEPEND_ON_TARGET:'Magento має товари зі значенням цього атрибута.',
  SHARED_ATTRIBUTE_SETS:'Атрибут доступний у кількох наборах Magento. Спільне видалення заблоковано.',
  LOCAL_SCOPE_LIMIT:'Обсяг залежностей перевищує межу повної перевірки.',
};
const REMOTE_ONLY_BLOCKERS = {
  REMOTE_ONLY_TEST_NAMESPACE_REQUIRED:'Цей шлях доступний лише для власної архівованої TEST характеристики.',
  ACTIVE_TEMPLATE_DEPENDENCY:'Поточний активний шаблон виводить цей атрибут до Magento.',
  BINDING_DEPENDENCY:'Чинна опублікована відповідність використовує цей атрибут. Потрібне окреме рішення щодо цієї залежності.',
};
function Failure({ error }) { return error ? <p role="alert" className="text-red-700">{error}</p> : null; }
function Counts({ review }) {
  return <ul>
    <li>Manager: {review.affected.products.length} товарів, {review.affected.options.length} варіантів, {review.affected.rules.length} умов, {review.affected.pricing.length} правил ціни.</li>
    <li>Шаблони: {review.affected.templates.length}; відповідності Magento: {review.affected.bindings.length}.</li>
    <li>Magento: {review.remote.products.length} товарів; набори: {review.remote.sets.map(set=>`${set.name} (#${set.id})`).join(', ') || 'немає'}.</li>
    <li>Історичні SKU схеми: {review.affected.historicalSchemas.map(schema=>`#${schema.id} v${schema.version}`).join(', ') || 'немає'} — будуть збережені.</li>
  </ul>;
}
// `target` is an explicit exact-ID selection made by the owning catalog workflow:
// {bindingRevisionId,expectedRevision,type,questionId,optionId,attributeCode,
// attributeId,remoteOptionId}. Question scope requires both option IDs = null.
export function CatalogDeletionReview(props) {
  return <DeletionReviewSession key={JSON.stringify([props.target || null,Boolean(props.remoteOnly)])} {...props}/>;
}
function DeletionReviewSession({ target, isAdministrator, remoteOnly = false, onClose, onCompleted, apiClient = api }) {
  const endpoint = '/admin/catalog-deletion' + (remoteOnly ? '/remote-only' : '');
  const acknowledgements = remoteOnly ? [['ackRemoteOnly','Видалити лише точну ціль у Magento. Локальний архів та його історію зберегти.'], ...ACKNOWLEDGEMENTS.slice(1)] : ACKNOWLEDGEMENTS;
  const completed = (value) => value.remoteAbsent && (remoteOnly ? value.localArchived && value.historicalEvidencePreserved && value.localDeleted === false : value.localDeleted);
  const [review,setReview] = useState(null); const [confirmation,setConfirmation] = useState('');
  const [reason,setReason] = useState(''); const [acks,setAcks] = useState({});
  const [busy,setBusy] = useState(false); const [error,setError] = useState(''); const [receipts,setReceipts] = useState([]);
  const [receipt,setReceipt] = useState(null);
  useEffect(()=>{
    let active=true;
    if(isAdministrator) apiClient.get(endpoint + '/actions').then(response=>{ if(active) setReceipts(response.data); })
      .catch(cause=>{ if(active) setError(cause.response?.data?.error || 'Не вдалося завантажити незавершені дії.'); });
    return ()=>{ active=false; };
  },[apiClient,isAdministrator,endpoint]);
  async function run(operation) {
    setBusy(true); setError('');
    try { await operation(); }
    catch(cause) { setError(cause.response?.data?.error || 'Дію не підтверджено. Оновіть список збережених дій.'); }
    finally { setBusy(false); }
  }
  const ready = review && review.blockers.length === 0 && confirmation === review.confirmationText
    && reason.trim().length >= 3 && acknowledgements.every(([key])=>acks[key] === true);
  if(!isAdministrator) return <section><h3>Видалення з обох каталогів</h3><p>Ця окрема дія потребує ролі Адміністратора. Архівування у Manager залишається доступним за поточними правами.</p></section>;
  return <section className="catalog-context-form" aria-label={remoteOnly ? 'Перевірене видалення лише з Magento зі збереженням архіву' : 'Перевірене видалення з Manager і Magento'}>
    <div className="catalog-context-form-header"><h3>{remoteOnly ? 'Видалити лише з Magento, зберегти архів Manager' : target?.type === 'option' ? 'Видалити один варіант з обох каталогів' : 'Видалити характеристику з обох каталогів'}</h3>
      {onClose && <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Закрити</button>}</div>
    <p>{remoteOnly ? 'Ця дія прибирає власний створений ресурс лише з Magento. Архівовані характеристики, варіанти, товари та незмінна історія залишаються в Manager. Чинні зовнішні залежності блокують видалення.' : 'Архівування у Manager зберігає призначення і не змінює Magento. Ця окрема дія прибирає точну вибрану ціль з обох активних каталогів.'}</p>
    {target && <p>Manager question #{target.questionId}{target.type === 'option' ? `, option #${target.optionId}` : ', усі варіанти'}; Magento {target.attributeCode} #{target.attributeId}{target.type === 'option' ? `, option #${target.remoteOptionId}` : ', весь атрибут'}.</p>}
    <Failure error={error}/>
    {!receipt && <button type="button" className="btn btn-outline" disabled={busy || !target} onClick={()=>run(async()=>{
      const response=await apiClient.post(endpoint + '/preview',target); setReview(response.data); setAcks({}); setConfirmation('');
    })}>Перевірити наслідки</button>}
    {review && !receipt && <div>
      <p>{review.localTarget.label} → {review.remote.attributeLabel}{review.remote.selectedRemoteLabel ? ` / ${review.remote.selectedRemoteLabel}` : ''}</p>
      <Counts review={review}/>
      {review.blockers.length > 0 && <ul role="alert">{review.blockers.map(code=><li key={code}>{(remoteOnly && REMOTE_ONLY_BLOCKERS[code]) || BLOCKERS[code] || code}</li>)}</ul>}
      <details><summary>Точні залежності та IDs</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(review.affected,null,2)}</pre></details>
      {review.futureSkuPublicationRequired && <p>Для майбутніх товарів після вилучення знадобиться окрема публікація нової SKU схеми. Історична схема збережеться.</p>}
      {review.blockers.length === 0 && <>
        <p>Зовнішні шаблони та спеціальні конфігурації Magento потребують окремої перевірки Адміністратором.</p>
        {acknowledgements.map(([key,label])=><label key={key} className="block"><input type="checkbox" checked={acks[key] || false} disabled={busy} onChange={event=>setAcks({...acks,[key]:event.target.checked})}/> {label}</label>)}
        <label className="block">Причина<input className="input-sm" value={reason} maxLength={1000} disabled={busy} onChange={event=>setReason(event.target.value)}/></label>
        <p>Введіть точне підтвердження: <code>{review.confirmationText}</code></p>
        <input className="input-sm" aria-label="Точне підтвердження видалення" value={confirmation} disabled={busy} onChange={event=>setConfirmation(event.target.value)}/>
        <button type="button" className="btn btn-danger" disabled={busy || !ready} onClick={()=>run(async()=>{
          const response=await apiClient.post(endpoint + '/apply',{...target,previewToken:review.previewToken,confirmationText:confirmation,reason,...acks});
          setReceipt(response.data); setReceipts(previous=>[response.data,...previous.filter(item=>item.id!==response.data.id)]);
          if(completed(response.data)) onCompleted?.(response.data);
        })}>{remoteOnly ? 'Підтвердити видалення лише з Magento' : 'Підтвердити видалення з Manager і Magento'}</button>
      </>}
    </div>}
    {receipt && <div role="status"><p>{receipt.message}</p><p>Дія: {receipt.id}. Стан: {receipt.state}.</p></div>}
    {receipts.length > 0 && <details open={!!receipt}><summary>Збережені дії та відновлення після перезавантаження</summary>
      {receipts.map(item=><div key={item.id}><p>{item.localTarget.label} — {item.message} ({item.id})</p>
        {item.canReconcile && <button type="button" className="btn btn-outline" disabled={busy} onClick={()=>run(async()=>{
          const response=await apiClient.post(endpoint + '/reconcile',{actionId:item.id}); setReceipt(response.data);
          setReceipts(previous=>previous.map(old=>old.id===item.id ? response.data : old));
          if(completed(response.data)) onCompleted?.(response.data);
        })}>Перевірити та завершити без повторного DELETE</button>}</div>)}
    </details>}
  </section>;
}
