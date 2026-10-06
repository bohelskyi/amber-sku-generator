import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import SyncProblemsPage from '../src/pages/SyncProblemsPage.jsx';
import { ProductMagentoState } from '../src/components/app/ProductMagentoState.jsx';
import { CategoryCard } from '../src/components/workspace/MagentoOverview.jsx';
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const problem = { code: 'AMBER_SYNC_ELIGIBILITY_UNRESOLVED', resolution: 'lifecycle_reconciliation',
  message: 'Потрібне підтвердження історії доставки', eligibilityIssue: { type: 'historical_ambiguity',
    lifecycleRoute: 'hold', holdReason: 'historical_ambiguity', primaryReason: 'INFERRED_HISTORY_WITHOUT_EXACT_MEMBERSHIP',
    classification: 'historical_ambiguous', sourceCorrectionId: 1509, ancestorProductIds: [1368], deliveryVersion: '1' } };
const permissions = ['products.view', 'products.decode', 'history.view', 'export_templates.view'];
const shell = (element, capabilities) => render(<AuthContext.Provider value={{ permissions: capabilities }}><MemoryRouter>{element}</MemoryRouter></AuthContext.Provider>);
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

for (const reconcile of [false, true]) it(`lifecycle hold handoff is read-only, reconcile capability=${reconcile}`, async () => {
  api.get.mockResolvedValue({ data: { items: [{ productId: 5033, article: 'SV5111010', category: 'SV', problems: [problem] }],
    pageInfo: { total: 1, hasPrevious: false, hasNext: false } } });
  shell(<SyncProblemsPage />, [...permissions, ...(reconcile ? ['exports.reconcile'] : [])]);
  await screen.findByRole('heading', { name: 'Немає точного підтвердження, які попередні версії товару доставлено в Magento' });
  if (!reconcile) expect(screen.getByText(/Потрібне узгодження Адміністратора/)).toBeTruthy();
  expect(screen.getByText(/Amber ще не підтвердив, як попередні зміни/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Відкрити товар' }).getAttribute('href')).toContain('article=SV5111010');
  expect(screen.getByRole('link', { name: 'Історія товару' }).getAttribute('href')).toBe('/products/history?sku=SV5111010');
  expect(screen.queryByRole('link', { name: /Перевірити відповідності/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Повтор|Надіслати|Зняти|Release|Retry/ })).toBeNull();
  fireEvent.click(screen.getByText('Дані для підтримки'));
  expect(screen.getByText(/INFERRED_HISTORY_WITHOUT_EXACT_MEMBERSHIP/).textContent).toContain('1368');
  expect(screen.getByText(/INFERRED_HISTORY_WITHOUT_EXACT_MEMBERSHIP/).textContent).toContain('1509');
  if (reconcile) expect(screen.getByRole('button', { name: 'Перевірити товар у Magento' })).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});

it('Product Detail explains the same held successor without mapping or mutation controls', async () => {
  api.get.mockResolvedValue({ data: { state: 'needs_attention', reason: problem.message, problems: [problem] } });
  shell(<ProductMagentoState product={{ productId: 5033, publicSku: 'SV5111010', status: 'active' }} />, ['products.view']);
  await screen.findByText('Потрібне узгодження Адміністратора');
  expect(screen.getByText(/Товар збережено в Amber/)).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Історія товару' })).toBeNull();
  expect(screen.queryByRole('link', { name: /Відповідності/ })).toBeNull();
  expect(api.get.mock.calls.map(([url]) => url)).toEqual(['/magento/product-status/5033']);
  expect(api.post).not.toHaveBeenCalled();
});

it('actual mapping problem opens exact field while resource configuration opens preparation', async () => {
  api.get.mockResolvedValue({ data: { items: [{ productId: 5033, article: 'SV5111010', category: 'SV', problems: [
    { code: 'OPTION_BINDING_REVIEW_REQUIRED', resolution: 'integration_configuration', target: 'kamin_obrobka', message: 'Потрібна відповідність' },
    { code: 'ATTRIBUTE_NOT_FOUND', resolution: 'integration_preparation', message: 'Потрібна характеристика' },
  ] }], pageInfo: { total: 1 } } });
  shell(<SyncProblemsPage />, [...permissions, 'export_templates.manage']);
  const mapping = new URL((await screen.findByRole('link', { name: 'Пов’язати значення' })).href);
  expect(mapping.pathname).toBe('/admin/magento/categories/SV');
  expect(Object.fromEntries(mapping.searchParams)).toMatchObject({ field: 'kamin_obrobka', productId: '5033', view: 'attributes', returnTo: '/attention?problem=5033' });
  expect(screen.getByRole('link', { name: 'Налаштувати атрибут Magento' }).getAttribute('href')).toContain('/admin/magento/categories/SV?view=attributes');
  expect(api.post).not.toHaveBeenCalled();
});

it('Integration overview routes lifecycle attention to product problems rather than mappings', () => {
  shell(<CategoryCard category={{ code: 'SV', name: 'Сувеніри', operational: { count: 1,
    reasons: [{ code: 'LIFECYCLE_HISTORICAL_AMBIGUITY', resolution: 'lifecycle_reconciliation', message: problem.message }] },
    preparation: { needed: false } }} />, permissions);
  expect(screen.getByRole('link', { name: 'Переглянути проблеми товарів' }).getAttribute('href')).toBe('/sync-problems?category=SV');
  expect(screen.queryByRole('link', { name: 'Переглянути категорію' })).toBeNull();
});
