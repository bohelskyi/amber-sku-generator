import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { MagentoSyncStatus } from '../src/components/app/MagentoSyncStatus';

afterEach(cleanup);
it.each([
  ['not_tracked', 'Синхронізацію ще не відстежуємо'],
  ['pending', 'Очікує синхронізації'], ['syncing', 'Синхронізується'],
  ['synced', 'Синхронізовано'], ['needs_attention', 'Потребує уваги'],
  ['future_state', 'Стан невідомий'],
])('shows %s without mutation controls', (state, label) => {
  render(<MagentoSyncStatus status={{ state, reason: state === 'needs_attention' ? 'Перевірте дані товару.' : null }} />);
  const badge = screen.getByText(`Magento: ${label}`);
  expect(badge).toBeTruthy();
  if (state === 'future_state') expect(badge.className).toContain('is-neutral');
  expect(screen.queryByRole('button')).toBeNull();
  if (state === 'needs_attention') expect(screen.getByText('Перевірте дані товару.')).toBeTruthy();
});
