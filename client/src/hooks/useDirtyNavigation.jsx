import { useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router-dom';

export function useDirtyNavigation({ dirty, save, discard, busy = false }) {
  const blocker = useBlocker(dirty);
  const [pending, setPending] = useState(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const dialog = useRef(null);
  const blocked = blocker.state === 'blocked' || Boolean(pending);
  useEffect(() => { if (blocked) dialog.current?.focus(); }, [blocked]);
  const request = (action) => { if (dirty) setPending(() => action); else action(); };
  const stay = () => { setPending(null); setSaveFailed(false); if (blocker.state === 'blocked') blocker.reset(); };
  const proceed = () => {
    const action = pending; setPending(null);
    if (blocker.state === 'blocked') blocker.proceed(); else action?.();
  };
  const prompt = blocked && <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Незбережені зміни" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onKeyDown={(event) => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); stay(); }
    if (event.key !== 'Tab') return;
    const buttons = [...dialog.current.querySelectorAll('button:not(:disabled)')];
    if (!buttons.length) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === buttons[0] || document.activeElement === dialog.current)) { event.preventDefault(); buttons.at(-1).focus(); }
    else if (!event.shiftKey && (document.activeElement === buttons.at(-1) || document.activeElement === dialog.current)) { event.preventDefault(); buttons[0].focus(); }
  }}>
    <div className="card max-w-lg p-5 space-y-4">
      <h2 className="font-semibold">Є незбережені зміни</h2><p>Збережіть їх або явно відкиньте перед переходом.</p>
      {saveFailed && <p role="alert">Збереження не виконано. Перехід заблоковано, зміни залишаються у формі. Оберіть «Залишитися», щоб переглянути помилку.</p>}
      <div className="flex flex-wrap gap-3">
        {save && <button className="btn btn-primary px-3" disabled={busy} onClick={async () => { if (await save()) { setSaveFailed(false); proceed(); } else setSaveFailed(true); }}>Зберегти й перейти</button>}
        <button className="btn btn-outline px-3" disabled={busy} onClick={() => { discard(); proceed(); }}>Відкинути й перейти</button>
        <button className="btn btn-outline px-3" disabled={busy} onClick={stay}>Залишитися</button>
      </div>
    </div>
  </section>;
  return { request, prompt };
}
