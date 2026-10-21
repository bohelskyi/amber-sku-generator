import { useState } from 'react';
import { KeyRound, Monitor } from 'lucide-react';
import amberLogo from '../assets/amber-logo-white-orange.png';
import { useAuth } from './auth-context.js';
import { AUTH_STATUS } from './auth-model.js';

function AccessState({ auth, pending }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (action) => {
    setBusy(true);
    setError('');
    try { await action(); }
    catch { setError('Не вдалося виконати дію. Спробуйте ще раз.'); }
    finally { setBusy(false); }
  };
  const account = auth.applicationUser?.displayName || auth.identity?.name || auth.identity?.preferredUsername;
  return <main className="auth-gate"><div className="card auth-card">
    <h1 className="text-xl font-semibold">{pending ? 'Доступ очікує підтвердження' : 'Доступ вимкнено'}</h1>
    {account && <p className="mt-3 font-medium">{account}</p>}
    <p className="mt-2 text-sm text-slate-600">{pending
      ? 'Адміністратор має підтвердити ваш доступ. Після підтвердження перевірте його тут.'
      : 'Зверніться до адміністратора, щоб відновити доступ.'}</p>
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    <div className="auth-access-actions">
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act(auth.refresh)}>
        {busy ? 'Перевіряємо…' : 'Перевірити доступ'}
      </button>
      <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void act(auth.logout)}>
        {pending ? 'Увійти іншим обліковим записом' : 'Вийти'}
      </button>
    </div>
  </div></main>;
}

export function AuthGate({ children }) {
  const auth = useAuth();

  if (auth.status === AUTH_STATUS.LOADING) {
    return (
      <main className="auth-gate" aria-busy="true">
        <div className="card auth-card" role="status">
          <h1 className="text-lg font-semibold">Amber SKU Manager</h1>
          <p className="mt-2 text-sm text-slate-500">Перевіряємо сеанс…</p>
        </div>
      </main>
    );
  }

  if (auth.status === AUTH_STATUS.UNAUTHENTICATED) {
    return (
      <main className="auth-gate">
        <div className="card auth-card auth-login-card">
          <div className="auth-login-brand">
            <img src={amberLogo} alt="" className="auth-login-logo" />
          </div>

          <div className="auth-login-body">
            <p className="eyebrow">Вхід до системи</p>
            <h1 className="auth-login-title">Amber SKU Manager</h1>
            <p className="auth-login-intro">
              Оберіть спосіб входу, щоб продовжити роботу.
            </p>

            <div className="auth-login-actions">
              <div>
                <button
                  type="button"
                  className="btn btn-amber w-full gap-2"
                  onClick={auth.loginWithWindows}
                >
                  <Monitor size={18} aria-hidden="true" />
                  Увійти через Windows
                </button>
                <p className="auth-login-hint">
                  Рекомендовано для офісних і доменних комп'ютерів.
                </p>
              </div>

              <div className="auth-login-divider"><span>або</span></div>

              <div>
                <button
                  type="button"
                  className="btn btn-outline w-full gap-2"
                  onClick={auth.login}
                >
                  <KeyRound size={18} aria-hidden="true" />
                  Увійти за логіном і паролем
                </button>
                <p className="auth-login-hint">
                  Використовуйте, якщо входите не з офісного комп’ютера.
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (auth.status === AUTH_STATUS.PENDING) {
    return <AccessState auth={auth} pending />;
  }

  if (auth.status === AUTH_STATUS.DISABLED) {
    return <AccessState auth={auth} pending={false} />;
  }

  if (auth.status === AUTH_STATUS.ERROR) {
    return (
      <main className="auth-gate">
        <div className="card auth-card" role="alert">
          <h1 className="text-xl font-semibold">Amber SKU Manager</h1>
          <p className="mt-2 text-sm text-slate-600">{auth.errorMessage}</p>
          <button type="button" className="btn btn-outline mt-5" onClick={auth.retry}>
            Спробувати ще раз
          </button>
        </div>
      </main>
    );
  }

  return children;
}
