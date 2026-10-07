import { useEffect, useRef } from 'react';

export function HistoricalManualNameReview({ flow }) {
  const heading = useRef(null);
  const { request, preview, uncertain, acknowledged, subjectUa = '', subjectEn = '' } = flow.nameReview;
  const busy = Boolean(flow.busyKind || !flow.canReviewNames), completed = preview?.alreadyCompleted;
  useEffect(() => { heading.current?.focus(); heading.current?.scrollIntoView?.({ block: 'nearest' }); }, [request.productId]);
  return <section className="mt-3 rounded border border-amber-200 bg-white p-3" aria-label={'Ручні назви ' + request.article}>
    <h3 ref={heading} tabIndex={-1} className="font-semibold">Ручна назва для {request.article}</h3>
    <p className="mt-2 text-sm">Введіть конкретну назву українською й англійською. Чинний шаблон додасть артикул та решту повної назви. Збереження залишить товар в архіві.</p>
    {flow.busyKind === 'name_read' && <p className="mt-2" role="status">Читаємо збережені назви…</p>}
    {uncertain && <p className="mt-2 text-amber-800">Результат збереження ще не підтверджено. Прочитайте назви цього самого товару; повторного збереження не буде.</p>}
    {flow.namesExpired && <p className="mt-2 text-amber-800" role="alert">Перевірка назв застаріла. Прочитайте збережені назви й перегляньте пару ще раз.</p>}
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label>Назва UA<input className="input mt-1 w-full" value={subjectUa} maxLength={200} disabled={busy || uncertain || completed}
        onChange={event => flow.editManualSubject('subjectUa', event.target.value)} /></label>
      <label>Назва EN<input className="input mt-1 w-full" value={subjectEn} maxLength={200} disabled={busy || uncertain || completed}
        onChange={event => flow.editManualSubject('subjectEn', event.target.value)} /></label>
    </div>
    {(preview?.nameUa && preview?.nameEn && preview?.preparationToken || completed) && <div className="mt-3 space-y-2 text-sm">
      <p><strong>Повна назва UA: </strong>{preview.nameUa}</p><p><strong>Повна назва EN: </strong>{preview.nameEn}</p>
      {completed ? <p className="font-medium">Ручну пару вже збережено. Товар залишається архівованим.</p>
        : <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={acknowledged} disabled={busy || uncertain || flow.namesExpired}
          onChange={event => flow.acknowledgeNames(event.target.checked)} /><span>Підтверджую цю ручну UA/EN пару та обидві повні назви. Зберегти лише назви в архівованому товарі.</span></label>}
    </div>}
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void flow.readNameReview()}>Прочитати збережені назви</button>
      {completed ? <>
        {flow.nextManualArticle && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void flow.nextManualNames()}>Наступний товар: {flow.nextManualArticle}</button>}
        <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void flow.repeatAfterNames()}>Перевірити перед відновленням</button>
      </> : <>
        <button type="button" className="btn btn-outline" disabled={busy || uncertain || !subjectUa.trim() || !subjectEn.trim()} onClick={() => void flow.previewManualNames()}>Переглянути повні назви</button>
        <button type="button" className="btn btn-primary" disabled={busy || uncertain || !preview?.preparationToken || !preview?.nameUa || !preview?.nameEn || !acknowledged || flow.namesExpired} onClick={() => void flow.saveNames()}>
          {flow.busyKind === 'name_save' ? 'Зберігаємо назви…' : 'Зберегти ручну пару'}</button>
      </>}
      <button type="button" className="btn btn-outline" disabled={Boolean(flow.busyKind)} onClick={flow.cancelNameReview}>Закрити перевірку назв</button>
    </div>
  </section>;
}
