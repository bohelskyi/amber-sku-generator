import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { LifecycleReconciliationNotice } from '../src/components/app/LifecycleReconciliationNotice.jsx';
import { api } from '../src/lib/api.js';

vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const problem = {
  code: 'AMBER_SYNC_ELIGIBILITY_UNRESOLVED',
  eligibilityIssue: {
    lifecycleRoute: 'hold', holdReason: 'historical_ambiguity',
    primaryReason: 'INFERRED_HISTORY_WITHOUT_EXACT_MEMBERSHIP', classification: 'historical_ambiguous',
    sourceCorrectionId: 1509, ancestorProductIds: [1368, 1400], deliveryVersion: '7',
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('The notice must not contact Magento'); }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount({ permissions = [], auth = { permissions }, ...props } = {}) {
  return render(<MemoryRouter><AuthContext.Provider value={auth}>
    <LifecycleReconciliationNotice problem={problem} article="SV5111010" {...props} />
  </AuthContext.Provider></MemoryRouter>);
}

function detail(label) {
  return screen.getByText(label, { selector: 'dt' }).nextElementSibling.textContent;
}

function expectNoRequests() {
  expect(api.get).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
}

it.each([null, {}])('without effective permissions (%j) requests Administrator review and exposes no history link', (auth) => {
  mount({ auth, recoveryAvailable: true });
  expect(screen.getByText('Потрібне узгодження Адміністратора')).toBeTruthy();
  expect(screen.getByText(/Передайте артикул Адміністратору/)).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  expectNoRequests();
});

it.each([false, true])('reconcile permission offers the appropriate explicit review handoff, recovery available=%s', (recoveryAvailable) => {
  mount({ permissions: ['exports.reconcile'], recoveryAvailable });
  expect(screen.getByText('Потрібне контрольоване узгодження історії доставки')).toBeTruthy();
  expect(screen.getByText(recoveryAvailable ? /Відкрийте перевірку доставки нижче/ : /Відкрийте проблему товару/)).toBeTruthy();
  expect(screen.getByText(/окремо підтверд/)).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Історія товару' })).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  expectNoRequests();
});

it('history permission is independent of reconciliation permission and preserves the exact encoded article', () => {
  const article = 'SV 1&scope=all/#?';
  mount({ permissions: ['history.view'], article });
  expect(screen.getByRole('link', { name: 'Історія товару' }).getAttribute('href'))
    .toBe(`/products/history?sku=${encodeURIComponent(article)}`);
  expect(screen.getByText('Потрібне узгодження Адміністратора')).toBeTruthy();
  expect(screen.queryByText('Потрібне контрольоване узгодження історії доставки')).toBeNull();
  expectNoRequests();
});

it.each(['', null])('does not invent an article for the history link when the supplied article is %j', (article) => {
  mount({ permissions: ['history.view', 'exports.reconcile'], article });
  expect(screen.queryByRole('link', { name: 'Історія товару' })).toBeNull();
  expectNoRequests();
});

it('shows exact diagnostic evidence only after disclosure and opening it never reads Magento or changes delivery', () => {
  mount({ permissions: ['history.view', 'exports.reconcile'], recoveryAvailable: true });
  expect(screen.getByText(/Товар збережено в Amber/)).toBeTruthy();
  expect(screen.getByText(/до надсилання змін у Magento/)).toBeTruthy();
  expect(screen.getByText(/відкриття цієї сторінки його не виконує/)).toBeTruthy();
  expect(screen.queryByText(problem.code)).toBeNull();
  fireEvent.click(screen.getByText('Технічні деталі'));
  expect(detail('Код')).toBe(problem.code);
  expect(detail('Маршрут доставки')).toBe('hold');
  expect(detail('Причина утримання')).toBe('historical_ambiguity');
  expect(detail('Причина історичної невизначеності')).toBe('INFERRED_HISTORY_WITHOUT_EXACT_MEMBERSHIP');
  expect(detail('Класифікація підтверджень')).toBe('historical_ambiguous');
  expect(detail('ID переобліку')).toBe('1509');
  expect(detail('ID попередніх версій')).toBe('1368, 1400');
  expect(detail('Версія доставки')).toBe('7');
  expect(screen.queryByRole('button')).toBeNull();
  expectNoRequests();
  fireEvent.click(screen.getByText('Технічні деталі'));
  expect(screen.queryByText(problem.code)).toBeNull();
  expectNoRequests();
});

it('keeps absent history evidence explicitly unknown without inventing an ancestor or correction', () => {
  mount({ problem: { ...problem, eligibilityIssue: {
    ...problem.eligibilityIssue, primaryReason: null, classification: '', sourceCorrectionId: null, ancestorProductIds: [],
  } } });
  fireEvent.click(screen.getByText('Технічні деталі'));
  expect(detail('Причина історичної невизначеності')).toBe('Не встановлено');
  expect(detail('Класифікація підтверджень')).toBe('Не встановлено');
  expect(detail('ID переобліку')).toBe('Немає');
  expect(detail('ID попередніх версій')).toBe('Немає');
  expectNoRequests();
});

it('retains the server code when no detailed eligibility issue is available', () => {
  mount({ problem: { code: 'AMBER_SYNC_ELIGIBILITY_UNRESOLVED' } });
  fireEvent.click(screen.getByText('Технічні деталі'));
  expect(detail('Код')).toBe('AMBER_SYNC_ELIGIBILITY_UNRESOLVED');
  expect(screen.queryByText('Маршрут доставки')).toBeNull();
  expect(screen.queryByText('ID переобліку')).toBeNull();
  expectNoRequests();
});
