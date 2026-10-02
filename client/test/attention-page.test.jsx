import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import AttentionPage from '../src/pages/AttentionPage.jsx';
import { correctionsApi } from '../src/api/corrections-api.js';
import { useMagentoSummary } from '../src/hooks/useMagentoSummary.js';

vi.mock('../src/api/corrections-api.js', () => ({ correctionsApi: { listRequestPage: vi.fn() } }));

const auth = (permissions) => ({
  permissions, identity: { name: 'Оператор' }, principalLifetime: { valid: true }, logout: vi.fn(),
});
const renderPage = (permissions = ['corrections.view', 'products.view']) => render(
  <AuthContext.Provider value={auth(permissions)}><MemoryRouter><AttentionPage /></MemoryRouter></AuthContext.Provider>
);

beforeEach(() => {
  vi.restoreAllMocks();
  correctionsApi.listRequestPage.mockResolvedValue({ data: { items: [], summary: { active: 4 } } });
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
  expect(correctionsApi.listRequestPage).toHaveBeenCalledWith({ status: 'active', limit: 1, offset: 0 });
  expect(api.get).toHaveBeenCalledWith('/magento/summary', expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

it('does not present an unavailable source as an empty queue', async () => {
  correctionsApi.listRequestPage.mockRejectedValue(new Error('unavailable'));
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

it('does not expose a previous principal summary while the next principal is loading', async () => {
  let resolveNext;
  api.get
    .mockResolvedValueOnce({ data: { problemCount: 3 } })
    .mockImplementationOnce(() => new Promise((resolve) => { resolveNext = resolve; }));
  const firstPrincipal = { id: 'first', valid: true };
  const secondPrincipal = { id: 'second', valid: true };
  const Probe = () => {
    const state = useMagentoSummary();
    return <span>{state.loading ? 'loading' : state.summary?.problemCount ?? 'none'}</span>;
  };
  const show = (principal) => <AuthContext.Provider value={{ ...auth(['products.view']), principalLifetime: principal }}><Probe /></AuthContext.Provider>;
  const view = render(show(firstPrincipal));

  await screen.findByText('3');
  view.rerender(show(secondPrincipal));
  expect(screen.queryByText('3')).toBeNull();
  await screen.findByText('loading');
  await act(async () => resolveNext({ data: { problemCount: 7 } }));
  await screen.findByText('7');
});
