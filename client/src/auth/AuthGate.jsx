import { useAuth } from './auth-context.js';
import { AUTH_STATUS } from './auth-model.js';

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
        <div className="card auth-card">
          <h1 className="text-xl font-semibold">Amber SKU Manager</h1>
          <p className="mt-2 text-sm text-slate-500">Увійдіть, щоб продовжити роботу.</p>
          <button type="button" className="btn btn-amber mt-5" onClick={auth.login}>
            Увійти
          </button>
        </div>
      </main>
    );
  }

  if (auth.status === AUTH_STATUS.PENDING) {
    return (
      <main className="auth-gate">
        <div className="card auth-card">
          <h1 className="text-xl font-semibold">Доступ очікує підтвердження</h1>
          <p className="mt-2 text-sm text-slate-500">
            Вхід виконано. Адміністратор має активувати ваш доступ до Amber SKU Manager.
          </p>
          <button
            type="button"
            className="btn btn-outline mt-5"
            onClick={() => { void auth.logout(); }}
          >
            Вийти
          </button>
        </div>
      </main>
    );
  }

  if (auth.status === AUTH_STATUS.DISABLED) {
    return (
      <main className="auth-gate">
        <div className="card auth-card">
          <h1 className="text-xl font-semibold">Доступ вимкнено</h1>
          <p className="mt-2 text-sm text-slate-500">
            Ваш обліковий запис автентифіковано, але доступ до застосунку деактивовано.
          </p>
          <button
            type="button"
            className="btn btn-outline mt-5"
            onClick={() => { void auth.logout(); }}
          >
            Вийти
          </button>
        </div>
      </main>
    );
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
