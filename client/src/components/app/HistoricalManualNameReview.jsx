import { useEffect, useRef } from 'react';

export function HistoricalManualNameReview({ flow }) {
  const heading = useRef(null);
  const { request, preview, preparation, preparationError, uncertain, acknowledged, subjectUa = '', subjectEn = '', nameMode = 'template', fullNameUa = '', fullNameEn = '' } = flow.nameReview;
  const busy = Boolean(flow.busyKind || !flow.canReviewNames), completed = preview?.alreadyCompleted, full = nameMode === 'full';
  useEffect(() => { heading.current?.focus(); heading.current?.scrollIntoView?.({ block: 'nearest' }); }, [request.productId]);
  return <section className="mt-3 rounded border border-amber-200 bg-white p-3" aria-label={'Ручні назви ' + request.article}>
    <h3 ref={heading} tabIndex={-1} className="font-semibold">Ручна назва для {request.article}</h3>
    <p className="mt-2 text-sm">Введіть конкретну назву українською й англійською. За замовчуванням чинний шаблон додасть артикул та решту повної назви. За потреби повну назву можна відредагувати. Збереження залишить товар в архіві.</p>
    {flow.busyKind === 'name_read' && <p className="mt-2" role="status">Читаємо збережені назви…</p>}
    {preparationError && <p className="mt-2 text-amber-800" role="alert">{preparationError}</p>}
    {uncertain && <p className="mt-2 text-amber-800">Результат збереження ще не підтверджено. Прочитайте назви цього самого товару; повторного збереження не буде.</p>}
    {flow.namesExpired && <p className="mt-2 text-amber-800" role="alert">Перевірка назв застаріла. Прочитайте збережені назви й перегляньте пару ще раз.</p>}
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label>Назва UA<input className="input mt-1 w-full" value={subjectUa} maxLength={200} disabled={busy || uncertain || completed || full}
        onChange={event => flow.editManualSubject('subjectUa', event.target.value)} /></label>
      <label>Назва EN<input className="input mt-1 w-full" value={subjectEn} maxLength={200} disabled={busy || uncertain || completed || full}
        onChange={event => flow.editManualSubject('subjectEn', event.target.value)} /></label>
    </div>
    {full && <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label>Повна назва UA<textarea className="input mt-1 w-full" rows={3} value={fullNameUa} maxLength={255} disabled={busy || uncertain || completed}
        onChange={event => flow.editManualFullName('fullNameUa', event.target.value)} /></label>
      <label>Повна назва EN<textarea className="input mt-1 w-full" rows={3} value={fullNameEn} maxLength={255} disabled={busy || uncertain || completed}
        onChange={event => flow.editManualFullName('fullNameEn', event.target.value)} /></label>
      <p className="text-sm sm:col-span-2">Збережемо повні назви точно як у перевірці. Артикул товару: {request.article}.</p>
    </div>}
    {(preview?.nameUa && preview?.nameEn && preview?.preparationToken || completed) && <div className="mt-3 space-y-2 text-sm">
      <p><strong>Повна назва UA: </strong>{preview.nameUa}</p><p><strong>Повна назва EN: </strong>{preview.nameEn}</p>
      {completed ? <p className="font-medium">Ручну пару вже збережено. Товар залишається архівованим.</p>
        : <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={acknowledged} disabled={busy || uncertain || flow.namesExpired}
          onChange={event => flow.acknowledgeNames(event.target.checked)} /><span>Підтверджую цю ручну UA/EN пару та обидві повні назви. Зберегти лише назви в архівованому товарі.</span></label>}
    </div>}
    <div className="mt-3 flex flex-wrap gap-2">
      {!completed && preparation?.fullNameEditing && (full
        ? <button type="button" className="btn btn-outline" disabled={busy || uncertain} onClick={() => flow.setManualFullNameMode(false)}>Повернутися до шаблону</button>
        : <button type="button" className="btn btn-outline" disabled={busy || uncertain || !preview?.nameUa || !preview?.nameEn || flow.namesExpired}
            onClick={() => flow.setManualFullNameMode(true)}>Редагувати повну назву</button>)}
      <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void flow.readNameReview()}>Прочитати збережені назви</button>
      {completed ? <>
        {flow.nextManualArticle && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void flow.nextManualNames()}>Наступний товар: {flow.nextManualArticle}</button>}
        <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void flow.repeatAfterNames()}>Перевірити перед відновленням</button>
      </> : <>
        <button type="button" className="btn btn-outline" disabled={busy || uncertain || !preparation || flow.namesExpired || !subjectUa.trim() || !subjectEn.trim()} onClick={() => void flow.previewManualNames()}>Переглянути повні назви</button>
        <button type="button" className="btn btn-primary" disabled={busy || uncertain || !preview?.preparationToken || !preview?.nameUa || !preview?.nameEn || !acknowledged || flow.namesExpired} onClick={() => void flow.saveNames()}>
          {flow.busyKind === 'name_save' ? 'Зберігаємо назви…' : 'Зберегти ручну пару'}</button>
      </>}
      <button type="button" className="btn btn-outline" disabled={Boolean(flow.busyKind)} onClick={flow.cancelNameReview}>Закрити перевірку назв</button>
    </div>
  </section>;
}
