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

function renderRepricing() {
  return render(
    <AuthContext.Provider value={authValue([
      'repricing.view',
      'repricing.prepare',
      'repricing.apply',
      'repricing.rollback',
    ])}>
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
