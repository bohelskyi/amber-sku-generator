import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

export default function MagentoTargetPicker({ group, selected, onSelect, disabled }) {
  const [data, setData] = useState(null); const [error, setError] = useState('');
  const [search, setSearch] = useState(''); const [busy, setBusy] = useState(false);
  const [setId, setSetId] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api.get('/admin/magento-integration', { signal: controller.signal }).then(({ data: result }) => {
      if (controller.signal.aborted) return;
      setData(result.revision?.schema || null);
      const matching = result.revision?.bindings?.routes?.filter((route) => route.routeKey.split(/[.:]/)[0] === group.route) || [];
      const ids = [...new Set(matching.map((route) => route.setId).filter(Boolean))];
      if (ids.length === 1) setSetId(String(ids[0]));
    }).catch(() => { if (!controller.signal.aborted) setError('Не вдалося прочитати атрибути Magento.'); });
    return () => controller.abort();
  }, [group.route]);
  async function refresh() {
    setBusy(true); setError('');
    try { const { data: observation } = await api.post('/admin/magento-integration/discovery', {}); setData(observation.schema); }
    catch { setError('Не вдалося перевірити структуру Magento. Попередній список збережено.'); }
    finally { setBusy(false); }
  }
  const set = data?.attributeSets?.find((item) => String(item.attribute_set_id) === setId);
  const attributes = (data?.attributes || []).filter((attribute) => set?.attributeCodes.includes(attribute.attribute_code)
    && !group.columns.includes(attribute.attribute_code));
  const filtered = attributes.filter((attribute) => attribute.attribute_code === selected || `${attribute.default_frontend_label || ''} ${attribute.attribute_code}`.toLocaleLowerCase('uk').includes(search.toLocaleLowerCase('uk')));
  return <fieldset className="space-y-3"><legend>Куди передавати значення</legend>
    {error && <p role="alert">{error}</p>}
    <label>Набір характеристик Magento<select className="input" value={setId} disabled={disabled || busy} onChange={(event) => { setSetId(event.target.value); onSelect(null); }}><option value="">Оберіть набір</option>{data?.attributeSets?.map((item) => <option key={item.attribute_set_id} value={item.attribute_set_id}>{item.attribute_set_name}</option>)}</select></label>
    <label>Знайти атрибут<input className="input" type="search" value={search} disabled={disabled || busy} onChange={(event) => setSearch(event.target.value)} /></label>
    <label>Наявний атрибут Magento<select className="input" value={selected} disabled={disabled || busy || !set} onChange={(event) => onSelect(attributes.find((item) => item.attribute_code === event.target.value) || null)}><option value="">Оберіть атрибут</option>{filtered.map((item) => <option key={item.attribute_code} value={item.attribute_code}>{item.default_frontend_label || item.attribute_code} · {item.frontend_input === 'select' ? 'список' : item.frontend_input === 'text' ? 'текст' : item.frontend_input}</option>)}</select></label>
    {set && !attributes.length && <p>У цьому наборі немає додаткових атрибутів. Підключіть потрібний атрибут у категорії або перевірте оновлену структуру.</p>}
    <button type="button" className="btn btn-outline" disabled={disabled || busy} onClick={refresh}>{busy ? 'Перевіряємо…' : 'Оновити атрибути з Magento'}</button>
  </fieldset>;
}
