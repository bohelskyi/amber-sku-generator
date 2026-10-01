import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../auth/auth-context.js';
import { EmptyState, LoadingState, Notice, StatusBadge } from '../components/app/UiPrimitives.jsx';
import { WorkspaceHeader, WorkspaceLocalNav } from '../components/workspace/WorkspacePrimitives.jsx';
import MagentoCategoryActions from '../components/workspace/MagentoCategoryActions.jsx';

const root = '/admin/magento-integration';
const states = { approved: 'Підтверджено', candidate: 'Кандидат', missing: 'Відсутній зв’язок',
  ambiguous: 'Неоднозначно', blocked: 'Заблоковано', drifted: 'Потрібна повторна перевірка', not_applicable: 'Не застосовується' };
const sections = [{ to: '/admin', label: 'Каталог і ціни' }, { to: '/admin/magento', label: 'Інтеграція Magento' }];
export default function MagentoIntegrationPage() {
  const { permissions } = useAuth();
  const [data, setData] = useState(null); const [error, setError] = useState('');
  const [revisionId, setRevisionId] = useState(''); const [categoryCode, setCategoryCode] = useState('');
  const [observation, setObservation] = useState(null); const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(true); const [answers, setAnswers] = useState({});
  const [weight, setWeight] = useState(''); const [price, setPrice] = useState('');
  const [subjectUa, setSubjectUa] = useState(''); const [subjectEn, setSubjectEn] = useState('');
  const [productId, setProductId] = useState(''); const sequence = useRef(0);
  const canPreview = permissions.includes('export_templates.manage') && permissions.includes('exports.view');
  useEffect(() => {
    const controller = new AbortController(); const current = ++sequence.current;
    api.get(root, { params: revisionId ? { bindingRevisionId: revisionId } : {}, signal: controller.signal })
      .then(({ data: next }) => { if (!controller.signal.aborted && current === sequence.current) setData(next); })
      .catch((cause) => { if (!controller.signal.aborted && current === sequence.current) setError(cause.response?.data?.error || 'Не вдалося прочитати стан інтеграції.'); })
      .finally(() => { if (current === sequence.current) setBusy(false); });
    return () => { controller.abort(); };
  }, [revisionId]);
  async function action(path, payload, setter) {
    const current = ++sequence.current; setBusy(true); setError('');
    try { const result = await api.post(`${root}/${path}`, payload); if (current === sequence.current) setter(result.data); }
    catch (cause) { if (current === sequence.current) setError(cause.response?.data?.error || 'Перевірка не завершилася. Спробуйте ще раз.'); }
    finally { if (current === sequence.current) setBusy(false); }
  }
  const category = data?.categories.find((c) => c.code === categoryCode) || data?.categories[0];
  const questions = data?.catalog.questions[category?.code] || [];
  return <main className="app-page"><div className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6">
    <WorkspaceHeader title="Інтеграція Magento" description="Каталог Amber, відповідності та перевірка готовності до доставки." />
    <WorkspaceLocalNav label="Налаштування каталогу" items={sections} />
    {error && <Notice tone="error">{error}</Notice>}
    {!data ? busy && <LoadingState label="Читаємо стан інтеграції…" /> : <>
      <Notice>{data.limitations.join(' ')}</Notice>
      <label className="block text-sm font-medium">Версія відповідностей
        <select className="input mt-1" value={revisionId} onChange={(e) => { ++sequence.current; setBusy(true); setError(''); setPreview(null); setRevisionId(e.target.value); }}>
          <option value="">Поточна опублікована</option>
          {data.revisions.map((r) => <option key={r.id} value={r.id}>{r.state === 'draft' ? 'Чернетка' : 'Опублікована'} · {r.version_number || r.revision} · {new Date(r.observed_at).toLocaleDateString('uk-UA')}</option>)}
        </select>
      </label>
      {!data.revision && <EmptyState title="Опублікованих відповідностей ще немає" description="Каталог можна налаштовувати до готовності Magento." />}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Категорії інтеграції">{data.categories.map((c) => <button type="button" className={`btn ${category?.code === c.code ? 'btn-primary' : 'btn-outline'} btn-compact-md`} key={c.code}
        onClick={() => { ++sequence.current; setBusy(false); setCategoryCode(c.code); setAnswers({}); setPreview(null); }}>{c.name}</button>)}</div>
      {category && <section className="card space-y-4 p-5"><h2 className="font-semibold">{category.name} <StatusBadge>{category.message}</StatusBadge></h2>
        <p>SKU-схема: {category.schema ? `опублікована, версія ${category.schema.version}` : 'ще не опублікована'}</p>
        {category.routes.map((r) => <p key={r.routeKey}>{r.routeKey} · Набір атрибутів: {data.revision?.schema.attributeSets.find((s) => s.attribute_set_id === r.setId)?.attribute_set_name || 'не вибрано'} / {r.setId || '—'} · {states[r.reviewState] || 'Потрібна перевірка'}</p>)}
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="text-left">Характеристика Amber</th><th className="text-left">Magento</th><th className="text-left">Стан</th></tr></thead><tbody>
          {category.values.map((v) => <tr key={`${v.questionKey}:${v.valueId}`} className="border-t"><td className="py-2">{v.questionLabel}: {v.label}<small className="block text-slate-500">{category.code}.{v.questionKey} · value_id {v.valueId}</small></td>
            <td>{v.mappings.map((m, index) => <div key={index}>{m.attribute || '—'} · {m.optionId || '—'} / {m.optionLabel || '—'}</div>)}</td><td>{states[v.state]}</td></tr>)}
        </tbody></table></div>
        <p className="text-sm">{(() => { const p = data.products.find((p) => p.category === category.code); return p ? `Товарів: ${p.total}. Локально перевірено: ${p.checked}; обчислено: ${p.evaluated}; заблоковано: ${p.blocked}; не перевірено: ${p.unexamined}. Remote preview: ${p.remoteChecked}.` : 'Поточних товарів немає.'; })()}</p>
        <Link className="text-sm underline" to="/admin#catalog-structure">Налаштувати каталог і SKU-схему</Link>
      </section>}
      <section className="card space-y-3 p-5"><h2 className="font-semibold">Структура Magento</h2>
        <button type="button" disabled={busy || !data.configured} className="btn btn-outline btn-compact-md" onClick={() => action('discovery', {}, setObservation)}>Перевірити структуру Magento</button>
        {observation && <><p className="text-sm">Спостереження: {new Date(observation.observedAt).toLocaleString('uk-UA')}. Послідовні GET-запити.</p>
          <details><summary>Набори атрибутів та їх склад</summary>{observation.schema.attributeSets.map((s) => <p className="text-sm break-words" key={s.attribute_set_id}>{s.attribute_set_name} / {s.attribute_set_id}: {s.attributeCodes.join(', ')}</p>)}</details>
          <details><summary>Атрибути й варіанти</summary>{observation.schema.attributes.map((a) => <details key={a.attribute_code}><summary>{a.attribute_code} · {a.frontend_input}</summary>{a.options.map((o) => <p key={o.value}>{o.label} / {o.value || 'порожній'}</p>)}</details>)}</details>
          <details><summary>Дерево категорій</summary>{observation.categories.map((c) => <p className="text-sm break-words" key={c.categoryId}>{c.path} / {c.categoryId}</p>)}</details>
        </>}
      </section>
      <MagentoCategoryActions key={data.revision?.id || 'none'} revision={data.revision} observation={observation} />
      {canPreview && data.revision && category && <section className="card space-y-4 p-5"><h2 className="font-semibold">Перевірка товару</h2>
        <p className="text-sm">Preview виконує лише читання. Товар, артикул і завдання доставки не створюються.</p>
        <form className="space-y-3" onChangeCapture={() => { ++sequence.current; setBusy(false); setPreview(null); }} onSubmit={(e) => { e.preventDefault(); action('create-preview', { bindingRevisionId: data.revision.id,
          product: { categoryCode: category.code, answers, weight, magentoNameSubjectUa: subjectUa, magentoNameSubjectEn: subjectEn },
          ...(price ? { pricingDecision: { mode: 'manual_uah', manualPriceUah: price } } : {}) }, setPreview); }}>
          {questions.map((q) => <label className="block text-sm" key={q.id}>{q.label}{q.input_type === 'options'
            ? <select className="input" value={answers[q.id] ?? ''} onChange={(e) => { setAnswers({ ...answers, [q.id]: e.target.value }); setPreview(null); }}><option value="">Оберіть значення</option>{q.options.filter((o) => !o.archived).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
            : <input className="input" value={answers[q.id] ?? ''} onChange={(e) => { setAnswers({ ...answers, [q.id]: e.target.value }); setPreview(null); }} />}</label>)}
          <div className="grid gap-3 sm:grid-cols-2"><label>Вага, г<input className="input" value={weight} onChange={(e) => setWeight(e.target.value)} /></label><label>Ручна ціна для прикладу, грн<input className="input" value={price} onChange={(e) => setPrice(e.target.value)} /></label></div>
          {category.code === 'SV' && <div className="grid gap-3 sm:grid-cols-2"><label>Назва українською<input className="input" value={subjectUa} onChange={(e) => setSubjectUa(e.target.value)} /></label><label>Назва англійською<input className="input" value={subjectEn} onChange={(e) => setSubjectEn(e.target.value)} /></label></div>}
          <button className="btn btn-outline btn-compact-md" disabled={busy || !category.schema}>Перевірити приклад CREATE</button>
        </form>
        <form className="flex flex-wrap items-end gap-2" onChangeCapture={() => { ++sequence.current; setBusy(false); setPreview(null); }} onSubmit={(e) => { e.preventDefault(); action('product-preview', { productId: Number(productId), bindingRevisionId: data.revision.id }, setPreview); }}>
          <label className="text-sm">ID наявного товару<input required type="number" min="1" className="input" value={productId} onChange={(e) => setProductId(e.target.value)} /></label>
          <button className="btn btn-outline btn-compact-md" disabled={busy}>Перевірити поточний товар</button>
        </form>
      </section>}
      {busy && <LoadingState label="Виконуємо обмежену перевірку…" />}
      {preview && <section className="card space-y-2 p-5"><h2 className="font-semibold">{preview.sendable ? 'Перевірений приклад готовий до доставки' : 'Приклад ще не готовий до Magento'}</h2>
        {preview.hypothetical && <p>CREATE з умовним артикулом; це не збережений товар.</p>}
        <ul>{preview.blockers.map((b, i) => <li key={i}>{b.message || 'Потрібно перевірити відповідності Magento.'}{b.target ? ` · ${b.target}` : ''}</li>)}</ul>
        <details><summary>Технічні деталі перевірки</summary><pre className="overflow-auto text-xs">{JSON.stringify(preview, null, 2)}</pre></details>
      </section>}
    </>}
  </div></main>;
}
