export function HistoricalWeightNormalizationReview({ flow }) {
  const current = flow.nameReview, value = current.preview;
  const locked = Boolean(flow.busyKind || !flow.canNormalizeWeights);
  return <section className="mt-3 rounded border p-3" aria-label={'Формат ваги ' + current.request.article}>
    <h4 className="font-semibold">Виправлення формату ваги · {current.request.article}</h4>
    {value && <>
      <p className="mt-2 font-mono">{value.sourceWeight} → {value.targetWeight} г</p>
      <p className="mt-2 text-sm">Збережена вага: {value.canonicalWeight} г. Кома зміниться на крапку; числова вага, ціна й артикул збережуться.</p>
      {value.alreadyCompleted ? <>
        <p role="status" className="mt-2 font-medium">Формат ваги узгоджений. Товар залишається архівованим; перевірте актуальні умови відновлення.</p>
        <button type="button" className="btn btn-primary mt-3" disabled={locked} onClick={() => void flow.repeatAfterNames()}>Перевірити товари після виправлення</button>
      </> : <>
        <label className="mt-3 flex items-start gap-2"><input type="checkbox" checked={current.acknowledged}
          disabled={locked || current.uncertain || flow.namesExpired} onChange={event => flow.acknowledgeNames(event.target.checked)} />
          <span>Погоджую лише виправлення формату {value.sourceWeight} → {value.targetWeight} для {current.request.article}.</span></label>
        <button type="button" className="btn btn-primary mt-3" disabled={locked || current.uncertain || flow.namesExpired || !current.acknowledged}
          onClick={() => void flow.saveNames()}>Виправити формат ваги</button>
      </>}
    </>}
    {flow.namesExpired && !value?.alreadyCompleted && <p role="alert" className="mt-2">Перевірка ваги застаріла. Прочитайте її заново.</p>}
    {current.uncertain && <p role="alert" className="mt-2">Відповідь виправлення не підтверджена. Повторіть лише читання цього товару.</p>}
    {(!value || current.uncertain || flow.namesExpired) && <button type="button" className="btn btn-outline mt-3" disabled={locked}
      onClick={() => void flow.readNameReview()}>Прочитати вагу цього товару</button>}
    <button type="button" className="btn btn-outline mt-3 ml-2" disabled={Boolean(flow.busyKind)} onClick={flow.cancelNameReview}>Закрити перевірку ваги</button>
  </section>;
}
