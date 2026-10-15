import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/auth-context.js';
import { useDirtyNavigation } from '../../hooks/useDirtyNavigation.jsx';
import { getCatalogReturnTarget } from '../../lib/catalog-entry.js';
import { CatalogCharacteristicEditor } from '../admin/CatalogCharacteristicEditor.jsx';
import { Notice } from '../app/UiPrimitives.jsx';
import { WorkspaceDialog } from './WorkspaceDialog.jsx';
import CatalogCharacteristics from './CatalogCharacteristics.jsx';

export default function LocalCatalogCategory({ categoryCode, localConfig, onLocalSaved, error, canIntegrate, onPendingChange }) {
  const auth = useAuth(); const [params, setParams] = useSearchParams();
  const [editor, setEditor] = useState(() => ['new-question', 'edit-question', 'new-option', 'edit-option'].includes(params.get('action')) ? { questionKey: params.get('question'), initialAction: params.get('action'), optionValue: params.get('value'), optionId: params.get('optionId') } : null);
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false);
  useEffect(() => { onPendingChange?.(dirty || busy); return () => onPendingChange?.(false); }, [dirty, busy, onPendingChange]);
  const navigation = useDirtyNavigation({ dirty: dirty || busy, busy, discard: () => { setEditor(null); setDirty(false); } });
  const category = localConfig?.categories?.[categoryCode];
  const canEdit = auth.principalLifetime?.valid !== false && auth.permissions.includes('catalog.manage') && Boolean(category);
  const resource = new URLSearchParams(params); resource.set('category', categoryCode); resource.set('catalogTask', 'resource'); resource.set('intent', 'connect'); resource.delete('action');
  const tab = params.get('view') || 'attributes';
  const returnTo = getCatalogReturnTarget(params.get('returnTo'));
  return <section className="mc-category-content space-y-4">
    <header><h2>{category?.name || categoryCode}</h2>{canEdit && <Link className="mc-field-link" to={`/admin/catalog?category=${encodeURIComponent(categoryCode)}&action=edit-category`}>Редагувати категорію</Link>}</header>
    {returnTo && <Link className="mc-field-link" to={returnTo}>Повернутися до попередньої задачі</Link>}
    <nav className="mc-tabs" aria-label="Поля категорії">{[['attributes', 'Характеристики'], ['placement', 'Категорії магазину'], ['text', 'Назви та SEO']].map(([value, label]) => <button type="button" key={value} aria-pressed={tab === value} onClick={() => { const next = new URLSearchParams(params); next.set('view', value); setParams(next); }}>{label}</button>)}</nav>
    {error && <Notice tone="warning">{error} Збереження характеристик у Менеджері доступне окремо.</Notice>}
    {tab === 'attributes' ? <CatalogCharacteristics categoryCode={categoryCode} questions={localConfig?.questions?.[categoryCode] || []} canEdit={canEdit} disabled={busy} selectedQuestion={params.get('question')} onEdit={setEditor} /> : <p>Щоб налаштувати цю вкладку, підключіть категорію до магазину.</p>}
    {canIntegrate && <Link className="btn btn-outline" to={`/admin/catalog?${resource}`}>Налаштувати підключення категорії</Link>}
    {editor && <WorkspaceDialog title="Характеристика Менеджера" busy={busy} onClose={() => navigation.request(() => setEditor(null))}>
      <CatalogCharacteristicEditor key={JSON.stringify(editor)} categoryCode={categoryCode} {...editor} onSaved={onLocalSaved} onClose={() => setEditor(null)} onDirtyChange={setDirty} onBusyChange={setBusy} />
    </WorkspaceDialog>}
    {navigation.prompt}
  </section>;
}
