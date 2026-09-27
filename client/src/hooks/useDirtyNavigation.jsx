import { useCallback, useRef, useState } from 'react';
import { useBlocker } from 'react-router-dom';
import { WorkspaceDialog } from '../components/workspace/WorkspaceDialog';

export function useDirtyNavigation({ dirty, save, discard, busy = false, shouldBlock }) {
  const bypass = useRef(false);
  const blocker = useBlocker((transition) => !bypass.current && Boolean(dirty) && (!shouldBlock || shouldBlock(transition)));
  const [pending, setPending] = useState(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const blocked = blocker.state === 'blocked' || Boolean(pending);
  // Only for a successful explicit save/create, or an already resolved local guard.
  const commit = useCallback((action) => { bypass.current = true; try { action(); } finally { bypass.current = false; } }, []);
  const request = (action) => { if (dirty) setPending(() => action); else action(); };
  const stay = () => { setPending(null); setSaveFailed(false); if (blocker.state === 'blocked') blocker.reset(); };
  const proceed = () => {
    const action = pending; setPending(null);
    if (blocker.state === 'blocked') blocker.proceed(); else if (action) commit(action);
  };
  const prompt = blocked && <WorkspaceDialog title="Незбережені зміни" busy={busy} onClose={stay}>
      <h2 className="font-semibold">Є незбережені зміни</h2><p>Збережіть їх або явно відкиньте перед переходом.</p>
      {saveFailed && <p role="alert">Збереження не виконано. Перехід заблоковано, зміни залишаються у формі. Оберіть «Залишитися», щоб переглянути помилку.</p>}
      <div className="flex flex-wrap gap-3">
        {save && <button className="btn btn-primary px-3" disabled={busy} onClick={async () => { if (await save()) { setSaveFailed(false); proceed(); } else setSaveFailed(true); }}>Зберегти й перейти</button>}
        <button className="btn btn-outline px-3" disabled={busy} onClick={() => { discard(); proceed(); }}>Відкинути й перейти</button>
        <button className="btn btn-outline px-3" disabled={busy} onClick={stay}>Залишитися</button>
      </div>
  </WorkspaceDialog>;
  return { request, prompt, commit, blocked };
}
