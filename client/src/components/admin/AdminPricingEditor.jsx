import { useState } from 'react';
import { Copy, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { ConditionBuilder } from './ConditionBuilder';
import {
  getMatrixPriceValidationError,
  handleNumberKeyDown,
  handleNumberWheel,
  normalizeDecimalInput,
} from '../../lib/number-input';
import { getPricingAxis } from '../../lib/pricing-axis';
import { formatConditionSummary } from '../../lib/admin-conditions';
import { formatDecimal } from '../../lib/formatters';

const getScenarioGroupName = (scenario) => {
  const groupName = String(scenario.group_name || '').trim();
  if (groupName) return groupName;

  const scenarioName = String(scenario.name || '').trim();
  if (scenarioName.includes(' - ')) return scenarioName.split(' - ')[0].trim() || 'Без групи';
  return scenarioName || 'Без групи';
};

const groupScenarios = (scenarios = []) => {
  const groups = [];
  const groupMap = new Map();

  scenarios.forEach((scenario) => {
    const groupName = getScenarioGroupName(scenario);
    if (!groupMap.has(groupName)) {
      const group = { name: groupName, scenarios: [] };
      groupMap.set(groupName, group);
      groups.push(group);
    }
    groupMap.get(groupName).scenarios.push(scenario);
  });

  return groups;
};

const defaultWeightBands = [
  { label: 'До 10 г', min_weight: 0, max_weight: 10 },
  { label: '10-15 г', min_weight: 10, max_weight: 15 },
  { label: 'Від 15 г', min_weight: 15, max_weight: '' },
];

const getAxisQuestions = (questions = [], requiresWeight = false) => {
  const axisQuestions = questions.filter((question) =>
    (question.input_type || 'options') !== 'text' && (question.options || []).length > 0
  );
  if (requiresWeight && !axisQuestions.some((question) => question.id === 'weight')) {
    axisQuestions.push({
      id: 'weight',
      label: 'Вага',
      input_type: 'text',
      options: [{ id: 0, label: 'Ціна за грам' }],
    });
  }
  if (requiresWeight) {
    axisQuestions.push({
      id: 'weight_band',
      label: 'Діапазон ваги',
      input_type: 'options',
      options: [],
    });
  }

  return axisQuestions;
};

const splitComboAxis = (axisKey) => {
  const keys = String(axisKey || '').split('+').map((key) => key.trim()).filter(Boolean);
  return { primaryKey: keys[0] || '', secondaryKey: keys[1] || '' };
};

const getStatusLabel = (status) => {
  if (status === 'draft') return 'Чернетка';
  if (status === 'archived') return 'Архівна';
  return 'Активна';
};

const getPriceModeLabel = (mode) => {
  if (mode === 'fixed_uah') return 'Фіксована UAH';
  if (mode === 'per_gram_usd') return 'USD за грам';
  return 'Режим категорії';
};

const getModifierRule = (modifier) =>
  modifier.match_json || (modifier.trigger_key ? { [modifier.trigger_key]: modifier.trigger_val } : {});

function FieldControl({ children, hint, label }) {
  return (
    <label className="pricing-field-control">
      <span>{label}</span>
      <div>{children}{hint && <small>{hint}</small>}</div>
    </label>
  );
}

function SettingsSection({ children, title }) {
  return (
    <section className="pricing-settings-section">
      <h4>{title}</h4>
      <div>{children}</div>
    </section>
  );
}

function MetaItem({ label, value }) {
  return <div className="pricing-meta-item"><span>{label}</span><strong>{value}</strong></div>;
}

function WeightBandsEditor({ bands = [], onChange }) {
  const updateBand = (index, key, value) => {
    onChange(bands.map((band, bandIndex) => (
      bandIndex === index ? { ...band, [key]: value } : band
    )));
  };

  return (
    <div className="pricing-weight-bands">
      <div className="pricing-weight-bands-header">
        <strong>Вагові діапазони</strong>
        <button type="button" className="btn btn-outline px-2 py-1 text-xs" onClick={() => onChange([...bands, { label: '', min_weight: '', max_weight: '' }])}>
          Додати діапазон
        </button>
      </div>
      <div className="pricing-weight-band-list">
        {bands.map((band, index) => (
          <div key={band.id || index} className="pricing-weight-band-row">
            <input className="input-sm" value={band.label} placeholder="Назва" onChange={(event) => updateBand(index, 'label', event.target.value)} />
            <input className="input-sm" type="number" min="0" step="0.1" value={band.min_weight} placeholder="Від, включно" onChange={(event) => updateBand(index, 'min_weight', event.target.value)} onWheel={handleNumberWheel} onKeyDown={handleNumberKeyDown} />
            <input className="input-sm" type="number" min="0" step="0.1" value={band.max_weight ?? ''} placeholder="До, не включно" onChange={(event) => updateBand(index, 'max_weight', event.target.value)} onWheel={handleNumberWheel} onKeyDown={handleNumberKeyDown} />
            <button type="button" className="pricing-icon-button is-danger" onClick={() => onChange(bands.filter((_, bandIndex) => bandIndex !== index))} title="Видалити діапазон" aria-label="Видалити діапазон">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function AxisSelector({ allowEmpty = false, axisKey, axisQuestions, emptyLabel = 'Без колонок', label, onChange, supportCombo = false }) {
  const { primaryKey, secondaryKey } = splitComboAxis(axisKey);
  const commit = (nextPrimaryKey, nextSecondaryKey = secondaryKey) => {
    if (!nextPrimaryKey) {
      onChange('');
      return;
    }
    onChange(nextSecondaryKey ? `${nextPrimaryKey}+${nextSecondaryKey}` : nextPrimaryKey);
  };

  return (
    <div className={supportCombo ? 'pricing-axis-combo' : ''}>
      <FieldControl label={label}>
        <select className="input-sm" value={primaryKey} onChange={(event) => commit(event.target.value, '')}>
          {allowEmpty && <option value="">{emptyLabel}</option>}
          {!allowEmpty && <option value="">Оберіть питання</option>}
          {axisQuestions.map((question) => <option key={question.id} value={question.id}>{question.label || question.id}</option>)}
        </select>
      </FieldControl>
      {supportCombo && (
        <FieldControl label="Додаткова колонка" hint="Для комбінованої осі.">
          <select className="input-sm" value={secondaryKey} disabled={!primaryKey} onChange={(event) => commit(primaryKey, event.target.value)}>
            <option value="">Немає</option>
            {axisQuestions.filter((question) => question.id !== primaryKey).map((question) => (
              <option key={question.id} value={question.id}>{question.label || question.id}</option>
            ))}
          </select>
        </FieldControl>
      )}
    </div>
  );
}

function ScenarioForm({ config, currentCatQuestions, groupOptions, isNew = false, onCancel, onSave, scenario, selectedCat, setScenario }) {
  const categoryRequiresWeight = Number(selectedCat?.requires_weight || 0) === 1;
  const availableAxisQuestions = getAxisQuestions(currentCatQuestions, categoryRequiresWeight);

  return (
    <div className="pricing-settings-form">
      <SettingsSection title="Загальні">
        <div className="pricing-form-grid two-columns">
          <FieldControl label="Назва сценарію">
            <input className="input-sm" placeholder="Натур. Калібрований - 1 сорт" value={scenario.name} onChange={(event) => setScenario({ ...scenario, name: event.target.value })} />
          </FieldControl>
          <FieldControl label="Група">
            <input className="input-sm" list="scenario-group-options" placeholder="Натур. Калібрований" value={scenario.group_name} onChange={(event) => setScenario({ ...scenario, group_name: event.target.value })} />
          </FieldControl>
        </div>
        <div className="pricing-form-grid three-columns">
          <FieldControl label="Статус">
            <select className="input-sm" value={scenario.status || 'draft'} onChange={(event) => setScenario({ ...scenario, status: event.target.value })}>
              <option value="draft">Чернетка</option><option value="active">Активна</option><option value="archived">Архівна</option>
            </select>
          </FieldControl>
          <FieldControl label="Пріоритет" hint="Більше число має перевагу.">
            <input className="input-sm" type="number" value={scenario.priority ?? 0} onChange={(event) => setScenario({ ...scenario, priority: event.target.value })} onWheel={handleNumberWheel} onKeyDown={handleNumberKeyDown} />
          </FieldControl>
          <FieldControl label="Режим ціни">
            <select className="input-sm" value={scenario.price_mode || 'category_default'} onChange={(event) => setScenario({ ...scenario, price_mode: event.target.value })}>
              <option value="category_default">Як у категорії</option><option value="per_gram_usd">USD за грам</option><option value="fixed_uah">Фіксована сума UAH</option>
            </select>
          </FieldControl>
        </div>
        <label className="pricing-checkbox"><input type="checkbox" checked={scenario.apply_modifiers !== false} onChange={(event) => setScenario({ ...scenario, apply_modifiers: event.target.checked })} />Застосовувати модифікатори після матриці</label>
        <datalist id="scenario-group-options">{groupOptions.map((groupName) => <option key={groupName} value={groupName} />)}</datalist>
      </SettingsSection>

      <SettingsSection title="Умови">
        <ConditionBuilder config={config} label="Коли використовувати цей сценарій" questions={currentCatQuestions} value={scenario.match_json} onChange={(nextValue) => setScenario({ ...scenario, match_json: nextValue })} />
      </SettingsSection>

      <SettingsSection title="Структура матриці">
        <div className="pricing-form-grid two-columns">
          <AxisSelector
            axisKey={scenario.axis_x_key}
            axisQuestions={availableAxisQuestions}
            label="Рядки матриці"
            onChange={(nextValue) => setScenario({
              ...scenario,
              axis_x_key: nextValue,
              weight_bands: nextValue === 'weight_band' && !(scenario.weight_bands || []).length ? defaultWeightBands : scenario.weight_bands || [],
            })}
          />
          <AxisSelector allowEmpty axisKey={scenario.axis_y_key} axisQuestions={availableAxisQuestions.filter((question) => question.id !== 'weight_band')} label="Колонки матриці" onChange={(nextValue) => setScenario({ ...scenario, axis_y_key: nextValue })} supportCombo />
        </div>
        {scenario.axis_x_key === 'weight_band' && <WeightBandsEditor bands={scenario.weight_bands || []} onChange={(weightBands) => setScenario({ ...scenario, weight_bands: weightBands })} />}
      </SettingsSection>

      <div className="pricing-form-actions">
        <button type="button" onClick={onSave} className="btn btn-primary">{isNew ? 'Створити сценарій' : 'Зберегти сценарій'}</button>
        {onCancel && <button type="button" onClick={onCancel} className="btn btn-outline">Скасувати</button>}
      </div>
    </div>
  );
}

function ModifierForm({ config, currentCatQuestions, isNew = false, modifier, onCancel, onSave, setModifier }) {
  return (
    <div className="pricing-settings-form">
      <SettingsSection title="Правило модифікатора">
        <FieldControl label="Множник" hint="0.7 = знижка 30%, 1.15 = націнка 15%.">
          <input
            className="input-sm pricing-factor-input"
            type="number"
            min="0"
            placeholder="0.7"
            value={modifier.factor}
            onChange={(event) => { if (event.target.value >= 0) setModifier({ ...modifier, factor: event.target.value }); }}
            onWheel={handleNumberWheel}
            onKeyDown={handleNumberKeyDown}
          />
        </FieldControl>
        <ConditionBuilder config={config} label="Коли застосовувати модифікатор" questions={currentCatQuestions} value={modifier.match_json} onChange={(nextValue) => setModifier({ ...modifier, match_json: nextValue })} />
      </SettingsSection>
      <div className="pricing-form-actions">
        <button type="button" onClick={onSave} className="btn btn-primary">{isNew ? 'Додати модифікатор' : 'Зберегти модифікатор'}</button>
        {onCancel && <button type="button" onClick={onCancel} className="btn btn-outline">Скасувати</button>}
      </div>
    </div>
  );
}

function ScenarioMatrix({ currentCatQuestions, handlePriceChange, matrixValidationError, scenario, setMatrixValidationError }) {
  const axisX = getPricingAxis(scenario.axis_x_key, currentCatQuestions, 'X', scenario.weight_bands || [], scenario.match_json);
  const axisY = getPricingAxis(scenario.axis_y_key, currentCatQuestions, 'Base', scenario.weight_bands || [], scenario.match_json);

  return (
    <div className="pricing-matrix-panel">
      <div className="pricing-matrix-heading">
        <div><h4>Матриця цін</h4><p>{axisX.label} × {axisY.label}</p></div>
        <span>Порожня клітинка — немає автоматичної ціни</span>
      </div>
      {matrixValidationError && <div role="alert" className="pricing-matrix-error">{matrixValidationError}</div>}
      <div className="pricing-matrix-scroll">
        <table className="pricing-matrix-table">
          <thead>
            <tr>
              <th>{axisX.label} \ {axisY.label}</th>
              {axisY.options.map((option) => <th key={option.id}>{option.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {axisX.options.map((xOption) => (
              <tr key={xOption.id}>
                <th>{xOption.label}</th>
                {axisY.options.map((yOption) => {
                  const cell = scenario.matrix.find((item) => item.x_val === xOption.id && item.y_val === yOption.id);
                  return (
                    <td key={yOption.id}>
                      <input
                        type="text"
                        inputMode="decimal"
                        defaultValue={cell ? formatDecimal(cell.price) : ''}
                        placeholder="—"
                        aria-label={`${xOption.label}, ${yOption.label}`}
                        onChange={(event) => { event.currentTarget.value = normalizeDecimalInput(event.currentTarget.value); }}
                        onBlur={(event) => {
                          const normalizedPrice = normalizeDecimalInput(event.currentTarget.value);
                          const validationError = getMatrixPriceValidationError(normalizedPrice);
                          if (!normalizedPrice) {
                            setMatrixValidationError('');
                            Promise.resolve(handlePriceChange(scenario.id, xOption.id, yOption.id, null)).catch((error) => setMatrixValidationError(error.response?.data?.error || error.message));
                            return;
                          }
                          if (validationError) {
                            event.currentTarget.value = cell ? formatDecimal(cell.price) : '';
                            setMatrixValidationError(validationError);
                            return;
                          }
                          event.currentTarget.value = normalizedPrice;
                          setMatrixValidationError('');
                          Promise.resolve(handlePriceChange(scenario.id, xOption.id, yOption.id, normalizedPrice)).catch((error) => setMatrixValidationError(error.response?.data?.error || error.message));
                        }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AdminPricingEditor({
  config,
  selectedCat,
  pricesData,
  currentCatQuestions,
  editScenario,
  setEditScenario,
  newScenario,
  setNewScenario,
  newModifier,
  setNewModifier,
  editModifier,
  setEditModifier,
  beginModifierEdit,
  beginScenarioEdit,
  updateScenario,
  duplicateScenario,
  deleteItem,
  handlePriceChange,
  addScenario,
  saveModifierEdit,
  addModifier,
}) {
  const [workspaceMode, setWorkspaceMode] = useState('scenarios');
  const [scenarioTabState, setScenarioTabState] = useState({ scenarioId: null, tab: 'matrix' });
  const [scenarioSelection, setScenarioSelection] = useState({ categoryCode: null, id: null });
  const [modifierSelection, setModifierSelection] = useState({ categoryCode: null, id: null });
  const [newScenarioCategory, setNewScenarioCategory] = useState(null);
  const [newModifierCategory, setNewModifierCategory] = useState(null);
  const [scenarioQuery, setScenarioQuery] = useState('');
  const [scenarioStatusFilter, setScenarioStatusFilter] = useState('all');
  const [modifierQuery, setModifierQuery] = useState('');
  const [matrixValidation, setMatrixValidation] = useState({ scenarioId: null, message: '' });

  if (!selectedCat || !pricesData) return null;

  const scenarios = pricesData.scenarios || [];
  const modifiers = pricesData.modifiers || [];
  const selectedScenario = (
    scenarioSelection.categoryCode === selectedCat.code
      ? scenarios.find((scenario) => scenario.id === scenarioSelection.id)
      : null
  ) || scenarios[0] || null;
  const selectedModifier = (
    modifierSelection.categoryCode === selectedCat.code
      ? modifiers.find((modifier) => modifier.id === modifierSelection.id)
      : null
  ) || modifiers[0] || null;
  const isNewScenario = newScenarioCategory === selectedCat.code;
  const isNewModifier = newModifierCategory === selectedCat.code;
  const scenarioTab = scenarioTabState.scenarioId === selectedScenario?.id ? scenarioTabState.tab : 'matrix';
  const matrixValidationError = matrixValidation.scenarioId === selectedScenario?.id ? matrixValidation.message : '';
  const knownGroupNames = groupScenarios(scenarios).map((group) => group.name);
  const normalizedScenarioQuery = scenarioQuery.trim().toLocaleLowerCase('uk');
  const filteredScenarios = scenarios.filter((scenario) => {
    const matchesSearch = !normalizedScenarioQuery || [scenario.name, getScenarioGroupName(scenario), formatConditionSummary(scenario.match_json, currentCatQuestions, config, 'Завжди')]
      .some((value) => String(value || '').toLocaleLowerCase('uk').includes(normalizedScenarioQuery));
    const matchesStatus = scenarioStatusFilter === 'all'
      || (scenarioStatusFilter === 'active' && scenario.status === 'active')
      || (scenarioStatusFilter === 'inactive' && scenario.status !== 'active');
    return matchesSearch && matchesStatus;
  });
  const filteredScenarioGroups = groupScenarios(filteredScenarios);
  const normalizedModifierQuery = modifierQuery.trim().toLocaleLowerCase('uk');
  const filteredModifiers = modifiers.filter((modifier) => {
    const summary = formatConditionSummary(getModifierRule(modifier), currentCatQuestions, config, 'Завжди');
    return !normalizedModifierQuery || `${summary} ${formatDecimal(modifier.factor)}`.toLocaleLowerCase('uk').includes(normalizedModifierQuery);
  });

  const selectScenario = (scenario) => {
    setScenarioSelection({ categoryCode: selectedCat.code, id: scenario.id });
    setNewScenarioCategory(null);
    setScenarioTabState({ scenarioId: scenario.id, tab: 'matrix' });
    setMatrixValidation({ scenarioId: scenario.id, message: '' });
    setEditScenario(null);
  };

  const openScenarioSettings = () => {
    if (!selectedScenario) return;
    if (editScenario?.id !== selectedScenario.id) beginScenarioEdit(selectedScenario);
    setScenarioTabState({ scenarioId: selectedScenario.id, tab: 'settings' });
  };

  const selectModifier = (modifier) => {
    setModifierSelection({ categoryCode: selectedCat.code, id: modifier.id });
    setNewModifierCategory(null);
    setEditModifier(null);
  };

  const openModifierEdit = () => {
    if (!selectedModifier) return;
    beginModifierEdit(selectedModifier);
  };

  return (
    <div className="pricing-shell fade-up">
      <div className="pricing-workspace-header">
        <div><p className="eyebrow">Ціни</p><h2>Ціноутворення · {selectedCat.name}</h2></div>
        <div className="pricing-mode-tabs" role="tablist" aria-label="Режим ціноутворення">
          <button type="button" role="tab" aria-selected={workspaceMode === 'scenarios'} className={workspaceMode === 'scenarios' ? 'is-active' : ''} onClick={() => setWorkspaceMode('scenarios')}>Сценарії</button>
          <button type="button" role="tab" aria-selected={workspaceMode === 'modifiers'} className={workspaceMode === 'modifiers' ? 'is-active' : ''} onClick={() => setWorkspaceMode('modifiers')}>Модифікатори</button>
        </div>
      </div>

      <div className="pricing-workspace">
        {workspaceMode === 'scenarios' ? (
          <>
            <aside className="pricing-master">
              <div className="pricing-master-header"><div><h3>Сценарії</h3><p>{scenarios.length} у категорії</p></div><button type="button" className="btn btn-amber flex items-center gap-1.5 px-3 py-2 text-xs" onClick={() => { setNewScenarioCategory(selectedCat.code); setEditScenario(null); }}><Plus size={14} />Додати</button></div>
              <div className="pricing-master-filters">
                <label className="pricing-search"><Search size={14} /><input value={scenarioQuery} onChange={(event) => setScenarioQuery(event.target.value)} placeholder="Пошук сценарію" /></label>
                <select value={scenarioStatusFilter} onChange={(event) => setScenarioStatusFilter(event.target.value)} aria-label="Фільтр статусу сценаріїв"><option value="all">Усі статуси</option><option value="active">Активні</option><option value="inactive">Неактивні</option></select>
              </div>
              <div className="pricing-master-list">
                {filteredScenarioGroups.map((group) => (
                  <section key={group.name} className="pricing-scenario-group">
                    <div className="pricing-scenario-group-title"><span>{group.name}</span><small>{group.scenarios.length}</small></div>
                    {group.scenarios.map((scenario) => (
                      <button key={scenario.id} type="button" onClick={() => selectScenario(scenario)} className={`pricing-master-row ${selectedScenario?.id === scenario.id && !isNewScenario ? 'is-selected' : ''}`}>
                        <div className="pricing-master-row-title"><i className={`is-${scenario.status || 'active'}`} /><strong>{scenario.name}</strong></div>
                        <div className="pricing-master-row-meta"><span>{getStatusLabel(scenario.status)}</span><span>Пріоритет {scenario.priority || 0}</span><span>{getPriceModeLabel(scenario.price_mode)}</span></div>
                      </button>
                    ))}
                  </section>
                ))}
                {filteredScenarioGroups.length === 0 && <p className="pricing-empty-state">Сценарії не знайдено.</p>}
              </div>
            </aside>

            <main className="pricing-detail">
              {isNewScenario ? (
                <>
                  <div className="pricing-detail-header"><div><h3>Новий сценарій</h3><p>Налаштування для категорії {selectedCat.name}</p></div><button type="button" className="btn btn-outline px-3 py-2 text-xs" onClick={() => setNewScenarioCategory(null)}>Закрити</button></div>
                  <ScenarioForm config={config} currentCatQuestions={currentCatQuestions} groupOptions={knownGroupNames} isNew onCancel={() => setNewScenarioCategory(null)} onSave={addScenario} scenario={newScenario} selectedCat={selectedCat} setScenario={setNewScenario} />
                </>
              ) : selectedScenario ? (
                <>
                  <div className="pricing-detail-header">
                    <div className="min-w-0"><h3>{selectedScenario.name}</h3><p>Умова: {formatConditionSummary(selectedScenario.match_json, currentCatQuestions, config, 'Завжди')}</p></div>
                    <div className="pricing-detail-actions">
                      <button type="button" className="btn btn-outline flex items-center gap-1.5 px-3 py-2 text-xs" onClick={openScenarioSettings}><Pencil size={14} />Редагувати</button>
                      <button type="button" className="pricing-icon-button" onClick={() => duplicateScenario(selectedScenario.id)} title="Дублювати сценарій" aria-label="Дублювати сценарій"><Copy size={15} /></button>
                      <button type="button" className="pricing-icon-button is-danger" onClick={() => deleteItem('scenario', selectedScenario.id)} title="Видалити сценарій" aria-label="Видалити сценарій"><Trash2 size={15} /></button>
                    </div>
                  </div>
                  <div className="pricing-meta-strip">
                    <MetaItem label="Статус" value={getStatusLabel(selectedScenario.status)} />
                    <MetaItem label="Група" value={getScenarioGroupName(selectedScenario)} />
                    <MetaItem label="Пріоритет" value={selectedScenario.priority || 0} />
                    <MetaItem label="Режим" value={getPriceModeLabel(selectedScenario.price_mode)} />
                  </div>
                  <div className="pricing-local-tabs" role="tablist" aria-label="Редактор сценарію">
                    <button type="button" role="tab" aria-selected={scenarioTab === 'matrix'} className={scenarioTab === 'matrix' ? 'is-active' : ''} onClick={() => setScenarioTabState({ scenarioId: selectedScenario.id, tab: 'matrix' })}>Матриця</button>
                    <button type="button" role="tab" aria-selected={scenarioTab === 'settings'} className={scenarioTab === 'settings' ? 'is-active' : ''} onClick={openScenarioSettings}>Налаштування</button>
                  </div>
                  {scenarioTab === 'matrix' ? (
                    <ScenarioMatrix currentCatQuestions={currentCatQuestions} handlePriceChange={handlePriceChange} matrixValidationError={matrixValidationError} scenario={selectedScenario} setMatrixValidationError={(message) => setMatrixValidation({ scenarioId: selectedScenario.id, message })} />
                  ) : editScenario?.id === selectedScenario.id ? (
                    <ScenarioForm config={config} currentCatQuestions={currentCatQuestions} groupOptions={knownGroupNames} onCancel={() => { setEditScenario(null); setScenarioTabState({ scenarioId: selectedScenario.id, tab: 'matrix' }); }} onSave={updateScenario} scenario={editScenario} selectedCat={selectedCat} setScenario={setEditScenario} />
                  ) : null}
                </>
              ) : <div className="pricing-detail-empty"><h3>Виберіть сценарій</h3><p>Матриця та налаштування відкриються у цій панелі.</p></div>}
            </main>
          </>
        ) : (
          <>
            <aside className="pricing-master">
              <div className="pricing-master-header"><div><h3>Модифікатори</h3><p>{modifiers.length} у категорії</p></div><button type="button" className="btn btn-amber flex items-center gap-1.5 px-3 py-2 text-xs" onClick={() => { setNewModifierCategory(selectedCat.code); setEditModifier(null); }}><Plus size={14} />Додати</button></div>
              <div className="pricing-master-filters"><label className="pricing-search full-width"><Search size={14} /><input value={modifierQuery} onChange={(event) => setModifierQuery(event.target.value)} placeholder="Пошук модифікатора" /></label></div>
              <div className="pricing-master-list">
                {filteredModifiers.map((modifier) => {
                  const summary = formatConditionSummary(getModifierRule(modifier), currentCatQuestions, config, 'Завжди');
                  return (
                    <button key={modifier.id} type="button" onClick={() => selectModifier(modifier)} className={`pricing-master-row ${selectedModifier?.id === modifier.id && !isNewModifier ? 'is-selected' : ''}`}>
                      <strong className="pricing-modifier-summary">{summary}</strong>
                      <div className="pricing-master-row-meta"><span>Множник {formatDecimal(modifier.factor)}</span></div>
                    </button>
                  );
                })}
                {filteredModifiers.length === 0 && <p className="pricing-empty-state">Модифікатори не знайдено.</p>}
              </div>
            </aside>

            <main className="pricing-detail">
              {isNewModifier ? (
                <>
                  <div className="pricing-detail-header"><div><h3>Новий модифікатор</h3><p>Коригування ціни після матриці</p></div><button type="button" className="btn btn-outline px-3 py-2 text-xs" onClick={() => setNewModifierCategory(null)}>Закрити</button></div>
                  <ModifierForm config={config} currentCatQuestions={currentCatQuestions} isNew modifier={newModifier} onCancel={() => setNewModifierCategory(null)} onSave={addModifier} setModifier={setNewModifier} />
                </>
              ) : selectedModifier ? (
                <>
                  <div className="pricing-detail-header">
                    <div className="min-w-0"><h3>Модифікатор ×{formatDecimal(selectedModifier.factor)}</h3><p>{formatConditionSummary(getModifierRule(selectedModifier), currentCatQuestions, config, 'Завжди')}</p></div>
                    <div className="pricing-detail-actions">
                      {!editModifier && <button type="button" className="btn btn-outline flex items-center gap-1.5 px-3 py-2 text-xs" onClick={openModifierEdit}><Pencil size={14} />Редагувати</button>}
                      <button type="button" className="pricing-icon-button is-danger" onClick={() => deleteItem('modifier', selectedModifier.id)} title="Видалити модифікатор" aria-label="Видалити модифікатор"><Trash2 size={15} /></button>
                    </div>
                  </div>
                  {editModifier?.id === selectedModifier.id ? (
                    <ModifierForm config={config} currentCatQuestions={currentCatQuestions} modifier={editModifier} onCancel={() => setEditModifier(null)} onSave={saveModifierEdit} setModifier={setEditModifier} />
                  ) : (
                    <div className="pricing-modifier-overview">
                      <SettingsSection title="Правило"><MetaItem label="Умова" value={formatConditionSummary(getModifierRule(selectedModifier), currentCatQuestions, config, 'Завжди')} /><MetaItem label="Множник" value={formatDecimal(selectedModifier.factor)} /></SettingsSection>
                    </div>
                  )}
                </>
              ) : <div className="pricing-detail-empty"><h3>Виберіть модифікатор</h3><p>Правило та множник відкриються у цій панелі.</p></div>}
            </main>
          </>
        )}
      </div>
    </div>
  );
}
