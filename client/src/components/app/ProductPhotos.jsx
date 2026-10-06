import { useId, useRef } from 'react';
import { Camera, GripVertical, ImagePlus } from 'lucide-react';
import { usePhotoSort } from '../../hooks/usePhotoSort.js';

const statuses={pending:'Очікує передавання',running:'Передаються фото',uncertain:'Потрібно перевірити результат передавання',blocked:'Передавання потребує уваги',succeeded:'Фото перевірено в Magento',superseded:'Передавання продовжується для актуального товару'};
const controlStyle={minHeight:34};
export function ProductPhotos({controller,canEdit=true,existingProduct=false,activationDisabledReason=null}) {
  const id=useId(); const picker=useRef(null); const camera=useRef(null); const p=controller;
  const supportsCamera=typeof HTMLInputElement!=='undefined' && 'capture' in HTMLInputElement.prototype;
  const disabled=!p || !canEdit || p.busy || p.loading || p.ready===false;
  const unresolved=p?.delivery && p.delivery.state!=='succeeded';
  const controlsLocked=disabled || Boolean(unresolved);
  const sort=usePhotoSort(p?.photos || [],controlsLocked,(order)=>p.reorderPhotos(order));
  if(!p)return null;
  const pickerLocked=controlsLocked || p.photos.length>=8;
  const choose=(event)=>{const files=Array.from(event.target.files || []);event.target.value='';if(!pickerLocked && files.length)p.addFiles(files);};
  const openPicker=(input)=>{if(!pickerLocked)input.current?.click();};
  return <section className="product-photos" aria-labelledby={`${id}-title`}>
    <div className="product-photos-heading"><h3 id={`${id}-title`}>Фотографії</h3>
    {canEdit && <>
      <button type="button" className="btn btn-outline product-photos-add" style={controlStyle}
        disabled={pickerLocked} aria-controls={`${id}-picker`} onClick={()=>openPicker(picker)}>
        <ImagePlus size={18} aria-hidden="true"/>Додати фото
      </button>
    </>}<span>{p.photos.length}/8</span></div>
    <div className="product-photos-gallery">
    {p.loading && <p role="status">Завантаження фотографій…</p>}
    {canEdit && <div className="product-photos-picker">
      <input id={`${id}-picker`} ref={picker} className="product-photos-input" type="file" tabIndex={-1}
        aria-label="Додати фото" accept="image/jpeg,image/png" multiple disabled={pickerLocked} onChange={choose}/>
      <p className="product-photos-picker-hint">{p.photos.length ? `Додано ${p.photos.length} із 8 фото.` : 'Оберіть одне або кілька фото з пристрою.'}</p>
      {p.photos.length>=8 && <p>Додано всі 8 фото. Приберіть одне, щоб додати інше.</p>}
      {unresolved && <p>Спочатку перевірте результат поточного передавання фото.</p>}
      {supportsCamera && <details className="product-photos-camera">
        <summary>Камера, якщо доступна</summary>
        <button type="button" className="btn btn-outline" style={controlStyle} disabled={pickerLocked}
          aria-controls={`${id}-camera`} onClick={()=>openPicker(camera)}><Camera size={16} aria-hidden="true"/>Зробити фото</button>
        <input id={`${id}-camera`} ref={camera} className="product-photos-input" type="file" tabIndex={-1}
          aria-label="Зробити фото камерою" accept="image/jpeg,image/png" capture="environment" disabled={pickerLocked} onChange={choose}/>
        <p>Браузер відкриє камеру, якщо пристрій підтримує знімання.</p>
      </details>}
    </div>}
    {p.photos.length ? <><p id={`${id}-sort-hint`} className="product-photos-sort-hint">Перетягніть, щоб змінити порядок. Перше фото — головне.</p>
    <p id={`${id}-keyboard-hint`} className="sr-only">На кнопці переміщення натисніть пробіл, змініть порядок стрілками й підтвердьте Enter. Escape скасовує переміщення.</p>
    <ol className="product-photos-list" {...sort.pointerHandlers}>
      {sort.ordered.map((photo,index)=><li key={photo.id} ref={sort.cardRef(photo.id)} data-photo-id={photo.id}
        className={`product-photo-card${sort.dragging?.id===photo.id ? ' is-sorting' : ''}`}>
        <div className="product-photo-image">
        <img src={p.contentUrl(photo.id)} alt={photo.name} loading="lazy" width="160" height="160" style={{objectFit:'cover'}}/>
        {index===0 && <span className="product-photo-main">Головне</span>}</div>
        <small title={photo.name}>{photo.name}</small>
        {canEdit && <div className="product-photos-actions">
          <button type="button" className="btn btn-outline product-photo-drag" style={controlStyle}
            aria-label={`Перемістити ${photo.name}`} aria-describedby={`${id}-keyboard-hint`}
            aria-pressed={sort.dragging?.id===photo.id} disabled={controlsLocked || p.photos.length<2} {...sort.handle(photo.id)}>
            <GripVertical size={18} aria-hidden="true"/></button>
          <button type="button" className="btn btn-outline product-photo-remove" style={controlStyle}
            disabled={controlsLocked || Boolean(sort.dragging)} onClick={()=>p.removePhoto(photo.id)}>Прибрати<span className="sr-only"> {photo.name}</span></button>
        </div>}
      </li>)}
    </ol><span className="sr-only" role="status" aria-live="polite">{sort.announcement}</span></> : <p>{existingProduct ? 'Фото ще не додані через Amber. Зображення в Magento перевіряються окремо.' : 'Без фото товар буде прихованим у Magento.'}</p>}
    {sort.dragging?.mode==='pointer' && sort.dragging.moved && <img className="product-photo-drag-preview" aria-hidden="true" alt=""
      src={p.contentUrl(sort.dragging.id)} style={{left:sort.dragging.x-54,top:sort.dragging.y-54}}/>}
    </div>
    {canEdit && p.photos.length>0 && <label className="product-photos-enable" style={{...controlStyle,display:'flex',alignItems:'center',gap:8}}>
      <input type="checkbox" checked={!activationDisabledReason && p.enableWhenVerified} disabled={disabled || Boolean(unresolved) || Boolean(activationDisabledReason)} onChange={(event)=>{if(!activationDisabledReason)p.setEnableWhenVerified(event.target.checked);}}/>
      Увімкнути товар у Magento після перевірки всіх фото
    </label>}
    {activationDisabledReason && <p className="product-photos-picker-hint">{activationDisabledReason}</p>}
    {p.failedUploads.length>0 && <div role="alert" className="product-photos-failure">
      <p>Не всі фото збережені. {existingProduct ? 'Зберегти фотографії' : 'Створити товар'} можна після повторного збереження або вилучення цих фото зі спроби.</p>
      {p.failedUploads.map((file)=><p key={file.key}>{file.name} <button type="button" className="btn btn-outline" style={controlStyle} disabled={disabled} onClick={()=>p.discardFailed(file.key)}>Прибрати зі спроби</button></p>)}
      <button type="button" className="btn btn-outline" style={controlStyle} disabled={disabled} onClick={p.retryUploads}>Повторити збереження цих фото</button>
    </div>}
    {p.busy && <p role="status">Збереження фотографій…</p>}
    {p.error && <p role="alert">{p.error}</p>}
    {p.delivery && <p role="status">{p.delivery.code==='PHOTO_NATIVE_SYNC_REQUIRED' ? 'Фото очікують завершення синхронізації товару.' : statuses[p.delivery.state] || 'Стан передавання невідомий'}</p>}
    {existingProduct && canEdit && <div className="product-photos-actions">
      <button type="button" className="btn btn-outline" style={controlStyle} disabled={disabled || p.hasPendingUploads || !p.dirty || Boolean(unresolved)} onClick={p.save}>Зберегти фотографії</button>
      {['uncertain','blocked'].includes(p.delivery?.state) && <button type="button" className="btn btn-outline" style={controlStyle} disabled={disabled} onClick={p.reconcile}>Перевірити результат у Magento</button>}
    </div>}
  </section>;
}
