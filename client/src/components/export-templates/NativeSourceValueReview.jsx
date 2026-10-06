import { useState } from 'react';
import { useSourceEvidence } from '../../hooks/useTemplateSourceEvidence.js';
import { nativeDeferredReview, promoteNativeDeferredValue } from '../../lib/native-source-value-review.js';

export default function NativeSourceValueReview({ definition, sourceId, loadSource, disabled, onChange }) {
  const evidence = useSourceEvidence(definition.sources?.[sourceId], loadSource);
  const review = nativeDeferredReview(definition, sourceId, evidence);
  const [selected, setSelected] = useState(''); const [outputs, setOutputs] = useState({});
  const [semantic, setSemantic] = useState(false); const [allUses, setAllUses] = useState(false);
  const [error, setError] = useState(''); const [receipt, setReceipt] = useState('');
  if (!review) return receipt ? <p role="status">{receipt}</p> : null;
  const value = review.values.find((item) => item.valueId === selected);
  const ready = value?.available && review.tableIds.length > 0 && semantic && allUses
    && review.tableIds.every((id) => typeof outputs[id] === 'string' && outputs[id].trim());
  function select(valueId) {
    setSelected(valueId); setSemantic(false); setAllUses(false); setError(''); setReceipt('');
    setOutputs(Object.fromEntries(review.tableIds.map((id) => [id, definition.tables[id]?.[valueId] || ''])));
  }
  return <section className="space-y-3 border-t pt-3" aria-label="Окремий перегляд відкладеного значення">
    <h3 className="font-semibold">Підготувати підтримку відкладеного розміру</h3>
    <p>Оновлення до підтримки нових товарів саме по собі не дозволяє ці розміри. Перевірте конкретний розмір, текст усіх його відповідностей і потім зв’язок із точним значенням Magento.</p>
    <label className="block">Розмір для окремого перегляду<select className="input" value={selected} disabled={disabled} onChange={(e) => select(e.target.value)}><option value="">Оберіть точний розмір</option>{review.values.map((item) => <option key={item.valueId} value={item.valueId} disabled={!item.available}>{item.label}{!item.available ? ' · джерело не підтверджено' : ''}</option>)}</select></label>
    {!evidence && <p>Читаємо поточну характеристику. Значення не обираються навмання.</p>}
    {value && <>
      <p><strong>Обране значення:</strong> {value.label}. Інші відкладені розміри залишаються заблокованими.</p>
      <p>Зміна підтримки стосується всіх використань цієї характеристики у версії правил:</p>
      <ul>{review.fields.map((field) => <li key={`${field.groupIndex}:${field.rowIndex}:${field.column}:${field.dependency || ''}`}>{definition.groups[field.groupIndex]?.route} · {field.rowIndex === 1 ? 'EN' : 'Основний'} · {field.column}</li>)}</ul>
      {review.uses.some((use) => use.endsWith('/ перевірка готовності')) && <p>Таблиці також використовуються в перевірках готовності товарів; підтримка зміниться і для цих перевірок.</p>}
      {review.tableIds.map((id, i) => <label key={id} className="block">Текст відповідності {i + 1}<input className="input" maxLength={4096} value={outputs[id] || ''} disabled={disabled} onChange={(e) => { setOutputs((old) => ({ ...old, [id]: e.target.value })); setError(''); }}/><small>Перевірте мову й усі поля, які використовують цей текст.</small></label>)}
      {!review.tableIds.length && <p role="alert">Для цього джерела немає доступної таблиці текстових відповідностей. Потрібна окрема перевірка власного правила.</p>}
      <label className="block"><input type="checkbox" checked={semantic} disabled={disabled} onChange={(e) => setSemantic(e.target.checked)}/> Підтверджую точний розмір у чинній характеристиці.</label>
      <label className="block"><input type="checkbox" checked={allUses} disabled={disabled} onChange={(e) => setAllUses(e.target.checked)}/> Переглянув усі використання й тексти цього значення.</label>
      <p>Це лише зміна чернетки. Далі потрібні перевірка товарів, нова версія правил, точні відповідності Magento та явне застосування всього пакета. Історичні SKU й дані товарів зберігаються.</p>
      <button type="button" className="btn btn-outline" disabled={disabled || !ready} onClick={() => {
        try { const next = promoteNativeDeferredValue(definition, sourceId, selected, evidence, outputs, { exactSemanticValue: semantic, allUsesReviewed: allUses });
          if (onChange(next) === false) throw new Error('Правила змінилися. Повторіть окремий перегляд.');
          select('');
          setReceipt(`Розмір ${value.label} додано до підтримки в цій чернетці; зв’язок і застосування Magento ще не підтверджено.`);
        } catch (cause) { setError(cause.message); }
      }}>Додати підтримку цього розміру до чернетки</button>
    </>}
    {receipt && <p role="status">{receipt}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
