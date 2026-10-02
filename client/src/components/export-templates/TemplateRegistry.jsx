import { useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, LoadingState, Notice, StatusBadge } from '../ui/index.js';

const base = '/admin/export-templates';
export function TemplateRegistry({ families, manage, busy, error, onRefresh, onCopy }) {
  const [view, setView] = useState('all');
  const [query, setQuery] = useState('');
  const found = families?.filter((item) => item.display_name.toLocaleLowerCase('uk').includes(query.toLocaleLowerCase('uk')));
  const versions = (item) => item.version_summaries || [...(item.versions || [])].sort((a, b) => Number(b.versionNumber) - Number(a.versionNumber));
  return <section className="et-template-list" aria-label="Шаблони">
    <article className="et-template-row"><div><h2>Magento — поточний системний</h2><p>Системний профіль · лише перегляд</p><p className="et-muted">Профіль історичного CSV. Створення файлів залежить від стану доставки. Вибір шаблону для CSV не змінює опублікований зв’язок автоматичної інтеграції.</p></div>
      <div className="et-actions"><Link className="btn btn-outline px-4" to={base + '/system'}>Переглянути</Link>{manage && <button className="et-link" disabled={busy} onClick={onCopy}>Створити редаговану копію</button>}</div>
    </article>
    <div className="et-registry-controls"><div className="et-registry-views" role="group" aria-label="Види реєстру">{[['all', 'Усі шаблони'], ['drafts', 'Чернетки'], ['published', 'Опубліковані версії']].map(([key, label]) => <button type="button" key={key} aria-pressed={view === key} onClick={() => setView(key)}>{label}</button>)}</div>
      <label>Пошук за назвою<input className="input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} /></label><button className="et-link" disabled={busy} onClick={onRefresh}>Оновити список</button>
    </div>
    {families === null ? error
      ? <Notice tone="error" title="Не вдалося завантажити шаблони">Спробуйте оновити список.</Notice>
      : <LoadingState compact label="Завантажуємо шаблони…" />
      : !families.length ? <EmptyState title="Шаблонів ще немає" description="Створіть перший шаблон на основі готових правил Magento." />
      : !found.length ? <EmptyState compact title="Шаблонів із такою назвою немає" description="Змініть пошуковий запит." /> : view === 'published' ? <>
        {!found.some((item) => versions(item).length) && <EmptyState compact title="Опублікованих версій немає" />}
        {found.flatMap((item) => versions(item).map((version) => <article className="et-template-row" key={version.id}><div><h2>{item.display_name} · v{version.versionNumber}</h2><p>Опублікована версія · незмінна</p>{item.selected_version_id === version.id && <StatusBadge tone="info">Вибрано для експорту за шаблоном</StatusBadge>}</div><Link className="btn btn-outline px-4" to={`${base}/${encodeURIComponent(item.id)}/versions?version=${encodeURIComponent(version.id)}`}>Переглянути v{version.versionNumber}</Link></article>))}
      </> : found.map((item) => {
        const history = versions(item); const latest = history[0]; const revision = item.draft_revision || item.draft?.revision;
        return <article className="et-template-row" key={item.id}><div><h2>{item.display_name}</h2><div className="et-template-meta">
          <span>Чернетка · редакція {revision}{history.some((version) => version.sourceDraftRevision === revision) ? ' · опублікована' : ' · збережена'}</span>
          {view === 'all' && <span>{latest ? `Остання публікація: v${latest.versionNumber}` : 'Ще не опубліковано'}</span>}
        </div>{item.selected_version_id && <StatusBadge tone="info">Вибрано для експорту за шаблоном{history.find((v) => v.id === item.selected_version_id) ? ' · v' + history.find((v) => v.id === item.selected_version_id).versionNumber : ''}</StatusBadge>}</div>
          <Link className="btn btn-outline px-4" to={`${base}/${encodeURIComponent(item.id)}`} aria-label={'Відкрити ' + item.display_name}>Відкрити</Link>
        </article>;
      })}
  </section>;
}
