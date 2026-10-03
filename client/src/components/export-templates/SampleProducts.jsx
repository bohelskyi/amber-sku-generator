import { useEffect, useRef, useState } from 'react';
import { getApiError } from '../../lib/http-error';

function publicArticle(product) {
  return typeof product?.public_sku === 'string' && product.public_sku.trim()
    ? product.public_sku.trim()
    : null;
}

function ProductIdentity({ product }) {
  const article = publicArticle(product);
  const internalSku = typeof product?.full_sku === 'string' && product.full_sku.trim()
    ? product.full_sku.trim()
    : null;
  return <div>
    <strong>{article ? `Артикул: ${article}` : 'Артикул недоступний'}</strong>
    {internalSku && <details className="mt-1"><summary>Внутрішні дані</summary><div><small>Внутрішній SKU: {internalSku}</small></div></details>}
  </div>;
}

export function SampleProducts({ search, selected, onChange }) {
  const [query, setQuery] = useState(''); const [offset, setOffset] = useState(0);
  const [result, setResult] = useState(null); const [error, setError] = useState(null); const [busy, setBusy] = useState(false);
  const generation = useRef(0); const controller = useRef(null);
  useEffect(() => {
    if (query.trim().length < 2) return;
    const ticket = ++generation.current; const abort = new AbortController(); controller.current = abort;
    const timer = setTimeout(() => {
      setBusy(true);
      Promise.resolve(search({ q: query.trim(), offset }, abort.signal)).then((r) => { if (ticket === generation.current && !abort.signal.aborted) setResult(r.data); })
        .catch((e) => { if (ticket === generation.current && !abort.signal.aborted) setError(e); })
        .finally(() => { if (ticket === generation.current && !abort.signal.aborted) setBusy(false); });
    }, 250);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [query, offset, search]);
  const changeSearch = (q, page = 0) => { generation.current++; controller.current?.abort(); setQuery(q); setOffset(page); setResult(null); setError(null); setBusy(false); };
  return <section aria-label="Обрати товари" className="et-sample-picker">
    <h3>Обрати товари</h3><label>Пошук за артикулом або внутрішнім SKU<input type="search" className="input" maxLength={160} value={query} onChange={(e) => changeSearch(e.target.value)} placeholder="Артикул, внутрішній SKU або щонайменше 2 символи" /></label>
    <p>Оберіть до 100 товарів. Пошук не перевіряє готовність до експорту й показує також неповні та архівні товари.</p>
    {busy && <p role="status">Пошук…</p>}{error && <p role="alert">Не вдалося знайти товари: {getApiError(error)}</p>}
    {result && <><ul>{result.products.map((p) => { const article = publicArticle(p); return <li key={p.id}><div><ProductIdentity product={p} /><span>{p.category} · {({ active: 'Активний', archived: 'Архівний', corrected: 'Переоблікований', generated: 'Створений' })[p.status] || 'Статус не вказано'}</span></div>
      <button type="button" disabled={selected.some((s) => s.id === p.id) || selected.length >= 100} onClick={() => onChange([...selected, p])}>Обрати {article || 'товар без артикулу'}</button></li>; })}</ul>
      {!result.products.length && <p>Товарів за цим запитом не знайдено.</p>}
      <div className="et-actions"><button type="button" disabled={!offset} onClick={() => changeSearch(query, Math.max(0, offset - 20))}>Попередні товари</button>
        <button type="button" disabled={result.nextOffset === null} onClick={() => changeSearch(query, result.nextOffset)}>Наступні товари</button></div></>}
    <h4>Вибрано: {selected.length} / 100</h4>
    <ul>{selected.map((p) => { const article = publicArticle(p); return <li key={p.id}><div><ProductIdentity product={p} />{p.category && <span>{p.category}</span>}</div><button type="button" aria-label={`Прибрати ${article || `товар #${p.id}`}`} onClick={() => onChange(selected.filter((s) => s.id !== p.id))}>Прибрати</button></li>; })}</ul>
  </section>;
}
