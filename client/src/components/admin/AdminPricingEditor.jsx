import { useState } from 'react';
import { Copy, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { FormSection } from '../shared/FormSection';
import { formatConditionSummary } from '../../lib/admin-conditions';
import { formatDecimal } from '../../lib/formatters';
import { MetaItem, ModifierForm, ScenarioForm, ScenarioMatrix } from './AdminPricingForms';
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
  readOnly = false,
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
    setScenarioSelection({ categoryCode: selectedCat.code, id: selectedScenario.id });
    if (editScenario?.id !== selectedScenario.id) beginScenarioEdit(selectedScenario);
    setScenarioTabState({ scenarioId: selectedScenario.id, tab: 'settings' });
  };

  const saveScenarioSettings = () => Promise.resolve(updateScenario()).then((savedScenario) => {
    if (!savedScenario) return;
    setScenarioSelection({ categoryCode: selectedCat.code, id: savedScenario.id });
    setScenarioTabState({ scenarioId: savedScenario.id, tab: 'settings' });
  });

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
              <div className="pricing-master-header"><div><h3>Сценарії</h3><p>{scenarios.length} у категорії</p></div>{!readOnly && <button type="button" className="btn btn-amber flex items-center gap-1.5 px-3 py-2 text-xs" onClick={() => { setNewScenarioCategory(selectedCat.code); setEditScenario(null); }}><Plus size={14} />Додати</button>}</div>
              <div className="pricing-master-filters">
                <label className="pricing-search"><Search size={14} /><input value={scenarioQuery} onChange={(event) => setScenarioQuery(event.target.value)} placeholder="Пошук сценарію" aria-label="Пошук цінового сценарію" /></label>
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
                    {!readOnly && <div className="pricing-detail-actions">
                      <button type="button" className="btn btn-outline flex items-center gap-1.5 px-3 py-2 text-xs" onClick={openScenarioSettings}><Pencil size={14} />Редагувати</button>
                      <button type="button" className="pricing-icon-button" onClick={() => duplicateScenario(selectedScenario.id)} title="Дублювати сценарій" aria-label="Дублювати сценарій"><Copy size={15} /></button>
                      <button type="button" className="pricing-icon-button is-danger" onClick={() => deleteItem('scenario', selectedScenario.id)} title="Видалити сценарій" aria-label="Видалити сценарій"><Trash2 size={15} /></button>
                    </div>}
                  </div>
                  <div className="pricing-meta-strip">
                    <MetaItem label="Статус" value={getStatusLabel(selectedScenario.status)} />
                    <MetaItem label="Група" value={getScenarioGroupName(selectedScenario)} />
                    <MetaItem label="Пріоритет" value={selectedScenario.priority || 0} />
                    <MetaItem label="Режим" value={getPriceModeLabel(selectedScenario.price_mode)} />
                  </div>
                  <div className="pricing-local-tabs" role="tablist" aria-label="Редактор сценарію">
                    <button type="button" role="tab" aria-selected={scenarioTab === 'matrix'} className={scenarioTab === 'matrix' ? 'is-active' : ''} onClick={() => setScenarioTabState({ scenarioId: selectedScenario.id, tab: 'matrix' })}>Матриця</button>
                    {!readOnly && <button type="button" role="tab" aria-selected={scenarioTab === 'settings'} className={scenarioTab === 'settings' ? 'is-active' : ''} onClick={openScenarioSettings}>Налаштування</button>}
                  </div>
                  {scenarioTab === 'matrix' ? (
                    <ScenarioMatrix currentCatQuestions={currentCatQuestions} handlePriceChange={handlePriceChange} matrixValidationError={matrixValidationError} readOnly={readOnly} scenario={selectedScenario} setMatrixValidationError={(message) => setMatrixValidation({ scenarioId: selectedScenario.id, message })} />
                  ) : editScenario?.id === selectedScenario.id ? (
                    <ScenarioForm config={config} currentCatQuestions={currentCatQuestions} groupOptions={knownGroupNames} onCancel={() => { setEditScenario(null); setScenarioTabState({ scenarioId: selectedScenario.id, tab: 'matrix' }); }} onSave={saveScenarioSettings} scenario={editScenario} selectedCat={selectedCat} setScenario={setEditScenario} />
                  ) : null}
                </>
              ) : <div className="pricing-detail-empty"><h3>Виберіть сценарій</h3><p>Матриця та налаштування відкриються у цій панелі.</p></div>}
            </main>
          </>
        ) : (
          <>
            <aside className="pricing-master">
              <div className="pricing-master-header"><div><h3>Модифікатори</h3><p>{modifiers.length} у категорії</p></div>{!readOnly && <button type="button" className="btn btn-amber flex items-center gap-1.5 px-3 py-2 text-xs" onClick={() => { setNewModifierCategory(selectedCat.code); setEditModifier(null); }}><Plus size={14} />Додати</button>}</div>
              <div className="pricing-master-filters"><label className="pricing-search full-width"><Search size={14} /><input value={modifierQuery} onChange={(event) => setModifierQuery(event.target.value)} placeholder="Пошук модифікатора" aria-label="Пошук цінового модифікатора" /></label></div>
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
                    {!readOnly && <div className="pricing-detail-actions">
                      {!editModifier && <button type="button" className="btn btn-outline flex items-center gap-1.5 px-3 py-2 text-xs" onClick={openModifierEdit}><Pencil size={14} />Редагувати</button>}
                      <button type="button" className="pricing-icon-button is-danger" onClick={() => deleteItem('modifier', selectedModifier.id)} title="Видалити модифікатор" aria-label="Видалити модифікатор"><Trash2 size={15} /></button>
                    </div>}
                  </div>
                  {editModifier?.id === selectedModifier.id ? (
                    <ModifierForm config={config} currentCatQuestions={currentCatQuestions} modifier={editModifier} onCancel={() => setEditModifier(null)} onSave={saveModifierEdit} setModifier={setEditModifier} />
                  ) : (
                    <div className="pricing-modifier-overview">
                      <FormSection title="Правило"><MetaItem label="Умова" value={formatConditionSummary(getModifierRule(selectedModifier), currentCatQuestions, config, 'Завжди')} /><MetaItem label="Множник" value={formatDecimal(selectedModifier.factor)} /></FormSection>
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
