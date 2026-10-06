import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { addIntegrationCategory, enableExtensibleContract } from '../../lib/integration-template.js';
import { hasControlCharacter } from '../../lib/magento-placement-rule.js';
import { LoadingState, Notice } from '../app/UiPrimitives.jsx';
import { ObservedAttributeSetPicker, ObservedCategoryPicker } from '../workspace/MagentoObservedSelectors.jsx';
import MagentoCategoryPlan from '../workspace/MagentoCategoryPlan.jsx';

function CategoryForm({ definition, onChange, onPendingChange, initialCategory = '' }) {
  const [context, setContext] = useState(null); const [observation, setObservation] = useState(null);
  const [fields, setFields] = useState({ code: initialCategory, nameUa: '', nameEn: '', attributeSet: '', categoryPath: '' });
  const [placement, setPlacement] = useState('existing'); const [parent, setParent] = useState(''); const [child, setChild] = useState('');
  const [categoryPlan, setCategoryPlan] = useState(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [receipt, setReceipt] = useState('');
  const discovery = useRef(0);
  const pending = !receipt && (Object.entries(fields).some(([key, value]) => key === 'code' ? value !== initialCategory : Boolean(value)) || Boolean(parent || child));
  useEffect(() => { onPendingChange(pending); return () => onPendingChange(false); }, [pending, onPendingChange]);
  useEffect(() => {
    const controller = new AbortController(); const requests = discovery;
    api.get('/admin/magento-integration', { signal: controller.signal }).then(({ data }) => { if (!controller.signal.aborted) setContext(data); })
      .catch(() => { if (!controller.signal.aborted) setError('Не вдалося прочитати категорії каталогу. Закрийте й відкрийте форму для повторного читання.'); });
    return () => { controller.abort(); ++requests.current; };
  }, []);
  async function observe() {
    const ticket = ++discovery.current; setBusy(true); setError(''); setCategoryPlan(null);
    try { const { data } = await api.post('/admin/magento-integration/discovery', {}); if (ticket === discovery.current) { setCategoryPlan(null); setObservation(data); } }
    catch (cause) { if (ticket === discovery.current) setError(cause.response?.data?.error || 'Не вдалося прочитати структуру магазину.'); }
    finally { if (ticket === discovery.current) setBusy(false); }
  }
  const categories = (context?.categories || []).filter((item) => !definition.groups.some((group) => group.route === item.code));
  const selected = categories.find((item) => item.code === fields.code);
  const path = placement === 'new' && parent && child ? `${parent}/${child.trim()}` : placement === 'existing' ? fields.categoryPath : '';
  const sets = observation?.schema?.attributeSets || context?.revision?.schema?.attributeSets || [];
  function add() {
    setError('');
    try {
      if (!selected) throw new Error('Оберіть категорію каталогу.');
      if (!observation) throw new Error('Спочатку прочитайте структуру магазину.');
      if (observation.categories.filter((item) => item.comparable && item.normalizedPath === (placement === 'new' ? parent : path)).length !== 1) throw new Error('Повторно оберіть однозначний розділ зі свіжої структури магазину.');
      if (observation.schema.attributeSets.filter((item) => item.attribute_set_name === fields.attributeSet).length !== 1) throw new Error('Повторно оберіть набір характеристик зі свіжої структури магазину.');
      if (placement === 'new' && (!child.trim() || /[/,]/.test(child) || hasControlCharacter(child) || child !== child.trim())) throw new Error('Вкажіть назву підкатегорії без /, коми та пробілів на початку або в кінці.');
      if (placement === 'new' && observation.categories.some((item) => item.normalizedPath === path)) throw new Error('Цей розділ уже існує. Оберіть його серед наявних.');
      if (placement === 'new' && (categoryPlan?.path !== path || categoryPlan.categoryCode !== fields.code)) throw new Error('Спочатку перевірте точний шлях і вплив створення.');
      const base = definition.evaluatorVersion === 'magento-declarative-3' ? enableExtensibleContract(definition) : definition;
      const next = addIntegrationCategory(base, { ...fields, label: selected.name, categoryPath: path });
      if (onChange(next) === false) throw new Error('Чернетка змінилася. Повторно відкрийте додавання категорії.');
      setReceipt(`Категорію «${selected.name}» додано до чернетки правил.`);
    } catch (cause) { setError(cause.message); }
  }
  return <div className="space-y-4 py-3">
    {error && <Notice tone="error">{error}</Notice>}
    {receipt ? <Notice>{receipt} Збережіть і опублікуйте правила, потім перевірте підключення. Категорію магазину ще не створено.</Notice> : <>
      {!context && !error && <LoadingState compact />}
      <label className="block text-sm">Категорія товару<select className="input" value={fields.code} onChange={(event) => { setCategoryPlan(null); setFields({ ...fields, code: event.target.value }); }}><option value="">Оберіть категорію каталогу</option>{categories.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
      {context && !categories.length && <p>Усі наявні категорії вже включено до цих правил. Новий тип товару спочатку створюється в каталозі.</p>}
      <div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm">Основна назва товару українською<input className="input" value={fields.nameUa} onChange={(event) => setFields({ ...fields, nameUa: event.target.value })} /></label><label className="block text-sm">Основна назва товару англійською<input className="input" value={fields.nameEn} onChange={(event) => setFields({ ...fields, nameEn: event.target.value })} /></label></div>
      <p className="text-sm text-slate-600">До назви додається публічний артикул. Назви обома мовами вводяться окремо.</p>
      <button type="button" className="btn btn-outline" disabled={busy} onClick={observe}>{busy ? 'Читаємо структуру…' : observation ? 'Оновити структуру магазину' : 'Прочитати структуру магазину'}</button>
      <ObservedAttributeSetPicker sets={sets} value={fields.attributeSet} onChange={(attributeSet) => setFields({ ...fields, attributeSet })} disabled={busy} />
      {observation && <><label className="block text-sm">Розміщення в магазині<select className="input" value={placement} onChange={(event) => { setCategoryPlan(null); setPlacement(event.target.value); }}><option value="existing">У наявному розділі</option><option value="new">У новій підкатегорії</option></select></label>
        <ObservedCategoryPicker categories={observation.categories} value={placement === 'new' ? parent : fields.categoryPath} label={placement === 'new' ? 'Батьківський розділ' : 'Розділ магазину'} onChange={(value) => { setCategoryPlan(null); if (placement === 'new') setParent(value); else setFields({ ...fields, categoryPath: value }); }} disabled={busy} />
        {placement === 'new' && <label className="block text-sm">Назва нової підкатегорії<input className="input" maxLength={255} value={child} onChange={(event) => { setCategoryPlan(null); setChild(event.target.value); }} /></label>}
        {placement === 'new' && <MagentoCategoryPlan key={`${fields.code}:${parent}:${child}:${observation.observedAt || ''}`} categoryCode={fields.code} categories={observation.categories} parentPath={parent} name={child} onVerified={setCategoryPlan} />}
        {path && <p className="category-observed-selection">Товари розміщуватимуться: {path.split('/').join(' › ')}</p>}
      </>}
      <button type="button" className="btn btn-primary" disabled={busy || !selected || !observation || !path || !fields.attributeSet || placement === 'new' && (categoryPlan?.path !== path || categoryPlan.categoryCode !== fields.code)} onClick={add}>Додати категорію до чернетки</button>
      <p className="text-sm text-slate-600">Це зміна правил. Підкатегорія створюється та підключається окремим підтвердженням; до меню магазину автоматично не додається.</p>
    </>}
  </div>;
}

export default function IntegrationCategoryForm({ definition, onChange, onPendingChange, initialCategory = '' }) {
  const [open, setOpen] = useState(() => Boolean(initialCategory && !definition.groups.some((group) => group.route === initialCategory))); const [dirty, setDirty] = useState(false); const [closing, setClosing] = useState(false); const id = useId();
  useEffect(() => { onPendingChange?.(dirty); return () => onPendingChange?.(false); }, [dirty, onPendingChange]);
  if (!['magento-declarative-3', 'magento-declarative-4', 'magento-declarative-5'].includes(definition.evaluatorVersion) || definition.outputContract !== 'magento-products-columns-v2') return null;
  return <section className="text-sm mb-3"><button type="button" className="btn btn-outline" aria-expanded={open} aria-controls={id} onClick={() => { if (open && dirty) setClosing(true); else setOpen(!open); }}>Додати категорію до правил</button>
    {closing && <Notice tone="warning">Є незастосоване заповнення категорії.<div className="category-journey-actions"><button type="button" className="btn btn-outline" onClick={() => { setClosing(false); setOpen(false); }}>Відкинути заповнення</button><button type="button" className="btn btn-primary" onClick={() => setClosing(false)}>Залишитися</button></div></Notice>}
    {open && <div id={id}><CategoryForm definition={definition} onChange={onChange} onPendingChange={setDirty} initialCategory={initialCategory} /></div>}
  </section>;
}
