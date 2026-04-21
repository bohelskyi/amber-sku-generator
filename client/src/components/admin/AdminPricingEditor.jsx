import { handleNumberKeyDown, handleNumberWheel } from '../../lib/number-input';
import { getPricingAxis } from '../../lib/pricing-axis';

export function AdminPricingEditor({
  selectedCat,
  pricesData,
  currentCatQuestions,
  editScenario,
  setEditScenario,
  newScenario,
  setNewScenario,
  newModifier,
  setNewModifier,
  beginScenarioEdit,
  updateScenario,
  duplicateScenario,
  deleteItem,
  formatMatchJson,
  handlePriceChange,
  addScenario,
  updateModifier,
  addModifier,
}) {
  if (!selectedCat || !pricesData) return null;

  return (
    <div className="card p-6 sm:p-8 border-t-4 border-[rgba(20,32,59,0.4)] fade-up">
      <div className="section-title mb-6">
        <div>
          <p className="eyebrow">Ціни</p>
          <h2 className="section-title-text">Управління цінами ({selectedCat.name})</h2>
        </div>
      </div>

      <div className="space-y-10">
        {pricesData.scenarios.map((scenario) => {
          const axisX = getPricingAxis(scenario.axis_x_key, currentCatQuestions, 'X');
          const axisY = getPricingAxis(scenario.axis_y_key, currentCatQuestions, 'Base');
          const optionsX = axisX.options;
          const optionsY = axisY.options;

          return (
            <div key={scenario.id} className="border border-slate-200 p-4 rounded-2xl bg-slate-50/80 relative">
              <div className="flex flex-wrap justify-between items-center gap-3 mb-3">
                <h3 className="font-semibold text-lg text-slate-800">{scenario.name}</h3>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => beginScenarioEdit(scenario)} className="btn btn-outline text-xs">Редагувати</button>
                  <button onClick={() => duplicateScenario(scenario.id)} className="btn btn-outline text-xs">Дублювати</button>
                  <button onClick={() => deleteItem('scenario', scenario.id)} className="btn btn-outline text-xs">Видалити сценарій</button>
                </div>
              </div>
              <p className="text-xs text-slate-500 mb-4 bg-white px-2 py-1 inline-block rounded">Умова: {formatMatchJson(scenario.match_json)}</p>

              {editScenario?.id === scenario.id && (
                <div className="mb-4 p-3 border border-slate-200 rounded-xl bg-white">
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                    <input className="input-sm" placeholder="Назва" value={editScenario.name} onChange={(event) => setEditScenario({ ...editScenario, name: event.target.value })} />
                    <input className="input-sm font-mono text-xs" placeholder="JSON умова" value={editScenario.match_json} onChange={(event) => setEditScenario({ ...editScenario, match_json: event.target.value })} />
                    <input className="input-sm" placeholder="Вісь X key" value={editScenario.axis_x_key} onChange={(event) => setEditScenario({ ...editScenario, axis_x_key: event.target.value })} />
                    <input className="input-sm" placeholder="Вісь Y key або glass+additional" value={editScenario.axis_y_key} onChange={(event) => setEditScenario({ ...editScenario, axis_y_key: event.target.value })} />
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button onClick={updateScenario} className="btn btn-primary text-xs">Зберегти сценарій</button>
                    <button onClick={() => setEditScenario(null)} className="btn btn-outline text-xs">Скасувати</button>
                  </div>
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
                                type="number"
                                min="0"
                                onKeyDown={(event) => { if (event.key === '-') event.preventDefault(); handleNumberKeyDown(event); }}
                                onWheel={handleNumberWheel}
                                className="w-full h-full p-2 text-center focus:bg-amber-50 outline-none min-w-[60px]"
                                defaultValue={cell ? cell.price : ''}
                                placeholder="-"
                                onBlur={(event) => {
                                  if (event.target.value < 0) event.target.value = 0;
                                  handlePriceChange(scenario.id, xOption.id, yOption.id, event.target.value);
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

      <div className="mt-8 p-4 border border-dashed border-slate-300 rounded-2xl bg-slate-50/70">
        <h4 className="font-semibold text-slate-700 mb-2">Додати нову таблицю цін (Сценарій)</h4>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <input className="input-sm" placeholder="Назва (напр. Некалібровані)" value={newScenario.name} onChange={(event) => setNewScenario({ ...newScenario, name: event.target.value })} />
          <input className="input-sm font-mono text-xs" placeholder='JSON: {"raw_type":1, "is_calibrated":2}' value={newScenario.match_json} onChange={(event) => setNewScenario({ ...newScenario, match_json: event.target.value })} />
          <input className="input-sm" placeholder="Вісь X Key (напр. size)" value={newScenario.axis_x_key} onChange={(event) => setNewScenario({ ...newScenario, axis_x_key: event.target.value })} />
          <input className="input-sm" placeholder="Вісь Y Key (напр. glass+additional)" value={newScenario.axis_y_key} onChange={(event) => setNewScenario({ ...newScenario, axis_y_key: event.target.value })} />
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Для комбінованої осі введи ключі через +, наприклад glass+additional. Перший ключ має варіант 1 = “так”, другий може бути необовʼязковим списком.
        </p>
        <button onClick={addScenario} className="btn btn-primary mt-3">Створити сценарій</button>
      </div>

      <div className="mt-12 border-t border-slate-200 pt-6">
        <h3 className="font-semibold text-lg mb-4 text-slate-800">Модифікатори (Знижки / Націнки)</h3>
        <div className="space-y-2 mb-4">
          {pricesData.modifiers.map((modifier) => (
            <div key={modifier.id} className="flex flex-wrap items-center gap-3 p-3 bg-[rgba(221,151,74,0.14)] border border-[rgba(221,151,74,0.35)] rounded-xl">
              <span className="text-sm">Якщо <b>{modifier.trigger_key}</b> = {modifier.trigger_val}</span>
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-600">Множник:</span>
                <input type="number" className="input-xs w-24 text-center font-semibold" defaultValue={modifier.factor} onBlur={(event) => updateModifier(modifier.id, event.target.value)} onWheel={handleNumberWheel} onKeyDown={handleNumberKeyDown} />
              </div>
              <button onClick={() => deleteItem('modifier', modifier.id)} className="text-rose-500 hover:text-rose-700 px-2 font-bold">×</button>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2 items-center bg-slate-100 p-3 rounded-xl">
          <span className="text-sm font-semibold">Новий:</span>
          <input className="input-xs w-28" placeholder="Key (quality)" value={newModifier.trigger_key} onChange={(event) => setNewModifier({ ...newModifier, trigger_key: event.target.value })} />
          <input className="input-xs w-24" type="number" placeholder="Val (2)" value={newModifier.trigger_val} onChange={(event) => setNewModifier({ ...newModifier, trigger_val: event.target.value })} onWheel={handleNumberWheel} onKeyDown={handleNumberKeyDown} />
          <input
            className="input-xs w-24"
            type="number"
            min="0"
            placeholder="Factor (0.7)"
            value={newModifier.factor}
            onChange={(event) => {
              if (event.target.value >= 0) setNewModifier({ ...newModifier, factor: event.target.value });
            }}
            onWheel={handleNumberWheel}
            onKeyDown={handleNumberKeyDown}
          />
          <button onClick={addModifier} className="btn btn-amber">Додати</button>
        </div>
      </div>
    </div>
  );
}
