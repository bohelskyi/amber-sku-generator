import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import { EffectiveProductNameReview } from '../src/components/app/EffectiveProductNameReview.jsx';
import { createRequirements } from '../src/lib/product-create-readiness.js';
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const product = { productId: 41, publicSku: 'SV-EXACT' };
const missing = { productId: 41, publicSku: 'SV-EXACT', names: null, previewToken: 'local-evidence', nameConflict: false,
  readiness: { policy: 'effective-product-names-v1', ready: false, source: 'template' } };
let saved;
function show(initial = missing) {
  return render(<AuthContext.Provider value={{ principalLifetime: { valid: true } }}>
    <EffectiveProductNameReview product={product} initial={initial} onSaved={saved} onClose={vi.fn()} />
  </AuthContext.Provider>);
}
beforeEach(() => { vi.resetAllMocks(); saved = vi.fn(); }); afterEach(cleanup);
it('template names satisfy creation without manual subjects; an incomplete preview requests a full pair', () => {
  const config = { productNameReadiness: { available: true, policy: 'effective-product-names-v1' }, productCreateRequirements: { SV: { requiredAnswers: ['weight'], automaticName: { question: 'souvenir', values: ['6'] } } } };
  expect(createRequirements(config, 'SV', { souvenir: 5 }).namesRequired).toBe(false);
  expect(createRequirements(config, 'SV', { souvenir: 5 }, { creationNames: { ready: true } }).namesRequired).toBe(false);
  expect(createRequirements(config, 'SV', { souvenir: 5 }, { creationNames: { ready: false } }).namesRequired).toBe(true);
});
it('complete generated names are shown without required manual entry or an automatic remote read', () => {
  show({ ...missing, names: { all: 'Назва шаблону', en: 'Template name' }, readiness: { ...missing.readiness, ready: true } });
  expect(screen.getByLabelText('Повна назва українською').readOnly).toBe(true);
  expect(screen.queryByRole('button', { name: 'Перевірити назви в Magento' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});
it('full manual names need an explicit review and preserve exact text without adding subject formatting', async () => {
  api.post.mockResolvedValue({ data: {} }); show();
  fireEvent.change(screen.getByLabelText('Повна назва українською'), { target: { value: ' Повна українська назва ' } });
  fireEvent.change(screen.getByLabelText('Повна назва англійською (EN)'), { target: { value: ' Exact full name ' } });
  expect(api.post).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Переглянути зміни' }));
  expect(api.post).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Зберегти повні назви' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(api.post).toHaveBeenCalledWith('/product-names/save', { productId: 41,
    names: { all: ' Повна українська назва ', en: ' Exact full name ' }, previewToken: 'local-evidence' });
});
it('Magento fallback is GET-preview driven and imports only after the exact pair is explicitly accepted', async () => {
  const remote = { magento: { all: ' Точна UA ', en: ' Exact EN ' }, previewToken: 'remote-evidence' };
  api.post.mockResolvedValue({ data: remote }); show();
  expect(api.post).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Перевірити назви в Magento' }));
  await screen.findByRole('button', { name: 'Імпортувати перевірені назви' });
  expect(api.post).toHaveBeenCalledTimes(1); expect(saved).not.toHaveBeenCalled();
  expect(api.post).toHaveBeenCalledWith('/magento/name-resolution/preview', { productId: 41, choice: 'magento', intent: 'complete' });
  fireEvent.click(screen.getByRole('button', { name: 'Імпортувати перевірені назви' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(api.post).toHaveBeenCalledWith('/magento/name-resolution/apply', { productId: 41, choice: 'magento', intent: 'complete', previewToken: 'remote-evidence' });
});
it('a stale import removes reviewed evidence and requires a fresh preview rather than permitting another apply', async () => {
  api.post.mockResolvedValueOnce({ data: { magento: { all: 'UA', en: 'EN' }, previewToken: 'remote-evidence' } })
    .mockRejectedValueOnce({ response: { status: 409, data: { error: 'Назви змінилися' } } }); show();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити назви в Magento' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Імпортувати перевірені назви' }));
  await screen.findByText('Назви змінилися'); expect(saved).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Імпортувати перевірені назви' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Перевірити назви в Magento' }).disabled).toBe(true);
});
it('an import preview that finishes after unmount cannot create a write or invoke success', async () => {
  let resolve; api.post.mockImplementation(() => new Promise(done => { resolve = done; })); const view = show();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити назви в Magento' })); view.unmount();
  await act(async () => resolve({ data: { magento: { all: 'UA', en: 'EN' }, previewToken: 'late' } }));
  expect(api.post).toHaveBeenCalledTimes(1); expect(saved).not.toHaveBeenCalled();
});
