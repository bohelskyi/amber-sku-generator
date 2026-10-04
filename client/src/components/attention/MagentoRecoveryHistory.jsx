import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Notice } from '../ui/index.js';
import { downloadBlob } from '../../lib/download.js';

const remoteText = result => !result ? 'Ще не перевірено' : result.status === 'found' ? `Є в Magento · ID ${result.id}`
  : result.status === 'not_found' ? 'Немає в Magento' : 'Не вдалося перевірити';
const policyText = product => product.businessExclusion === 'excluded' ? 'Виключено із синхронізації'
  : product.businessExclusion !== 'none' || product.independentExclusion || ['unknown', 'independent_exclusion'].includes(product.exclusionProvenance)
    ? 'Причину виключення потрібно підтвердити' : product.compatibilityExcluded ? 'Залишилося старе обмеження після переобліку'
      : product.status === 'active' && product.legacyExportExcluded ? 'Позначку виключення потрібно узгодити з поточними правилами синхронізації' : null;
function issueText(issue, history) {
  const product = history.products.find(p => p.productId === issue.productId);
  const article = product?.article || `товар №${issue.productId}`;
  const correction = issue.correctionId ? `Переоблік №${issue.correctionId}` : 'Запис переобліку';
  switch (issue.code) {
    case 'SOURCE_CORRECTION_NOT_RECORDED': return `${correction} збережений, але для ${article} його ще не підтверджено в історії синхронізації.`;
    case 'SOURCE_CORRECTION_MISMATCH': return `Для ${article} історія синхронізації посилається на переоблік №${issue.recordedCorrectionId}, а записи товару — на №${issue.correctionId}.`;
    case 'LINEAGE_LINK_MISMATCH': return `${correction} та посилання між версіями ${article} вказують на різні товари.`;
    case 'CORRECTION_SKU_MISMATCH': return `${correction} містить артикул ${issue.storedSku}, який не збігається зі збереженою версією ${article}.`;
    case 'CORRECTION_EDGE_MISSING': return `Між версіями ${article} і товару №${issue.successorId} є посилання, але немає запису переобліку.`;
    case 'DUPLICATE_CORRECTION_EDGE': return `Для одного переходу від ${article} збережено кілька переобліків: ${(issue.correctionIds || []).join(', ')}.`;
    case 'LINEAGE_BRANCH': return `${article} пов’язаний з кількома попередніми або наступними версіями. Потрібно встановити правильну послідовність.`;
    case 'LINEAGE_CYCLE': return 'Посилання між версіями повертаються до попереднього товару замість завершеної послідовності.';
    case 'LINEAGE_PRODUCT_MISSING': return `${correction} посилається на версію товару, якої немає в збережених даних.`;
    case 'DISCONNECTED_IDENTITY_HISTORY': return 'Один артикул належить версіям, між якими немає повної послідовності переобліків.';
    default: return `${correction} має неповні дані. Його точний запис включено до звіту.`;
  }
}

function recoveryHistoryReport(history, inspection) {
  return [
    'Перевірка історії синхронізації Magento',
    `Поточний товар: ${history.products.find(p => p.productId === history.productId)?.article} (№${history.productId})`,
    `Сторінка проблеми: /attention?problem=${history.productId}`,
    `Історія повна: ${history.complete ? 'так' : 'ні'}`,
    `Артикул змінився після переобліку: ${history.identityChanged ? 'так' : 'ні'}`,
    `Magento перевірено: ${inspection?.observedAt || 'ще не перевірено'}`,
    ...(inspection?.stale ? ['Дані Amber змінилися під час перевірки; результати потребують повторної перевірки.'] : []),
    '', 'Версії товару:',
    ...history.products.map(p => `№${p.productId} · ${p.article} · внутрішній SKU ${p.internalSku} · ${p.status}; попередня №${p.previousProductId ?? '—'}, наступна №${p.nextProductId ?? '—'}; переоблік №${p.sourceCorrectionId ?? 'не підтверджено'}; маршрут ${p.route}, причина ${p.holdReason ?? '—'}; виключення ${p.businessExclusion}, походження ${p.exclusionProvenance ?? '—'}, обмеження переобліку ${p.compatibilityExcluded}; ${remoteText(inspection?.remote?.find(r => r.article === p.article))}`),
    '', 'Записи переобліку:',
    ...history.corrections.map(v => `№${v.correctionId}: №${v.sourceProductId} (${v.sourceInternalSku}) → №${v.successorProductId} (${v.successorInternalSku})`),
    '', 'Що потребує розбору:',
    ...history.issues.map(issue => `${issueText(issue, history)} [${issue.code}]`),
    ...history.products.filter(policyText).map(p => `${p.article}: ${policyText(p)}.`),
    '', 'Перевірка лише читає дані. Вона не змінює історію, артикули, виключення або товари Magento.',
  ].join('\n');
}

