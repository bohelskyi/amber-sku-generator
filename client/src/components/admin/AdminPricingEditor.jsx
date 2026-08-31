import { useState } from 'react';
import { ConditionBuilder } from './ConditionBuilder';
import {
  getMatrixPriceValidationError,
  handleNumberKeyDown,
  handleNumberWheel,
  normalizeDecimalInput,
} from '../../lib/number-input';
import { getPricingAxis } from '../../lib/pricing-axis';
import { formatConditionSummary } from '../../lib/admin-conditions';

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
  const keys = String(axisKey || '')
    .split('+')
    .map((key) => key.trim())
    .filter(Boolean);

  return {
    primaryKey: keys[0] || '',
    secondaryKey: keys[1] || '',
  };
};

function FieldControl({ children, hint, label }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-slate-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}

function WeightBandsEditor({ bands = [], onChange }) {
  const updateBand = (index, key, value) => {
    onChange(bands.map((band, bandIndex) => (
      bandIndex === index ? { ...band, [key]: value } : band
    )));
  };

  return (
    <div className="mt-3 border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold text-slate-700">Вагові діапазони</div>
        <button
          type="button"
          className="btn btn-outline px-2 py-1 text-xs"
          onClick={() => onChange([...bands, { label: '', min_weight: '', max_weight: '' }])}
        >
          Додати діапазон
        </button>
      </div>
      <div className="mt-3 space-y-2">
        {bands.map((band, index) => (
          <div key={band.id || index} className="grid gap-2 sm:grid-cols-[minmax(140px,1fr)_100px_100px_auto]">
            <input
              className="input-sm"
              value={band.label}
              placeholder="Назва"
              onChange={(event) => updateBand(index, 'label', event.target.value)}
            />
            <input
              className="input-sm"
              type="number"
              min="0"
              step="0.1"
              value={band.min_weight}
              placeholder="Від, включно"
              onChange={(event) => updateBand(index, 'min_weight', event.target.value)}
              onWheel={handleNumberWheel}
              onKeyDown={handleNumberKeyDown}
            />
            <input
              className="input-sm"
              type="number"
              min="0"
              step="0.1"
              value={band.max_weight ?? ''}
              placeholder="До, не включно"
              onChange={(event) => updateBand(index, 'max_weight', event.target.value)}
              onWheel={handleNumberWheel}
              onKeyDown={handleNumberKeyDown}
            />
            <button
              type="button"
              className="btn btn-outline px-2 py-1 text-xs"
              onClick={() => onChange(bands.filter((_, bandIndex) => bandIndex !== index))}
            >
              Видалити
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function AxisSelector({
  allowEmpty = false,
  axisKey,
  axisQuestions,
  emptyLabel = 'Без колонок',
  label,
  onChange,
  supportCombo = false,
}) {
  const { primaryKey, secondaryKey } = splitComboAxis(axisKey);

  const commit = (nextPrimaryKey, nextSecondaryKey = secondaryKey) => {
    if (!nextPrimaryKey) {
      onChange('');
      return;
    }

    onChange(nextSecondaryKey ? `${nextPrimaryKey}+${nextSecondaryKey}` : nextPrimaryKey);
  };

  return (
    <div className={supportCombo ? 'grid grid-cols-1 sm:grid-cols-2 gap-2' : ''}>
      <FieldControl label={label}>
        <select className="input-sm" value={primaryKey} onChange={(event) => commit(event.target.value, '')}>
          {allowEmpty && <option value="">{emptyLabel}</option>}
          {!allowEmpty && <option value="">Оберіть питання</option>}
          {axisQuestions.map((question) => (
            <option key={question.id} value={question.id}>{question.label || question.id}</option>
          ))}
        </select>
      </FieldControl>

      {supportCombo && (
        <FieldControl label="Додаткова колонка" hint="Для комбінованих осей на кшталт glass+additional.">
          <select
            className="input-sm"
            value={secondaryKey}
            disabled={!primaryKey}
            onChange={(event) => commit(primaryKey, event.target.value)}
          >
            <option value="">Немає</option>
            {axisQuestions
              .filter((question) => question.id !== primaryKey)
              .map((question) => (
                <option key={question.id} value={question.id}>{question.label || question.id}</option>
              ))}
          </select>
        </FieldControl>
      )}
    </div>
  );
}

function ScenarioForm({
  config,
  currentCatQuestions,
  groupOptions,
  onCancel,
  onSave,
  scenario,
  selectedCat,
  setScenario,
  title,
}) {
  const axisQuestions = getAxisQuestions(
    currentCatQuestions,
    Number(selectedCat?.requires_weight || 0) === 1
  );
  const categoryRequiresWeight = Number(selectedCat?.requires_weight || 0) === 1;
  const availableAxisQuestions = categoryRequiresWeight
    ? axisQuestions
    : getAxisQuestions(currentCatQuestions, false);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      {title && <div className="mb-3 text-xs font-semibold text-slate-500">{title}</div>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <FieldControl label="Назва матриці">
          <input className="input-sm" placeholder="Натур. Калібрований - 1 сорт" value={scenario.name} onChange={(event) => setScenario({ ...scenario, name: event.target.value })} />
        </FieldControl>
        <FieldControl label="Група">
          <input className="input-sm" list="scenario-group-options" placeholder="Натур. Калібрований" value={scenario.group_name} onChange={(event) => setScenario({ ...scenario, group_name: event.target.value })} />
        </FieldControl>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
        <FieldControl label="Статус">
          <select
            className="input-sm"
            value={scenario.status || 'draft'}
            onChange={(event) => setScenario({ ...scenario, status: event.target.value })}
          >
            <option value="draft">Чернетка</option>
            <option value="active">Активна</option>
            <option value="archived">Архівна</option>
          </select>
        </FieldControl>
        <FieldControl label="Пріоритет" hint="Більше число має перевагу.">
          <input
            className="input-sm"
            type="number"
            value={scenario.priority ?? 0}
            onChange={(event) => setScenario({ ...scenario, priority: event.target.value })}
            onWheel={handleNumberWheel}
            onKeyDown={handleNumberKeyDown}
          />
        </FieldControl>
        <FieldControl label="Режим ціни">
          <select
            className="input-sm"
            value={scenario.price_mode || 'category_default'}
            onChange={(event) => setScenario({ ...scenario, price_mode: event.target.value })}
          >
            <option value="category_default">Як у категорії</option>
            <option value="per_gram_usd">USD за грам</option>
            <option value="fixed_uah">Фіксована сума UAH</option>
          </select>
        </FieldControl>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={scenario.apply_modifiers !== false}
          onChange={(event) => setScenario({ ...scenario, apply_modifiers: event.target.checked })}
        />
        Застосовувати модифікатори після матриці
      </label>

      <datalist id="scenario-group-options">
        {groupOptions.map((groupName) => (
          <option key={groupName} value={groupName} />
        ))}
      </datalist>

      <div className="mt-3">
        <ConditionBuilder
          config={config}
          label="Коли використовувати цю матрицю"
          questions={currentCatQuestions}
          value={scenario.match_json}
          onChange={(nextValue) => setScenario({ ...scenario, match_json: nextValue })}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <AxisSelector
          axisKey={scenario.axis_x_key}
          axisQuestions={availableAxisQuestions}
          label="Рядки матриці"
          onChange={(nextValue) => setScenario({
            ...scenario,
            axis_x_key: nextValue,
            weight_bands: nextValue === 'weight_band' && !(scenario.weight_bands || []).length
              ? defaultWeightBands
              : scenario.weight_bands || [],
          })}
        />
        <AxisSelector
          allowEmpty
          axisKey={scenario.axis_y_key}
          axisQuestions={availableAxisQuestions.filter((question) => question.id !== 'weight_band')}
          label="Колонки матриці"
          onChange={(nextValue) => setScenario({ ...scenario, axis_y_key: nextValue })}
          supportCombo
        />
      </div>

      {scenario.axis_x_key === 'weight_band' && (
        <WeightBandsEditor
          bands={scenario.weight_bands || []}
          onChange={(weightBands) => setScenario({ ...scenario, weight_bands: weightBands })}
        />
      )}

      <div className="mt-3 flex gap-2">
        <button onClick={onSave} className="btn btn-primary text-xs">{title?.includes('Редагувати') ? 'Зберегти сценарій' : 'Створити сценарій'}</button>
        {onCancel && <button onClick={onCancel} className="btn btn-outline text-xs">Скасувати</button>}
      </div>
    </div>
  );
}

function ModifierForm({
  config,
  currentCatQuestions,
  modifier,
  onCancel,
  onSave,
  setModifier,
  title,
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      {title && <div className="mb-3 text-xs font-semibold text-slate-500">{title}</div>}
      <ConditionBuilder
        config={config}
        label="Коли застосовувати модифікатор"
        questions={currentCatQuestions}
        value={modifier.match_json}
        onChange={(nextValue) => setModifier({ ...modifier, match_json: nextValue })}
      />
      <FieldControl label="Множник" hint="0.7 = знижка 30%, 1.15 = націнка 15%.">
        <input
          className="input-sm"
          type="number"
          min="0"
          placeholder="0.7"
          value={modifier.factor}
          onChange={(event) => {
            if (event.target.value >= 0) setModifier({ ...modifier, factor: event.target.value });
          }}
          onWheel={handleNumberWheel}
          onKeyDown={handleNumberKeyDown}
        />
      </FieldControl>
      <div className="mt-3 flex gap-2">
        <button onClick={onSave} className="btn btn-primary text-xs">{title?.includes('Редагувати') ? 'Зберегти' : 'Додати'}</button>
        {onCancel && <button onClick={onCancel} className="btn btn-outline text-xs">Скасувати</button>}
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
  formatMatchJson,
  handlePriceChange,
  addScenario,
  saveModifierEdit,
  addModifier,
}) {
  const [openGroups, setOpenGroups] = useState({});
  const [matrixValidationError, setMatrixValidationError] = useState('');
  if (!selectedCat || !pricesData) return null;

  const scenarioGroups = groupScenarios(pricesData.scenarios);
  const knownGroupNames = scenarioGroups.map((group) => group.name);
  const toggleGroup = (groupName) => {
    setOpenGroups((prev) => ({ ...prev, [groupName]: !(prev[groupName] ?? false) }));
  };

  return (
    <div className="card p-6 sm:p-8 border-t-4 border-[rgba(20,32,59,0.4)] fade-up">
      <div className="section-title mb-6">
        <div>
          <p className="eyebrow">Ціни</p>
          <h2 className="section-title-text">Управління цінами ({selectedCat.name})</h2>
        </div>
      </div>

      {matrixValidationError && (
        <div role="alert" className="danger-panel mb-6 p-4 text-sm">
          {matrixValidationError}
        </div>
      )}

      <div className="space-y-4">
        {scenarioGroups.map((group, groupIndex) => {
          const isOpen = openGroups[group.name] ?? groupIndex === 0;

          return (
            <div key={group.name} className="rounded-2xl border border-slate-200 bg-white/70">
              <button
                type="button"
                onClick={() => toggleGroup(group.name)}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
              >
                <div>
                  <div className="text-sm font-semibold text-slate-800">{group.name}</div>
                  <div className="text-xs text-slate-500">Матриць: {group.scenarios.length}</div>
                </div>
                <span className="rounded-lg bg-slate-100 px-2 py-1 text-xs text-slate-600">
                  {isOpen ? 'Згорнути' : 'Розгорнути'}
                </span>
              </button>

              {isOpen && (
                <div className="space-y-6 border-t border-slate-200 p-4">
                  {group.scenarios.map((scenario) => {
                    const axisX = getPricingAxis(
                      scenario.axis_x_key,
                      currentCatQuestions,
                      'X',
                      scenario.weight_bands || [],
                      scenario.match_json
                    );
                    const axisY = getPricingAxis(
                      scenario.axis_y_key,
                      currentCatQuestions,
                      'Base',
                      scenario.weight_bands || [],
                      scenario.match_json
                    );
                    const optionsX = axisX.options;
                    const optionsY = axisY.options;

                    return (
                      <div key={scenario.id} className="border border-slate-200 p-4 rounded-2xl bg-slate-50/80 relative">
                        <div className="flex flex-wrap justify-between items-center gap-3 mb-3">
                          <div>
                            <h3 className="font-semibold text-lg text-slate-800">{scenario.name}</h3>
                            <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-500">
                              <span>Група: {getScenarioGroupName(scenario)}</span>
                              <span className="chip normal-case tracking-normal">
                                {scenario.status === 'draft'
                                  ? 'Чернетка'
                                  : scenario.status === 'archived'
                                    ? 'Архівна'
                                    : 'Активна'}
                              </span>
                              {scenario.apply_modifiers === false && (
                                <span className="chip normal-case tracking-normal">Без модифікаторів</span>
                              )}
                              <span className="chip normal-case tracking-normal">
                                Пріоритет: {scenario.priority || 0}
                              </span>
                              <span className="chip normal-case tracking-normal">
                                {scenario.price_mode === 'fixed_uah'
                                  ? 'Фіксована UAH'
                                  : scenario.price_mode === 'per_gram_usd'
                                    ? 'USD за грам'
                                    : 'Режим категорії'}
                              </span>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <button onClick={() => beginScenarioEdit(scenario)} className="btn btn-outline text-xs">Редагувати</button>
                            <button onClick={() => duplicateScenario(scenario.id)} className="btn btn-outline text-xs">Дублювати</button>
                            <button onClick={() => deleteItem('scenario', scenario.id)} className="btn btn-outline text-xs">Видалити сценарій</button>
                          </div>
                        </div>
                        <p className="text-xs text-slate-500 mb-4 bg-white px-2 py-1 inline-block rounded">Умова: {formatMatchJson(scenario.match_json)}</p>

                        {editScenario?.id === scenario.id && (
                          <div className="mb-4">
                            <ScenarioForm
                              config={config}
                              currentCatQuestions={currentCatQuestions}
                              groupOptions={knownGroupNames}
                              onCancel={() => setEditScenario(null)}
                              onSave={updateScenario}
                              scenario={editScenario}
                              selectedCat={selectedCat}
                              setScenario={setEditScenario}
                              title="Редагувати сценарій"
                            />
                          </div>
                        )}

                        <div className="overflow-x-auto">
                          <table className="min-w-full bg-white border border-slate-200 rounded-xl">
                            <thead>
                              <tr className="table-head">
                                <th className="table-cell text-left min-w-[150px]">{axisX.label} \ {axisY.label}</th>
                                {optionsY.map((option) => <th key={option.id} className="table-cell text-left text-xs">{option.label}</th>)}
                              </tr>
                            </thead>
                            <tbody>
                              {optionsX.map((xOption) => (
                                <tr key={xOption.id} className="border-t border-slate-100">
                                  <td className="table-cell font-semibold bg-slate-50 text-xs text-slate-700">{xOption.label}</td>
                                  {optionsY.map((yOption) => {
                                    const cell = scenario.matrix.find((item) => item.x_val === xOption.id && item.y_val === yOption.id);
                                    return (
                                      <td key={yOption.id} className="border-l border-slate-100 p-0">
                                        <input
                                          type="text"
                                          inputMode="decimal"
                                          className="w-full h-full p-2 text-center focus:bg-amber-50 outline-none min-w-[60px]"
                                          defaultValue={cell ? cell.price : ''}
                                          placeholder="-"
                                          onChange={(event) => {
                                            event.currentTarget.value = normalizeDecimalInput(event.currentTarget.value);
                                          }}
                                          onBlur={(event) => {
                                            const normalizedPrice = normalizeDecimalInput(event.currentTarget.value);
                                            const validationError = getMatrixPriceValidationError(normalizedPrice);

                                            if (!normalizedPrice) {
                                              setMatrixValidationError('');
                                              Promise.resolve(handlePriceChange(scenario.id, xOption.id, yOption.id, null))
                                                .catch((error) => setMatrixValidationError(
                                                  error.response?.data?.error || error.message
                                                ));
                                              return;
                                            }

                                            if (validationError) {
                                              event.currentTarget.value = cell ? String(cell.price) : '';
                                              setMatrixValidationError(validationError);
                                              return;
                                            }

                                            event.currentTarget.value = normalizedPrice;
                                            setMatrixValidationError('');
                                            Promise.resolve(handlePriceChange(
                                              scenario.id,
                                              xOption.id,
                                              yOption.id,
                                              normalizedPrice
                                            )).catch((error) => setMatrixValidationError(
                                              error.response?.data?.error || error.message
                                            ));
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
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-8 p-4 border border-dashed border-slate-300 rounded-2xl bg-slate-50/70">
        <h4 className="font-semibold text-slate-700 mb-2">Додати нову таблицю цін (Сценарій)</h4>
        <ScenarioForm
          config={config}
          currentCatQuestions={currentCatQuestions}
          groupOptions={knownGroupNames}
          onSave={addScenario}
          scenario={newScenario}
          selectedCat={selectedCat}
          setScenario={setNewScenario}
          title=""
        />
      </div>

      <div className="mt-12 border-t border-slate-200 pt-6">
        <h3 className="font-semibold text-lg mb-4 text-slate-800">Модифікатори (Знижки / Націнки)</h3>
        <div className="space-y-2 mb-4">
          {pricesData.modifiers.map((modifier) => {
            const modifierRule = modifier.match_json || (modifier.trigger_key ? { [modifier.trigger_key]: modifier.trigger_val } : {});
            return (
              <div key={modifier.id} className="p-3 bg-[rgba(221,151,74,0.14)] border border-[rgba(221,151,74,0.35)] rounded-xl">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">
                      {formatConditionSummary(modifierRule, currentCatQuestions, config, 'Завжди')}
                    </div>
                    <div className="text-xs text-slate-500">Множник: {modifier.factor}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => beginModifierEdit(modifier)} className="btn btn-outline text-xs">Редагувати</button>
                    <button onClick={() => deleteItem('modifier', modifier.id)} className="text-rose-500 hover:text-rose-700 px-2 font-bold">×</button>
                  </div>
                </div>

                {editModifier?.id === modifier.id && (
                  <div className="mt-3">
                    <ModifierForm
                      config={config}
                      currentCatQuestions={currentCatQuestions}
                      modifier={editModifier}
                      onCancel={() => setEditModifier(null)}
                      onSave={saveModifierEdit}
                      setModifier={setEditModifier}
                      title="Редагувати модифікатор"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="bg-slate-100 p-3 rounded-xl">
          <ModifierForm
            config={config}
            currentCatQuestions={currentCatQuestions}
            modifier={newModifier}
            onSave={addModifier}
            setModifier={setNewModifier}
            title="Новий модифікатор"
          />
        </div>
      </div>
    </div>
  );
}
