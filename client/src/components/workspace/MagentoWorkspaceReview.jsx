import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { deliveryPolicies, decisionKey } from '../../lib/magento-category-workspace.js';
import { fieldLabels } from '../../lib/export-template-editor.js';
import { LoadingState, Notice } from '../app/UiPrimitives.jsx';
import MagentoDetails from './MagentoDetails.jsx';

const root = '/admin/magento-integration';
const kinds = { route: 'Набір атрибутів', attribute: 'Поле', option: 'Значення', policy: 'Поведінка поля', category: 'Розміщення' };

// Explicit bounded decisions through the original CAS/authorization endpoints.
// A partial failure leaves the saved original draft available for a fresh read.
export default function MagentoWorkspaceReview({ revision, categoryCode, categories = [], questions, selections, focusTarget, onChanged, disabled, onPendingChange, onReadyChange, onProgressChange }) {
  const [data, setData] = useState(null); const [error, setError] = useState('');
  const [loadedKey, setLoadedKey] = useState('');
  const [busy, setBusy] = useState(false); const [reason, setReason] = useState('');
  const [choices, setChoices] = useState({}); const [all, setAll] = useState(false); const [page, setPage] = useState(0);
  const [editPolicies, setEditPolicies] = useState(false);
  const [showOtherFields, setShowOtherFields] = useState(false);
  const sequence = useRef(0); const flight = useRef(false);
  const readKey = `${revision.id}:${revision.revision}`;
  const fresh = loadedKey === readKey;
  useEffect(() => {
    const controller = new AbortController(); const requests = sequence; const ticket = ++requests.current;
    api.get(`${root}/bindings/${revision.id}`, { signal: controller.signal }).then(({ data: result }) => {
      if (!controller.signal.aborted && ticket === sequence.current) { setData(result); setLoadedKey(`${revision.id}:${revision.revision}`); setError(''); }
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause.response?.data?.error || 'Не вдалося прочитати підготовлені відповідності.'); });
    return () => { controller.abort(); ++requests.current; };
  }, [revision.id, revision.revision]);
  useEffect(() => {
    onPendingChange?.(busy || Boolean(reason.trim()) || Object.keys(choices).length > 0);
    return () => onPendingChange?.(false);
  }, [busy, choices, reason, onPendingChange]);
  const unresolved = fresh ? data?.entries.filter((e) => !['approved', 'not_applicable', 'blocked'].includes(e.reviewState)) || [] : [];
  const ready = Boolean(fresh && data && data.revision.revision === revision.revision && !unresolved.length);
  useEffect(() => { onReadyChange?.(ready); }, [ready, onReadyChange]);
  const entries = [...unresolved, ...(editPolicies ? data?.entries.filter((e) => e.kind === 'policy' && e.group === categoryCode && e.reviewState === 'approved') || [] : [])];
  const focused = (e) => !focusTarget || showOtherFields || e.target === focusTarget || e.kind === 'route';
  const local = unresolved.filter((e) => e.group === categoryCode);
  const focusComplete = Boolean(focusTarget && !editPolicies && !local.some(focused));
  const remainingFields = focusComplete && local.length > 0;
  const remainingCategories = focusComplete && !local.length && unresolved.length > 0;
  const scoped = entries.filter((e) => remainingCategories || (all || e.group === categoryCode) && (remainingFields || focused(e)));
  const otherFields = entries.filter((e) => e.group === categoryCode && !focused(e));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(scoped.length / 30) - 1));
  const visible = scoped.slice(currentPage * 30, (currentPage + 1) * 30);
  const placementReview = focusTarget === 'categories' && !showOtherFields;
  const categoryName = (code) => categories.find((category) => category.code === code)?.name || code;
  const progress = !fresh ? '' : data?.revision.revision !== revision.revision ? 'Підготовка змінилася. Натисніть «Перечитати підготовку» нижче.' : ready ? 'Відповідності підтверджено. Перевірте вплив на товари й застосуйте зміни.'
    : remainingCategories ? `${placementReview ? 'Розділи' : 'Поля'} «${categoryName(categoryCode)}» підтверджено. Застосування чекає на підтвердження: ${[...new Set(unresolved.map((e) => categoryName(e.group)))].join(', ')}.`
      : remainingFields ? `${placementReview ? 'Розділи' : 'Вибране поле'} підтверджено. Залишилося перевірити інші поля цієї категорії — їх показано нижче.`
        : `Підготовку збережено. Потрібно підтвердити відповідності: ${unresolved.length}.`;
  useEffect(() => { onProgressChange?.(progress); }, [progress, onProgressChange]);
  const label = (entry) => {
    if (entry.kind === 'policy') return `${data.revision.schema.attributes.find((a) => a.attribute_code === entry.target)?.default_frontend_label || fieldLabels[entry.target] || entry.target} · ${entry.label === 'en' ? 'EN' : 'UA'}`;
    const match = entry.source?.match(/\.([^.=]+)=value_id:(-?\d+)$/);
    const question = entry.group === categoryCode && match ? questions.find((q) => q.id === match[1]) : null;
    const option = question?.options.find((o) => String(o.id) === match[2]);
    return question ? `${question.label}: ${option?.label || entry.evaluated || match[2]}` : entry.evaluated || entry.label || entry.target;
  };
  const options = (entry) => {
    if (entry.kind === 'policy') return Object.entries(deliveryPolicies).map(([value, name]) => ({ value, label: name }));
    if (entry.kind === 'route') return data.revision.schema.attributeSets.map((s) => ({ value: String(s.attribute_set_id), label: s.attribute_set_name }));
    if (entry.kind === 'category') return (entry.candidates || []).map((c) => ({ value: c.categoryId, label: c.path }));
    const attribute = data?.revision.bindings.attributes.find((a) => a.bindingKey === entry.id.split(':')[1]);
    return (data?.revision.schema.attributes.find((a) => a.attribute_code === attribute?.attributeCode)?.options || []).filter((o) => !o.isEmpty).map((o) => ({ value: o.value, label: o.label }));
  };
  const chosen = (entry) => choices[entry.id] ?? selections[decisionKey(entry)] ?? (entry.kind === 'policy' && entry.reviewState !== 'approved' ? '' : entry.identity == null ? '' : String(entry.identity));
  async function approve(list) {
    if (flight.current || disabled || !data || data.revision.revision !== revision.revision) return;
    flight.current = true; setBusy(true); setError('');
    const ticket = sequence.current; let current = data.revision;
    try {
      for (const entry of list) {
        const value = chosen(entry);
        if (['route', 'option', 'category'].includes(entry.kind) && value !== String(entry.identity)) {
          current = (await api.post(`${root}/bindings/${current.id}/select`, { expectedRevision: current.revision, binding: entry.id, identity: entry.kind === 'route' ? Number(value) : value })).data;
        }
        current = (await api.post(`${root}/bindings/${current.id}/decision`, { expectedRevision: current.revision, binding: entry.id,
          action: 'approve', acceptReview: true, ...(reason.trim() ? { reason: reason.trim() } : {}),
          ...(entry.kind === 'policy' ? { policy: value, ...(entry.target === 'product_online' && entry.row === 'base' && value === 'initialize_create_only' ? { createValue: '2' } : {}) } : {}) })).data;
      }
      if (ticket === sequence.current) { setReason(''); setChoices({}); }
    } catch (cause) { if (ticket === sequence.current) setError(cause.response?.data?.error || 'Частину перевірки не завершено. Збережені рішення залишаються у чернетці.'); }
    finally {
      if (ticket === sequence.current) { onChanged(current); setBusy(false); }
      flight.current = false;
    }
  }
  const eligible = (entry) => chosen(entry) !== '' && (entry.reviewState !== 'approved' || chosen(entry) !== String(entry.identity)) && (entry.exact && String(entry.identity) === chosen(entry) && entry.kind !== 'policy' || reason.trim().length >= 3);
  return <section className="mc-review space-y-3" aria-label="Перевірка підготовлених відповідностей">
    <h3 className="font-semibold">{ready && !editPolicies ? 'Відповідності перевірено' : remainingCategories ? 'Підтвердьте відповідності інших категорій' : remainingFields ? 'Підтвердьте решту полів категорії' : placementReview ? 'Підтвердьте розділи магазину' : 'Перевірте ці відповідності'}</h3>
    {error && <Notice tone="error">{error}</Notice>}{!fresh && !error && <LoadingState label="Оновлюємо підтвердження…" compact />}
    {(data && fresh || error) && <>
      {fresh && data?.revision.revision !== revision.revision && <Notice tone="warning">Чернетка змінилася. Перечитайте збережену підготовку перед підтвердженням.</Notice>}
      <div className="mc-actions">{(error || fresh && data?.revision.revision !== revision.revision) && <button type="button" className="btn btn-outline" disabled={busy || disabled} onClick={async () => {
        if (flight.current) return; flight.current = true; setBusy(true);
        try { const { data: latest } = await api.get(`${root}/bindings/${revision.id}`); setData(latest); setLoadedKey(`${latest.revision.id}:${latest.revision.revision}`); onChanged(latest.revision); setError(''); }
        catch (cause) { setError(cause.response?.data?.error || 'Не вдалося перечитати підготовку. Введення залишено у формі.'); }
        finally { flight.current = false; setBusy(false); }
      }}>Перечитати підготовку</button>}{(reason || Object.keys(choices).length > 0) && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => { setReason(''); setChoices({}); }}>Відкинути незбережені рішення</button>}</div>
      {unresolved.length > 0 && <p>Залишилося підтвердити: {unresolved.length}. {unresolved.some((e) => e.group !== categoryCode) && `В інших категоріях: ${unresolved.filter((e) => e.group !== categoryCode).length}.`}</p>}
      {focusTarget && <p className="mc-help">{remainingCategories ? 'Налаштування категорій застосовуються одним пакетом. Нижче показано решту відповідностей, які ще потрібно підтвердити.'
        : remainingFields ? 'Нижче показано інші поля цієї категорії, які ще потребують підтвердження.' : placementReview ? ready
        ? 'Розділи підтверджено. Наступний крок — перевірка впливу на товари у блоці нижче, а потім «Застосувати зміни».'
        : visible.length ? 'Перевірте шлях у колонці Magento й натисніть «Підтвердити». Після підтвердження всіх відповідностей з’явиться кнопка «Застосувати зміни».'
          : otherFields.length ? 'Розділи цієї категорії підтверджено. Наступний крок — «Показати решту полів категорії» нижче.'
            : 'Розділи цієї категорії підтверджено. Наступний крок — «Показати також інші категорії» нижче.'
        : 'Спочатку показано вибране поле й набір характеристик. Для застосування всієї підготовки потрібно вирішити також решту питань.'}</p>}
      {focusTarget && !remainingFields && (otherFields.length > 0 || showOtherFields) && <button className="btn btn-outline" disabled={busy} onClick={() => { setShowOtherFields(!showOtherFields); setPage(0); }}>{showOtherFields ? 'Лише вибране поле' : `Показати решту полів категорії (${otherFields.length})`}</button>}
      <MagentoDetails summary="Поведінка передавання полів">{() => <button type="button" className="btn btn-outline" disabled={busy || disabled} onClick={() => { setEditPolicies(!editPolicies); setPage(0); }}>{editPolicies ? 'Сховати поведінку підключених полів' : 'Змінити поведінку підключених полів'}</button>}</MagentoDetails>
      {!remainingCategories && entries.some((e) => e.group !== categoryCode) && <button className="btn btn-outline" type="button" onClick={() => { setAll(!all); setPage(0); }}>{all ? 'Лише поточна категорія' : 'Показати також інші категорії'}</button>}
      {(reason || visible.some((e) => !e.exact || e.kind === 'policy' || chosen(e) !== String(e.identity))) && <label className="mc-label">Пояснення перевірки<input className="input" maxLength={2000} disabled={busy || disabled} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Чому обрано цю відповідність або поведінку" /></label>}
      {visible.length > 0 && <div className="mc-table-scroll"><table><thead><tr><th>Поле / значення менеджера</th><th>Відповідність Magento</th><th>Підтвердження</th></tr></thead><tbody>{visible.map((entry) => <tr key={entry.id}>
        <td>{entry.group !== categoryCode && <strong className="block">{categoryName(entry.group)}</strong>}{label(entry)}<small>{kinds[entry.kind]} · {entry.row === 'english' ? 'EN' : 'UA'}</small></td>
        <td>{['policy', 'route', 'option', 'category'].includes(entry.kind) ? <select className="input" aria-label={`Відповідність: ${label(entry)}`} value={chosen(entry)} disabled={busy || disabled} onChange={(e) => setChoices({ ...choices, [entry.id]: e.target.value })}><option value="">Оберіть явно</option>{options(entry).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select> : entry.label || entry.target}</td>
        <td><button type="button" className="btn btn-outline" disabled={busy || disabled || !eligible(entry)} onClick={() => approve([entry])}>Підтвердити</button></td>
      </tr>)}</tbody></table></div>}
      {!visible.length && <p>{otherFields.length ? 'Вибране поле підтверджено. Відкрийте решту полів цієї категорії, щоб завершити перевірку.' : entries.length ? 'Питання цієї категорії підтверджено. Перевірте також інші категорії.' : 'Усі необхідні відповідності підтверджено.'}</p>}
      {visible.length > 1 && visible.some((e) => e.exact && e.kind !== 'policy') && <MagentoDetails summary="Однозначні підказки">{() => <button type="button" className="btn btn-outline" disabled={busy || disabled} onClick={() => approve(visible.filter((e) => e.exact && e.kind !== 'policy' && String(e.identity) === chosen(e)))}>Прийняти однозначні підказки на цій сторінці</button>}</MagentoDetails>}
      {visible.length > 1 && <button type="button" className="btn btn-primary" disabled={busy || disabled || !visible.every(eligible)} onClick={() => approve(visible)}>Підтвердити показані відповідності</button>}
      {scoped.length > 30 && <nav aria-label="Сторінки перевірки" className="mc-actions"><button className="btn btn-outline" disabled={!currentPage || busy} onClick={() => setPage(currentPage - 1)}>Назад</button><span>{currentPage + 1} / {Math.ceil(scoped.length / 30)}</span><button className="btn btn-outline" disabled={(currentPage + 1) * 30 >= scoped.length || busy} onClick={() => setPage(currentPage + 1)}>Далі</button></nav>}
      {data && fresh && <MagentoDetails summary="Технічна перевірка">{() => <p>Невирішених структурних питань: {data.validation.diagnostics.length}. Чернетка {revision.revision}.</p>}</MagentoDetails>}
    </>}
  </section>;
}
