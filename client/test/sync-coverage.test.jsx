import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import { SyncCoverage } from '../src/components/app/SyncCoverage.jsx';
import { coveragePercent } from '../src/lib/sync-coverage.js';

afterEach(cleanup);

const principal = { valid: true };
const show = (permissions) => render(
  <AuthContext.Provider value={{ permissions, principalLifetime: principal }}><SyncCoverage /></AuthContext.Provider>);

test('percent is bounded, floors partial progress and treats an empty catalog as 0%', () => {
  expect(coveragePercent(0, 10)).toBe(0);
  expect(coveragePercent(970, 2494)).toBe(38);
  expect(coveragePercent(10, 10)).toBe(100);
  expect(coveragePercent(5, 0)).toBe(0);
});

test('shows overall and per-category synchronization from the server summary', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { enabled: true, problemCount: 2, coverage: { total: 249, synced: 97,
    categories: [{ code: 'CH', name: 'Чотки', total: 148, synced: 0 }, { code: 'SV', name: 'Сувеніри', total: 101, synced: 97 }] } } });
  show(['products.view']);
  const overall = await screen.findByRole('progressbar', { name: 'Синхронізовано з Magento: синхронізовано 38%' });
  expect(overall.getAttribute('aria-valuenow')).toBe('38');
  expect(screen.getByText('97 / 249 · 38%')).toBeTruthy();
  expect(screen.getByRole('progressbar', { name: 'Чотки: синхронізовано 0%' }).getAttribute('aria-valuenow')).toBe('0');
  expect(screen.getByText('97 / 101 · 96%')).toBeTruthy();
  expect(api.get).toHaveBeenCalledWith('/magento/summary', expect.anything());
});

test('renders nothing without permission or without server coverage', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({ data: { enabled: false, problemCount: 0, coverage: null } });
  show([]);
  expect(get).not.toHaveBeenCalled();
  expect(screen.queryByTestId('sync-coverage')).toBeNull();
  cleanup();
  show(['products.view']);
  await vi.waitFor(() => expect(get).toHaveBeenCalled());
  expect(screen.queryByTestId('sync-coverage')).toBeNull();
});
