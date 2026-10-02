import { useState } from 'react';
import { addIntegrationCategory, enableExtensibleContract } from '../../lib/integration-template.js';
export default function IntegrationCategoryForm({ definition, onChange, registry }) {
  const [fields, setFields] = useState({ code: '', label: '', nameUa: '', nameEn: '', attributeSet: '', categoryPath: '' });
  const [error, setError] = useState('');
  if (!['magento-declarative-3','magento-declarative-4'].includes(definition.evaluatorVersion) || definition.outputContract !== 'magento-products-columns-v2') return null;
  const labels = { code: 'Код категорії Amber', label: 'Назва категорії Amber', nameUa: 'Основна назва товару українською', nameEn: 'Основна назва товару англійською', attributeSet: 'Точна назва набору атрибутів Magento', categoryPath: 'Повний шлях категорії Magento' };
  return <details className="text-sm mb-3"><summary>Категорії інтеграційного шаблону</summary>
    <p className="my-2">Зміни залишаються у чернетці. Публікація шаблону та відповідностей виконується окремо. До обох введених назв додається публічний артикул.</p>
    {error && <p role="alert">{error}</p>}
    {definition.evaluatorVersion === 'magento-declarative-3' ? <button type="button" className="btn btn-outline btn-compact-md" onClick={() => { try { onChange(enableExtensibleContract(definition)); } catch (cause) { setError(cause.message); } }}>Розширити чернетку до контракту v4</button>
      : <div className="grid gap-2 sm:grid-cols-2">{Object.entries(labels).map(([key, label]) => <label key={key}>{label}<input className="input" value={fields[key]} list={key === 'code' ? 'integration-amber-categories' : undefined} onChange={(e) => setFields({ ...fields, [key]: e.target.value })} /></label>)}
        <datalist id="integration-amber-categories">{(registry?.references?.categories || []).map((code) => <option key={code} value={code} />)}</datalist>
        <button type="button" className="btn btn-outline btn-compact-md" onClick={() => { try { onChange(addIntegrationCategory(definition, fields)); setError(''); } catch (cause) { setError(cause.message); } }}>Додати категорію до чернетки</button>
      </div>}
  </details>;
}
