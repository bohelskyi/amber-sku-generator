import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { sourceLabel } from '../../lib/export-template-presentation.js';
import { appendPlacement, hasControlCharacter, placementRules, removePlacement, updatePlacement } from '../../lib/magento-placement-rule.js';
import { availableSources } from '../../lib/export-template-columns.js';
import { useSourceEvidence } from '../../hooks/useTemplateSourceEvidence.js';
import { currentOptionIds, currentOptionLabel, optionDisplayLabel } from '../../lib/export-template-option-labels.js';
import { ObservedCategoryPicker } from '../workspace/MagentoObservedSelectors.jsx';
import { Notice } from '../app/UiPrimitives.jsx';
import { RuleSummary } from './RuleSummary.jsx';
import MagentoCategoryPlan from '../workspace/MagentoCategoryPlan.jsx';

function PlacementCondition({ row, definition, registry, loadSource }) {
  const evidence = useSourceEvidence(row.sourceId ? definition.sources[row.sourceId] : null, loadSource);
  return row.scope === 'all' ? 'Усі товари цієї категорії'
    : <>{sourceLabel(definition, row.sourceId, registry)} = {optionDisplayLabel(evidence, row.valueId)}</>;
}

export default function MagentoPlacementRuleEditor({ definition, cellPath, registry, loadSource, readOnly, onChange, onEditing, initialRow = null, tableOnly = false, onEditRow }) {
  const [observation, setObservation] = useState(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [kind, setKind] = useState('existing'); const [selectedPath, setSelectedPath] = useState(initialRow?.path || ''); const [name, setName] = useState('');
  const [scope, setScope] = useState(initialRow?.scope || ''); const [sourceId, setSourceId] = useState(initialRow?.sourceId || ''); const [valueId, setValueId] = useState(initialRow?.valueId ?? ''); const [receipt, setReceipt] = useState('');
  const [categoryPlan, setCategoryPlan] = useState(null);
  const [editing, setEditing] = useState(initialRow);
  const formHeading = useRef(null);
  const sequence = useRef(0); useEffect(() => () => { ++sequence.current; }, []);
  const source = definition.sources?.[sourceId]; const evidence = useSourceEvidence(source, loadSource);
  const rows = placementRules(definition, cellPath);
  const group = definition.groups[cellPath[1]];
  const authorized = availableSources(registry, group.route, definition);
  const sources = Object.entries(definition.sources || {}).filter(([, item]) => item.kind === 'semantic' && item.category === group.route
    && authorized.some((choice) => ['kind', 'category', 'key'].every((key) => choice.descriptor[key] === item[key])));
  const options = currentOptionIds(evidence).filter((id) => currentOptionLabel(evidence, id));
  const targetPath = kind === 'new' && name.trim() && selectedPath ? `${selectedPath}/${name.trim()}` : kind === 'existing' ? selectedPath : '';
  const set = (setter, value) => { if ([setKind, setSelectedPath, setName].includes(setter)) setCategoryPlan(null); setter(value); setReceipt(''); onEditing?.(); };
  async function discover() {
    const ticket = ++sequence.current; setBusy(true); setError(''); setCategoryPlan(null);
    try { const { data } = await api.post('/admin/magento-integration/discovery', {}); if (ticket === sequence.current) { setCategoryPlan(null); setObservation(data); } }
    catch (cause) { if (ticket === sequence.current) setError(cause.response?.data?.error || 'Не вдалося прочитати розділи магазину.'); }
    finally { if (ticket === sequence.current) setBusy(false); }
  }
  function resetForm() {
    setEditing(null); setKind('existing'); setSelectedPath(''); setName(''); setScope(''); setSourceId(''); setValueId(''); setCategoryPlan(null);
  }
  function edit(row) {
    if (onEditRow) { onEditRow(row); return; }
    setEditing(row); setKind('existing'); setSelectedPath(row.path); setName(''); setScope(row.scope);
    setSourceId(row.sourceId || ''); setValueId(row.valueId ?? ''); setCategoryPlan(null); setReceipt(''); setError('');
    formHeading.current?.focus();
  }
  function remove(row) {
    if (readOnly || busy) return;
    try {
      onChange(removePlacement(definition, cellPath, row));
      setReceipt(`Розміщення «${row.path.split('/').join(' › ')}» вилучено з редагованого правила.`); setError('');
    } catch (cause) { setError(cause.message); }
  }
  function savePlacement() {
    if (readOnly || busy) return;
    try {
      if (!scope || scope === 'condition' && (!sources.some(([id]) => id === sourceId) || !options.includes(valueId))) throw new Error('Оберіть, які товари потраплятимуть до розділу.');
      const matches = observation?.categories?.filter((item) => item.comparable && item.normalizedPath === selectedPath) || [];
      if (matches.length !== 1) throw new Error('Повторно оберіть однозначний розділ магазину.');
      if (kind === 'new' && (!name.trim() || name !== name.trim() || /[/,]/.test(name) || hasControlCharacter(name))) throw new Error('Вкажіть назву підкатегорії без /, коми та крайніх пробілів.');
      if (kind === 'new' && observation.categories.some((item) => item.normalizedPath === targetPath)) throw new Error('Ця підкатегорія вже існує. Оберіть наявний розділ.');
      if (kind === 'new' && (categoryPlan?.path !== targetPath || categoryPlan.categoryCode !== group.route)) throw new Error('Спочатку перевірте точний шлях і вплив створення.');
      const next = editing ? updatePlacement(definition, cellPath, editing, targetPath, scope === 'condition' ? sourceId : null, valueId)
        : appendPlacement(definition, cellPath, targetPath, scope === 'condition' ? sourceId : null, valueId);
      onChange(next);
      setReceipt(`${editing ? 'Змінено' : 'Додано'} розміщення: ${targetPath.split('/').join(' › ')}.`); setError(''); resetForm();
    } catch (cause) { setError(cause.message); }
  }
  return <section className="space-y-3" aria-label="Розміщення товарів у магазині">
    <div className="mc-table-scroll"><table className="mc-field-table"><caption className="sr-only">Правила розміщення товарів</caption>
      <thead><tr><th>Для яких товарів</th><th>Розділ магазину</th><th>Дії</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.key}>
        <td>{row.supported ? <PlacementCondition row={row} definition={definition} registry={registry} loadSource={loadSource} /> : 'Складне або спільне правило'}</td>
        <td>{row.supported ? row.path.split('/').join(' › ') : <details><summary>Переглянути збережене правило</summary><RuleSummary definition={definition} expression={row.expression} registry={registry} loadSource={loadSource} /></details>}</td>
        <td>{!row.supported ? <p className="text-sm">Збережено без змін. Редагується в розширених налаштуваннях.</p> : readOnly ? 'Лише перегляд' : <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || Boolean(editing)} aria-label={`Редагувати розміщення ${row.path}`} onClick={() => edit(row)}>Редагувати</button>
          <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || Boolean(editing)} aria-label={`Вилучити розміщення ${row.path}`} onClick={() => remove(row)}>Вилучити</button>
        </div>}</td>
      </tr>)}</tbody>
    </table></div>
    {!rows.length && <p>Розміщень у цьому правилі ще немає.</p>}
    {error && <Notice tone="error">{error}</Notice>}
    {receipt && <Notice>{receipt} {tableOnly ? 'Перевірте зміни перед застосуванням.' : 'Збережіть поле й перевірте вплив перед застосуванням змін у магазині.'}</Notice>}
    {!readOnly && !tableOnly && <>
      <h3 ref={formHeading} tabIndex={-1} className="font-semibold">{editing ? 'Змінити розміщення' : 'Додати розміщення'}</h3>
      {editing && <><p>Змінюємо лише вибране розміщення. Решта правил залишиться без змін.</p><button type="button" className="btn btn-outline" disabled={busy} onClick={() => { resetForm(); setError(''); }}>Скасувати редагування розміщення</button></>}
      <button type="button" className="btn btn-outline" disabled={busy} onClick={discover}>{busy ? 'Читаємо розділи…' : observation ? 'Оновити розділи магазину' : 'Прочитати розділи магазину'}</button>
      {observation && <>
        <label className="block">Розділ<select className="input" value={kind} onChange={(event) => set(setKind, event.target.value)}><option value="existing">Наявний розділ</option><option value="new">Нова підкатегорія</option></select></label>
        <ObservedCategoryPicker categories={observation.categories} value={selectedPath} onChange={(value) => set(setSelectedPath, value)} label={kind === 'new' ? 'Батьківський розділ' : 'Розділ магазину'} disabled={busy} />
        {kind === 'new' && <label className="block">Назва підкатегорії<input className="input" maxLength={255} value={name} onChange={(event) => set(setName, event.target.value)} /></label>}
        {kind === 'new' && <MagentoCategoryPlan key={`${group.route}:${selectedPath}:${name}:${observation.observedAt || ''}`} categoryCode={group.route} categories={observation.categories} parentPath={selectedPath} name={name} onVerified={setCategoryPlan} />}
        <label className="block">Які товари тут розміщувати?<select className="input" value={scope} onChange={(event) => set(setScope, event.target.value)}><option value="">Оберіть товари</option><option value="all">Усі товари цієї категорії</option><option value="condition">Товари з певною характеристикою</option></select></label>
        {scope === 'condition' && <><label className="block">Характеристика<select className="input" value={sourceId} onChange={(event) => { set(setSourceId, event.target.value); setValueId(''); }}><option value="">Оберіть характеристику</option>{sources.map(([id, item]) => <option key={id} value={id}>{registry?.references?.questions?.find((question) => question.category_code === group.route && question.key === item.key)?.label || item.key}</option>)}</select></label>
          <label className="block">Значення характеристики<select className="input" value={valueId} onChange={(event) => set(setValueId, event.target.value)}><option value="">Оберіть значення</option>{options.map((id) => <option key={id} value={id}>{currentOptionLabel(evidence, id)}</option>)}</select></label>
          {sourceId && !evidence && <p className="text-sm">Значення ще не прочитано. Обирати їх навмання не можна.</p>}
          {!sources.length && <p className="text-sm">У поточних правилах немає підтвердженого джерела для цієї умови. Спочатку додайте характеристику.</p>}
        </>}
        {targetPath && <p className="category-observed-selection">{targetPath.split('/').join(' › ')}{scope && <><br />{scope === 'all' ? 'Для всіх товарів цієї категорії' : `${source?.key || 'Характеристика'}: ${currentOptionLabel(evidence, valueId) || 'оберіть значення'}`}</>}</p>}
        <p className="text-sm text-slate-600">{editing ? 'Зміниться лише цей рядок правила.' : 'Нове розміщення додається до наявних.'} Створення підкатегорії та застосування правил потребують окремого підтвердження.</p>
        <button type="button" className="btn btn-outline" disabled={busy || !scope || !targetPath || kind === 'new' && (categoryPlan?.path !== targetPath || categoryPlan.categoryCode !== group.route)} onClick={savePlacement}>{editing ? 'Зберегти розміщення в правилі' : 'Додати розміщення до правила'}</button>
      </>}
    </>}
  </section>;
}
