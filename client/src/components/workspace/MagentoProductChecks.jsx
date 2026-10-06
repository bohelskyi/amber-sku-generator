import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { createRequirements, isCreateQuestionRequired } from '../../lib/product-create-readiness.js';
import { getVisibleOptionsForQuestion, isQuestionVisible, isTextQuestion } from '../../lib/sku-visibility.js';
import { LoadingState, Notice } from '../app/UiPrimitives.jsx';
import MagentoDetails from './MagentoDetails.jsx';
import MagentoProductComparison from '../attention/MagentoProductComparison.jsx';
import { problemTitle } from '../attention/sync-problem-presentation.js';

const root = '/admin/magento-integration';
function productIdentity(product) {
  if (product.public_sku) return { label: 'Артикул', value: product.public_sku, actionLabel: `Обрати ${product.public_sku}` };
  if (product.full_sku) return { label: 'Внутрішній SKU', value: product.full_sku, actionLabel: `Обрати внутрішній SKU ${product.full_sku}` };
  return { label: '', value: 'Артикул недоступний', actionLabel: `Обрати товар ID ${product.id}` };
}
function ProductChecks({ revision, categoryCode, onRepresentative, initialProductId, initialArticle }) {
  const [config, setConfig] = useState(null); const [error, setError] = useState('');
  const [answers, setAnswers] = useState({}); const [weight, setWeight] = useState(''); const [price, setPrice] = useState('');
  const [ua, setUa] = useState(''); const [en, setEn] = useState('');
  const [preview, setPreview] = useState(null); const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(''); const [products, setProducts] = useState(null);
  const [selected, setSelected] = useState(() => Number.isSafeInteger(Number(initialProductId)) && Number(initialProductId) > 0
    ? { id: Number(initialProductId), public_sku: initialArticle || null, fromProblem: true } : null);
  const [offset, setOffset] = useState(0); const [searching, setSearching] = useState(false);
  const sequence = useRef(0); const searchSequence = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); const requests = sequence; const searches = searchSequence;
    api.get(`${root}/creation-inputs`, { params: { categoryCode }, signal: controller.signal }).then(({ data }) => { if (!controller.signal.aborted) setConfig(data); })
      .catch(() => { if (!controller.signal.aborted) setError('Не вдалося прочитати опубліковані поля створення.'); });
    return () => { controller.abort(); ++requests.current; ++searches.current; };
  }, [categoryCode]);
  const questions = config?.questions[categoryCode] || [];
  const requiresPhysicalWeight = Number(config?.categories[categoryCode]?.requires_weight) === 1;
  const weightQuestion = questions.find((question) => question.id === 'weight');
  const canCheckCreation = config?.productCreation?.identityMode === 'public_identity'
    || Boolean(config?.categories[categoryCode]?.sku_schema_version_id);
  const calibrated = answers.is_calibrated == null ? null : Number(answers.is_calibrated);
  const rules = createRequirements(config, categoryCode, answers);
  function invalidate() { ++sequence.current; setBusy(false); setPreview(null); setError(''); }
  function changeAnswer(question, value) {
    invalidate();
    const next = { ...answers, [question.id]: isTextQuestion(question) ? value : Number(value) };
    if (value === '') delete next[question.id];
    // Use the same visibility rules as ProductBuilder; removed parents may hide children.
    let changed;
    do {
      changed = false;
      for (const field of questions) if (next[field.id] !== undefined && (!isQuestionVisible(field, next, next.is_calibrated ?? null)
        || (!isTextQuestion(field) && !getVisibleOptionsForQuestion(field, next, next.is_calibrated ?? null).some((option) => Number(option.id) === Number(next[field.id]))))) {
        delete next[field.id]; changed = true;
      }
    } while (changed);
    setAnswers(next);
  }
  async function check(kind, input) {
    const ticket = ++sequence.current; setBusy(true); setError(''); setPreview(null);
    try { const { data } = await api.post(`${root}/${kind}`, { bindingRevisionId: revision.id, ...input });
      if (kind === 'product-preview' && data.productId !== undefined && Number(data.productId) !== Number(input.productId)) throw new Error('Wrong product evidence');
      if (ticket === sequence.current) setPreview({ result: data, input: structuredClone(input) });
    } catch (cause) { if (ticket === sequence.current) setError(cause.response?.data?.error || 'Перевірка товару не завершилася.'); }
    finally { if (ticket === sequence.current) setBusy(false); }
  }
  async function search(page = 0) {
    const ticket = ++searchSequence.current; setSearching(true); setError('');
    try { const { data } = await api.get('/admin/export-templates/sample-products', { params: { q: query.trim(), offset: page } });
      if (ticket === searchSequence.current) { setProducts(data); setOffset(page); }
    } catch { if (ticket === searchSequence.current) setError('Не вдалося знайти товари.'); }
    finally { if (ticket === searchSequence.current) setSearching(false); }
  }
  const createInput = () => ({ product: { categoryCode, answers, isCalibrated: calibrated,
    weight: requiresPhysicalWeight ? weight : 0,
    ...(rules.namesRequired ? { magentoNameSubjectUa: ua, magentoNameSubjectEn: en } : {}) },
    ...(price ? { pricingDecision: { mode: 'manual_uah', manualPriceUah: price } } : {}) });
  return <div className="space-y-5">
    <section className="card space-y-3 p-5"><h3 className="font-semibold">Перевірити поточний товар</h3>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); search(); }}>
        <label className="min-w-0 flex-1 text-sm">Пошук за артикулом<input className="input" value={query} minLength={2} maxLength={160} onChange={(event) => { ++searchSequence.current; setSearching(false); setProducts(null); setQuery(event.target.value); setSelected(null); invalidate(); }} /></label>
        <button className="btn btn-outline btn-compact-md" disabled={searching || query.trim().length < 2}>Знайти товар</button>
      </form>
      {searching && <LoadingState compact />}
      {products && <><ul className="space-y-2">{products.products.map((product) => {
        const identity = productIdentity(product);
        return <li key={product.id} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="break-all">{identity.label && <>{identity.label}: </>}<strong>{identity.value}</strong> · {product.category} · {product.status}</span>
          <button type="button" className="btn btn-outline btn-compact-md" onClick={() => { invalidate(); setSelected(product); }}>{identity.actionLabel}</button>
        </li>;
      })}</ul>{!products.products.length && <p>Товарів не знайдено.</p>}
        <div className="flex flex-wrap gap-2"><button className="btn btn-outline btn-compact-md" disabled={searching || !offset} onClick={() => search(Math.max(0, offset - 20))}>Попередні товари</button><button className="btn btn-outline btn-compact-md" disabled={searching || products.nextOffset == null} onClick={() => search(products.nextOffset)}>Наступні товари</button></div>
      </>}
      {selected && <p>Обрано: {selected.fromProblem && !selected.public_sku ? <strong>товар із черги проблем</strong> : <>{productIdentity(selected).label && <>{productIdentity(selected).label}: </>}<strong>{productIdentity(selected).value}</strong></>}</p>}
      <button className="btn btn-primary btn-compact-md" disabled={busy || !selected} onClick={() => check('product-preview', { productId: selected.id })}>Перевірити поточний товар</button>
    </section>
    <section className="card space-y-3 p-5"><h3 className="font-semibold">Приклад нового товару</h3><p className="text-sm text-slate-600">Перевірка CREATE лише читає дані. Товар, публічний артикул і завдання доставки не створюються.</p>
      {!config && !error && <LoadingState />}
      {config && <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); check('create-preview', createInput()); }}>
        {questions.filter((question) => (!requiresPhysicalWeight || question.id !== 'weight') && isQuestionVisible(question, answers, calibrated)).map((question) => <label className="block text-sm" key={question.id}>{question.label}
          {isTextQuestion(question) ? <input className="input" required={isCreateQuestionRequired(question, rules)} value={answers[question.id] ?? ''} onChange={(event) => changeAnswer(question, event.target.value)} />
            : <select className="input" required={isCreateQuestionRequired(question, rules)} value={answers[question.id] ?? ''} onChange={(event) => changeAnswer(question, event.target.value)}><option value="">Оберіть значення</option>{getVisibleOptionsForQuestion(question, answers, calibrated).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>}
        </label>)}
        {requiresPhysicalWeight && <label className="block text-sm">{weightQuestion?.label || 'Вага, г'}<input className="input" required inputMode="decimal" value={weight} onChange={(event) => {
          const value = event.target.value; invalidate(); setWeight(value);
          if (weightQuestion) setAnswers((current) => {
            const next = { ...current }; if (value === '') delete next.weight; else next.weight = value; return next;
          });
        }} /></label>}
        {rules.namesRequired && <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Назва українською<input className="input" required value={ua} onChange={(event) => { invalidate(); setUa(event.target.value); }} /></label><label className="text-sm">Назва англійською<input className="input" required value={en} onChange={(event) => { invalidate(); setEn(event.target.value); }} /></label></div>}
        <label className="block text-sm">Ручна ціна прикладу, грн (за потреби)<input className="input" type="number" min="0.01" step="0.01" value={price} onChange={(event) => { invalidate(); setPrice(event.target.value); }} /></label>
        {!canCheckCreation && <Notice tone="warning">Спочатку потрібна опублікована схема SKU цієї категорії.</Notice>}
        <button className="btn btn-primary btn-compact-md" disabled={busy || !canCheckCreation}>Перевірити приклад CREATE</button>
      </form>}
    </section>
    {error && <Notice>{error}</Notice>}{busy && <LoadingState label="Перевіряємо цей товар у Magento…" />}
    {preview && <section className="card space-y-3 p-5" aria-live="polite"><h3 className="font-semibold">{preview.result.sendable ? 'Цей приклад пройшов перевірку доставки' : 'Цей приклад потребує уваги'}</h3>
      <p className="text-sm">{preview.result.hypothetical ? 'Умовний приклад CREATE; це не збережений товар.' : `Артикул: ${preview.result.article}`} Результат стосується лише цього прикладу та вибраних відповідностей.</p>
      <ul>{preview.result.blockers.map((blocker, index) => <li key={index}>{problemTitle(blocker)}</li>)}</ul>
      <MagentoProductComparison result={preview.result} />
      {preview.result.hypothetical && preview.result.sendable && <button className="btn btn-outline btn-compact-md" onClick={() => onRepresentative({ routeKey: preview.result.routeKey, input: structuredClone(preview.input), group: categoryCode })}>Зберегти перевірений приклад</button>}
      <MagentoDetails summary="Технічні деталі перевірки">{() => <pre className="text-xs">{JSON.stringify(preview.result, null, 2)}</pre>}</MagentoDetails>
    </section>}
  </div>;
}
export default function MagentoProductChecks(props) {
  return <ProductChecks key={`${props.revision.id}:${props.revision.revision}:${props.categoryCode}:${props.initialProductId || ''}`} {...props} />;
}
