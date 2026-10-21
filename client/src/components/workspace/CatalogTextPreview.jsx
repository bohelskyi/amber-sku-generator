import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAuth } from '../../auth/auth-context.js';
import { exportTemplatesApi as templates } from '../../api/export-templates-api.js';
import { parsePreviewCsv } from '../../lib/export-template-csv.js';
import { getApiError } from '../../lib/http-error.js';
import { SampleProducts } from '../export-templates/SampleProducts.jsx';

function TextResult({ response, categoryCode, column, rowId }) {
  const result = response.result;
  const artifact = (result.provisionalArtifacts || result.artifacts || []).find((item) => item.groupCode === categoryCode);
  let values;
  try {
    if (artifact) {
      const parsed = parsePreviewCsv(artifact.csvContent);
      const field = parsed.headers.indexOf(column); const language = parsed.headers.indexOf('store_view_code');
      if (field >= 0 && language >= 0) values = Object.fromEntries(parsed.rows.map((row) => [row[language] === 'en' ? 'english' : 'base', row[field]]));
    }
  } catch { /* Malformed or absent server output must never become a local approximation. */ }
  return <div className="space-y-3" aria-label="Обчислений приклад тексту">
    {values ? ['base', 'english'].map((language) => <section key={language} aria-label={language === 'base' ? 'Приклад UA' : 'Приклад EN'} className="rounded-lg border p-3">
      <h4 className="font-semibold">{language === 'base' ? 'UA · українською' : 'EN · англійською'}{rowId === language && ' · редагуємо'}</h4>
      <p className="whitespace-pre-wrap break-words">{values[language] === undefined ? 'Сервер не повернув значення.' : values[language] || 'Порожнє значення'}</p>
    </section>) : <p role="status">Приклад поки не обчислено. Перевірте правило та заповнення вибраного товару.</p>}
    {result.errors?.length > 0 && <details><summary>Що заважає обчисленню</summary><ul>{result.errors.flatMap((product) => product.fields.map((field, index) => <li key={`${product.productId}:${index}`}>{field.field}: {field.message}</li>))}</ul></details>}
    {response.globalSourceDiagnostics?.length > 0 && <details><summary>Інші питання до правил</summary><p>Для повної перевірки залишилися питання до джерел інших категорій.</p></details>}
  </div>;
}

// Examples use the unsaved definition and authoritative server product data.
// No template family or draft is created as a side effect of viewing text.
export default function CatalogTextPreview(props) {
  const auth = useAuth();
  return <TextPreviewEditor key={`${auth.principalLifetime?.id || auth.applicationUser?.id || 'session'}:${props.categoryCode}:${props.column}`} {...props} auth={auth} />;
}

function TextPreviewEditor({ getDefinition, changeKey, disabled = false, categoryCode, column, rowId, onBusyChange, auth }) {
  const { permissions = [], principalLifetime } = auth;
  const allowed = ['export_templates.view', 'export_templates.manage', 'exports.view'].every((permission) => permissions.includes(permission)) && principalLifetime?.valid !== false;
  const [selected, setSelected] = useState([]); const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null); const [error, setError] = useState(null);
  const scope = useRef(null); const flight = useRef(false); const accessible = useRef(null); const busyCallback = useRef(onBusyChange);
  useLayoutEffect(() => { accessible.current = { allowed, disabled, owner: principalLifetime }; busyCallback.current = onBusyChange; }, [allowed, disabled, principalLifetime, onBusyChange]);
  useEffect(() => {
    const lifetime = { valid: true }; scope.current = lifetime;
    return () => { lifetime.valid = false; busyCallback.current?.(false); };
  }, []);
  const search = useCallback(async (query, signal) => {
    if (!allowed || principalLifetime?.valid === false) return { data: { products: [], nextOffset: null } };
    const response = await templates.searchSamples(query, signal);
    return { ...response, data: { ...response.data, products: response.data.products.filter((product) => product.category === categoryCode) } };
  }, [allowed, categoryCode, principalLifetime]);

  const update = async () => {
    if (flight.current || disabled || !allowed || principalLifetime?.valid === false || selected.length !== 1) return;
    const lifetime = scope.current;
    const current = () => lifetime?.valid && accessible.current.owner === principalLifetime && accessible.current.allowed && !accessible.current.disabled && principalLifetime?.valid !== false;
    flight.current = true; setBusy(true); setError(null); busyCallback.current?.(true);
    try {
      const definition = structuredClone(getDefinition());
      const { data } = await templates.evaluateExample({ definition, productIds: [selected[0].id] });
      if (!current()) return;
      setPreview({ response: data, changeKey, productId: selected[0].id, owner: principalLifetime });
    } catch (cause) { if (current()) setError(cause); }
    finally { if (lifetime?.valid) { flight.current = false; setBusy(false); busyCallback.current?.(false); } }
  };
  const visible = allowed && preview?.owner === principalLifetime ? preview : null;
  const stale = visible && (visible.changeKey !== changeKey || visible.productId !== selected[0]?.id);
  return <section aria-label="Приклад тексту" className="space-y-3 catalog-text-preview">
    {!allowed ? <p>Для прикладу потрібні права на редагування правил і перегляд товарів експорту.</p> : <>
      <fieldset disabled={disabled || busy} className="min-w-0 space-y-3">
        <SampleProducts search={search} selected={selected} onChange={setSelected} maxSelected={1} />
        <button type="button" className="btn btn-outline" disabled={disabled || busy || selected.length !== 1} onClick={update}>{busy ? 'Обчислюємо…' : 'Оновити приклад'}</button>
      </fieldset>
      {!visible && <p className="text-sm text-slate-600">Приклад врахує поточне введення.</p>}
      {error && <div role="alert"><p>Не вдалося обчислити приклад. Перевірте правило та спробуйте ще раз.</p><details><summary>Подробиці</summary><p>{getApiError(error)}</p></details></div>}
      {stale && <p role="status">Правило або товар змінилися. Оновіть приклад — нижче попередній результат.</p>}
      {visible && <TextResult response={visible.response} categoryCode={categoryCode} column={column} rowId={rowId} />}
    </>}
  </section>;
}
