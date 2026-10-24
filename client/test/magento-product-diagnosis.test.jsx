import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import MagentoProductDiagnosis from '../src/components/attention/MagentoProductDiagnosis.jsx';
import MagentoProductComparison from '../src/components/attention/MagentoProductComparison.jsx';
import * as policyLabels from '../src/lib/magento-policy-labels.js';

vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const grants = ['export_templates.view', 'export_templates.manage', 'exports.view'];
const product = { productId: 42, article: 'AG-000042', category: 'SV' };
const returnTo = '/attention?category=SV&reason=integration&problem=42';
const result = { productId: 42, article: 'AG-000042', mode: 'update', observedAt: '2026-10-04T10:00:00Z', sendable: false,
  blockers: [{ code: 'OPTION_UNRESOLVED', resolution: 'integration_configuration', target: 'kamin_obrobka', fieldLabel: 'Обробка каменю',
    question: 'finish', value: '0', expectedValue: 'Необроблений', message: 'У Magento немає підтвердженого відповідного значення характеристики.' }],
  comparisons: [{ target: 'kamin_obrobka', label: 'Обробка каменю', current: { state: 'known', value: 'Полірований' }, expected: { state: 'known', value: 'Необроблений' },
    action: 'unresolved', policy: 'authoritative_create_update', severity: 'blocked' },
  { target: 'description', label: 'Опис', current: { state: 'known', value: 'Опис Magento' }, expected: { state: 'known', value: 'Опис Amber' },
    action: 'preserve', policy: 'magento_managed', severity: 'warning' },
  { target: 'categories', label: 'Категорії Magento', current: { state: 'unavailable', value: [] }, expected: { state: 'known', value: ['Root/Сувеніри'] },
    action: 'unresolved', policy: 'unknown', severity: 'blocked' }],
  warnings: [{ code: 'FIELD_INTENTIONALLY_PRESERVED', target: 'description' }, { code: 'PRODUCT_ATTRIBUTE_SET_MISMATCH' }] };
const shell = (permissions = grants, principalLifetime = undefined) => render(<AuthContext.Provider value={{ permissions, principalLifetime }}><MemoryRouter>
  <MagentoProductDiagnosis product={product} returnTo={returnTo} />
</MemoryRouter></AuthContext.Provider>);
beforeEach(() => { vi.resetAllMocks(); api.post.mockResolvedValue({ data: result }); });
afterEach(cleanup);

it('checks only the exact selected product explicitly and preserves repair context for the actual missing value', async () => {
  shell(); expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані та очікувані зміни' }));
  await screen.findByText('Перевірка виявила перешкоди для доставки.');
  expect(api.post).toHaveBeenCalledWith('/admin/magento-integration/product-preview', { productId: 42 }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  const link = new URL(screen.getByRole('link', { name: 'Знайти або додати значення' }).href);
  expect(link.pathname).toBe('/admin/catalog');
  expect(Object.fromEntries(link.searchParams)).toMatchObject({ category: 'SV', view: 'attributes', productId: '42', field: 'kamin_obrobka', question: 'finish', value: '0', returnTo });
  expect(screen.getByText('Полірований')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Надіслати|Застосувати/ })).toBeNull();
});

it('shows unknown evidence and preserved Magento values without turning a warning into a blocker', () => {
  render(<MagentoProductComparison result={result} />);
  const row = screen.getByRole('row', { name: /Опис Опис Magento Опис Amber/ });
  expect(within(row).getByText('Зберігається Magento')).toBeTruthy();
  expect(within(row).getByText('Зберігати значення Magento')).toBeTruthy();
  expect(within(row).queryByText('Потребує виправлення')).toBeNull();
  expect(screen.getByText('Немає достовірних даних')).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Зауваження до перевірки' }).textContent).toContain('Це зауваження');
});

it('uses the shared policy presenter without reclassifying safe-preview or unapproved evidence', () => {
  const original = policyLabels.deliveryPolicyLabel;
  const label = vi.spyOn(policyLabels, 'deliveryPolicyLabel').mockImplementation((policy) => policy === 'magento_managed' ? 'Спільний підпис політики' : original(policy));
  render(<MagentoProductComparison result={{ comparisons: result.comparisons.map((row) => ({ ...row,
    ...(row.target === 'description' ? { policyState: 'review_required' } : {}),
    ...(row.target === 'categories' ? { policy: 'preserve_by_safe_preview' } : {}),
  })) }} />);
  const row = screen.getByRole('row', { name: /Опис Опис Magento Опис Amber/ });
  expect(within(row).getByText('Спільний підпис політики · правило не підтверджене')).toBeTruthy();
  expect(label).toHaveBeenCalledWith('magento_managed');
  expect(within(row).getByText('Зберігається Magento')).toBeTruthy();
  expect(screen.getByText('Збережено до окремого рішення')).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});

it.each(['future_policy', 'toString', 'constructor', undefined])('does not invent ownership text for an unknown policy %s', (policy) => {
  render(<MagentoProductComparison result={{ comparisons: [{ ...result.comparisons[1], policy }] }} />);
  const cell = screen.getByText('Зберігається Magento').closest('td');
  expect(cell.textContent).toBe('Зберігається Magento');
});

it('hides diagnostics without both existing preview permissions', () => {
  shell(['export_templates.view', 'export_templates.manage']);
  expect(screen.queryByRole('button')).toBeNull(); expect(api.post).not.toHaveBeenCalled();
});

it('rejects evidence for another identity and does not offer its repair actions', async () => {
  api.post.mockResolvedValue({ data: { ...result, productId: 43 } }); shell();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані та очікувані зміни' }));
  await screen.findByText('Не вдалося отримати підтверджені дані цього товару. Повторіть перевірку.');
  expect(screen.queryByRole('table')).toBeNull(); expect(screen.queryByRole('link')).toBeNull();
});

it('does not apply late diagnosis after leaving the selected product', async () => {
  let complete; api.post.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const view = shell(); fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані та очікувані зміни' }));
  const signal = api.post.mock.calls[0][2].signal; view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => complete({ data: result }));
  expect(screen.queryByRole('table')).toBeNull();
});
