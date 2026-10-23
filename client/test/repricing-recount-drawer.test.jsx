import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RepricingRecountDrawer } from '../src/components/app/RepricingRecountDrawer.jsx';
import { api } from '../src/lib/api.js';

// Exercise the actual recount hook, workspace and dialogs; only the HTTP boundary is controlled.
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const config = { categories: { LN: { code: 'LN', name: 'Намисто', requires_weight: 1 } }, questions: { LN: [] } };
const inputName = 'Артикул для розшифрування або переобліку';
let decoded;
let preview;

beforeEach(() => {
  vi.resetAllMocks();
  decoded = {
    existsInDb: true, sku: 'LN1001', publicSku: 'AG-000001', category: config.categories.LN,
    decodedAnswers: [], suffix: { type: 'sequence', value: 1, raw: '001' }, skuSchema: { version: 1 },
    product: { id: 71, status: 'active', weight: 10, details: { answers: {} } },
    pricing: { totalPriceUah: 1000, weight: 10 },
  };
  preview = {
    source: { sku: 'LN1001', publicSku: 'AG-000001', totalPriceUah: 1000, stateSignature: 'reviewed-source-state' },
    corrected: { categoryCode: 'LN', publicSku: 'AG-000001', totalPriceUah: 1200, autoPriceUah: 1200 },
    changes: [{ key: 'weight', from: 10, to: 11 }], priceDeltaUah: 200, previewToken: 'reviewed-pricing-decision',
  };
  api.post.mockImplementation(async (url) => {
    if (url === '/decode') return { data: structuredClone(decoded) };
    if (url === '/recount/preview' || url === '/admin/correction-requests/preview') return { data: structuredClone(preview) };
    throw new Error(`Unexpected request: ${url}`);
  });
  api.get.mockImplementation(async (url) => { throw new Error(`Unexpected read: ${url}`); });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(props = {}) {
  const callbacks = { onApplied: vi.fn(), onRequestCreated: vi.fn(), onClose: vi.fn() };
  const view = render(<RepricingRecountDrawer config={config} {...callbacks} {...props} />);
  return { ...view, ...callbacks };
}

function writes() {
  return api.post.mock.calls.filter(([url]) => !['/decode', '/recount/preview', '/admin/correction-requests/preview'].includes(url));
}

async function openConfirmation(props = {}) {
  const view = mount({ initialSku: 'AG-000001', ...props });
  fireEvent.click(await screen.findByRole('button', { name: props.canApplyRecount === false ? 'Підготувати запит' : 'Змінити характеристики' }));
  fireEvent.change(screen.getByLabelText(/Вага виробу/), { target: { value: '11' } });
  fireEvent.change(screen.getByLabelText(props.canApplyRecount === false ? 'Коментар до запиту' : 'Причина переобліку'), {
    target: { value: 'Уточнена вага після перевірки виробу' },
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Продовжити' }).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Продовжити' }));
  const confirmation = await screen.findByRole('dialog', {
    name: props.canApplyRecount === false ? 'Передати товар на виправлення?' : 'Застосувати переоблік?',
  });
  return { ...view, confirmation };
}

it('opening an empty drawer performs no decode, preview or mutation', () => {
  const view = mount();
  expect(screen.getByRole('dialog', { name: 'Товар і переоблік' }).getAttribute('aria-modal')).toBe('true');
  expect(screen.getByText('Артикул не обрано')).toBeTruthy();
  expect(screen.getByRole('textbox', { name: inputName }).value).toBe('');
  expect(api.post).not.toHaveBeenCalled();
  expect(api.get).not.toHaveBeenCalled();
  expect(view.onApplied).not.toHaveBeenCalled();
  expect(view.onRequestCreated).not.toHaveBeenCalled();
});

it('decodes an initial public article once, including equivalent rerenders, and reads a changed article separately', async () => {
  const view = mount({ initialSku: '  ag-000001  ' });
  await screen.findByRole('heading', { name: 'Характеристики товару' });
  expect(api.post.mock.calls).toEqual([['/decode', { sku: 'AG-000001' }]]);
  view.rerender(<RepricingRecountDrawer config={config} initialSku="AG-000001" />);
  expect(api.post).toHaveBeenCalledTimes(1);
  view.rerender(<RepricingRecountDrawer config={config} initialSku=" ag-000002 " />);
  await waitFor(() => expect(screen.getByRole('textbox', { name: inputName }).value).toBe('AG-000002'));
  expect(api.post.mock.calls).toEqual([
    ['/decode', { sku: 'AG-000001' }], ['/decode', { sku: 'AG-000002' }],
  ]);
  expect(writes()).toEqual([]);
});

it('typing and ordinary keys are inert; Enter and the decode button explicitly read the entered article', async () => {
  mount();
  const input = screen.getByRole('textbox', { name: inputName });
  fireEvent.change(input, { target: { value: ' ag-000001 ' } });
  fireEvent.keyDown(input, { key: 'ArrowLeft' });
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter' });
  await screen.findByRole('heading', { name: 'Характеристики товару' });
  expect(api.post).toHaveBeenLastCalledWith('/decode', { sku: 'AG-000001' });
  fireEvent.change(input, { target: { value: 'ag-000002' } });
  expect(screen.queryByRole('heading', { name: 'Характеристики товару' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Розшифрувати' }));
  await screen.findByRole('heading', { name: 'Характеристики товару' });
  expect(api.post).toHaveBeenLastCalledWith('/decode', { sku: 'AG-000002' });
  expect(writes()).toEqual([]);
});

it('refuses an empty lookup locally without making any API call', () => {
  mount();
  fireEvent.keyDown(screen.getByRole('textbox', { name: inputName }), { key: 'Enter' });
  expect(screen.getByText('Введіть артикул для розшифровки.')).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});

it('shows authoritative decode refusal and its category details without opening a recount', async () => {
  api.post.mockRejectedValueOnce({ response: { status: 422, data: {
    error: 'Невідома категорія товару',
    details: { type: 'unknown_category', received: 'XX', categories: [{ code: 'LN', name: 'Намисто' }] },
  } } });
  const view = mount({ initialSku: 'XX1001' });
  await screen.findByText('Невідома категорія товару');
  expect(screen.getByText('XX')).toBeTruthy();
  expect(screen.getByText('Доступні категорії')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Змінити характеристики' })).toBeNull();
  expect(writes()).toEqual([]);
  expect(view.onApplied).not.toHaveBeenCalled();
});

it.each([
  ['unsaved SKU', { existsInDb: false }],
  ['archived product', { product: { status: 'archived' } }],
  ['superseded product', { product: { corrected_to_product_id: 72 } }],
])('does not offer recount for an %s even when direct recount is permitted', async (_label, state) => {
  decoded = { ...decoded, ...state, product: { ...decoded.product, ...state.product } };
  mount({ initialSku: 'AG-000001', canApplyRecount: true, canCreateRequest: false });
  await screen.findByRole('heading', { name: decoded.existsInDb ? 'Характеристики товару' : 'Розшифрований код' });
  expect(screen.queryByRole('button', { name: 'Змінити характеристики' })).toBeNull();
  expect(screen.queryByLabelText(/Вага виробу/)).toBeNull();
  expect(writes()).toEqual([]);
});

it.each([
  ['request-only fallback', false, true, 'apply', 'request'],
  ['apply-only fallback', true, false, 'request', 'apply'],
  ['permitted initial request', true, true, 'request', 'request'],
  ['permitted initial apply', true, true, 'apply', 'apply'],
  ['unknown mode fallback', true, true, 'unexpected', 'apply'],
])('%s selects an available action and never submits it on opening', async (_label, canApplyRecount, canCreateRequest, initialMode, mode) => {
  const view = mount({ initialSku: 'AG-000001', canApplyRecount, canCreateRequest, initialMode });
  const start = await screen.findByRole('button', { name: mode === 'request' ? 'Підготувати запит' : 'Змінити характеристики' });
  expect(screen.queryAllByRole('button', { name: 'Переоблік зараз' })).toHaveLength(canApplyRecount ? 2 : 0);
  expect(Boolean(screen.queryByRole('button', { name: 'Передати на розгляд' }))).toBe(canCreateRequest);
  expect(Boolean(screen.queryByRole('button', { name: 'Створити запит' }))).toBe(canCreateRequest);
  fireEvent.click(start);
  expect(screen.getByLabelText(mode === 'request' ? 'Коментар до запиту' : 'Причина переобліку')).toBeTruthy();
  expect(writes()).toEqual([]);
  expect(view.onApplied).not.toHaveBeenCalled();
  expect(view.onRequestCreated).not.toHaveBeenCalled();
});

it('both desktop and compact mode controls change the review workflow without submitting it', async () => {
  mount({ initialSku: 'AG-000001' });
  fireEvent.click(await screen.findByRole('button', { name: 'Змінити характеристики' }));
  fireEvent.click(screen.getByRole('button', { name: 'Передати на розгляд' }));
  expect(screen.getByLabelText('Коментар до запиту')).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button', { name: 'Переоблік зараз' })[0]);
  expect(screen.getByLabelText('Причина переобліку')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Створити запит' }));
  expect(screen.getByLabelText('Коментар до запиту')).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button', { name: 'Переоблік зараз' })[1]);
  expect(screen.getByLabelText('Причина переобліку')).toBeTruthy();
  expect(writes()).toEqual([]);
});

it('focuses close, traps boundary Tab keys, handles Escape and restores the opener on unmount', () => {
  // jsdom has no layout; expose non-empty rectangles solely for the actual focus-trap visibility check.
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{ width: 10, height: 10 }]);
  render(<button type="button">Відкрити переоблік</button>);
  const opener = screen.getByRole('button', { name: 'Відкрити переоблік' });
  opener.focus();
  const originalOverflow = document.body.style.overflow;
  const view = mount({ canCreateRequest: false });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Закрити декодер' }));
  expect(document.body.style.overflow).toBe('hidden');
  const first = screen.getAllByRole('button', { name: 'Переоблік зараз' })[0];
  const last = screen.getByRole('button', { name: 'Розшифрувати' });
  last.focus();
  fireEvent.keyDown(last, { key: 'Tab' });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: 'Escape' });
  expect(view.onClose).toHaveBeenCalledOnce();
  view.unmount();
  expect(document.activeElement).toBe(opener);
  expect(document.body.style.overflow).toBe(originalOverflow);
});

it('requires a separate confirmation and lets Escape return to parameters without closing the drawer', async () => {
  const view = await openConfirmation({ canCreateRequest: false });
  expect(writes()).toEqual([]);
  expect(within(view.confirmation).getByText('Уточнена вага після перевірки виробу')).toBeTruthy();
  fireEvent.keyDown(view.confirmation, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Застосувати переоблік?' })).toBeNull();
  expect(screen.getByRole('dialog', { name: 'Товар і переоблік' })).toBeTruthy();
  expect(screen.getByLabelText(/Вага виробу/).value).toBe('11');
  expect(view.onClose).not.toHaveBeenCalled();
  expect(writes()).toEqual([]);
});

it('keeps a pending apply locked, then displays the server refusal without success or automatic retry', async () => {
  let confirmationPreviewCount = 0;
  let resolveConfirmationPreview;
  let rejectApply;
  const confirmationPreview = new Promise((resolve) => { resolveConfirmationPreview = resolve; });
  const pendingApply = new Promise((_resolve, reject) => { rejectApply = reject; });
  const original = api.post.getMockImplementation();
  api.post.mockImplementation((url, ...args) => {
    if (url === '/recount/preview' && screen.queryByRole('dialog', { name: 'Застосувати переоблік?' })) {
      confirmationPreviewCount += 1;
      return confirmationPreview;
    }
    return url === '/recount/apply' ? pendingApply : original(url, ...args);
  });
  const view = await openConfirmation();
  // Establish a settled review before exercising the ordinary apply-refusal path.
  await waitFor(() => expect(confirmationPreviewCount).toBe(1));
  await act(async () => resolveConfirmationPreview({ data: {
    ...preview, previewToken: 'settled-confirmation-preview', priceDeltaUah: 300,
    corrected: { ...preview.corrected, totalPriceUah: 1300, autoPriceUah: 1300 },
  } }));
  expect(await within(view.confirmation).findByText('1300 ₴', { exact: true })).toBeTruthy();
  fireEvent.click(within(view.confirmation).getByRole('button', { name: 'Застосувати переоблік' }));
  const pendingButton = await within(view.confirmation).findByRole('button', { name: 'Застосовуємо…' });
  expect(pendingButton.disabled).toBe(true);
  for (const button of [screen.getByRole('button', { name: 'Закрити декодер' }),
    screen.getByRole('button', { name: 'Передати на розгляд' }),
    ...screen.getAllByRole('button', { name: 'Переоблік зараз' }),
    screen.getByRole('button', { name: 'Створити запит' }),
    within(view.confirmation).getByRole('button', { name: 'Повернутися до параметрів' }), pendingButton]) {
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
  }
  fireEvent.keyDown(view.confirmation, { key: 'Escape' });
  expect(view.onClose).not.toHaveBeenCalled();
  expect(writes()).toHaveLength(1);
  expect(writes()[0][1]).toMatchObject({ previewToken: 'settled-confirmation-preview' });
  await act(async () => { rejectApply({ response: { status: 403, data: { error: 'Право переобліку відкликано' } } }); });
  expect((await within(view.confirmation).findByRole('alert')).textContent).toBe('Право переобліку відкликано');
  expect(view.onApplied).not.toHaveBeenCalled();
  expect(view.onRequestCreated).not.toHaveBeenCalled();
  expect(writes()).toHaveLength(1);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Закрити декодер' }).disabled).toBe(false));
});

it('submits the reviewed source and pricing proof only after confirmation and reports the server receipt', async () => {
  const result = { corrected: { publicSku: 'AG-000001', id: 72 } };
  const original = api.post.getMockImplementation();
  api.post.mockImplementation((url, ...args) => url === '/recount/apply' ? Promise.resolve({ data: result }) : original(url, ...args));
  const view = await openConfirmation({ canCreateRequest: false });
  expect(writes()).toEqual([]);
  fireEvent.click(within(view.confirmation).getByRole('button', { name: 'Застосувати переоблік' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Застосувати переоблік?' })).toBeNull());
  await screen.findByRole('heading', { name: 'Характеристики товару' });
  expect(screen.getByText(/Переоблік застосовано\. Артикул: AG-000001/)).toBeTruthy();
  expect(writes()).toEqual([['/recount/apply', expect.objectContaining({
    sourceSku: 'LN1001', weight: 11, reason: 'Уточнена вага після перевірки виробу',
    sourceStateSignature: 'reviewed-source-state', previewToken: 'reviewed-pricing-decision',
    pricingDecision: { mode: 'system_auto' },
  })]]);
  expect(view.onApplied).toHaveBeenCalledExactlyOnceWith({ result, sourceSku: 'LN1001', correctedSku: 'AG-000001' });
  expect(view.onRequestCreated).not.toHaveBeenCalled();
});

it('request-only review hides price overrides and creates a request without direct apply', async () => {
  const request = { id: 42 };
  const original = api.post.getMockImplementation();
  api.post.mockImplementation((url, ...args) => url === '/admin/correction-requests'
    ? Promise.resolve({ data: { request } }) : original(url, ...args));
  const view = await openConfirmation({ canApplyRecount: false, canCreateRequest: true });
  expect(within(view.confirmation).queryByRole('radiogroup', { name: 'Режим ціни' })).toBeNull();
  expect(writes()).toEqual([]);
  fireEvent.click(within(view.confirmation).getByRole('button', { name: 'Створити запит' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Передати товар на виправлення?' })).toBeNull());
  await screen.findByRole('heading', { name: 'Характеристики товару' });
  expect(screen.getByText('Створено запит на виправлення #42.')).toBeTruthy();
  expect(writes()).toEqual([['/admin/correction-requests', expect.objectContaining({ sourceSku: 'LN1001', weight: 11 })]]);
  expect(view.onRequestCreated).toHaveBeenCalledExactlyOnceWith({ request, sourceSku: 'LN1001' });
  expect(view.onApplied).not.toHaveBeenCalled();
});

it('an explicitly permitted request price override uses the request preview without granting direct apply', async () => {
  const view = await openConfirmation({ canApplyRecount: false, canCreateRequest: true, canPriceOverride: true });
  expect(within(view.confirmation).getByRole('radiogroup', { name: 'Режим ціни' })).toBeTruthy();
  expect(api.post.mock.calls.some(([url]) => url === '/admin/correction-requests/preview')).toBe(true);
  expect(screen.queryByRole('button', { name: 'Застосувати переоблік' })).toBeNull();
  expect(screen.queryAllByRole('button', { name: 'Переоблік зараз' })).toHaveLength(0);
  expect(writes()).toEqual([]);
  fireEvent.click(within(view.confirmation).getByRole('button', { name: 'Повернутися до параметрів' }));
  expect(screen.queryByRole('dialog', { name: 'Передати товар на виправлення?' })).toBeNull();
  expect(writes()).toEqual([]);
});

function deferredResponse() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function openWithPendingPreview() {
  const pendingPreview = deferredResponse();
  const pendingApply = deferredResponse();
  let confirmationPreviewCount = 0;
  const original = api.post.getMockImplementation();
  api.post.mockImplementation((url, ...args) => {
    // Identify the actual confirmation phase; an earlier debounce may run before Continue.
    if (url === '/recount/preview' && screen.queryByRole('dialog', { name: 'Застосувати переоблік?' })) {
      confirmationPreviewCount += 1;
      return pendingPreview.promise;
    }
    return url === '/recount/apply' ? pendingApply.promise : original(url, ...args);
  });
  const view = await openConfirmation();
  await waitFor(() => expect(confirmationPreviewCount).toBe(1));
  fireEvent.click(within(view.confirmation).getByRole('button', { name: 'Застосувати переоблік' }));
  expect((await within(view.confirmation).findByRole('button', { name: 'Застосовуємо…' })).disabled).toBe(true);
  return { ...view, pendingPreview, pendingApply };
}

function expectOriginalApply(view) {
  expect(writes()).toEqual([['/recount/apply', {
    sourceSku: 'LN1001', answers: {}, isCalibrated: null, weight: 11,
    reason: 'Уточнена вага після перевірки виробу',
    sourceStateSignature: 'reviewed-source-state', previewToken: 'reviewed-pricing-decision',
    pricingDecision: { mode: 'system_auto' },
  }]]);
  expect(view.onApplied).not.toHaveBeenCalled();
  expect(view.onRequestCreated).not.toHaveBeenCalled();
}

async function rejectPendingApply(view) {
  await act(async () => view.pendingApply.reject({
    response: { status: 403, data: { error: 'Право переобліку відкликано' } },
  }));
  expect((await within(view.confirmation).findByRole('alert')).textContent).toBe('Право переобліку відкликано');
}

async function resolveLatePreview(view) {
  await act(async () => view.pendingPreview.resolve({ data: {
    ...preview, previewToken: 'late-preview-token', priceDeltaUah: 300,
    source: { ...preview.source, stateSignature: 'late-source-state' },
    corrected: { ...preview.corrected, totalPriceUah: 1300, autoPriceUah: 1300 },
  } }));
  expect(await within(view.confirmation).findByText('1300 ₴', { exact: true })).toBeTruthy();
}

it.each(['success', 'failure'])('preserves the apply refusal after an older automatic preview returns %s', async (outcome) => {
  const view = await openWithPendingPreview();
  expectOriginalApply(view);
  await rejectPendingApply(view);
  await waitFor(() => expect(within(view.confirmation).getByRole('button', { name: 'Застосувати переоблік' }).disabled).toBe(false));
  if (outcome === 'success') {
    await resolveLatePreview(view);
  } else {
    await act(async () => view.pendingPreview.reject({ response: { status: 422, data: { error: 'Попередній розрахунок відхилено' } } }));
    await waitFor(() => expect(within(view.confirmation).getByRole('button', { name: 'Застосувати переоблік' }).disabled).toBe(true));
  }
  expect(within(view.confirmation).getByRole('alert').textContent).toBe('Право переобліку відкликано');
  expectOriginalApply(view);
});

it('displays the apply refusal when the automatic preview completes before the apply response', async () => {
  const view = await openWithPendingPreview();
  await resolveLatePreview(view);
  expect(within(view.confirmation).getByRole('button', { name: 'Застосовуємо…' }).disabled).toBe(true);
  expect(within(view.confirmation).queryByRole('alert')).toBeNull();
  expectOriginalApply(view);
  await rejectPendingApply(view);
  expectOriginalApply(view);
});

it('clears an ordinary preview validation error after an explicit price edit obtains a valid preview', async () => {
  const view = await openWithPendingPreview();
  await rejectPendingApply(view);
  await resolveLatePreview(view);
  expect(within(view.confirmation).getByRole('alert').textContent).toBe('Право переобліку відкликано');

  const invalidPreview = deferredResponse();
  const refreshedPreview = deferredResponse();
  const original = api.post.getMockImplementation();
  api.post.mockImplementation((url, payload, ...args) => {
    if (url === '/recount/preview' && payload.pricingDecision.mode === 'manual_uah') {
      return payload.pricingDecision.manualPriceUah === '1400' ? refreshedPreview.promise : invalidPreview.promise;
    }
    return original(url, payload, ...args);
  });
  fireEvent.click(within(view.confirmation).getByRole('radio', { name: 'Ручна UAH' }));
  await waitFor(() => expect(api.post.mock.calls.some(([url, payload]) => url === '/recount/preview'
    && payload.pricingDecision.mode === 'manual_uah' && payload.pricingDecision.manualPriceUah === '')).toBe(true));
  await act(async () => invalidPreview.reject({ response: { status: 422, data: { error: 'Вкажіть ціну' } } }));
  await waitFor(() => expect(within(view.confirmation).getByRole('alert').textContent).toBe('Вкажіть коректну ціну для вибраного режиму.'));
  fireEvent.change(within(view.confirmation).getByLabelText('Точна ціна UAH'), { target: { value: '1400' } });
  await waitFor(() => expect(api.post.mock.calls.some(([url, payload]) => url === '/recount/preview'
    && payload.pricingDecision.manualPriceUah === '1400')).toBe(true));
  await act(async () => refreshedPreview.resolve({ data: {
    ...preview, previewToken: 'refreshed-manual-preview', priceDeltaUah: 400,
    corrected: { ...preview.corrected, totalPriceUah: 1400, manualPriceUah: 1400 },
  } }));
  expect(await within(view.confirmation).findByText('1400 ₴', { exact: true })).toBeTruthy();
  expect(within(view.confirmation).queryByRole('alert')).toBeNull();
  expect(within(view.confirmation).getByRole('button', { name: 'Застосувати переоблік' }).disabled).toBe(false);
  expectOriginalApply(view);
});
