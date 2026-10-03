import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAdminPricingController } from '../src/hooks/admin/useAdminPricingController.js';
import { api } from '../src/lib/api.js';

const categoryA = { code: 'BR', name: 'Браслети' };
const categoryB = { code: 'NM', name: 'Намиста' };
const response = (data) => ({ data });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const renderController = (category, onFeedback = vi.fn()) => renderHook(
  ({ selectedCat }) => useAdminPricingController({
    canViewPricing: true,
    formatMatchJson: JSON.stringify,
    onFeedback,
    selectedCat,
  }),
  { initialProps: { selectedCat: category } }
);

afterEach(() => vi.restoreAllMocks());

it('does not let a late matrix save from the previous category replace the active category data', async () => {
  const saved = deferred();
  const get = vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/prices/BR') return response({ category: 'BR', scenarios: [], modifiers: [] });
    if (url === '/admin/prices/NM') return response({ category: 'NM', scenarios: [], modifiers: [] });
    throw new Error(`Unexpected GET ${url}`);
  });
  vi.spyOn(api, 'post').mockReturnValue(saved.promise);
  const controller = renderController(categoryA);

  act(() => controller.result.current.selectCategory(categoryA));
  await waitFor(() => expect(controller.result.current.pricesData?.category).toBe('BR'));
  let savePromise;
  act(() => { savePromise = controller.result.current.handlePriceChange(11, 'round', 'base', '1250'); });

  controller.rerender({ selectedCat: categoryB });
  act(() => controller.result.current.selectCategory(categoryB));
  await waitFor(() => expect(controller.result.current.pricesData?.category).toBe('NM'));

  await act(async () => {
    saved.resolve(response({ success: true }));
    await savePromise;
  });
  expect(controller.result.current.pricesData?.category).toBe('NM');
  expect(get.mock.calls.filter(([url]) => url === '/admin/prices/BR')).toHaveLength(1);
});

it('reports a successful cell write separately when the following refresh fails', async () => {
  const onFeedback = vi.fn();
  vi.spyOn(api, 'post').mockResolvedValue(response({ success: true }));
  vi.spyOn(api, 'get').mockRejectedValue(new Error('refresh unavailable'));
  const controller = renderController(categoryA, onFeedback);

  await act(async () => {
    await controller.result.current.handlePriceChange(11, 'round', 'base', '1250');
  });

  expect(controller.result.current.matrixCellSaveStates['11:round:base']).toEqual({
    state: 'saved',
    message: 'Збережено; оновіть дані',
  });
  expect(onFeedback).toHaveBeenCalledWith({
    tone: 'warning',
    title: 'Ціну збережено, але дані не оновлено',
    message: 'refresh unavailable',
  });
});

it('exposes a category read error and can retry without an unhandled rejection', async () => {
  const get = vi.spyOn(api, 'get')
    .mockRejectedValueOnce(new Error('prices unavailable'))
    .mockResolvedValueOnce(response({ category: 'BR', scenarios: [], modifiers: [] }));
  const controller = renderController(categoryA);

  act(() => controller.result.current.selectCategory(categoryA));
  await waitFor(() => expect(controller.result.current.pricesError).toBe('prices unavailable'));
  expect(controller.result.current.pricesData).toBeNull();

  await act(async () => {
    await controller.result.current.retryPrices();
  });
  await waitFor(() => expect(controller.result.current.pricesData?.category).toBe('BR'));
  expect(controller.result.current.pricesError).toBe('');
  expect(get).toHaveBeenCalledTimes(2);
});

it('does not report successful scenario and modifier writes as failed when refresh fails', async () => {
  const onFeedback = vi.fn();
  vi.spyOn(api, 'get').mockRejectedValue(new Error('refresh unavailable'));
  vi.spyOn(api, 'post').mockResolvedValue(response({ success: true }));
  vi.spyOn(api, 'put').mockResolvedValue(response({ success: true }));
  const controller = renderController(categoryA, onFeedback);

  await act(async () => {
    await controller.result.current.duplicateScenario(12);
    await controller.result.current.updateModifier({ id: 9, match_json: {}, factor: 1.1 });
  });

  expect(onFeedback).toHaveBeenCalledWith({
    tone: 'warning',
    title: 'Сценарій продубльовано, але дані не оновлено',
    message: 'refresh unavailable',
  });
  expect(onFeedback).toHaveBeenCalledWith({
    tone: 'warning',
    title: 'Модифікатор збережено, але дані не оновлено',
    message: 'refresh unavailable',
  });
  expect(onFeedback.mock.calls.some(([entry]) => entry.tone === 'error')).toBe(false);
});

