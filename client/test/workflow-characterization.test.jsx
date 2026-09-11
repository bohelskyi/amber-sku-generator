import { MemoryRouter } from 'react-router-dom';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { useSkuManager } from '../src/hooks/useSkuManager.js';
import { api } from '../src/lib/api.js';
import AdminPage from '../src/pages/AdminPage.jsx';
import CorrectionRequestsPage from '../src/pages/CorrectionRequestsPage.jsx';
import RepricingPage from '../src/pages/RepricingPage.jsx';

function response(data) {
  return { data, status: 200, statusText: 'OK', headers: {}, config: {} };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function authValue(permissions) {
  return {
    identity: { name: 'Phase One User' },
    applicationUser: { id: 42, status: 'active', displayName: 'Phase One User' },
    roles: [],
    permissions,
    logout: vi.fn(),
    refresh: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

const builderConfig = {
  categories: {
    BR: { code: 'BR', name: 'Bracelets', requires_weight: 0 },
  },
  questions: {
    BR: [{
      q_db_id: 1,
      id: 'kind',
      label: 'Kind',
      required: 1,
      include_in_sku: 1,
      input_type: 'options',
      sku_index: 1,
      display_order: 1,
      options: [
        { db_id: 11, id: 1, sku_code: '1', label: 'One', archived: 0 },
        { db_id: 12, id: 2, sku_code: '2', label: 'Two', archived: 0 },
      ],
    }],
  },
  extraConfig: {},
};

function SkuLivePreviewHarness() {
  const sku = useSkuManager();
  if (!sku.config) return <div>loading</div>;
  return (
    <div>
      <button type="button" onClick={() => sku.resetProductFlow('BR')}>Start</button>
      <button type="button" onClick={() => sku.handleAnswer('kind', '1')}>One</button>
      <button type="button" onClick={() => sku.handleAnswer('kind', '2')}>Two</button>
      <output aria-label="Live price">{sku.livePriceData?.totalPriceUah ?? 'none'}</output>
    </div>
  );
}

describe('Product Builder live pricing', () => {
  it('keeps the newest debounced preview when rapid edits resolve out of order', async () => {
    const firstPreview = deferred();
    const secondPreview = deferred();
    const previewRequests = [];
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/config') return response(builderConfig);
      if (url === '/products') return response([]);
      if (url === '/export/status') return response({});
      throw new Error(`Unexpected GET ${url}`);
    });
    vi.spyOn(api, 'post').mockImplementation((url, body) => {
      if (url !== '/price-preview') throw new Error(`Unexpected POST ${url}`);
      previewRequests.push(body);
      return previewRequests.length === 1 ? firstPreview.promise : secondPreview.promise;
    });

    render(<SkuLivePreviewHarness />);
    await screen.findByText('Start');
    fireEvent.click(screen.getByText('Start'));
    vi.useFakeTimers();

    fireEvent.click(screen.getByText('One'));
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(previewRequests[0].answers).toEqual({ kind: 1 });

    fireEvent.click(screen.getByText('Two'));
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(previewRequests[1].answers).toEqual({ kind: 2 });

    await act(async () => {
      secondPreview.resolve(response({ totalPriceUah: 2200 }));
      await Promise.resolve();
    });
    expect(screen.getByLabelText('Live price').textContent).toBe('2200');

    await act(async () => {
      firstPreview.resolve(response({ totalPriceUah: 1100 }));
      await Promise.resolve();
    });
    expect(screen.getByLabelText('Live price').textContent).toBe('2200');
  });
});

const repricingConfig = {
  categories: { BR: { code: 'BR', name: 'Bracelets', requires_weight: 0 } },
  questions: { BR: [] },
  extraConfig: {},
};
const repricingScenario = {
  id: 21,
  category_code: 'BR',
  name: 'Base matrix',
  priority: 1,
  price_mode: 'fixed_uah',
};
const repricingPreview = {
  scope: 'scenario',
  scenario: { id: 21, categoryCode: 'BR', name: 'Base matrix' },
  previewToken: 'preview-token',
  blockingCorrectionRequests: [],
  summary: {
    candidateCount: 1,
    changedCount: 1,
    unchangedCount: 0,
    skippedCount: 0,
    errorCount: 0,
  },
  items: [{
    productId: 501,
    sku: 'BR1001',
    categoryCode: 'BR',
    scenarioId: 21,
    scenarioName: 'Base matrix',
    weight: 0,
    oldPriceUah: 1000,
    newPriceUah: 1200,
    calculatedPriceUah: 1200,
    automaticPriceUah: 1200,
    priceDeltaUah: 200,
    priceMode: 'fixed_uah',
    pricingState: 'automatic',
    status: 'changed',
    pricingChange: { reasonCodes: [], reasonLabels: [] },
  }],
};

function renderRepricing(permissions = [
  'repricing.view',
  'repricing.prepare',
  'repricing.apply',
  'repricing.rollback',
]) {
  return render(
    <AuthContext.Provider value={authValue(permissions)}>
      <MemoryRouter><RepricingPage /></MemoryRouter>
    </AuthContext.Provider>
  );
}

describe('Repricing workflow', () => {
  it('autosaves edited resolutions after the established debounce with the complete draft state', async () => {
    let savedDraft = null;
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/config') return response(repricingConfig);
      if (url === '/admin/repricing/scenarios') return response([repricingScenario]);
      if (url === '/admin/repricing/batches') return response([]);
      if (url === '/admin/repricing/drafts') return response(savedDraft ? [savedDraft] : []);
      if (url === '/admin/correction-requests') return response({ items: [] });
      throw new Error(`Unexpected GET ${url}`);
    });
    const post = vi.spyOn(api, 'post').mockImplementation(async (url, body) => {
      if (url === '/admin/repricing/preview') return response(repricingPreview);
      if (url === '/admin/repricing/drafts') {
        savedDraft = {
          id: 77,
          scope: 'scenario',
          scenarioId: 21,
          updatedAt: '2026-09-11T09:00:00.000Z',
        };
        return response({ draft: savedDraft });
      }
      throw new Error(`Unexpected POST ${url} ${JSON.stringify(body)}`);
    });

    renderRepricing();
    fireEvent.click(await screen.findByRole('button', { name: 'Попередній перегляд' }));
    const priceInput = await screen.findByRole('textbox', { name: 'Нова ціна для BR1001' });
    vi.useFakeTimers();
    fireEvent.change(priceInput, { target: { value: '1350' } });
    expect(post).not.toHaveBeenCalledWith('/admin/repricing/drafts', expect.anything());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(799);
    });
    expect(post).not.toHaveBeenCalledWith('/admin/repricing/drafts', expect.anything());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(post).toHaveBeenCalledWith('/admin/repricing/drafts', {
      scope: 'scenario',
      scenarioId: 21,
      manualOverrides: [{ productId: 501, newPriceUah: 1350 }],
      automaticProductIds: [],
      reviewedProductIds: [],
      uiState: {
        filter: 'changed',
        reviewFilter: 'all',
        scenarioFilter: 'all',
        search: '',
        sort: { key: 'sku', direction: 'asc' },
      },
    });
    expect(screen.getByText('Чернетка #77')).toBeTruthy();
  });

  it('renders server-reported stale draft state and blocks apply until synchronization', async () => {
    const draft = {
      id: 88,
      scope: 'scenario',
      scenarioId: 21,
      updatedAt: '2026-09-11T09:00:00.000Z',
      manualOverrides: [],
      automaticProductIds: [],
      reviewedProductIds: [],
      uiState: {},
    };
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/config') return response(repricingConfig);
      if (url === '/admin/repricing/scenarios') return response([repricingScenario]);
      if (url === '/admin/repricing/batches') return response([]);
      if (url === '/admin/repricing/drafts') return response([draft]);
      if (url === '/admin/correction-requests') return response({ items: [] });
      if (url === '/admin/repricing/drafts/88') {
        return response({
          draft,
          preview: repricingPreview,
          conflicts: [],
          sync: {
            hasChanges: true,
            contextChanged: true,
            added: [],
            removed: [],
            changed: [{ productId: 501 }],
          },
        });
      }
      throw new Error(`Unexpected GET ${url}`);
    });

    renderRepricing();
    fireEvent.click(await screen.findByRole('button', { name: 'Продовжити чернетку' }));
    expect(await screen.findByText(/Дані або розрахунок змінилися після збереження чернетки/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Прийняти оновлення' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Застосувати переоцінку' }).disabled).toBe(true);
  });

  it('serializes overlapping autosaves and persists the newest resolution last', async () => {
    const firstSave = deferred();
    const secondSave = deferred();
    let savedDraft = null;
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/config') return response(repricingConfig);
      if (url === '/admin/repricing/scenarios') return response([repricingScenario]);
      if (url === '/admin/repricing/batches') return response([]);
      if (url === '/admin/repricing/drafts') return response(savedDraft ? [savedDraft] : []);
      if (url === '/admin/correction-requests') return response({ items: [] });
      throw new Error(`Unexpected GET ${url}`);
    });
    const post = vi.spyOn(api, 'post').mockImplementation((url) => {
      if (url === '/admin/repricing/preview') return Promise.resolve(response(repricingPreview));
      if (url === '/admin/repricing/drafts') return firstSave.promise;
      throw new Error(`Unexpected POST ${url}`);
    });
    const put = vi.spyOn(api, 'put').mockImplementation((url) => {
      if (url === '/admin/repricing/drafts/77') return secondSave.promise;
      throw new Error(`Unexpected PUT ${url}`);
    });

    renderRepricing();
    fireEvent.click(await screen.findByRole('button', { name: 'Попередній перегляд' }));
    const priceInput = await screen.findByRole(
      'textbox',
      { name: 'Нова ціна для BR1001' },
      { timeout: 3000 }
    );
    vi.useFakeTimers();

    fireEvent.change(priceInput, { target: { value: '1300' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(post).toHaveBeenCalledWith('/admin/repricing/drafts', expect.objectContaining({
      manualOverrides: [{ productId: 501, newPriceUah: 1300 }],
    }));

    fireEvent.change(priceInput, { target: { value: '1400' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(put).not.toHaveBeenCalled();

    await act(async () => {
      savedDraft = {
        id: 77,
        scope: 'scenario',
        scenarioId: 21,
        updatedAt: '2026-09-11T09:00:00.000Z',
      };
      firstSave.resolve(response({ draft: savedDraft }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(put).toHaveBeenCalledWith('/admin/repricing/drafts/77', expect.objectContaining({
      manualOverrides: [{ productId: 501, newPriceUah: 1400 }],
    }));

    await act(async () => {
      savedDraft = { ...savedDraft, updatedAt: '2026-09-11T09:05:00.000Z' };
      secondSave.resolve(response({ draft: savedDraft }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('Чернетка #77')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Нова ціна для BR1001' }).value).toBe('1400');
  });

  it('does not attach a late autosave response to a newer scenario workflow', async () => {
    const oldDraftSave = deferred();
    const secondScenario = {
      ...repricingScenario,
      id: 22,
      category_code: 'NM',
      name: 'New matrix',
    };
    const newestPreview = {
      ...repricingPreview,
      scenario: { id: 22, categoryCode: 'NM', name: 'New matrix' },
      previewToken: 'newest-preview-token',
      items: [{
        ...repricingPreview.items[0],
        productId: 502,
        sku: 'NM2002',
        categoryCode: 'NM',
        scenarioId: 22,
        scenarioName: 'New matrix',
      }],
    };
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/config') return response(repricingConfig);
      if (url === '/admin/repricing/scenarios') {
        return response([repricingScenario, secondScenario]);
      }
      if (url === '/admin/repricing/batches') return response([]);
      if (url === '/admin/repricing/drafts') return response([]);
      if (url === '/admin/correction-requests') return response({ items: [] });
      throw new Error(`Unexpected GET ${url}`);
    });
    let draftSaveCount = 0;
    const post = vi.spyOn(api, 'post').mockImplementation((url, body) => {
      if (url === '/admin/repricing/preview') {
        return Promise.resolve(response(
          Number(body.scenarioId) === 22 ? newestPreview : repricingPreview
        ));
      }
      if (url === '/admin/repricing/drafts') {
        draftSaveCount += 1;
        if (draftSaveCount === 1) return oldDraftSave.promise;
        return Promise.resolve(response({
          draft: {
            id: 88,
            scope: 'scenario',
            scenarioId: 22,
            updatedAt: '2026-09-11T10:00:00.000Z',
          },
        }));
      }
      throw new Error(`Unexpected POST ${url}`);
    });
    const put = vi.spyOn(api, 'put');

    renderRepricing();
    fireEvent.click(await screen.findByRole('button', { name: 'Попередній перегляд' }));
    const firstInput = await screen.findByRole('textbox', { name: 'Нова ціна для BR1001' });
    vi.useFakeTimers();
    fireEvent.change(firstInput, { target: { value: '1300' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(draftSaveCount).toBe(1);

    fireEvent.change(screen.getByRole('combobox', { name: 'Цінова матриця' }), {
      target: { value: '22' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Попередній перегляд' }));
    await act(async () => { await Promise.resolve(); });
    const secondInput = screen.getByRole('textbox', { name: 'Нова ціна для NM2002' });
    fireEvent.change(secondInput, { target: { value: '1500' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(draftSaveCount).toBe(1);

    await act(async () => {
      oldDraftSave.resolve(response({
        draft: {
          id: 77,
          scope: 'scenario',
          scenarioId: 21,
          updatedAt: '2026-09-11T09:00:00.000Z',
        },
      }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const draftCalls = post.mock.calls.filter(([url]) => url === '/admin/repricing/drafts');
    expect(draftCalls).toHaveLength(2);
    expect(draftCalls[1][1]).toEqual(expect.objectContaining({
      scenarioId: 22,
      manualOverrides: [{ productId: 502, newPriceUah: 1500 }],
    }));
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByText('Чернетка #88')).toBeTruthy();
    expect(screen.queryByText('Чернетка #77')).toBeNull();
  });

  it('ignores a preview response after the user switches to a newer scenario', async () => {
    const firstPreview = deferred();
    const secondPreview = deferred();
    const secondScenario = {
      ...repricingScenario,
      id: 22,
      category_code: 'NM',
      name: 'New matrix',
    };
    const newestPreview = {
      ...repricingPreview,
      scenario: { id: 22, categoryCode: 'NM', name: 'New matrix' },
      previewToken: 'newest-preview-token',
      items: [{
        ...repricingPreview.items[0],
        productId: 502,
        sku: 'NM2002',
        categoryCode: 'NM',
        scenarioId: 22,
        scenarioName: 'New matrix',
      }],
    };
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/config') return response(repricingConfig);
      if (url === '/admin/repricing/scenarios') {
        return response([repricingScenario, secondScenario]);
      }
      if (url === '/admin/repricing/batches') return response([]);
      if (url === '/admin/repricing/drafts') return response([]);
      if (url === '/admin/correction-requests') return response({ items: [] });
      throw new Error(`Unexpected GET ${url}`);
    });
    let previewRequestCount = 0;
    vi.spyOn(api, 'post').mockImplementation((url) => {
      if (url !== '/admin/repricing/preview') throw new Error(`Unexpected POST ${url}`);
      previewRequestCount += 1;
      return previewRequestCount === 1 ? firstPreview.promise : secondPreview.promise;
    });

    renderRepricing();
    fireEvent.click(await screen.findByRole('button', { name: 'Попередній перегляд' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Цінова матриця' }), {
      target: { value: '22' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Попередній перегляд' }));

    await act(async () => {
      secondPreview.resolve(response(newestPreview));
      await Promise.resolve();
    });
    expect(await screen.findByText('NM2002')).toBeTruthy();

    await act(async () => {
      firstPreview.resolve(response(repricingPreview));
      await Promise.resolve();
    });
    expect(screen.queryByText('BR1001')).toBeNull();
    expect(screen.getByText('NM2002')).toBeTruthy();
  });

  it('keeps correction blockers authoritative and submits apply only once', async () => {
    const applyRequest = deferred();
    const blocker = {
      id: 91,
      sourceProductId: 501,
      sourceSku: 'BR1001',
      status: 'pending',
    };
    let activeRequests = [blocker];
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/config') return response(repricingConfig);
      if (url === '/admin/repricing/scenarios') return response([repricingScenario]);
      if (url === '/admin/repricing/batches') return response([]);
      if (url === '/admin/repricing/drafts') return response([]);
      if (url === '/admin/correction-requests') return response({ items: activeRequests });
      throw new Error(`Unexpected GET ${url}`);
    });
    const post = vi.spyOn(api, 'post').mockImplementation((url) => {
      if (url === '/admin/repricing/preview') return Promise.resolve(response(repricingPreview));
      if (url === '/admin/repricing/apply') return applyRequest.promise;
      throw new Error(`Unexpected POST ${url}`);
    });

    const firstRender = renderRepricing();
    fireEvent.click(await screen.findByRole('button', { name: 'Попередній перегляд' }));
    expect(await screen.findByText('Переоцінку тимчасово заблоковано')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Застосувати переоцінку' }).disabled).toBe(true);

    firstRender.unmount();
    activeRequests = [];
    renderRepricing();
    fireEvent.click(await screen.findByRole('button', { name: 'Попередній перегляд' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Застосувати переоцінку' }));
    const confirmButton = screen.getByRole('button', { name: 'Застосувати' });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);
    expect(post.mock.calls.filter(([url]) => url === '/admin/repricing/apply')).toHaveLength(1);

    await act(async () => {
      applyRequest.resolve(response({
        batch: { id: 92, changedCount: 1, changed_count: 1 },
      }));
      await Promise.resolve();
    });
    expect(await screen.findByText('Оновлено товарів: 1')).toBeTruthy();
  });

  it('keeps apply and rollback controls hidden without their effective permissions', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/config') return response(repricingConfig);
      if (url === '/admin/repricing/scenarios') return response([repricingScenario]);
      if (url === '/admin/repricing/batches') {
        return response([{
          id: 31,
          applied_at: '2026-09-11T08:00:00.000Z',
          category_code: 'BR',
          scenario_name: 'Base matrix',
          status: 'completed',
          changed_count: 1,
          can_rollback: true,
        }]);
      }
      if (url === '/admin/repricing/drafts') return response([]);
      if (url === '/admin/correction-requests') return response({ items: [] });
      throw new Error(`Unexpected GET ${url}`);
    });
    vi.spyOn(api, 'post').mockImplementation(async (url) => {
      if (url === '/admin/repricing/preview') return response(repricingPreview);
      throw new Error(`Unexpected POST ${url}`);
    });

    renderRepricing(['repricing.view', 'repricing.prepare']);
    await screen.findByRole('button', { name: 'Попередній перегляд' });
    expect(screen.queryByRole('button', { name: 'Відкотити переоцінку 31' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Попередній перегляд' }));
    await screen.findByText('BR1001');
    expect(screen.queryByRole('button', { name: 'Застосувати переоцінку' })).toBeNull();
  });

  it('surfaces rollback conflicts without changing the rendered batch history', async () => {
    const batch = {
      id: 31,
      applied_at: '2026-09-11T08:00:00.000Z',
      category_code: 'BR',
      scenario_name: 'Base matrix',
      status: 'completed',
      changed_count: 1,
      can_rollback: true,
    };
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/config') return response(repricingConfig);
      if (url === '/admin/repricing/scenarios') return response([repricingScenario]);
      if (url === '/admin/repricing/batches') return response([batch]);
      if (url === '/admin/repricing/drafts') return response([]);
      if (url === '/admin/correction-requests') return response({ items: [] });
      throw new Error(`Unexpected GET ${url}`);
    });
    const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
      if (url === '/admin/repricing/31/rollback') {
        const conflict = new Error('Rollback conflict');
        conflict.response = { data: { error: 'Товар змінився після переоцінки.' } };
        throw conflict;
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    renderRepricing();
    fireEvent.click(await screen.findByRole('button', { name: 'Відкотити переоцінку 31' }));
    fireEvent.click(screen.getByRole('button', { name: 'Відкотити' }));

    expect(await screen.findByText('Товар змінився після переоцінки.')).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/admin/repricing/31/rollback');
    expect(screen.queryByRole('dialog', { name: 'Відкотити переоцінку' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Відкотити переоцінку 31' })).toBeTruthy();
  });

  it('preserves explicit automatic and manual resolution cycles in a global draft', async () => {
    const manualPreview = {
      ...repricingPreview,
      scope: 'global',
      scenario: null,
      summary: { ...repricingPreview.summary, changedCount: 0, errorCount: 1 },
      items: [{
        ...repricingPreview.items[0],
        oldPriceUah: 1000,
        newPriceUah: 1200,
        automaticPriceUah: 1200,
        status: 'error',
        errorCode: 'manual_price',
        pricingState: 'manual',
        message: 'Товар має ручну ціну.',
      }],
    };
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/config') return response(repricingConfig);
      if (url === '/admin/repricing/scenarios') return response([repricingScenario]);
      if (url === '/admin/repricing/batches') return response([]);
      if (url === '/admin/repricing/drafts') return response([]);
      if (url === '/admin/correction-requests') return response({ items: [] });
      throw new Error(`Unexpected GET ${url}`);
    });
    vi.spyOn(api, 'post').mockImplementation(async (url) => {
      if (url === '/admin/repricing/global/preview') return response(manualPreview);
      throw new Error(`Unexpected POST ${url}`);
    });

    renderRepricing();
    fireEvent.click(await screen.findByRole('button', { name: 'Переоцінити все' }));
    const applyButton = await screen.findByRole('button', { name: 'Застосувати переоцінку' });
    expect(applyButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Усі' }));
    fireEvent.click(screen.getByRole('button', { name: /Застосувати автоматичну ціну/ }));
    expect(screen.getByText('Автоматичну ціну підтверджено')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Нова ціна для BR1001' }).value).toBe('1200');
    expect(applyButton.disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Скинути ручну ціну для BR1001' }));
    expect(screen.queryByText('Автоматичну ціну підтверджено')).toBeNull();
    expect(applyButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Залишити ручну ціну/ }));
    expect(screen.getByText('Ручну ціну підтверджено')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Нова ціна для BR1001' }).value).toBe('1000');
    expect(applyButton.disabled).toBe(false);
  });
});

describe('Admin catalog workflow', () => {
  it('persists a rendered question edit, reloads authoritative config, and publishes the draft schema', async () => {
    const originalConfig = {
      categories: { BR: { code: 'BR', name: 'Bracelets', requires_weight: 0 } },
      questions: {
        BR: [{
          q_db_id: 10,
          id: 'kind',
          label: 'Kind',
          display_order: 1,
          sku_index: 1,
          required: 1,
          include_in_sku: 1,
          input_type: 'options',
          sku_separator: '',
          visible_if_json: null,
          options: [],
        }],
      },
      extraConfig: {},
    };
    const updatedConfig = {
      ...originalConfig,
      questions: {
        BR: [{ ...originalConfig.questions.BR[0], label: 'Updated kind' }],
      },
    };
    let questionSaved = false;
    let published = false;
    vi.spyOn(globalThis, 'alert').mockImplementation(() => {});
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/admin/config') return response(questionSaved ? updatedConfig : originalConfig);
      if (url === '/admin/sku-schema/BR') {
        return response(published
          ? { active: { id: 2, version: 2, marker: 'BR2/' }, draftChanged: false, nextVersion: 3 }
          : { active: { id: 1, version: 1, marker: '' }, draftChanged: true, nextVersion: 2, nextMarker: 'BR2/' });
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    const post = vi.spyOn(api, 'post').mockImplementation(async (url, body) => {
      if (url === '/admin/question/update') {
        questionSaved = true;
        return response({ success: true, key: body.key });
      }
      if (url === '/admin/sku-schema/BR/publish') {
        published = true;
        return response({ id: 2, categoryCode: 'BR', version: 2, marker: 'BR2/' });
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    render(
      <AuthContext.Provider value={authValue(['catalog.view', 'catalog.manage', 'sku_schemas.publish'])}>
        <MemoryRouter><AdminPage /></MemoryRouter>
      </AuthContext.Provider>
    );
    fireEvent.click(await screen.findByRole('tab', { name: /Bracelets/ }));
    fireEvent.click(screen.getByText('Kind').closest('[role="button"]'));
    fireEvent.click(screen.getByRole('button', { name: 'Редагувати' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Назва питання' }), {
      target: { value: 'Updated kind' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/question/update', expect.objectContaining({
      id: 10,
      key: 'kind',
      label: 'Updated kind',
    })));
    expect((await screen.findAllByText('Updated kind')).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Опублікувати V2' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/sku-schema/BR/publish'));
    await waitFor(() => expect(screen.getByText(/Схема V2/)).toBeTruthy());
  });
});

function correctionRequest(id, sourceSku) {
  return {
    id,
    status: 'pending',
    sourceSku,
    proposedSku: `${sourceSku}-NEW`,
    categoryCode: 'BR',
    comment: '',
    changes: [],
    proposedPayload: { totalPriceUah: 1250 },
    createdAt: '2026-09-11T08:00:00.000Z',
    updatedAt: '2026-09-11T08:00:00.000Z',
  };
}

describe('Correction queue polling', () => {
  it('loads immediately, polls every five seconds without overlap, and renders the completed refresh', async () => {
    vi.useFakeTimers();
    const inFlightPoll = deferred();
    let correctionLoads = 0;
    vi.spyOn(api, 'get').mockImplementation((url) => {
      if (url === '/config') return Promise.resolve(response(builderConfig));
      if (url === '/admin/correction-requests') {
        correctionLoads += 1;
        if (correctionLoads === 1) {
          return Promise.resolve(response({
            items: [correctionRequest(1, 'BR-OLD')],
            summary: { active: 1, pending: 1 },
          }));
        }
        if (correctionLoads === 2) return inFlightPoll.promise;
        return Promise.resolve(response({
          items: [correctionRequest(2, 'BR-LATEST')],
          summary: { active: 1, pending: 1 },
        }));
      }
      throw new Error(`Unexpected GET ${url}`);
    });

    render(
      <AuthContext.Provider value={authValue(['corrections.view'])}>
        <MemoryRouter><CorrectionRequestsPage /></MemoryRouter>
      </AuthContext.Provider>
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('BR-OLD')).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(correctionLoads).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(correctionLoads).toBe(2);

    await act(async () => {
      inFlightPoll.resolve(response({
        items: [correctionRequest(2, 'BR-LATEST')],
        summary: { active: 1, pending: 1 },
      }));
      await Promise.resolve();
    });
    expect(screen.queryByText('BR-OLD')).toBeNull();
    expect(screen.getByText('BR-LATEST')).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(correctionLoads).toBe(3);
  });
});
