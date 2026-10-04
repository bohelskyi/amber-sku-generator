import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { at } from '../../lib/export-template-presentation.js';
import { appendPlacement, hasControlCharacter } from '../../lib/magento-placement-rule.js';
import { availableSources } from '../../lib/export-template-columns.js';
import { useSourceEvidence } from '../../hooks/useTemplateSourceEvidence.js';
import { currentOptionIds, currentOptionLabel } from '../../lib/export-template-option-labels.js';
import { ObservedCategoryPicker } from '../workspace/MagentoObservedSelectors.jsx';
import { Notice } from '../app/UiPrimitives.jsx';
import { RuleSummary } from './RuleSummary.jsx';

export default function MagentoPlacementRuleEditor({ definition, cellPath, registry, loadSource, readOnly, onChange, onEditing }) {
  const [observation, setObservation] = useState(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [kind, setKind] = useState('existing'); const [selectedPath, setSelectedPath] = useState(''); const [name, setName] = useState('');
  const [scope, setScope] = useState(''); const [sourceId, setSourceId] = useState(''); const [valueId, setValueId] = useState(''); const [receipt, setReceipt] = useState('');
  const sequence = useRef(0); useEffect(() => () => { ++sequence.current; }, []);
  const source = definition.sources?.[sourceId]; const evidence = useSourceEvidence(source, loadSource);
  const group = definition.groups[cellPath[1]];
  const authorized = availableSources(registry, group.route);
  const sources = Object.entries(definition.sources || {}).filter(([, item]) => item.kind === 'semantic' && item.category === group.route
    && authorized.some((choice) => ['kind', 'category', 'key'].every((key) => choice.descriptor[key] === item[key])));
  const options = currentOptionIds(evidence).filter((id) => currentOptionLabel(evidence, id));
  const targetPath = kind === 'new' && name.trim() && selectedPath ? `${selectedPath}/${name.trim()}` : kind === 'existing' ? selectedPath : '';
  const set = (setter, value) => { setter(value); setReceipt(''); onEditing?.(); };
  async function discover() {
    const ticket = ++sequence.current; setBusy(true); setError('');
    try { const { data } = await api.post('/admin/magento-integration/discovery', {}); if (ticket === sequence.current) setObservation(data); }
    catch (cause) { if (ticket === sequence.current) setError(cause.response?.data?.error || 'Не вдалося прочитати розділи магазину.'); }
    finally { if (ticket === sequence.current) setBusy(false); }
  }
  function append() {
    if (readOnly || busy) return;
    try {
      if (!scope || scope === 'condition' && (!sources.some(([id]) => id === sourceId) || !options.includes(valueId))) throw new Error('Оберіть, які товари потраплятимуть до розділу.');
      const matches = observation?.categories?.filter((item) => item.comparable && item.normalizedPath === selectedPath) || [];
      if (matches.length !== 1) throw new Error('Повторно оберіть однозначний розділ магазину.');
      if (kind === 'new' && (!name.trim() || name !== name.trim() || /[/,]/.test(name) || hasControlCharacter(name))) throw new Error('Вкажіть назву підкатегорії без /, коми та крайніх пробілів.');
      if (kind === 'new' && observation.categories.some((item) => item.normalizedPath === targetPath)) throw new Error('Ця підкатегорія вже існує. Оберіть наявний розділ.');
      onChange(appendPlacement(definition, cellPath, targetPath, scope === 'condition' ? sourceId : null, valueId));
      setReceipt(targetPath); setError('');
    } catch (cause) { setError(cause.message); }
  }
  return <section className="space-y-3" aria-label="Розміщення товарів у магазині">
    <RuleSummary definition={definition} expression={at(definition, cellPath)} registry={registry} loadSource={loadSource} />
    {!readOnly && <>
      <h3 className="font-semibold">Додати розміщення</h3>
      <button type="button" className="btn btn-outline" disabled={busy} onClick={discover}>{busy ? 'Читаємо розділи…' : observation ? 'Оновити розділи магазину' : 'Прочитати розділи магазину'}</button>
      {error && <Notice tone="error">{error}</Notice>}
      {observation && <>
        <label className="block">Розділ<select className="input" value={kind} onChange={(event) => set(setKind, event.target.value)}><option value="existing">Наявний розділ</option><option value="new">Нова підкатегорія</option></select></label>
        <ObservedCategoryPicker categories={observation.categories} value={selectedPath} onChange={(value) => set(setSelectedPath, value)} label={kind === 'new' ? 'Батьківський розділ' : 'Розділ магазину'} disabled={busy} />
        {kind === 'new' && <label className="block">Назва підкатегорії<input className="input" maxLength={255} value={name} onChange={(event) => set(setName, event.target.value)} /></label>}
        <label className="block">Які товари тут розміщувати?<select className="input" value={scope} onChange={(event) => set(setScope, event.target.value)}><option value="">Оберіть товари</option><option value="all">Усі товари цієї категорії</option><option value="condition">Товари з певною характеристикою</option></select></label>
        {scope === 'condition' && <><label className="block">Характеристика<select className="input" value={sourceId} onChange={(event) => { set(setSourceId, event.target.value); setValueId(''); }}><option value="">Оберіть характеристику</option>{sources.map(([id, item]) => <option key={id} value={id}>{registry?.references?.questions?.find((question) => question.category_code === group.route && question.key === item.key)?.label || item.key}</option>)}</select></label>
          <label className="block">Значення характеристики<select className="input" value={valueId} onChange={(event) => set(setValueId, event.target.value)}><option value="">Оберіть значення</option>{options.map((id) => <option key={id} value={id}>{currentOptionLabel(evidence, id)}</option>)}</select></label>
          {sourceId && !evidence && <p className="text-sm">Значення ще не прочитано. Обирати їх навмання не можна.</p>}
          {!sources.length && <p className="text-sm">У поточних правилах немає підтвердженого джерела для цієї умови. Спочатку додайте характеристику.</p>}
        </>}
        {targetPath && <p className="category-observed-selection">{targetPath.split('/').join(' › ')}{scope && <><br />{scope === 'all' ? 'Для всіх товарів цієї категорії' : `${source?.key || 'Характеристика'}: ${currentOptionLabel(evidence, valueId) || 'оберіть значення'}`}</>}</p>}
        <p className="text-sm text-slate-600">Наявне розміщення зберігається. Нове додається лише за обраною умовою. Створення підкатегорії та підключення потребують окремого підтвердження.</p>
        <button type="button" className="btn btn-outline" disabled={busy || !scope || !targetPath || Boolean(receipt)} onClick={append}>Додати розміщення до правила</button>
      </>}
      {receipt && <Notice>Додано до заповнення: {receipt.split('/').join(' › ')}. Застосуйте до чернетки й перевірте приклади товарів.</Notice>}
    </>}
  </section>;
}
