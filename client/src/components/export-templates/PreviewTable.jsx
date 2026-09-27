import { useMemo, useState } from 'react';
import { parsePreviewCsv } from '../../lib/export-template-csv';
import { OutputGrid } from './OutputGrid';

export function PreviewTable({ artifact }) {
  const parsed = useMemo(() => { try { return parsePreviewCsv(artifact.csvContent); } catch (error) { return { error }; } }, [artifact.csvContent]);
  if (parsed.error) return <p role="alert">{parsed.error.message}</p>;
  return <section aria-label={'Таблиця результату ' + artifact.groupCode}><OutputGrid columns={parsed.headers} rows={parsed.rows.map((values) => ({ values, label: (values[parsed.headers.indexOf('store_view_code')] === 'en' ? 'EN' : 'Основний') + ' · ' + (values[parsed.headers.indexOf('sku')] || '') }))}
    title={`${artifact.groupName || artifact.groupCode} · ${artifact.rowCount} рядків · порядок CSV`} /></section>;
}
export function ArtifactTables({ artifacts = [], stored = false }) {
  const [group, setGroup] = useState('');
  const selected = artifacts.find((a) => a.groupCode === group) || artifacts[0];
  if (!selected) return null;
  return <section className="et-artifacts" aria-label={stored ? 'Збережені таблиці' : 'Майбутні таблиці'}>
    <p>{stored ? 'Незмінний збережений результат' : 'Авторитетний попередній перегляд'} · значення CSV з нейтралізацією формул</p>
    <div className="et-tabs" role="group" aria-label="Файли">{artifacts.map((a) => <button type="button" key={a.groupCode} aria-pressed={selected.groupCode === a.groupCode} onClick={() => setGroup(a.groupCode)}>{a.groupName || a.groupCode}</button>)}</div>
    {typeof selected.csvContent === 'string' ? <PreviewTable key={selected.groupCode} artifact={selected} /> : <p>Для таблиці повторіть перевірку або відкрийте збережений знімок.</p>}
  </section>;
}
