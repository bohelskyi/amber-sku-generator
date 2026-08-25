import { useEffect, useMemo, useState } from 'react';
import {
  getConditionSources,
  parseConditionRows,
  stringifyConditionRows,
} from '../../lib/admin-conditions';

const normalizeValue = (value) => {
  if (value === null || value === undefined) return '';
  return String(value);
};

export function ConditionBuilder({
  config,
  excludeQuestionId,
  label = 'Видимість',
  onChange,
  questions,
  value,
}) {
  const parsedValue = useMemo(() => parseConditionRows(value), [value]);
  const sources = useMemo(
    () => getConditionSources(questions, config, excludeQuestionId),
    [questions, config, excludeQuestionId]
  );
  const [rows, setRows] = useState(parsedValue.rows);
  const [logicMode, setLogicMode] = useState(parsedValue.mode);

  useEffect(() => {
    if (!parsedValue.isValid) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRows(parsedValue.rows);
    setLogicMode(parsedValue.mode);
  }, [parsedValue]);

  const commitRows = (nextRows, nextLogicMode = logicMode) => {
    setRows(nextRows);
    setLogicMode(nextLogicMode);
    onChange(stringifyConditionRows(nextRows, nextLogicMode));
  };

  const addCondition = () => {
    const usedKeys = new Set(rows.map((row) => row.key).filter(Boolean));
    const source = sources.find((item) => !usedKeys.has(item.key)) || sources[0];
    if (!source) return;

    commitRows([
      ...rows,
      {
        key: source.key,
        values: [],
      },
    ]);
  };

  const updateRow = (index, patch) => {
    const nextRows = rows.map((row, rowIndex) =>
      rowIndex === index ? { ...row, ...patch } : row
    );
    commitRows(nextRows);
  };

  const removeRow = (index) => {
    commitRows(rows.filter((_, rowIndex) => rowIndex !== index));
  };

  const setMode = (mode) => {
    if (mode === 'always') {
      commitRows([]);
      return;
    }

    if (rows.length === 0) addCondition();
  };

  const changeLogicMode = (nextLogicMode) => {
    commitRows(rows, nextLogicMode);
  };

  return (
    <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-slate-500">{label}</div>
        <select
          className="input-sm max-w-[180px]"
          value={rows.length > 0 ? 'conditional' : 'always'}
          onChange={(event) => setMode(event.target.value)}
        >
          <option value="always">Завжди</option>
          <option value="conditional">За умовою</option>
        </select>
      </div>

      {!parsedValue.isValid && (
        <div className="mb-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          Умова зараз не схожа на JSON. Виправте її в розширеному полі нижче.
        </div>
      )}

      {rows.length > 0 && (
        <div className="space-y-3">
          {rows.length > 1 && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-500">Логіка</span>
              <select
                className="input-sm max-w-[180px]"
                value={logicMode}
                onChange={(event) => changeLogicMode(event.target.value)}
              >
                <option value="all">Усі умови</option>
                <option value="any">Хоча б одна</option>
              </select>
            </div>
          )}
          {rows.map((row, index) => {
            const source = sources.find((item) => item.key === row.key);
            const isTextSource = source && (source.input_type || 'options') === 'text';

            return (
              <div key={`${row.key || 'condition'}-${index}`} className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="mb-2 flex items-center gap-2">
                  <select
                    className="input-sm"
                    value={row.key}
                    onChange={(event) => updateRow(index, { key: event.target.value, values: [] })}
                  >
                    <option value="">Оберіть питання</option>
                    {sources.map((item) => (
                      <option key={item.key} value={item.key}>{item.label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-outline px-2 py-1 text-xs"
                    onClick={() => removeRow(index)}
                  >
                    Прибрати
                  </button>
                </div>

                {source && !isTextSource && (
                  <div className="flex flex-wrap gap-2">
                    {(source.options || []).map((option) => {
                      const optionValue = normalizeValue(option.id);
                      const isSelected = row.values.includes(optionValue);

                      return (
                        <button
                          key={optionValue}
                          type="button"
                          className={`rounded-lg border px-2 py-1 text-xs transition ${isSelected ? 'border-[rgba(20,32,59,0.45)] bg-[rgba(20,32,59,0.08)] text-slate-900' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
                          onClick={() => {
                            const nextValues = isSelected
                              ? row.values.filter((item) => item !== optionValue)
                              : [...row.values, optionValue];
                            updateRow(index, { values: nextValues });
                          }}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                )}

                {source && isTextSource && (
                  <input
                    className="input-sm"
                    placeholder="Значення текстового поля"
                    value={row.values[0] || ''}
                    onChange={(event) => updateRow(index, { values: [event.target.value] })}
                  />
                )}
              </div>
            );
          })}

          {sources.length > rows.length && (
            <button type="button" className="btn btn-outline w-full text-xs" onClick={addCondition}>
              Додати ще умову
            </button>
          )}
        </div>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-slate-500">Розширений JSON</summary>
        <input
          className="input-sm mt-2 font-mono text-xs"
          placeholder='{"raw_type":1}'
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </details>
    </div>
  );
}
