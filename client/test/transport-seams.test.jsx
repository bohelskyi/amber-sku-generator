import { describe, expect, it, vi } from 'vitest';
import { createCorrectionsApi } from '../src/api/corrections-api';
import { createExportsApi } from '../src/api/exports-api';
import { createProductsApi } from '../src/api/products-api';
import { createRepricingApi } from '../src/api/repricing-api';
import { downloadBlob } from '../src/lib/download';
import { getApiError } from '../src/lib/http-error';

function mockClient() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
}

describe('domain API wrappers', () => {
  it('preserves correction claim headers and CSV response type', () => {
    const client = mockClient();
    const domain = createCorrectionsApi(client);

    domain.releaseRequest(12, 4, { 'X-Correction-Claim-Token': 'legacy' });
    domain.exportHistory({ category: 'BR' });

    expect(client.post).toHaveBeenCalledWith(
      '/admin/correction-requests/12/release',
      { claimVersion: 4 },
      { headers: { 'X-Correction-Claim-Token': 'legacy' } }
    );
    expect(client.get).toHaveBeenCalledWith('/admin/product-corrections/csv', {
      params: { category: 'BR' },
      responseType: 'blob',
    });
  });

  it('preserves repricing draft and blob request contracts', () => {
    const client = mockClient();
    const domain = createRepricingApi(client);
    const payload = { previewToken: 'token' };

    domain.saveDraft(8, payload);
    domain.downloadRollback(9);

    expect(client.put).toHaveBeenCalledWith('/admin/repricing/drafts/8', payload);
    expect(client.get).toHaveBeenCalledWith('/admin/repricing/9/rollback-csv', {
      responseType: 'blob',
    });
  });

  it('preserves product builder and archive request contracts', () => {
    const client = mockClient();
    const domain = createProductsApi(client);
    const payload = { categoryCode: 'BR', weight: '2.5' };

    domain.previewPrice(payload);
    domain.save(payload);
    domain.archive('BR-001');

    expect(client.post).toHaveBeenCalledWith('/price-preview', payload);
    expect(client.post).toHaveBeenCalledWith('/save', payload);
    expect(client.post).toHaveBeenCalledWith('/delete', { skuToDelete: 'BR-001' });
  });

  it('preserves export idempotency and blob request contracts', () => {
    const client = mockClient();
    const domain = createExportsApi(client);
    const payload = { fromSku: 'BR-001', toSku: 'BR-010' };

    domain.createSnapshot(payload, 'request-id');
    domain.downloadSnapshot(14);
    domain.confirmSnapshot(14);

    expect(client.post).toHaveBeenCalledWith('/export/snapshots', payload, {
      headers: { 'Idempotency-Key': 'request-id' },
    });
    expect(client.get).toHaveBeenCalledWith('/export/snapshots/14/csv', {
      responseType: 'blob',
    });
    expect(client.post).toHaveBeenCalledWith('/export/snapshots/14/confirm');
  });
});

it('shared error extraction preserves server messages and stable fallback behavior', () => {
  expect(getApiError({ response: { data: { error: 'Server message' } } })).toBe('Server message');
  expect(getApiError(new Error('Network message'))).toBe('Network message');
  expect(getApiError(null, 'Fallback')).toBe('Fallback');
});

it('blob downloads always revoke the generated URL', () => {
  const anchor = { click: vi.fn(), remove: vi.fn() };
  const documentRef = {
    createElement: vi.fn(() => anchor),
    body: { appendChild: vi.fn() },
  };
  const urlApi = {
    createObjectURL: vi.fn(() => 'blob:download'),
    revokeObjectURL: vi.fn(),
  };

  downloadBlob(new Blob(['csv']), 'report.csv', { documentRef, urlApi });

  expect(anchor).toMatchObject({ href: 'blob:download', download: 'report.csv' });
  expect(anchor.click).toHaveBeenCalledOnce();
  expect(anchor.remove).toHaveBeenCalledOnce();
  expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:download');
});
