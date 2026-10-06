import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { resolveCatalogDeletionTarget } from '../../lib/catalog-deletion-target.js';
import { CatalogDeletionReview } from './CatalogDeletionReview.jsx';

export function CatalogDeletionEntry({categoryCode,questions,revision,field,optionEntry,isAdministrator,permissions=[],disabledReason='',onCompleted,apiClient,activeReviewKey,onReviewChange}) {
  const resolved=resolveCatalogDeletionTarget({categoryCode,questions,revision,field,optionEntry});
  const identity=JSON.stringify([resolved.target,disabledReason,isAdministrator,permissions]);
  return <EntrySession key={identity} {...{resolved,categoryCode,optionEntry,isAdministrator,permissions,disabledReason,onCompleted,apiClient,activeReviewKey,onReviewChange}}/>;
}
function EntrySession({resolved,categoryCode,optionEntry,isAdministrator,permissions,disabledReason,onCompleted,apiClient,activeReviewKey,onReviewChange}) {
  const [opened,setOpened]=useState(false);
  const openState=useRef(false);
  useEffect(()=>()=>{ if(openState.current) onReviewChange?.(null); },[onReviewChange]);
  if(!isAdministrator) return <p className="mc-help">Повне видалення з Manager і Magento доступне лише Адміністратору.</p>;
  const missing=['catalog.manage','export_templates.manage','export_templates.publish'].filter(permission=>!permissions.includes(permission));
  const reviewKey=JSON.stringify(resolved.target);
  const reason=missing.length ? `Для повного видалення бракує дозволів: ${missing.join(', ')}.` : disabledReason || resolved.reason
    || (activeReviewKey && activeReviewKey!==reviewKey ? 'Завершіть відкриту перевірку іншої цілі.' : '');
  const scope=optionEntry ? 'один варіант' : 'всю характеристику та її варіанти';
  const local=resolved.question;
  const remoteOnly = /^test_[a-z0-9_]+$/.test(resolved.target?.attributeCode || '') && /^TEST(?:\s|$)/.test(local?.label || '') && Boolean(optionEntry ? resolved.option?.archived : local?.archived);
  const archivePath=local && permissions.includes('catalog.manage') ? `/admin/catalog?${new URLSearchParams({category:categoryCode,question:local.id,
    ...(resolved.option ? {value:String(resolved.option.id),optionId:String(resolved.option.db_id),action:'edit-option'} : {action:'edit-question'}),
    returnTo:`/admin/magento/categories/${encodeURIComponent(categoryCode)}?${new URLSearchParams({tab:'attributes',field:resolved.target.attributeCode})}`})}` : null;
  return <section className="space-y-2" aria-label={optionEntry ? 'Архівування або видалення одного варіанта' : 'Архівування або видалення характеристики'}>
    <p className="mc-help">Архівування лише у Manager зберігає призначення і не змінює Magento. Повне видалення охоплює {scope}; товари та нерозв’язані залежності блокують його.</p>
    {archivePath && <Link className="underline text-sm" to={archivePath}>Архівування лише у Manager</Link>}
    {!opened && <button type="button" className="btn btn-outline" disabled={Boolean(reason)} onClick={()=>{ openState.current=true; setOpened(true); onReviewChange?.(reviewKey); }}>
      {remoteOnly ? 'Видалити лише з Magento, зберегти архів Manager' : optionEntry ? 'Видалити один варіант з Manager і Magento' : 'Видалити характеристику з Manager і Magento'}
    </button>}
    {reason && <p role="status" className="mc-help">{reason}</p>}
    {opened && !reason && <CatalogDeletionReview target={resolved.target} remoteOnly={remoteOnly} isAdministrator onClose={()=>{openState.current=false;setOpened(false);onReviewChange?.(null);}} onCompleted={onCompleted} apiClient={apiClient}/>}
  </section>;
}
