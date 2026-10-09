import { useState } from 'react';
import { controlledBlockerText, exactSkuInput } from '../../lib/magento-controlled-selection.js';
import { Notice } from '../app/UiPrimitives.jsx';

export default function MagentoExactSkuPicker({ busy, results, onResolve, onInvalidate }) {
  const [text, setText] = useState(''); const [error, setError] = useState('');
  return <section className="mc-exact-skus space-y-2" aria-label="Точний список артикулів">
    <h3 className="font-semibold">Вибрати точний список артикулів</h3>
    <p className="text-sm">Один артикул у рядку. Перевірка враховує регістр, зберігає коми в артикулі й лише додає доступні товари до вибору. Доставка не запускається.</p>
    <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); const input = exactSkuInput(text); setError(input.error); if (!input.error) onResolve(input.skus); }}>
      <label className="block text-sm">Точні артикули, до 100<textarea className="input" rows={4} disabled={busy} value={text} onChange={(event) => { setText(event.target.value); setError(''); onInvalidate(); }} /></label>
      <button type="submit" className="btn btn-outline btn-compact-md" disabled={busy || !text.trim()}>Перевірити точні артикули й додати до вибору</button>
    </form>
    {error && <Notice tone="error">{error}</Notice>}
    {results && <ul tabIndex={0} className="mc-exact-results text-sm" aria-label="Результат перевірки точних артикулів">{results.map((result, index) => <li key={index}>
      <strong>{result.sku}</strong> · {result.selectionState || ({ eligible: 'Доступний', blocked: 'Заблоковано', missing: 'Точний артикул не знайдено', duplicate: 'Повтор у вставленому списку; вдруге не додається' })[result.state]}
      {result.blockers.map((code) => <span className="block text-amber-800" key={code}>{controlledBlockerText(code)}</span>)}
    </li>)}</ul>}
  </section>;
}
