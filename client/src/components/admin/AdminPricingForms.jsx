import { Plus, Trash2 } from 'lucide-react';
import { FormSection } from '../shared/FormSection';
import { ConditionBuilder } from './ConditionBuilder';
import { getMatrixPriceValidationError, handleNumberKeyDown, handleNumberWheel, normalizeDecimalInput } from '../../lib/number-input';
import { getPricingAxis } from '../../lib/pricing-axis';
import { getScenarioMatrixCellKey } from '../../lib/admin-pricing-state';
import { formatDecimal } from '../../lib/formatters';

const defaultWeightBands = [
  { label: 'До 10 г', min_weight: 0, max_weight: 10 },
  { label: '10-15 г', min_weight: 10, max_weight: 15 },
  { label: 'Від 15 г', min_weight: 15, max_weight: '' },
];

const getAxisQuestions = (questions = [], requiresWeight = false) => {
  const axisQuestions = questions.filter((question) => (question.input_type || 'options') !== 'text' && (question.options || []).length > 0);
  if (requiresWeight && !axisQuestions.some((question) => question.id === 'weight')) axisQuestions.push({ id: 'weight', label: 'Вага', input_type: 'text', options: [{ id: 0, label: 'Ціна за грам' }] });
  if (requiresWeight) axisQuestions.push({ id: 'weight_band', label: 'Діапазон ваги', input_type: 'options', options: [] });
  return axisQuestions;
};

const splitComboAxis = (axisKey) => {
  const keys = String(axisKey || '').split('+').map((key) => key.trim()).filter(Boolean);
  return { primaryKey: keys[0] || '', secondaryKey: keys[1] || '' };
};
function FieldControl({ children, hint, label }) {
  return (
    <label className="pricing-field-control">
      <span>{label}</span>
      <div>{children}{hint && <small>{hint}</small>}</div>
    </label>
  );
}

export function MetaItem({ label, value }) {
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

export function ScenarioForm({ config, currentCatQuestions, groupOptions, isNew = false, onCancel, onSave, scenario, selectedCat, setScenario }) {
  const categoryRequiresWeight = Number(selectedCat?.requires_weight || 0) === 1;
  const availableAxisQuestions = getAxisQuestions(currentCatQuestions, categoryRequiresWeight);

  return (
    <div className="pricing-settings-form">
      <FormSection title="Загальні">
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
      </FormSection>

      <FormSection title="Умови">
        <ConditionBuilder config={config} label="Коли використовувати цей сценарій" questions={currentCatQuestions} value={scenario.match_json} onChange={(nextValue) => setScenario({ ...scenario, match_json: nextValue })} />
      </FormSection>

      <FormSection title="Структура матриці">
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
      </FormSection>

      <div className="pricing-form-actions">
        <button type="button" onClick={onSave} className="btn btn-primary">{isNew ? 'Створити сценарій' : 'Зберегти сценарій'}</button>
        {onCancel && <button type="button" onClick={onCancel} className="btn btn-outline">Скасувати</button>}
      </div>
    </div>
  );
}

export function ModifierForm({ config, currentCatQuestions, isNew = false, modifier, onCancel, onSave, setModifier }) {
  return (
    <div className="pricing-settings-form">
      <FormSection title="Правило модифікатора">
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
      </FormSection>
      <div className="pricing-form-actions">
        <button type="button" onClick={onSave} className="btn btn-primary">{isNew ? 'Додати модифікатор' : 'Зберегти модифікатор'}</button>
        {onCancel && <button type="button" onClick={onCancel} className="btn btn-outline">Скасувати</button>}
      </div>
    </div>
  );
}

export function ScenarioMatrix({ currentCatQuestions, handlePriceChange, matrixValidationError, readOnly, scenario, setMatrixValidationError }) {
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
                        key={getScenarioMatrixCellKey(scenario.id, xOption.id, yOption.id, cell?.price)}
                        type="text"
                        inputMode="decimal"
                        defaultValue={cell ? formatDecimal(cell.price) : ''}
                        placeholder="—"
                        aria-label={`${xOption.label}, ${yOption.label}`}
                        readOnly={readOnly}
                        onChange={(event) => { event.currentTarget.value = normalizeDecimalInput(event.currentTarget.value); }}
                        onBlur={(event) => {
                          if (readOnly) return;
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

