import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../auth/auth-context.js';
import { isActualAdministrator } from '../../auth/auth-model.js';
import { LoadingState, Notice } from '../app/UiPrimitives.jsx';
import MagentoDetails from './MagentoDetails.jsx';
import MagentoPublicationActions from './MagentoPublicationActions.jsx';
import MagentoExactSkuPicker from './MagentoExactSkuPicker.jsx';
import { checkedExactSkuResponse, controlledBlockerText, selectableControlledProduct } from '../../lib/magento-controlled-selection.js';

const root = '/admin/magento-integration';
const titles = { name_rule: 'Застосувати правило назв', broader_resync: 'Повторна синхронізація вибраних товарів' };


function ControlledWorkspace({ revision, kind, onApplied, categoryCode, singleProductId }) {
  const { principalLifetime } = useAuth();
  const [params] = useSearchParams();
  const targetId = Number.isSafeInteger(singleProductId) && singleProductId > 0 ? singleProductId
    : /^[1-9]\d*$/.test(params.get('productId') || '') && Number.isSafeInteger(Number(params.get('productId'))) ? Number(params.get('productId')) : null;
  const back = params.get('returnTo'); const returnTo = back && /^\/(attention|sync-problems)(\?|$)/.test(back) ? back : '/attention';
  const [candidates, setCandidates] = useState(null); const [selected, setSelected] = useState([]);
  const [knownProducts, setKnownProducts] = useState({}); const [exactResults, setExactResults] = useState(null);
  const [productCursors, setProductCursors] = useState([0]); const [productPage, setProductPage] = useState(0);
  const [search, setSearch] = useState(''); const [reason, setReason] = useState('');
  const [review, setReview] = useState(null); const [receipt, setReceipt] = useState(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const sequence = useRef(0); const inFlight = useRef(false);
  useEffect(() => { const requests = sequence; return () => { ++requests.current; }; }, []);
  async function action(path, payload, complete) {
    if (inFlight.current || principalLifetime?.valid === false) return;
    inFlight.current = true;
    const current = ++sequence.current; setBusy(true); setError(''); setReceipt(null);
    try { const { data } = await api.post(`${root}/${path}`, payload); if (current === sequence.current && principalLifetime?.valid !== false) complete(data); }
    catch (cause) { if (current === sequence.current) { setReview(null); setError(cause.response?.data?.error || 'Дані змінилися або дія не завершилася. Повторіть перевірку.'); } }
    finally { if (current === sequence.current) { inFlight.current = false; setBusy(false); } }
  }
  async function loadProducts(cursor = 0, page = 0, reset = false) {
    if (inFlight.current || principalLifetime?.valid === false) return;
    inFlight.current = true;
    const current = ++sequence.current; setBusy(true); setError(''); setReview(null);
    try {
      const { data } = await api.get(`${root}/bindings/${revision.id}/controlled-products`, { params: { after: targetId ? targetId - 1 : cursor, search, ...(categoryCode ? { categoryCode } : {}), ...(singleProductId ? { productId: singleProductId } : {}) } });
      if (current === sequence.current && principalLifetime?.valid !== false) {
        const eligible = targetId ? data.products.filter((product) => product.productId === targetId) : data.products;
        setCandidates(targetId ? { ...data, products: eligible, nextCursor: null } : data);
        setKnownProducts((current) => ({ ...current, ...Object.fromEntries(eligible.map((product) => [product.productId, product])) }));
        if (targetId) setSelected(eligible.filter((product) => selectableControlledProduct(product, kind)).map((product) => product.productId));
        setProductPage(page); if (reset) setProductCursors([0]);
      }
    } catch (cause) { if (current === sequence.current) setError(cause.response?.data?.error || 'Не вдалося прочитати товари.'); }
    finally { if (current === sequence.current) { inFlight.current = false; setBusy(false); } }
  }
  async function resolveExact(skus) {
    if (inFlight.current || principalLifetime?.valid === false) return;
    inFlight.current = true;
    const current = ++sequence.current; setBusy(true); setError(''); setReview(null); setReceipt(null); setExactResults(null);
    try {
      const { data } = await api.post(`${root}/bindings/${revision.id}/controlled-products/resolve`, { skus: JSON.stringify(skus), ...(categoryCode ? { categoryCode } : {}) });
      const checked = checkedExactSkuResponse(data, skus);
      if (current === sequence.current && principalLifetime?.valid !== false) {
        const next = [...selected];
        const results = checked.results.map((result) => {
          if (result.state !== 'eligible') return result;
          const product = checked.products.find((item) => item.productId === result.productId);
          if (!selectableControlledProduct(product, kind)) return { ...result, selectionState: kind === 'name_rule' && !product.changed ? 'Правило не змінює поточні назви; не додано' : 'Потрібне попереднє рішення; не додано' };
          if (next.includes(product.productId)) return { ...result, selectionState: 'Уже у виборі' };
          if (next.length >= 100) return { ...result, selectionState: 'Не додано: у виборі вже 100 товарів' };
          next.push(product.productId); return { ...result, selectionState: 'Додано до вибору' };
        });
        setKnownProducts((known) => ({ ...known, ...Object.fromEntries(checked.products.map((product) => [product.productId, product])) }));
        setSelected(next); setExactResults(results);
      }
    } catch (cause) { if (current === sequence.current) setError(cause.response?.data?.error || cause.message || 'Не вдалося перевірити точні артикули. Вибір не змінено.'); }
    finally { if (current === sequence.current) { inFlight.current = false; setBusy(false); } }
  }
  function invalidate() { ++sequence.current; setReview(null); setReceipt(null); }
  function removeProduct(id) { invalidate(); setSelected((current) => current.filter((item) => item !== id)); }
  const request = { bindingRevisionId: revision.id, expectedRevision: revision.revision, kind, productIds: selected, reason };
  return <section className="card space-y-3 p-5"><h2 className="font-semibold">{singleProductId ? 'Оновити цей товар у Magento' : titles[kind]}</h2>
    {targetId && !singleProductId && <div className="space-y-2"><Link className="text-sm underline" to={returnTo}>Повернутися до проблеми товару</Link><p className="text-sm">Відкрито для одного товару з черги проблем. Спочатку перевірте його доступність; надсилання не запускається автоматично.</p></div>}
    <p className="text-sm">{kind === 'name_rule' ? 'Перегляньте обидві назви для кожного вибраного товару перед застосуванням правила.' : 'Обирайте лише товари, яким потрібна повторна синхронізація.'} Непідтверджені відправлення не скидаються і не повторюються.</p>
    {error && <Notice tone="error">{error}</Notice>}
    {receipt && <Notice tone="success"><p>Контрольовану дію збережено. Фактичний результат доставки перевіряйте за станом передачі товарів.</p><MagentoDetails summary="Деталі збереженої дії">{() => <pre className="overflow-auto text-xs">{JSON.stringify(receipt, null, 2)}</pre>}</MagentoDetails></Notice>}
    <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); loadProducts(0, 0, true); }}>
      {!singleProductId && <label className="text-sm">Пошук за частиною артикулу<input className="input" maxLength={100} disabled={busy} value={search} onChange={(event) => { invalidate(); setSearch(event.target.value); setCandidates(null); }} /></label>}
      <button type="submit" className="btn btn-outline btn-compact-md" disabled={busy}>{singleProductId ? 'Перевірити готовність цього товару' : 'Перевірити товари для контрольованої дії'}</button>
    </form>
    {!targetId && <MagentoExactSkuPicker busy={busy} results={exactResults} onResolve={resolveExact} onInvalidate={() => { invalidate(); setExactResults(null); }} />}
    {!targetId && selected.length > 0 && <section className="mc-selected-products space-y-2" aria-label="Вибрані товари"><h3 className="font-semibold">Вибрано {selected.length} / 100</h3><p className="text-sm">Вибір зберігається між сторінками й пошуками. Перед підтвердженням сервер перевіряє весь точний вибір.</p><ul tabIndex={0} aria-label="Список вибраних артикулів">{selected.map((id) => <li className="flex flex-wrap items-center gap-2 text-sm" key={id}><strong>{knownProducts[id]?.article || `Товар ID ${id}`}</strong><button type="button" className="btn btn-outline btn-compact-md" disabled={busy} onClick={() => removeProduct(id)} aria-label={`Прибрати ${knownProducts[id]?.article || id} з вибору`}>Прибрати з вибору</button></li>)}</ul></section>}
    {selected.length > 0 && <button type="button" className="btn btn-outline btn-compact-md" disabled={busy} onClick={() => { invalidate(); setSelected([]); }}>Очистити вибір</button>}
    {candidates && <>
      {candidates.products.map((product) => <label key={product.productId} className="block text-sm break-words"><input type="checkbox" checked={selected.includes(product.productId)} disabled={busy || (!selected.includes(product.productId) && selected.length >= 100) || !selectableControlledProduct(product, kind)}
        onChange={(event) => { invalidate(); setSelected(event.target.checked ? [...selected, product.productId] : selected.filter((id) => id !== product.productId)); }} /> {product.article} · {product.before.all || 'Назва не сформована'}
        {kind === 'name_rule' && <> → {product.after.all}; {product.before.en} → {product.after.en}</>}
        {product.blockers.length > 0 && <span className="block text-amber-800">{product.blockers.map((code) => controlledBlockerText(code)).join(' ')}</span>}</label>)}
      {!singleProductId && <nav aria-label="Вибір товарів для контрольованої дії" className="flex flex-wrap items-center gap-2 text-sm">
        <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || productPage === 0} onClick={() => loadProducts(productCursors[productPage - 1], productPage - 1)}>Попередні товари</button>
        <span aria-live="polite">Сторінка {productPage + 1} · вибрано {selected.length} / 100</span>
        <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || candidates.nextCursor == null} onClick={() => { setProductCursors([...productCursors.slice(0, productPage + 1), candidates.nextCursor]); loadProducts(candidates.nextCursor, productPage + 1); }}>Наступні товари</button>
      </nav>}
      {!candidates.products.length && <p>{targetId ? 'Цей товар недоступний для контрольованої дії за поточними налаштуваннями. Поверніться до проблеми й перевірте актуальний стан.' : 'Товарів за цим пошуком немає.'}</p>}
    </>}
    {(candidates || selected.length > 0) && <>
      <label className="block text-sm">{singleProductId ? 'Чому потрібно оновити товар' : 'Пояснення контрольованої дії'}<input className="input" maxLength={2000} value={reason} disabled={busy} onChange={(event) => { invalidate(); setReason(event.target.value); }} /></label>
      <button type="button" className="btn btn-outline btn-compact-md" disabled={busy || !selected.length || reason.trim().length < 3} onClick={() => action('controlled/preview', request, setReview)}>{singleProductId ? 'Перевірити оновлення перед надсиланням' : 'Перевірити вибрану дію'}</button>
    </>}
    {review && <>
      {review.blockers.length > 0 && <Notice tone="warning"><ul>{review.blockers.map((blocker, index) => <li key={index}>{controlledBlockerText(blocker.code)}</li>)}</ul><Link className="underline" to="/sync-problems">Проблеми синхронізації</Link></Notice>}
      <p>Вибрано товарів: {review.products.length}.</p>
      {singleProductId && <p>Після підтвердження Amber поставить цей товар на синхронізацію за чинними правилами категорії. Поточні назви товару збережуться. Результат з’явиться у стані Magento.</p>}
      {review.products.map((product) => <p className="text-sm break-words" key={product.productId}>{product.article}{kind === 'name_rule' && <>: {product.before.all} → {product.after.all}; {product.before.en} → {product.after.en}</>}</p>)}
      <button type="button" className="btn btn-primary btn-compact-md" disabled={busy || review.blockers.length > 0} onClick={() => action('controlled/apply', { ...request, previewToken: review.previewToken }, (data) => { setReview(null); setCandidates(null); setSelected([]); setReceipt(data); onApplied?.(data); })}>{singleProductId ? 'Підтвердити надсилання цього товару' : 'Підтвердити контрольовану дію'}</button>
    </>}
    {busy && <LoadingState label="Перевіряємо точний вибір товарів…" />}
    {receipt && !singleProductId && <MagentoPublicationActions revision={revision} currentPublishedId={revision.id} />}
  </section>;
}

export default function MagentoControlledActions(props) {
  const auth = useAuth();
  const [params] = useSearchParams();
  const canApply = auth.principalLifetime?.valid !== false && isActualAdministrator(auth) && ['export_templates.manage', 'export_templates.publish', 'exports.view'].every((permission) => auth.permissions.includes(permission))
    && (props.kind !== 'name_rule' || auth.permissions.includes('exports.create'));
  if (!Object.hasOwn(titles, props.kind)) return null;
  if (!canApply) return <Notice>Для цієї дії потрібні права Адміністратора.</Notice>;
  if (props.revision?.state !== 'published' || props.currentPublishedId !== props.revision?.id) return <Notice>Для контрольованої дії потрібна чинна опублікована версія.</Notice>;
  return <ControlledWorkspace key={`${auth.principalLifetime?.id || 'session'}:${props.revision.id}:${props.revision.revision}:${props.kind}:${props.categoryCode || ''}:${props.singleProductId || params.get('productId') || ''}`} {...props} />;
}
