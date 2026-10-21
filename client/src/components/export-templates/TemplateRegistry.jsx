import { useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, LoadingState, Notice, StatusBadge } from '../ui/index.js';

const versions = (item) => [...(item.version_summaries || item.versions || [])].sort((a, b) => Number(b.versionNumber) - Number(a.versionNumber));
const revision = (item) => item.draft_revision ?? item.draft?.revision;
const unfinished = (item) => revision(item) == null || !versions(item).some((version) => version.sourceDraftRevision != null && String(version.sourceDraftRevision) === String(revision(item)));

export function TemplateRegistry({ families, manage, busy, error, onRefresh, onCopy, base = '/admin/export-templates', integration = false, activePublication }) {
  const [view, setView] = useState(integration ? 'drafts' : 'all');
  const [query, setQuery] = useState(''); const [page, setPage] = useState(0);
  const found = (families || []).filter((item) => item.display_name.toLocaleLowerCase('uk').includes(query.trim().toLocaleLowerCase('uk')) && (view !== 'drafts' || unfinished(item)));
  const rows = view === 'published' ? found.flatMap((item) => versions(item).map((version) => ({ item, version }))) : found.map((item) => ({ item }));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 25) - 1));
  return <section className="et-template-list" aria-label="Шаблони">
    {integration && activePublication?.templateId && <div className="et-template-row"><div><h2>Чинні правила магазину</h2><p>Версія {activePublication.templateVersionNumber || 'чинної публікації'}</p></div><Link className="btn btn-outline" to={`${base}/${encodeURIComponent(activePublication.templateId)}?version=${encodeURIComponent(activePublication.templateVersionId)}`}>Відкрити поточні правила</Link></div>}
    <div className="et-registry-controls"><div className="et-registry-views" role="group" aria-label="Види реєстру">{[['drafts', 'Незавершені зміни'], ['all', 'Усі шаблони'], ['published', 'Історія версій']].map(([key, label]) => <button type="button" key={key} aria-pressed={view === key} onClick={() => { setView(key); setPage(0); }}>{label}</button>)}</div>
      <label>Пошук за назвою<input className="input" type="search" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} /></label><button className="et-link" disabled={busy} onClick={onRefresh}>Оновити список</button>
    </div>
    {families === null ? error ? <Notice tone="error" title="Не вдалося завантажити шаблони">Спробуйте оновити список.</Notice> : <LoadingState compact label="Завантажуємо шаблони…" />
      : !rows.length ? <EmptyState compact title={query ? 'За цим пошуком нічого немає' : view === 'drafts' ? 'Незавершених змін немає' : view === 'published' ? 'Опублікованих версій немає' : 'Шаблонів ще немає'} />
        : <><div className="et-registry-scroll"><table className="et-registry-table"><thead><tr><th>Назва</th><th>Стан</th><th>Дія</th></tr></thead><tbody>{rows.slice(currentPage * 25, (currentPage + 1) * 25).map(({ item, version }) => {
          const active = version ? activePublication?.templateVersionId === version.id : activePublication?.templateId === item.id;
          const href = version ? `${base}/${encodeURIComponent(item.id)}/versions?version=${encodeURIComponent(version.id)}` : `${base}/${encodeURIComponent(item.id)}`;
          return <tr key={version?.id || item.id}><th scope="row">{item.display_name}{version && ` · v${version.versionNumber}`}</th><td>
            {version ? active ? <StatusBadge tone="info">Чинна версія</StatusBadge> : 'Історична версія' : unfinished(item) ? 'Незавершені зміни' : 'Чернетку опубліковано'}
            {!version && <small>Редакція {revision(item)}{versions(item)[0] ? ` · публікація v${versions(item)[0].versionNumber}` : ''}</small>}
            {!integration && item.selected_version_id && (!version || item.selected_version_id === version.id) && <StatusBadge tone="info">Вибрано для експорту{!version && versions(item).find((entry) => entry.id === item.selected_version_id) ? ` · v${versions(item).find((entry) => entry.id === item.selected_version_id).versionNumber}` : ''}</StatusBadge>}
          </td><td><Link className="et-link" to={href} aria-label={version ? `Переглянути ${item.display_name} v${version.versionNumber}` : `Відкрити ${item.display_name}`}>{version ? 'Переглянути' : 'Відкрити'}</Link></td></tr>;
        })}</tbody></table></div>
          {rows.length > 25 && <nav className="et-actions" aria-label="Сторінки шаблонів"><button type="button" className="btn btn-outline" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Назад</button><span>{currentPage + 1} / {Math.ceil(rows.length / 25)}</span><button type="button" className="btn btn-outline" disabled={(currentPage + 1) * 25 >= rows.length} onClick={() => setPage(currentPage + 1)}>Далі</button></nav>}
        </>}
    <details><summary>{integration ? 'Сумісність з історичним CSV' : 'Системний профіль CSV'}</summary><article className="et-template-row"><div><h2>Magento — поточний системний</h2><p>Системний профіль · лише перегляд</p><p className="et-muted">Вибір шаблону CSV не змінює чинні правила магазину.</p></div>
      <div className="et-actions"><Link className="btn btn-outline px-4" to={base + '/system'}>Переглянути</Link>{manage && <button className="et-link" disabled={busy} onClick={onCopy}>Створити редаговану копію</button>}</div>
    </article></details>
  </section>;
}
