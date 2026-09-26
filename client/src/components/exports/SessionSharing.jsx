import { useRef, useState } from 'react';
import { WorkspaceDialog } from '../workspace/WorkspaceDialog';
import { exportSessionsApi as api } from '../../api/export-sessions-api';

const nameOf = (user) => user.display_name || user.preferred_username || 'Ім’я не вказано';
export function SessionSharing({ session, canCreate, busy, error, run, refresh, onLeave, onClose }) {
  const [query, setQuery] = useState(''); const [users, setUsers] = useState([]); const [selected, setSelected] = useState('');
  const [searched, setSearched] = useState(false); const [notice, setNotice] = useState(''); const [confirmation, setConfirmation] = useState(null);
  const trigger = useRef(null); const cancel = useRef(null);
  const ownerActions = session.isOwner && canCreate;
  const recipient = users.find((user) => String(user.id) === selected);
  const back = () => { setConfirmation(null); window.requestAnimationFrame(() => trigger.current?.focus()); };
  const confirm = async () => {
    const body = confirmation.action === 'leave' ? { action: 'leave' }
      : { action: 'revoke', userId: confirmation.member.user_id, expectedMemberEpoch: confirmation.member.epoch };
    const ok = await run(() => api.membership(session.id, { expectedAccessEpoch: session.accessEpoch, ...body }),
      () => { if (body.action === 'leave') onLeave(); else { setConfirmation(null); setNotice('Доступ відкликано.'); void refresh(); } });
    if (!ok) back();
  };
  return <WorkspaceDialog title={confirmation ? confirmation.action === 'leave' ? 'Вийти з експорту' : 'Відкликати доступ' : 'Поділитися експортом'}
    busy={busy} onClose={confirmation ? back : onClose} className="export-share-dialog" initialFocusRef={confirmation ? cancel : undefined}>
    {error && <p role="alert">{error}</p>}
    {confirmation ? <><h3 className="font-semibold">{confirmation.action === 'leave' ? `Вийти з «${session.title}»?` : `Відкликати доступ: ${nameOf(confirmation.member)}?`}</h3>
      <p>{confirmation.action === 'leave' ? 'Ви втратите подальший доступ до цього приватного експорту. Сам експорт не буде видалено.'
        : 'Подальший доступ до експорту буде закрито. Уже завантажені файли неможливо відкликати.'}</p>
      <div className="flex flex-wrap gap-3"><button className="btn btn-primary px-3" disabled={busy} onClick={confirm}>{confirmation.action === 'leave' ? 'Підтвердити вихід' : 'Підтвердити відкликання'}</button>
        <button ref={cancel} className="btn btn-outline px-3" disabled={busy} onClick={back}>Скасувати</button></div>
    </> : <><div><h3 className="text-lg font-semibold">Учасники</h3><p>{session.title}</p></div>
      {notice && <p role="status">{notice}</p>}
      <ul className="export-participants"><li><div><strong>{session.ownerName || 'Ім’я не вказано'}</strong><p>Власник</p></div></li>
        {(session.participants || []).filter((m) => ['accepted', 'pending'].includes(m.state) && String(m.user_id) !== String(session.ownerUserId)).map((member) => <li key={member.user_id}>
          <div><strong>{nameOf(member)}</strong>{member.preferred_username && <p>{member.preferred_username}</p>}<p>{member.state === 'accepted' ? 'Приєднався' : 'Запрошено'}</p></div>
          {ownerActions && <button className="underline" disabled={busy} aria-label={`Відкликати доступ: ${nameOf(member)}`} onClick={(event) => { trigger.current = event.currentTarget; setConfirmation({ action: 'revoke', member }); }}>Відкликати доступ</button>}
        </li>)}
      </ul>
      {!session.isOwner && <button className="btn btn-outline px-3" disabled={busy} onClick={(event) => { trigger.current = event.currentTarget; setConfirmation({ action: 'leave' }); }}>Вийти зі спільного експорту</button>}
      {ownerActions && <div className="space-y-3 border-t pt-4"><h3 className="font-semibold">Запросити</h3><p>Оберіть конкретного користувача. Запрошення з’явиться в застосунку; його дозволи не зміняться.</p>
        <label className="block">Ім’я або логін одержувача<input className="input" disabled={busy} maxLength={80} value={query} onChange={(event) => { setQuery(event.target.value); setUsers([]); setSelected(''); setSearched(false); }} /></label>
        <button className="btn btn-outline px-3" disabled={busy || query.trim().length < 2} onClick={() => run(() => api.recipients(session.id, query), (data) => { setUsers(data.users); setSearched(true); })}>Знайти користувача</button>
        {searched && !users.length && <p>Користувачів не знайдено.</p>}
        {!!users.length && <label className="block">Одержувач<select className="input" disabled={busy} value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">Оберіть точного користувача</option>
          {users.map((user) => <option key={user.id} value={user.id}>{nameOf(user)} · {user.preferred_username || `№${user.id}`}</option>)}</select></label>}
        {recipient && <div className="border-l-2 pl-3"><p>Запросити: <strong>{nameOf(recipient)}</strong></p><p>Логін: {recipient.preferred_username || 'Не вказано'} · Користувач №{recipient.id}</p><p>До експорту «{session.title}»</p></div>}
        <button className="btn btn-primary px-3" disabled={busy || !recipient} onClick={() => run(() => api.invite(session.id, { userId: recipient.id, expectedAccessEpoch: session.accessEpoch }), (data) => {
          setNotice(data.state === 'accepted' ? 'Користувач уже приєднався.' : 'Запрошено. Користувач має явно приєднатися.'); setUsers([]); setSelected(''); setQuery(''); setSearched(false); void refresh();
        })}>Надіслати запрошення в застосунку</button>
      </div>}
      <button className="btn btn-outline px-3" disabled={busy} onClick={onClose}>Закрити</button>
    </>}
  </WorkspaceDialog>;
}
