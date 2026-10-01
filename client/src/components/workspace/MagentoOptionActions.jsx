import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../auth/auth-context.js';
import { Notice } from '../app/UiPrimitives.jsx';
const root = '/admin/magento-integration/options';
export default function MagentoOptionActions({ revision, category, observation }) {
  const { permissions } = useAuth();
  const canCreate = ['users.manage','export_templates.manage','export_templates.publish'].every((p) => permissions.includes(p));
  const [source, setSource] = useState(''); const [attributeCode, setAttributeCode] = useState('');
  const [englishLabel, setEnglishLabel] = useState(''); const [englishAuthoritative, setEnglishAuthoritative] = useState(false);
  const [ordinary, setOrdinary] = useState(false); const [hidden, setHidden] = useState(false); const [evidence, setEvidence] = useState('');
  const [inspection, setInspection] = useState(null); const [proof, setProof] = useState(null);
  const [actions, setActions] = useState([]); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const sequence = useRef(0);
  useEffect(() => {
    const requests = sequence;
    let active = true; api.get('/admin/magento-integration/actions').then(({ data }) => { if (active) setActions(data); }).catch(() => {});
    return () => { active = false; ++requests.current; };
  }, []);
  const value = category?.values.find((v) => `${v.questionKey}:${v.valueId}` === source);
  const command = value && revision ? { bindingRevisionId: revision.id, expectedRevision: revision.revision, attributeCode,
    amberGroup: category.code, questionKey: value.questionKey, valueId: value.valueId,
    ...(englishLabel ? { englishLabel, englishAuthoritative } : {}) } : null;
  async function run(kind, payload) {
    const current = ++sequence.current; setBusy(true); setError('');
    try {
      const response = await api.post(`${root}/${kind}`, payload);
      if (current !== sequence.current) return;
      if (kind === 'inspect') setInspection(response.data);
      else if (kind === 'attest') {
        const preview = await api.post(`${root}/preview`, { ...command, attestationId: response.data.id });
        if (current === sequence.current) setProof({ ...preview.data, command: { ...command, attestationId: response.data.id } });
      } else { setProof(null); const rows = await api.get('/admin/magento-integration/actions'); if (current === sequence.current) setActions(rows.data); }
    } catch (cause) {
      if (current === sequence.current) { setError(cause.response?.data?.error || 'Перевірка не завершилася.'); setProof(null);
        const rows = await api.get('/admin/magento-integration/actions').catch(() => null); if (rows && current === sequence.current) setActions(rows.data); }
    } finally { if (current === sequence.current) setBusy(false); }
  }
  function invalidate() { ++sequence.current; setBusy(false); setInspection(null); setProof(null); setOrdinary(false); setHidden(false); }
  return <section className="card space-y-3 p-5"><h2 className="font-semibold">Нові значення Magento</h2>
    <p className="text-sm">Створення одного значення та підтвердження його зв’язку з Amber — окремі дії.</p>
    {error && <Notice tone="error">{error}</Notice>}
    {canCreate && revision?.state === 'draft' && <>
      <form className="space-y-3" onChangeCapture={invalidate} onSubmit={(e) => { e.preventDefault(); run('inspect', command); }}>
        <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Значення Amber<select className="input" required value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Оберіть значення</option>{category?.values.map((v) => <option key={`${v.questionKey}:${v.valueId}`} value={`${v.questionKey}:${v.valueId}`}>{v.questionLabel}: {v.label} · {v.valueId}</option>)}</select></label>
        <label className="text-sm">Атрибут Magento<select className="input" required value={attributeCode} onChange={(e) => setAttributeCode(e.target.value)}><option value="">Оберіть атрибут</option>
          {(observation?.schema.attributes || revision.schema.attributes).filter((a) => ['select','multiselect'].includes(a.frontend_input)).map((a) => <option key={a.attribute_code} value={a.attribute_code}>{a.attribute_code} / {a.attribute_id}</option>)}</select></label></div>
        <label className="block text-sm">Затверджене значення Amber англійською (необов’язково)<input className="input" value={englishLabel} onChange={(e) => { setEnglishLabel(e.target.value); setEnglishAuthoritative(false); }} /></label>
        {englishLabel && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={englishAuthoritative} onChange={(e) => setEnglishAuthoritative(e.target.checked)} />Це явне затверджене EN значення Amber; включити його в цю дію.</label>}
        <button className="btn btn-outline btn-compact-md" disabled={busy || !command || !attributeCode || (!!englishLabel && !englishAuthoritative)}>Перевірити значення Magento</button>
      </form>
      {inspection && <div className="space-y-3 border-t pt-3"><p className="text-sm">Глобальна назва Amber: {inspection.target.label}. Атрибут: {inspection.attribute.attribute_code} / {inspection.attribute.attribute_id}.</p>
        {inspection.candidates.length ? <Notice>Значення вже існує: {inspection.candidates.map((c) => `${c.label} / ${c.value}`).join(', ')}. Підтвердьте зв’язок окремо в чернетці відповідностей.</Notice> : <>
          <Notice>{inspection.warning}</Notice>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={ordinary} onChange={(e) => { setOrdinary(e.target.checked); setProof(null); }} />Я перевірив, що це звичайний user-defined select/multiselect, без swatch або custom source model.</label>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={hidden} onChange={(e) => { setHidden(e.target.checked); setProof(null); }} />Розумію обмеження REST; підтверджую поточну класифікацію лише для цієї дії.</label>
          <label className="block text-sm">Підстава перевірки<input className="input" maxLength={2000} value={evidence} onChange={(e) => { setEvidence(e.target.value); setProof(null); }} /></label>
          <button className="btn btn-outline btn-compact-md" disabled={busy || !ordinary || !hidden || evidence.trim().length < 3} onClick={() => run('attest', {
            ...command, metadataFingerprint: inspection.metadataFingerprint, confirmOrdinary: ordinary, confirmHiddenLimit: hidden, evidence,
          })}>Підтвердити можливість і переглянути створення</button>
        </>}
      </div>}
      {proof && <Notice><p>Створити «{proof.label}» в {proof.target.attributeCode}{proof.target.englishLabel ? `; EN: ${proof.target.englishLabel}` : ''}. Це не підтверджує semantic binding.</p>
        <div className="mt-2 flex gap-2"><button className="btn btn-primary btn-compact-md" disabled={busy} onClick={() => run('apply', { ...proof.command, previewToken: proof.previewToken })}>Створити значення в Magento</button>
          <button className="btn btn-outline btn-compact-md" disabled={busy} onClick={invalidate}>Скасувати</button></div></Notice>}
    </>}
    {actions.filter((a) => a.kind === 'option').map((a) => <div className="border-t py-3 text-sm" key={a.id}><p>{a.attributeCode}: {a.label} · {a.message}{a.remoteId ? ` · ID ${a.remoteId}` : ''}</p>
      {canCreate && a.canReconcile && <button className="btn btn-outline btn-compact-md" disabled={busy} onClick={() => run('reconcile', { actionId: a.id })}>Перевірити результат читанням</button>}
      <details><summary>Технічні деталі</summary>{a.id} · {a.state}</details></div>)}
  </section>;
}
