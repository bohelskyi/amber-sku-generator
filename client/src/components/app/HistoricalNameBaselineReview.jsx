import { useEffect, useRef } from 'react';

export function HistoricalNameBaselineReview({ flow }) {
  const heading = useRef(null);
  const { request, preview, uncertain, acknowledged } = flow.nameReview;
  const busy = Boolean(flow.busyKind || !flow.canReviewNames), reading = flow.busyKind === 'name_read';
  useEffect(() => { heading.current?.focus(); heading.current?.scrollIntoView?.({ block: 'nearest' }); }, [request.productId]);
  return <section className="mt-3 rounded border border-amber-200 bg-white p-3" aria-label={'Перевірка назв ' + request.article}>
    <h3 ref={heading} tabIndex={-1} className="font-semibold">Чинні назви Magento для {request.article}</h3>
    <p className="mt-2 text-sm">Magento ID: {request.remoteProductId}. Збереження назв залишить товар архівованим у менеджері. Зміни на сайті не надсилаються.</p>
    {reading && <p className="mt-2" role="status">Перевіряємо українську й англійську назви…</p>}
    {uncertain && <p className="mt-2 text-amber-800">Результат збереження назв ще не підтверджено. Повторіть лише читання назв цього самого товару; збереження не надсилатиметься автоматично.</p>}
    {flow.namesExpired && <p role="alert" className="mt-2 text-amber-800">Перевірка назв застаріла. Прочитайте назви ще раз перед збереженням.</p>}
    {preview && <>
      <table className="mt-3 w-full table-fixed text-left text-sm">
        <thead><tr><th className="w-12" scope="col">Мова</th><th scope="col">Менеджер</th><th scope="col">Magento</th></tr></thead>
        <tbody>{[['all', 'UA'], ['en', 'EN']].map(([key, label]) => <tr key={key}>
          <th className="align-top py-2" scope="row">{label}</th>
          <td className="break-words whitespace-pre-wrap p-2 align-top">{preview.amber?.[key] || '—'}</td>
          <td className="break-words whitespace-pre-wrap p-2 align-top">{preview.magento[key]}</td>
        </tr>)}</tbody>
      </table>
      {preview.alreadyAccepted ? <p className="mt-3 font-medium">Ці назви Magento вже збережено. Товар залишається архівованим.</p>
        : <label className="mt-3 flex items-start gap-2"><input type="checkbox" className="mt-1" disabled={busy || uncertain} checked={acknowledged}
          onChange={event => flow.acknowledgeNames(event.target.checked)} />
          <span>Зберегти ці українську й англійську назви Magento в менеджері. Товар залишиться архівованим.</span></label>}
    </>}
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void flow.readNameReview()}>Перевірити назви ще раз</button>
      {preview?.alreadyAccepted ? <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void flow.repeatAfterNames()}>Повторити перевірку відновлення</button>
        : <button type="button" className="btn btn-primary" disabled={busy || uncertain || !preview || !acknowledged || flow.namesExpired} onClick={() => void flow.saveNames()}>
          {flow.busyKind === 'name_save' ? 'Зберігаємо назви…' : 'Зберегти назви Magento'}</button>}
      <button type="button" className="btn btn-outline" disabled={Boolean(flow.busyKind)} onClick={flow.cancelNameReview}>Закрити перевірку назв</button>
    </div>
  </section>;
}