it('does not let an A to B to A selection cycle apply a late scenario command refresh', async () => {
  const saved = deferred();
  const scenario = {
    id: 12, name: 'Base', group_name: '', match_json: {}, axis_x_key: 'weight', axis_y_key: null,
    priority: 0, status: 'active', price_mode: 'fixed_uah', apply_modifiers: true, weight_bands: [],
  };
  const get = vi.spyOn(api, 'get').mockImplementation(async (url) => response({
    category: url.endsWith('/NM') ? 'NM' : 'BR',
    scenarios: url.endsWith('/NM') ? [] : [scenario],
    modifiers: [],
  }));
  vi.spyOn(api, 'put').mockReturnValue(saved.promise);
  const controller = renderController(categoryA);

  act(() => controller.result.current.selectCategory(categoryA));
  await waitFor(() => expect(controller.result.current.pricesData?.category).toBe('BR'));
  act(() => controller.result.current.beginScenarioEdit(scenario));
  await waitFor(() => expect(controller.result.current.editScenario?.id).toBe(12));
  let savePromise;
  act(() => { savePromise = controller.result.current.updateScenario(); });

  controller.rerender({ selectedCat: categoryB });
  act(() => controller.result.current.selectCategory(categoryB));
  controller.rerender({ selectedCat: categoryA });
  act(() => controller.result.current.selectCategory(categoryA));
  await waitFor(() => expect(controller.result.current.pricesData?.category).toBe('BR'));

  await act(async () => {
    saved.resolve(response({ success: true }));
    await savePromise;
  });
  expect(controller.result.current.editScenario).toBeNull();
  expect(get.mock.calls.filter(([url]) => url === '/admin/prices/BR')).toHaveLength(2);
});

it('does not clear a new-category scenario draft when an earlier create finishes late', async () => {
  const created = deferred();
  vi.spyOn(api, 'post').mockReturnValue(created.promise);
  vi.spyOn(api, 'get').mockResolvedValue(response({ category: 'NM', scenarios: [], modifiers: [] }));
  const controller = renderController(categoryA);

  act(() => controller.result.current.setNewScenario((current) => ({
    ...current, name: 'Scenario A', axis_x_key: 'size', match_json: '{}',
  })));
  let createPromise;
  act(() => { createPromise = controller.result.current.addScenario(); });
  act(() => controller.result.current.discardLocalChanges());
  controller.rerender({ selectedCat: categoryB });
  act(() => controller.result.current.selectCategory(categoryB));
  act(() => controller.result.current.setNewScenario((current) => ({
    ...current, name: 'Scenario B', axis_x_key: 'weight', match_json: '{}',
  })));

  await act(async () => {
    created.resolve(response({ success: true }));
    await createPromise;
  });
  expect(controller.result.current.newScenario.name).toBe('Scenario B');
  expect(controller.result.current.newScenario.axis_x_key).toBe('weight');
});

it('does not clear later modifier drafts or cell state after old-category commands settle', async () => {
  const modifierSaved = deferred();
  const modifierCreated = deferred();
  const cellSaved = deferred();
  vi.spyOn(api, 'put').mockReturnValue(modifierSaved.promise);
  vi.spyOn(api, 'post').mockImplementation((url) => {
    if (url === '/admin/price-cell') return cellSaved.promise;
    if (url === '/admin/modifier') return modifierCreated.promise;
    return Promise.resolve(response({ success: true }));
  });
  vi.spyOn(api, 'get').mockResolvedValue(response({ category: 'NM', scenarios: [], modifiers: [] }));
  const controller = renderController(categoryA);

  act(() => controller.result.current.beginModifierEdit({ id: 9, match_json: { material: 'gold' }, factor: 1.1 }));
  act(() => controller.result.current.setNewModifier({ match_json: '{"material":"gold"}', factor: '1.1' }));
  let modifierPromise;
  let createPromise;
  let cellPromise;
  act(() => {
    modifierPromise = controller.result.current.saveModifierEdit();
    createPromise = controller.result.current.addModifier();
    cellPromise = controller.result.current.handlePriceChange(11, 'round', 'base', '1250');
  });
  act(() => controller.result.current.discardLocalChanges());
  controller.rerender({ selectedCat: categoryB });
  act(() => controller.result.current.selectCategory(categoryB));
  act(() => controller.result.current.beginModifierEdit({ id: 10, match_json: { material: 'silver' }, factor: 1.2 }));
  act(() => controller.result.current.setNewModifier({ match_json: '{"material":"silver"}', factor: '1.2' }));

  await act(async () => {
    modifierSaved.resolve(response({ success: true }));
    modifierCreated.resolve(response({ success: true }));
    cellSaved.resolve(response({ success: true }));
    await Promise.all([modifierPromise, createPromise, cellPromise]);
  });
  expect(controller.result.current.editModifier?.id).toBe(10);
  expect(controller.result.current.newModifier.match_json).toBe('{"material":"silver"}');
  expect(controller.result.current.matrixCellSaveStates).toEqual({});
});
