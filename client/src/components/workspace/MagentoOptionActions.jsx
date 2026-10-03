import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../auth/auth-context.js';
import { isActualAdministrator } from '../../auth/auth-model.js';
import { Notice } from '../app/UiPrimitives.jsx';
import MagentoDetails from './MagentoDetails.jsx';

const actionsRoot = '/admin/magento-integration/actions';
const optionsRoot = '/admin/magento-integration/options';
const labelsRoot = '/admin/magento-integration/option-labels';

function OptionWorkspace({ revision, category, observation, onResourceChanged, mode, currentPublishedId, readOnly = false }) {
  const auth = useAuth(); const { permissions } = auth;
  const labelUpdate = mode === 'labels'; const root = labelUpdate ? labelsRoot : optionsRoot;
  const canInspect = ['export_templates.manage', 'export_templates.publish'].every((permission) => permissions.includes(permission));
  const canWrite = canInspect && !readOnly && isActualAdministrator(auth);
  const isCurrent = !labelUpdate || (revision?.state === 'published' && (currentPublishedId === undefined || currentPublishedId === revision.id));
  const validContext = isCurrent && (labelUpdate ? revision?.state === 'published' : revision?.state === 'draft');
  const [source, setSource] = useState(''); const [attributeCode, setAttributeCode] = useState('');
  const [ordinary, setOrdinary] = useState(false); const [hidden, setHidden] = useState(false); const [evidence, setEvidence] = useState('');
  const [inspection, setInspection] = useState(null); const [proof, setProof] = useState(null);
  const [actions, setActions] = useState([]); const [currentActionIds, setCurrentActionIds] = useState([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const sequence = useRef(0); const inFlight = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); const requests = sequence;
    if (!readOnly) api.get(actionsRoot, { signal: controller.signal }).then(({ data }) => {
      if (!controller.signal.aborted) setActions((current) => [...current, ...data.filter((item) => !current.some((action) => action.id === item.id))]);
    }).catch(() => { if (!controller.signal.aborted) setError('Не вдалося прочитати історію дій.'); });
    return () => { controller.abort(); ++requests.current; };
  }, [readOnly]);
  const values = (category?.values || []).filter((value) => labelUpdate ? value.state === 'approved' : !['approved', 'not_applicable'].includes(value.state));
  const value = values.find((item) => `${item.questionKey}:${item.valueId}` === source);
  const command = value && revision ? { bindingRevisionId: revision.id, expectedRevision: revision.revision, attributeCode,
    amberGroup: category.code, questionKey: value.questionKey, valueId: value.valueId } : null;
  const approvedAttributes = new Set(value?.mappings?.filter((mapping) => mapping.optionId).map((mapping) => mapping.attribute));
  const attributes = (labelUpdate ? revision?.schema.attributes : observation?.schema.attributes || revision?.schema.attributes) || [];
  async function readActions(current) {
    try { const { data } = await api.get(actionsRoot); if (current === sequence.current) setActions(data); }
    catch { if (current === sequence.current) setError('Не вдалося оновити історію дій. Перевірте збережений результат перед наступною дією.'); }
  }
  async function run(kind, payload) {
    if (inFlight.current || !canInspect || !validContext || ((kind === 'attest' || kind === 'apply') && !canWrite) || (kind === 'reconcile' && readOnly)) return;
    inFlight.current = true;
    const current = ++sequence.current; setBusy(true); setError('');
    try {
      const response = await api.post(`${root}/${kind}`, payload);
      if (current !== sequence.current) return;
      if (kind === 'inspect') { setInspection(response.data); setProof(null); }
      else if (kind === 'attest') {
        const preview = await api.post(`${root}/preview`, { ...command, attestationId: response.data.id });
        if (current === sequence.current) setProof({ ...preview.data, command: { ...command, attestationId: response.data.id } });
      } else {
        setProof(null);
        if (response.data.id) {
          setCurrentActionIds((ids) => [...new Set([...ids, response.data.id])]);
          setActions((previous) => [response.data, ...previous.filter((action) => action.id !== response.data.id)]);
        }
        if (!labelUpdate && response.data.state === 'verified') onResourceChanged?.();
        await readActions(current);
      }
    } catch (cause) {
      if (current === sequence.current) {
        setError(cause.response?.data?.error || 'Перевірка не завершилася.'); setProof(null);
        const actionId = cause.response?.data?.details?.actionId;
        if (actionId) setCurrentActionIds((ids) => [...new Set([...ids, actionId])]);
        if (!readOnly) await readActions(current);
      }
    } finally { if (current === sequence.current) { inFlight.current = false; setBusy(false); } }
  }
  function invalidate() { ++sequence.current; setInspection(null); setProof(null); setOrdinary(false); setHidden(false); setEvidence(''); setCurrentActionIds([]); }
  const matchingKind = labelUpdate ? 'option_label' : 'option';
  const history = actions.filter((action) => action.kind === matchingKind);
  const isExactTarget = (action) => currentActionIds.includes(action.id) || (labelUpdate && inspection?.target.optionId
    && action.attributeCode === inspection.target.attributeCode && String(action.remoteId) === String(inspection.target.optionId));
  const currentActions = history.filter(isExactTarget); const otherActions = history.filter((action) => !isExactTarget(action));
  const pending = otherActions.filter((action) => !['verified', 'superseded'].includes(action.state)).length;
  const actionRow = (action) => <article className="border-t py-3 text-sm" key={action.id}><p className="break-words">{action.attributeCode}: {action.label} · {action.message}</p>
    {canInspect && !readOnly && action.canReconcile && <button className="btn btn-outline btn-compact-md" disabled={busy} onClick={() => run('reconcile', { actionId: action.id })}>Перевірити результат читанням</button>}
    <MagentoDetails summary="Технічні деталі">{() => <p>{action.id} · {action.state}{action.remoteId ? ` · Magento ID ${action.remoteId}` : ''}</p>}</MagentoDetails>
  </article>;
  return <section className="card space-y-3 p-5"><h2 className="font-semibold">{labelUpdate ? 'Назви варіантів Magento' : 'Нові значення Magento'}</h2>
    <p className="text-sm">{labelUpdate ? 'Порівняйте назви точного затвердженого варіанта. Для зміни назв потрібні окрема дія Адміністратора та адаптер Magento.' : 'Створення одного значення та підтвердження його зв’язку з Amber — окремі дії.'}</p>
    {error && <Notice tone="error">{error}</Notice>}
    {!validContext && <Notice>{labelUpdate ? 'Порівняння та зміна назв потребують чинної опублікованої відповідності.' : 'Для створення значень потрібна чернетка відповідностей.'}</Notice>}
    {canInspect && validContext && <>
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); run('inspect', command); }}>
        <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Значення Amber<select className="input" required disabled={busy} value={source} onChange={(event) => { invalidate(); setSource(event.target.value); setAttributeCode(''); }}>
          <option value="">Оберіть значення</option>{values.map((item) => <option key={`${item.questionKey}:${item.valueId}`} value={`${item.questionKey}:${item.valueId}`}>{item.questionLabel}: {item.label}</option>)}</select></label>
          <label className="text-sm">Атрибут Magento<select className="input" required disabled={busy} value={attributeCode} onChange={(event) => { invalidate(); setAttributeCode(event.target.value); }}><option value="">Оберіть атрибут</option>
            {attributes.filter((attribute) => ['select', 'multiselect'].includes(attribute.frontend_input) && (!labelUpdate || approvedAttributes.has(attribute.attribute_code))).map((attribute) => <option key={attribute.attribute_code} value={attribute.attribute_code}>{attribute.default_frontend_label || attribute.attribute_code}</option>)}</select></label></div>
        {value && <p className="text-sm">Українська: {value.label}. Англійська: {value.labelEn || 'Не задано в каталозі Amber'}.</p>}
        <button className="btn btn-outline btn-compact-md" disabled={busy || !command || !attributeCode}>Перевірити значення Magento</button>
      </form>
      {inspection && <div className="space-y-3 border-t pt-3"><p className="text-sm">Глобальна назва Amber: {inspection.target.label}. EN: {inspection.target.englishLabel || 'Не задано в каталозі Amber'}.</p>
        {labelUpdate && inspection.comparison?.map((difference) => <p className="text-sm" key={difference.scope}>{difference.scope === 'all' ? 'Українська' : 'Англійська'} · Magento: {difference.before ?? 'Не задано'} · Amber: {difference.after ?? 'Не задано'}</p>)}
        {inspection.updateUnavailable ? <Notice tone="warning">{inspection.updateUnavailable} Показано назви, які повертає Magento; англійська може бути успадкованою глобальною назвою. Це не доказ збереженого перекладу.</Notice>
          : !labelUpdate && inspection.candidates?.length ? <Notice>Значення вже існує: {inspection.candidates.map((candidate) => candidate.label).join(', ')}. Підтвердьте зв’язок окремо в чернетці відповідностей.</Notice>
            : canWrite ? <>
              <Notice>{inspection.warning}</Notice>
              <label className="flex gap-2 text-sm"><input type="checkbox" checked={ordinary} disabled={busy} onChange={(event) => { setOrdinary(event.target.checked); setProof(null); }} />Я перевірив, що це звичайний user-defined select/multiselect, без swatch або custom source model.</label>
              <label className="flex gap-2 text-sm"><input type="checkbox" checked={hidden} disabled={busy} onChange={(event) => { setHidden(event.target.checked); setProof(null); }} />Розумію обмеження REST; підтверджую поточну класифікацію лише для цієї дії.</label>
              <label className="block text-sm">Підстава перевірки<input className="input" maxLength={2000} value={evidence} disabled={busy} onChange={(event) => { setEvidence(event.target.value); setProof(null); }} /></label>
              <button className="btn btn-outline btn-compact-md" disabled={busy || !ordinary || !hidden || evidence.trim().length < 3} onClick={() => run('attest', {
                ...command, metadataFingerprint: inspection.metadataFingerprint, confirmOrdinary: ordinary, confirmHiddenLimit: hidden, evidence,
              })}>{labelUpdate ? 'Підтвердити можливість і переглянути зміни' : 'Підтвердити можливість і переглянути створення'}</button>
            </> : <p className="text-sm">{readOnly ? 'Це порівняння лише для перегляду. Зміни виконуються в розділі «Дії Адміністратора».' : 'Для створення або зміни значення потрібне окреме підтвердження Адміністратора.'}</p>}
        <MagentoDetails summary="Технічні деталі перевірки">{() => <pre className="overflow-auto text-xs">{JSON.stringify(inspection, null, 2)}</pre>}</MagentoDetails>
      </div>}
      {canWrite && proof && <Notice><p>{labelUpdate ? 'Оновити назви' : 'Створити'} «{proof.label}» в {proof.target.attributeCode}{proof.target.englishLabel ? `; EN: ${proof.target.englishLabel}` : ''}. Це не підтверджує відповідність.</p>
        <ul>{proof.differences?.map((difference) => <li key={difference.scope}>{difference.scope === 'all' ? 'Українська' : 'Англійська'}: {difference.before ?? 'Не задано'} → {difference.after}</li>)}</ul>
        <div className="mt-2 flex flex-wrap gap-2"><button className="btn btn-primary btn-compact-md" disabled={busy} onClick={() => run('apply', { ...proof.command, previewToken: proof.previewToken })}>{labelUpdate ? 'Підтвердити зміну назв у Magento' : 'Створити значення в Magento'}</button>
          <button className="btn btn-outline btn-compact-md" disabled={busy} onClick={invalidate}>Скасувати</button></div></Notice>}
    </>}
    {!readOnly && <>{currentActions.map(actionRow)}
      {pending > 0 && <Notice tone="warning">Незавершених дій цього типу: {pending}. Перевірте історію; повторне надсилання непідтверджених змін недоступне.</Notice>}
      {otherActions.length > 0 && <MagentoDetails summary={`Історія дій цього типу (${otherActions.length})`}>{() => otherActions.map(actionRow)}</MagentoDetails>}
    </>}
  </section>;
}

export default function MagentoOptionActions(props) {
  const mode = props.mode || (props.revision?.state === 'published' ? 'labels' : 'create');
  if (!['labels', 'create'].includes(mode)) return null;
  const context = `${props.revision?.id}:${props.revision?.revision}:${props.category?.code}:${mode}:${props.currentPublishedId}:${props.readOnly || false}:${props.observation?.observedAt || ''}`;
  return <OptionWorkspace key={context} {...props} mode={mode} />;
}
