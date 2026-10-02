import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import AttentionPage from '../src/pages/AttentionPage.jsx';
import { correctionsApi } from '../src/api/corrections-api.js';

vi.mock('../src/api/corrections-api.js', () => ({ correctionsApi: { listRequests: vi.fn() } }));

const auth = (permissions) => ({
  permissions, identity: { name: 'Оператор' }, principalLifetime: { valid: true }, logout: vi.fn(),
});
const renderPage = (permissions = ['corrections.view', 'products.view']) => render(
  <AuthContext.Provider value={auth(permissions)}><MemoryRouter><AttentionPage /></MemoryRouter></AuthContext.Provider>
);

beforeEach(() => {
  vi.restoreAllMocks();
  correctionsApi.listRequests.mockResolvedValue({ data: { items: [], summary: { active: 4 } } });
  vi.spyOn(api, 'get').mockResolvedValue({ data: { enabled: true, problemCount: 2 } });
});
afterEach(cleanup);

it('shows existing attention sources independently without an invented aggregate', async () => {
  renderPage();
  await screen.findByText('4');
  expect(screen.getByText('2')).toBeTruthy();
  expect(screen.getByText('активних запитів')).toBeTruthy();
  expect(screen.getByText('зафіксованих проблем')).toBeTruthy();
  expect(screen.queryByText('Усього')).toBeNull();
  expect(correctionsApi.listRequests).toHaveBeenCalledWith('active');
  expect(api.get).toHaveBeenCalledWith('/magento/summary', expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

it('does not present an unavailable source as an empty queue', async () => {
  correctionsApi.listRequests.mockRejectedValue(new Error('unavailable'));
  api.get.mockResolvedValue({ data: {} });
  renderPage();
  await waitFor(() => expect(screen.getByText('Стан недоступний')).toBeTruthy());
  expect(screen.getByText('Стан невідомий')).toBeTruthy();
  expect(screen.queryByText('активних запитів немає')).toBeNull();
  expect(screen.queryByText('зафіксованих проблем немає')).toBeNull();
});

it('does not request or expose attention sources outside effective capabilities', async () => {
  renderPage(['corrections.view']);
  await screen.findByText('4');
  expect(screen.queryByText('Доставка до Magento')).toBeNull();
  expect(api.get).not.toHaveBeenCalled();
});
