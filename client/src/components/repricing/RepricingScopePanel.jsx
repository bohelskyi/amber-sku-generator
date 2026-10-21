export function RepricingScopePanel({ canPrepareRepricing, controller, onBuildGlobal, scope = 'global', onScopeChange }) {
  const { drafts, globalDraft, openSelectedRepricing, previewing, scenarioId,
    scenarios, selectScenario, selectedDraft } = controller;
  const draft = scope === 'global' ? globalDraft : selectedDraft;
  const open = scope === 'global' ? onBuildGlobal : openSelectedRepricing;

  return <div className="repricing-scope p-5">
    <label><span>Які товари переоцінити</span><select className="input" value={scope} onChange={(event) => onScopeChange(event.target.value)}>
      <option value="global">Усі активні товари</option><option value="scenario">За окремою матрицею</option>
    </select></label>
    {scope === 'scenario' && <label><span>Цінова матриця</span><select className="input" value={scenarioId} onChange={(event) => selectScenario(event.target.value)}>
      {scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.category_code} — {scenario.name}
        {drafts.some((item) => Number(item.scenarioId) === Number(scenario.id)) ? ' · чернетка' : ''}</option>)}
    </select></label>}
    {(draft || canPrepareRepricing) && <button type="button" className="btn btn-primary" onClick={open}
      disabled={previewing || scope === 'scenario' && !scenarioId}>
      {previewing ? 'Готуємо переоцінку…' : draft ? canPrepareRepricing ? 'Продовжити чернетку' : 'Переглянути чернетку' : 'Підготувати переоцінку'}
    </button>}
    {!canPrepareRepricing && !draft && <p>Для цього обсягу немає підготовленої чернетки.</p>}
  </div>;
}
