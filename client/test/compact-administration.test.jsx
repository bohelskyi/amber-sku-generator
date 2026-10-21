import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { AuthGate } from '../src/auth/AuthGate.jsx';
import { AUTH_STATUS } from '../src/auth/auth-model.js';
import { AuditActorFilter } from '../src/components/admin/AuditActorFilter.jsx';
import { api } from '../src/lib/api.js';
import { getAuditChangeSummary, getAuditSubjectLabel } from '../src/lib/audit-viewer.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('rechecks pending access without logout or mounting business content', async () => {
  const auth = { status: AUTH_STATUS.PENDING, applicationUser: { displayName: 'Олена' }, refresh: vi.fn().mockResolvedValue(), logout: vi.fn() };
  const view = render(<AuthContext.Provider value={auth}><AuthGate><p>Робочі дані</p></AuthGate></AuthContext.Provider>);
  expect(screen.queryByText('Робочі дані')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити доступ' }));
  await waitFor(() => expect(auth.refresh).toHaveBeenCalledOnce());
  expect(auth.logout).not.toHaveBeenCalled();
  view.rerender(<AuthContext.Provider value={{ ...auth, status: AUTH_STATUS.AUTHENTICATED }}><AuthGate><p>Робочі дані</p></AuthGate></AuthContext.Provider>);
  expect(screen.getByText('Робочі дані')).toBeTruthy();
});

it('keeps disabled access gated when checking fails and allows another attempt', async () => {
  const auth = { status: AUTH_STATUS.DISABLED, refresh: vi.fn().mockRejectedValue(new Error('offline')), logout: vi.fn() };
  render(<AuthContext.Provider value={auth}><AuthGate><p>Робочі дані</p></AuthGate></AuthContext.Provider>);
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити доступ' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByText('Робочі дані')).toBeNull();
  expect(screen.getByRole('button', { name: 'Перевірити доступ' }).disabled).toBe(false);
});

it('selects the exact audit actor from historical names instead of submitting typed text as identity', async () => {
  const change = vi.fn();
  const get = vi.spyOn(api, 'get').mockResolvedValue({ data: { items: [
    { id: 7, displayName: 'Олена', status: 'recorded' }, { id: 8, displayName: 'Олена', status: 'recorded' },
  ] } });
  const view = render(<AuditActorFilter actorId="" onChange={change} />);
  expect(get).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Виконавець' }), { target: { value: 'Олена' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Олена #8' }));
  expect(change).toHaveBeenLastCalledWith('8');
  expect(get).toHaveBeenCalledWith('/admin/audit-events/actors', { params: { q: 'Олена' } });
  view.rerender(<AuditActorFilter actorId="8" onChange={change} />);
  expect(screen.getByRole('searchbox').value).toBe('Олена');
  view.rerender(<AuditActorFilter actorId="9" onChange={change} />);
  expect(screen.getByRole('searchbox').value).toBe('Користувач #9');
  view.rerender(<AuditActorFilter actorId="" onChange={change} />);
  expect(screen.getByRole('searchbox').value).toBe('');
  expect(screen.queryByRole('button', { name: 'Олена #8' })).toBeNull();
});

it('shows safe object identity and zero-valued before/after evidence without inventing history', () => {
  expect(getAuditSubjectLabel({ type: 'product', id: '12', label: 'AG-000012' })).toBe('Товар · AG-000012');
  expect(getAuditChangeSummary({ eventKey: 'product.price_changed', details: { price: { beforeUah: 0, afterUah: 1200 } } })).toBe('0 → 1200 грн');
  expect(getAuditChangeSummary({ eventKey: 'product.price_changed', details: {} })).toBe('');
});