export default function MagentoRecoveryHistory({ history, inspection, busy, onInspect, onReleaseExclusion, canViewHistory }) {
  const [copyResult, setCopyResult] = useState('');
  const rows = [...history.products].sort((a, b) => Number(a.productId === history.productId) - Number(b.productId === history.productId) || a.productId - b.productId);
  const problems = history.issues.map(issue => issueText(issue, history));
  const policies = rows.filter(policyText);
  const unsupported = !history.stableRecount;
  const title = history.identityChanged ? 'Після переобліку товар отримав інший артикул'
    : !history.complete ? 'Історія переобліку завелика для цього екрану' : 'Що сталося під час переобліку';
  async function copy() {
    try { await navigator.clipboard.writeText(recoveryHistoryReport(history, inspection)); setCopyResult('Звіт скопійовано. Передайте його відповідальному за інтеграцію.'); }
    catch { setCopyResult('Не вдалося скопіювати. Збережіть звіт у файл.'); }
  }
  function download() {
    downloadBlob(new Blob([recoveryHistoryReport(history, inspection)], { type: 'text/plain;charset=utf-8' }), `magento-product-${history.productId}-history.txt`);
  }
  return <section className="space-y-3" aria-label="Розбір історії товару">
    <h4 className="sync-next-heading">{title}</h4>
    {unsupported && <p className="sync-problem-guidance">{history.identityChanged
      ? 'Для цього старого переобліку потрібно узгодити різні артикули. Підтвердження зі сталим артикулом тут не підходить.'
      : 'Записи попередніх версій ще не дозволяють підтвердити поточний товар.'}</p>}
    <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead><tr className="border-b"><th className="py-2 pr-3">Версія</th><th className="py-2 pr-3">Артикул</th><th className="py-2">У Magento</th></tr></thead>
      <tbody>{rows.map(p => <tr className="border-b" key={p.productId}><td className="py-3 pr-3">{p.productId === history.productId ? 'Поточна' : p.status === 'corrected' ? 'До переобліку' : 'Пов’язана версія'}</td>
        <td className="py-3 pr-3"><strong>{p.article}</strong>{canViewHistory && <div><Link className="underline" to={`/products/history?sku=${encodeURIComponent(p.article)}&returnTo=${encodeURIComponent(`/attention?problem=${history.productId}`)}`}>Історія цієї версії</Link></div>}</td>
        <td className="py-3">{remoteText(inspection?.remote?.find(r => r.article === p.article))}</td></tr>)}</tbody></table></div>
    {inspection?.observedAt && <p className="sync-problem-guidance">Перевірено Magento: {new Date(inspection.observedAt).toLocaleString('uk-UA')}. Змін не надсилали.</p>}
    {inspection?.stale && <Notice tone="warning">Дані товару змінилися під час перевірки. Повторіть перевірку, щоб звіт відповідав поточній історії.</Notice>}
    {(problems.length > 0 || policies.length > 0) && <div><h4 className="sync-next-heading">Що потрібно з’ясувати</h4><ul className="list-disc pl-5 space-y-1">
      {problems.map((text, i) => <li key={i}>{text}</li>)}{policies.map(p => <li key={`policy-${p.productId}`}><strong>{p.article}:</strong> {policyText(p)}.</li>)}</ul></div>}
    {unsupported && <Notice tone="warning"><p className="font-semibold">Далі — виправлення історії переобліку</p>
      <p>На цьому екрані ще немає безпечної дії для узгодження такої історії. Збережіть звіт і передайте відповідальному за інтеграцію: у ньому є точні версії, записи переобліку та результати перевірки Magento.</p></Notice>}
    <div className="flex flex-wrap gap-2">
      {history.complete && onInspect && <Button size="compactMd" busy={busy} onClick={onInspect}>{inspection ? 'Повторити перевірку артикулів у Magento' : 'Перевірити ці артикули у Magento'}</Button>}
      <Button variant="primary" size="compactMd" disabled={busy} onClick={copy}>Копіювати звіт для виправлення</Button>
      <Button size="compactMd" disabled={busy} onClick={download}>Зберегти звіт у файл</Button>
    </div>
    {copyResult && <p role="status">{copyResult}</p>}
    {onReleaseExclusion && <div><p className="sync-problem-guidance">Окремо можна переглянути виключення поточного товару. Рішення щодо нього залишає перевірку історії переобліку окремим кроком.</p>
      <Button size="compactMd" busy={busy} onClick={onReleaseExclusion}>Переглянути виключення поточного товару</Button></div>}
  </section>;
}
