import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RepricingDraftPanel } from '../src/components/repricing/RepricingDraftPanel.jsx';

afterEach(cleanup);

function controller(overrides = {}) {
  return {
    activeDraft: null, draftConflicts: [], draftSaveState: 'saved', draftSync: null,
    invalidManualPriceIds: new Set(), previewing: false,
    removeDraftConflicts: vi.fn(), saveDraft: vi.fn().mockResolvedValue(undefined),
    setDiscardDraftOpen: vi.fn(), syncDraft: vi.fn(), ...overrides,
  };
}
const draft = { id: 17, updatedAt: '2026-10-10T12:30:00Z' };
const changes = { hasChanges: true, contextChanged: true, added: [1, 2], removed: [3], changed: [4, 5, 6] };

it('refuses saving invalid manual prices and saves only after an explicit allowed action', async () => {
  const c = controller({ invalidManualPriceIds: new Set([41]) });
  const view = render(<RepricingDraftPanel canPrepareRepricing controller={c} />);
  expect(screen.getByText('Перегляд ще не збережено')).toBeTruthy();
  const save = screen.getByRole('button', { name: 'Зберегти чернетку' });
  expect(save.disabled).toBe(true);
  fireEvent.click(save);
  expect(c.saveDraft).not.toHaveBeenCalled();
  view.rerender(<RepricingDraftPanel canPrepareRepricing controller={{ ...c, invalidManualPriceIds: new Set() }} />);
  expect(save.disabled).toBe(false);
  expect(c.saveDraft).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(save));
  expect(c.saveDraft).toHaveBeenCalledTimes(1);
  expect(c.syncDraft).not.toHaveBeenCalled();
});

it.each([
  ['pending preview', { previewing: true }],
  ['invalid manual price', { invalidManualPriceIds: new Set([42]) }],
])('blocks both draft refresh actions for %s', (_reason, overrides) => {
  const c = controller({ activeDraft: draft, draftSync: changes, ...overrides });
  const view = render(<RepricingDraftPanel canPrepareRepricing controller={c} />);
  for (const name of ['Оновити список', 'Прийняти оновлення']) {
    const button = screen.getByRole('button', { name });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
  }
  expect(c.syncDraft).not.toHaveBeenCalled();
  view.rerender(<RepricingDraftPanel canPrepareRepricing controller={{ ...c, previewing: false, invalidManualPriceIds: new Set() }} />);
  expect(screen.getByRole('button', { name: 'Прийняти оновлення' }).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Прийняти оновлення' }));
  expect(c.syncDraft).toHaveBeenCalledTimes(1);
  expect(c.saveDraft).not.toHaveBeenCalled();
});

it('keeps draft changes and conflict evidence readable without preparation permission', () => {
  const c = controller({ activeDraft: draft, draftSync: changes,
    draftConflicts: [{ publicSku: 'AG-000041', sku: 'BR-INTERNAL-41' }, {}] });
  render(<RepricingDraftPanel canPrepareRepricing={false} controller={c} />);
  expect(screen.getByText('Чернетка #17')).toBeTruthy();
  expect(screen.getByText(/додано 2, прибрано 1, перераховано 3/)).toBeTruthy();
  expect(screen.getByText(/матрицю оновлено/)).toBeTruthy();
  expect(screen.getByText(/AG-000041, Артикул недоступний/)).toBeTruthy();
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(screen.queryByText(/BR-INTERNAL-41/)).toBeNull();
  fireEvent.click(screen.getByText('Внутрішні SKU конфліктів'));
  expect(screen.getByText('BR-INTERNAL-41, Внутрішній SKU недоступний')).toBeTruthy();
  expect(c.syncDraft).not.toHaveBeenCalled();
  expect(c.removeDraftConflicts).not.toHaveBeenCalled();
  expect(c.setDiscardDraftOpen).not.toHaveBeenCalled();
});

it('opens discard review without saving, refreshing or silently removing conflicts', () => {
  const c = controller({ activeDraft: draft, draftConflicts: [{ publicSku: 'AG-000042', sku: 'BR-42' }] });
  render(<RepricingDraftPanel canPrepareRepricing controller={c} />);
  expect(c.setDiscardDraftOpen).not.toHaveBeenCalled();
  expect(c.removeDraftConflicts).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Відкинути чернетку' }));
  expect(c.setDiscardDraftOpen).toHaveBeenCalledTimes(1);
  expect(c.setDiscardDraftOpen).toHaveBeenCalledWith(true);
  expect(c.removeDraftConflicts).not.toHaveBeenCalled();
  expect(c.saveDraft).not.toHaveBeenCalled();
  expect(c.syncDraft).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Відкинути недоступні ціни' }));
  expect(c.removeDraftConflicts).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/AG-000042/)).toBeTruthy();
});

it('handles a rejected save callback without reporting success or retrying it', async () => {
  const c = controller({ saveDraft: vi.fn().mockRejectedValue(new Error('server refused')) });
  render(<RepricingDraftPanel canPrepareRepricing controller={c} />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Зберегти чернетку' })));
  expect(c.saveDraft).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Перегляд ще не збережено')).toBeTruthy();
  expect(screen.queryByText(/Збережено /)).toBeNull();
  expect(c.setDiscardDraftOpen).not.toHaveBeenCalled();
});

it('shows authoritative save states and does not invent a missing saved timestamp', () => {
  const c = controller({ activeDraft: { id: 17 }, draftSaveState: 'saving' });
  const view = render(<RepricingDraftPanel canPrepareRepricing={false} controller={c} />);
  expect(screen.getByText('Зберігаємо...')).toBeTruthy();
  view.rerender(<RepricingDraftPanel canPrepareRepricing={false} controller={{ ...c, draftSaveState: 'error' }} />);
  expect(screen.getByText('Не вдалося зберегти')).toBeTruthy();
  expect(screen.queryByText('Зберігаємо...')).toBeNull();
  view.rerender(<RepricingDraftPanel canPrepareRepricing={false} controller={{ ...c, draftSaveState: 'saved' }} />);
  expect(screen.getByText('Збережено -')).toBeTruthy();
});
