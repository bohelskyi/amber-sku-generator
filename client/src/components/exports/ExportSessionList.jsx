import { Link } from 'react-router-dom';
import { dateText } from '../../lib/export-review-presentation';
import { participantCount, rangeText, sessionDisplayState, sessionRecipe } from '../../lib/export-session-presentation';
import './export-workspaces.css';

export function ExportSessionList({ items, scope, onOpen }) {
  return <ul className="export-workspace-list">{items.map((session) => <li key={session.id} className="export-workspace-row">
    <div className="export-workspace-identity"><h3>{session.title}</h3><span className="export-workspace-status">{sessionDisplayState(session)}</span>
      <p>Власник: {session.ownerName || 'Ім’я не вказано'} · Учасників: {participantCount(session)}</p>
      <p>{sessionRecipe(session)}</p>
    </div>
    <div className="export-workspace-meta">
      <p>Обрано: {rangeText(session.settings)}</p>
      {session.snapshot?.capturedRange && <p>У файлах: {rangeText(session.snapshot.capturedRange)}</p>}
      <p>{session.snapshotId ? session.snapshot?.artifacts?.length ? `Збережених файлів: ${session.snapshot.artifacts.length}` : 'Збережений результат · перевірте доступність файлів' : 'Файлів ще немає'}
        {session.snapshot?.status && ` · ${session.snapshot.status === 'confirmed' ? 'Підтверджено' : 'Очікує підтвердження'}`}</p>
      <p>Створено: {dateText(session.createdAt)}</p>
      {session.lastRecordedActivityAt && <p>Остання зафіксована дія: {dateText(session.lastRecordedActivityAt)}</p>}
    </div>
    <div className="export-workspace-open"><Link className="btn btn-outline px-3" to={'/exports/sessions/' + encodeURIComponent(session.id)}
      state={{ returnTo: scope === 'shared' ? '/exports/shared' : '/exports/sessions' }} onClick={(event) => onOpen(event, session.id)}
      aria-label={`Відкрити / продовжити ${session.title}`}>Відкрити</Link>
      <details><summary>Технічні подробиці</summary><p>{session.id}</p><p>Ревізія: {session.configurationRevision}</p></details>
    </div>
  </li>)}</ul>;
}

export function ExportInvitations({ items, canCreate, busy, onRespond }) {
  return <><p>Ваші поточні права: {canCreate ? 'перегляд, завантаження, створення файлів і підтвердження' : 'перегляд і завантаження'}. Приєднання не надає нових дозволів.</p>
    <ul className="export-workspace-list">{items.map((invite) => <li key={invite.id} className="export-workspace-row export-invitation-row">
      <div><h3>{invite.title}</h3><p>{invite.ownerName || 'Власник експорту'} запрошує вас</p>
        <p>Ви приєднаєтесь до того самого експорту, а не створите копію.</p>
        <p className="text-sm text-slate-600">Приєднання не створює та не підтверджує файли.</p></div>
      <div className="flex flex-wrap gap-3"><button className="btn btn-primary px-3" disabled={busy} onClick={() => onRespond(invite, 'accept')}>Приєднатися</button>
        <button className="btn btn-outline px-3" disabled={busy} onClick={() => onRespond(invite, 'decline')}>Відхилити</button></div>
    </li>)}</ul></>;
}
