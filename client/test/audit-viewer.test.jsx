import AdministrationPage from '../src/pages/AdministrationPage.jsx';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { WorkspaceNav } from '../src/components/app/WorkspaceNav.jsx';
import AuditPage from '../src/pages/AuditPage.jsx';
import { api } from '../src/lib/api.js';
import { getAuditEventLabel } from '../src/lib/audit-viewer.js';

function authValue(permissions = ['audit.view']) {
  return {
    applicationUser: { id: 1, status: 'active' }, identity: { name: 'Admin' },
    roles: [], permissions, logout: vi.fn(),
  };
}

function response(items, page = { limit: 50, hasMore: false, nextCursor: null }) {
  return { data: { items, page, filters: {} } };
}

const knownEvent = {
  eventKey: 'application_user.role_changed', domain: 'application_user',
  occurredAt: '2026-09-10T12:00:00.000Z',
  actor: { status: 'recorded', id: 7, displayName: 'Історичне ім’я', preferredUsername: 'old.name' },
  subject: { type: 'application_user', id: '19' },
  details: { previousRole: { displayName: 'Manager' }, newRole: { displayName: 'Storekeeper' } },
};

afterEach(() => cleanup());

describe('global audit viewer', () => {
  it('uses only audit.view for navigation and page access', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(response([]));
    const { rerender } = render(<AuthContext.Provider value={authValue()}><MemoryRouter><WorkspaceNav /><AdministrationPage /><AuditPage /></MemoryRouter></AuthContext.Provider>);
    expect(screen.getByRole('link', { name: 'Адміністрування' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Аудит/ })).toBeTruthy();
    await waitFor(() => expect(api.get).toHaveBeenCalled());

    rerender(<AuthContext.Provider value={authValue(['roles.manage'])}><MemoryRouter><WorkspaceNav /><AdministrationPage /><AuditPage /></MemoryRouter></AuthContext.Provider>);
    expect(screen.queryByRole('link', { name: /Аудит/ })).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Недостатньо прав');
  });

  it('renders known and future keys, immutable actors, details, and explicit missing attribution', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(response([
      knownEvent,
      {
        eventKey: 'future_domain.new_action', domain: 'future_domain', occurredAt: '2026-09-10T11:00:00.000Z',
        actor: { status: 'not_recorded', id: null, displayName: null, preferredUsername: null },
        subject: { type: 'future_subject', id: 'exact-identifier' }, details: {},
      },
    ]));
    render(<AuthContext.Provider value={authValue()}><AuditPage /></AuthContext.Provider>);
    expect(await screen.findByText('Роль користувача змінено')).toBeTruthy();
    expect(screen.getByText('Історичне ім’я')).toBeTruthy();
    expect(screen.getByText('Невідома подія')).toBeTruthy();
    expect(screen.getByText('Виконавець не записаний')).toBeTruthy();
    expect(screen.queryByText('future_domain.new_action')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Відкрити деталі: Невідома подія' }));
    fireEvent.click(screen.getByText('Технічні деталі'));
    expect(screen.getByText('future_domain.new_action')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Закрити' }));
    fireEvent.click(screen.getByRole('button', { name: 'Відкрити деталі: Роль користувача змінено' }));
    expect(screen.getByText(/Manager/)).toBeTruthy();
  });

  it('applies and clears filters while replacing cursor pages', async () => {
    const get = vi.spyOn(api, 'get')
      .mockResolvedValueOnce(response([knownEvent], { limit: 50, hasMore: true, nextCursor: 'next-page' }))
      .mockResolvedValueOnce(response([{ ...knownEvent, eventKey: 'product.created', subject: { type: 'product', id: '22' } }]))
      .mockResolvedValueOnce(response([knownEvent], { limit: 50, hasMore: true, nextCursor: 'next-page' }))
      .mockResolvedValue(response([]));
    render(<AuthContext.Provider value={authValue()}><AuditPage /></AuthContext.Provider>);
    expect(await screen.findByText('Роль користувача змінено')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Далі' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/admin/audit-events', { params: { cursor: 'next-page' } }));
    expect(await screen.findByText('Товар створено')).toBeTruthy();
    expect(screen.queryByText('Роль користувача змінено')).toBeNull();
    expect(screen.getByText('Сторінка 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/admin/audit-events', { params: {} }));
    expect(await screen.findByText('Роль користувача змінено')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Домен'), { target: { value: 'product' } });
    fireEvent.click(screen.getByText('Розширені фільтри'));
    fireEvent.change(screen.getByLabelText('ID виконавця'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Застосувати' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/admin/audit-events', { params: { domain: 'product', actorId: '7' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Очистити' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith('/admin/audit-events', { params: {} }));
  });

  it('shows clear empty, loading, and error states', async () => {
    let resolveRequest;
    vi.spyOn(api, 'get').mockImplementationOnce(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const { unmount } = render(<AuthContext.Provider value={authValue()}><AuditPage /></AuthContext.Provider>);
    expect(await screen.findByText('Завантаження аудиту')).toBeTruthy();
    resolveRequest(response([]));
    expect(await screen.findByText('Подій за вибраними фільтрами не знайдено.')).toBeTruthy();
    unmount();

    vi.spyOn(api, 'get').mockRejectedValueOnce({ response: { data: { error: 'Серверна помилка' } } });
    render(<AuthContext.Provider value={authValue()}><AuditPage /></AuthContext.Provider>);
    expect((await screen.findByRole('alert')).textContent).toContain('Серверна помилка');
  });

  it('has a stable safe fallback label for unknown event keys', () => {
    expect(getAuditEventLabel('new_domain.future_event')).toBe('Подія: new_domain.future_event');
  });
});
