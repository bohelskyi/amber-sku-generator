import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAdminSchemaController } from '../src/hooks/admin/useAdminSchemaController.js';
import { api } from '../src/lib/api.js';

const categoryA = { code: 'BR', name: 'Браслети' };
const categoryB = { code: 'NM', name: 'Намиста' };
const config = { categories: {} };
const response = (data) => ({ data });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const renderController = ({ selectedCat = categoryA, fetchConfig = vi.fn().mockResolvedValue({}), onFeedback = vi.fn() } = {}) => ({
  ...renderHook(({ category }) => useAdminSchemaController({
    canPublishSchema: true,
    canViewCatalog: true,
    config,
    fetchConfig,
    onFeedback,
    selectedCat: category,
  }), { initialProps: { category: selectedCat } }),
  fetchConfig,
  onFeedback,
});

afterEach(() => vi.restoreAllMocks());

it('ignores schema status that arrives after the operator changes category', async () => {
  const oldRead = deferred();
  vi.spyOn(api, 'get').mockImplementation((url) => {
    if (url === '/admin/sku-schema/BR') return oldRead.promise;
    if (url === '/admin/sku-schema/NM') return Promise.resolve(response({ categoryCode: 'NM', draftChanged: false }));
    throw new Error(`Unexpected GET ${url}`);
  });
  const controller = renderController();

  act(() => controller.result.current.selectSchemaCategory(categoryB));
  controller.rerender({ category: categoryB });
  await waitFor(() => expect(controller.result.current.schemaStatus?.categoryCode).toBe('NM'));
  await act(async () => oldRead.resolve(response({ categoryCode: 'BR', draftChanged: true })));
  expect(controller.result.current.schemaStatus?.categoryCode).toBe('NM');
});

it('keeps a successful publication distinct from failed follow-up reads', async () => {
  const onFeedback = vi.fn();
  const fetchConfig = vi.fn().mockRejectedValue(new Error('config refresh failed'));
  let schemaReads = 0;
  vi.spyOn(api, 'get').mockImplementation(() => {
    schemaReads += 1;
    if (schemaReads === 1) return Promise.resolve(response({ draftChanged: true, nextVersion: 2 }));
    return Promise.reject(new Error('schema refresh failed'));
  });
  vi.spyOn(api, 'post').mockResolvedValue(response({ version: 2 }));
  const controller = renderController({ fetchConfig, onFeedback });
  await waitFor(() => expect(controller.result.current.schemaStatus?.draftChanged).toBe(true));

  act(() => controller.result.current.publishSkuSchema());
  await waitFor(() => expect(controller.result.current.schemaPublishState.loading).toBe(false));

  expect(onFeedback).toHaveBeenCalledWith({ tone: 'success', title: 'Схему SKU для «Браслети» опубліковано' });
  expect(onFeedback).toHaveBeenCalledWith({
    tone: 'warning',
    title: 'Схему SKU опубліковано, але дані не оновлено',
    message: 'Оновіть сторінку перед наступною зміною.',
  });
  expect(onFeedback.mock.calls.some(([entry]) => entry.tone === 'error')).toBe(false);
});

it('keeps an in-flight publication visible after selecting another category', async () => {
  const publish = deferred();
  vi.spyOn(api, 'get').mockImplementation((url) => Promise.resolve(response({
    categoryCode: url.endsWith('/NM') ? 'NM' : 'BR',
    draftChanged: url.endsWith('/NM') ? false : true,
    nextVersion: 2,
  })));
  vi.spyOn(api, 'post').mockReturnValue(publish.promise);
  const controller = renderController();
  await waitFor(() => expect(controller.result.current.schemaStatus?.draftChanged).toBe(true));

  act(() => controller.result.current.publishSkuSchema());
  act(() => controller.result.current.selectSchemaCategory(categoryB));
  controller.rerender({ category: categoryB });

  expect(controller.result.current.schemaPublishState).toMatchObject({
    loading: true,
    categoryCode: 'BR',
    categoryName: 'Браслети',
    otherCategory: true,
  });

  await act(async () => publish.resolve(response({ version: 2 })));
  await waitFor(() => expect(controller.result.current.schemaPublishState.loading).toBe(false));
});
