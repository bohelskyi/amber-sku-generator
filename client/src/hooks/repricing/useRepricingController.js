import { useCallback, useEffect, useMemo, useRef } from 'react';
import { correctionsApi } from '../../api/corrections-api';
import { repricingApi } from '../../api/repricing-api';
import { downloadBlob } from '../../lib/download';
import { formatDecimal } from '../../lib/formatters';
import { getApiError } from '../../lib/http-error';
import {
  applyManualPrices,
  canApplyRepricing,
  filterRepricingItems,
  getInvalidManualPriceIds,
  getManualOverrides,
  getRepricingSummary,
  getUnresolvedManualPriceItems,
  keepCurrentManualPrices,
  parseManualPrice,
  sortRepricingItems,
} from '../../lib/repricing';
import { useRepricingControllerState } from './useRepricingControllerState';

function getDraftUiState(state) {
  return {
    filter: state.filter,
    reviewFilter: state.reviewFilter,
    scenarioFilter: state.scenarioFilter,
    search: state.search,
    sort: state.sort,
  };
}

function getDraftPayload(state) {
  return {
    scope: state.preview.scope || 'scenario',
    scenarioId: state.preview.scenario?.id || null,
    manualOverrides: getManualOverrides(state.manualPrices),
    automaticProductIds: state.automaticProductIds,
    reviewedProductIds: state.reviewedProductIds,
    uiState: getDraftUiState(state),
  };
}

function normalizeDraftPayload(data) {
  const draft = data.draft;
  return {
    automaticProductIds: data.automaticProductIds || draft?.automaticProductIds || [],
    conflicts: data.conflicts || [],
    draft,
    manualPrices: Object.fromEntries(
      (data.manualOverrides || draft?.manualOverrides || []).map((item) => (
        [item.productId, formatDecimal(item.newPriceUah)]
      ))
    ),
    preview: data.preview,
    reviewedProductIds: draft?.reviewedProductIds || [],
    sync: data.sync || null,
    uiState: draft?.uiState || {},
  };
}

export function useRepricingController() {
  const [state, dispatch] = useRepricingControllerState();
  const stateRef = useRef(state);
  const activeDraftRef = useRef(state.activeDraft);
  const mountedRef = useRef(true);
  const workflowGenerationRef = useRef(0);
  const saveQueueRef = useRef(Promise.resolve());
  const lastQueuedSaveSignatureRef = useRef(null);
  const applyInFlightRef = useRef(false);
  const rollbackInFlightRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
    activeDraftRef.current = state.activeDraft;
  }, [state]);

  const patch = useCallback((value) => dispatch({ type: 'patch', value }), [dispatch]);
  const edit = useCallback(
    (field, value) => dispatch({ type: 'edit', field, value }),
    [dispatch]
  );
  const isCurrentWorkflow = useCallback(
    (generation) => mountedRef.current && workflowGenerationRef.current === generation,
    []
  );

  const loadBatches = useCallback(async () => {
    const response = await repricingApi.listBatches();
    if (mountedRef.current) patch({ batches: response.data || [] });
    return response.data || [];
  }, [patch]);

  const loadDrafts = useCallback(async () => {
    const response = await repricingApi.listDrafts();
    if (mountedRef.current) patch({ drafts: response.data || [] });
    return response.data || [];
  }, [patch]);

  useEffect(() => {
    mountedRef.current = true;
    Promise.all([
      repricingApi.getPublicConfig(),
      repricingApi.listScenarios(),
      repricingApi.listBatches(),
      repricingApi.listDrafts(),
      correctionsApi.listRequests('active'),
    ])
      .then(([
        configResponse,
        scenariosResponse,
        batchesResponse,
        draftsResponse,
        correctionRequestsResponse,
      ]) => {
        if (!mountedRef.current) return;
        const scenarios = scenariosResponse.data || [];
        const drafts = draftsResponse.data || [];
        const preferredScenario = scenarios.find((item) => item.price_mode === 'fixed_uah');
        patch({
          batches: batchesResponse.data || [],
          config: configResponse.data,
          correctionRequests: correctionRequestsResponse.data.items || [],
          drafts,
          scenarioId: String(
            drafts[0]?.scenarioId || preferredScenario?.id || scenarios[0]?.id || ''
          ),
          scenarios,
        });
      })
      .catch((error) => {
        if (mountedRef.current) patch({ error: getApiError(error) });
      })
      .finally(() => {
        if (mountedRef.current) patch({ loading: false });
      });
    return () => {
      mountedRef.current = false;
      workflowGenerationRef.current += 1;
    };
  }, [patch]);

  const selectedScenario = state.scenarios.find(
    (item) => Number(item.id) === Number(state.scenarioId)
  );
  const selectedDraft = state.drafts.find(
    (item) => item.scope !== 'global' && Number(item.scenarioId) === Number(state.scenarioId)
  );
  const globalDraft = state.drafts.find((item) => item.scope === 'global');

  const activeCorrectionRequestByProductId = useMemo(
    () => new Map(state.correctionRequests.map(
      (request) => [Number(request.sourceProductId), request]
    )),
    [state.correctionRequests]
  );
  const blockingCorrectionRequests = useMemo(() => {
    if (!state.preview) return [];
    const candidateProductIds = new Set(
      (state.preview.items || []).map((item) => Number(item.productId))
    );
    const requestsById = new Map();
    for (const request of state.preview.blockingCorrectionRequests || []) {
      requestsById.set(Number(request.id), request);
    }
    for (const request of state.correctionRequests) {
      if (candidateProductIds.has(Number(request.sourceProductId))) {
        requestsById.set(Number(request.id), request);
      }
    }
    return [...requestsById.values()]
      .sort((first, second) => Number(first.id) - Number(second.id));
  }, [state.correctionRequests, state.preview]);
  const effectiveItems = useMemo(
    () => applyManualPrices(
      state.preview?.items || [],
      state.manualPrices,
      state.automaticProductIds
    ),
    [state.automaticProductIds, state.manualPrices, state.preview]
  );
  const effectiveSummary = useMemo(
    () => getRepricingSummary(state.preview?.summary || {}, effectiveItems),
    [effectiveItems, state.preview]
  );
  const currentCalculationRate = useMemo(() => {
    const item = (state.preview?.items || []).find((previewItem) => (
      previewItem.pricingChange?.newPriceMode === 'per_gram_usd'
      && previewItem.pricingChange?.newUahRate !== null
      && previewItem.pricingChange?.newUahRate !== undefined
    ));
    return item?.pricingChange?.newUahRate ?? null;
  }, [state.preview]);
  const manualOverrides = useMemo(
    () => getManualOverrides(state.manualPrices),
    [state.manualPrices]
  );
  const invalidManualPriceIds = useMemo(
    () => new Set(getInvalidManualPriceIds(state.manualPrices)),
    [state.manualPrices]
  );
  const unresolvedManualPriceItems = useMemo(() => (
    state.preview?.scope === 'global'
      ? getUnresolvedManualPriceItems(
          state.preview.items || [],
          state.manualPrices,
          state.automaticProductIds
        )
      : []
  ), [state.automaticProductIds, state.manualPrices, state.preview]);
  const canApply = canApplyRepricing({
    summary: effectiveSummary,
    invalidManualPriceCount: invalidManualPriceIds.size,
    draftConflictCount: state.draftConflicts.length,
    blockingCorrectionRequestCount: blockingCorrectionRequests.length,
    isDraftStale: Boolean(state.activeDraft && state.draftSync?.hasChanges),
  });
  const reviewedProductIdSet = useMemo(
    () => new Set(state.reviewedProductIds.map(Number)),
    [state.reviewedProductIds]
  );
  const visibleItems = useMemo(() => sortRepricingItems(
    filterRepricingItems(effectiveItems, {
      status: state.filter,
      scenarioFilter: state.scenarioFilter,
      search: state.search,
      reviewFilter: state.reviewFilter,
      reviewedProductIds: state.reviewedProductIds,
    }),
    state.sort
  ), [
    effectiveItems,
    state.filter,
    state.reviewFilter,
    state.reviewedProductIds,
    state.scenarioFilter,
    state.search,
    state.sort,
  ]);
  const previewScenarios = useMemo(() => {
    if (state.preview?.scope !== 'global') return [];
    const byId = new Map();
    let hasMissingScenario = false;
    for (const item of state.preview.items || []) {
      if (item.scenarioId === null || item.scenarioId === undefined) {
        hasMissingScenario = true;
      } else if (!byId.has(Number(item.scenarioId))) {
        byId.set(Number(item.scenarioId), {
          id: Number(item.scenarioId),
          name: item.scenarioName || item.matrixName || `#${item.scenarioId}`,
          categoryCode: item.categoryCode,
        });
      }
    }
    const values = [...byId.values()].sort((first, second) => (
      String(first.categoryCode).localeCompare(String(second.categoryCode), 'uk')
      || String(first.name).localeCompare(String(second.name), 'uk')
    ));
    return hasMissingScenario
      ? [...values, { id: 'none', name: 'Без активної матриці', categoryCode: '' }]
      : values;
  }, [state.preview]);

  const applyDraftPayload = useCallback((data) => {
    const normalized = normalizeDraftPayload(data);
    activeDraftRef.current = normalized.draft;
    dispatch({ type: 'draftPayloadLoaded', ...normalized });
  }, [dispatch]);

  const selectScenario = useCallback((scenarioId) => {
    workflowGenerationRef.current += 1;
    activeDraftRef.current = null;
    lastQueuedSaveSignatureRef.current = null;
    dispatch({ type: 'scenarioSelected', scenarioId });
  }, [dispatch]);

  const beginWorkflow = useCallback(({ reset = true } = {}) => {
    workflowGenerationRef.current += 1;
    lastQueuedSaveSignatureRef.current = null;
    if (reset) {
      activeDraftRef.current = null;
      dispatch({ type: 'workflowStarted' });
    } else {
      patch({ appliedBatch: null, error: '', previewing: true });
    }
    return workflowGenerationRef.current;
  }, [dispatch, patch]);

  const openDraft = useCallback(async (draftId) => {
    if (!draftId || stateRef.current.previewing) return;
    const generation = beginWorkflow({ reset: false });
    try {
      const response = await repricingApi.getDraft(draftId);
      if (isCurrentWorkflow(generation)) applyDraftPayload(response.data);
    } catch (error) {
      if (isCurrentWorkflow(generation)) patch({ error: getApiError(error) });
    } finally {
      if (isCurrentWorkflow(generation)) patch({ previewing: false });
    }
  }, [applyDraftPayload, beginWorkflow, isCurrentWorkflow, patch]);

  const buildPreview = useCallback(async (scope) => {
    const current = stateRef.current;
    if (current.previewing || (scope === 'scenario' && !current.scenarioId)) return;
    const generation = beginWorkflow();
    try {
      const response = scope === 'global'
        ? await repricingApi.previewGlobal()
        : await repricingApi.previewScenario(Number(current.scenarioId));
      if (isCurrentWorkflow(generation)) {
        dispatch({ type: 'previewLoaded', preview: response.data });
      }
    } catch (error) {
      if (isCurrentWorkflow(generation)) patch({ error: getApiError(error) });
    } finally {
      if (isCurrentWorkflow(generation)) patch({ previewing: false });
    }
  }, [beginWorkflow, dispatch, isCurrentWorkflow, patch]);

  const openSelectedRepricing = useCallback(() => {
    if (selectedDraft) openDraft(selectedDraft.id);
    else buildPreview('scenario');
  }, [buildPreview, openDraft, selectedDraft]);

  const openGlobalRepricing = useCallback(() => {
    if (globalDraft) openDraft(globalDraft.id);
    else buildPreview('global');
  }, [buildPreview, globalDraft, openDraft]);

  const saveDraft = useCallback(({ automatic = false, snapshot = stateRef.current } = {}) => {
    if (!snapshot.preview || getInvalidManualPriceIds(snapshot.manualPrices).length > 0) {
      return Promise.resolve(null);
    }
    const generation = workflowGenerationRef.current;
    const payload = getDraftPayload(snapshot);
    const signature = `${generation}:${JSON.stringify(payload)}`;
    if (automatic && lastQueuedSaveSignatureRef.current === signature) {
      return saveQueueRef.current;
    }
    lastQueuedSaveSignatureRef.current = signature;
    if (isCurrentWorkflow(generation)) patch({ draftSaveState: 'saving' });

    const request = saveQueueRef.current
      .catch(() => null)
      .then(async () => {
        if (!isCurrentWorkflow(generation)) return null;
        const draft = activeDraftRef.current;
        try {
          const response = draft
            ? await repricingApi.saveDraft(draft.id, payload)
            : await repricingApi.createDraft(payload);
          const nextDraft = response.data.draft;
          if (isCurrentWorkflow(generation)) {
            activeDraftRef.current = nextDraft;
            patch({
              activeDraft: nextDraft,
              ...(response.data.preview ? {
                draftConflicts: response.data.conflicts || [],
                draftSync: response.data.sync || null,
              } : {}),
              draftSaveState: 'saved',
            });
            await loadDrafts();
          }
          return nextDraft;
        } catch (error) {
          if (lastQueuedSaveSignatureRef.current === signature) {
            lastQueuedSaveSignatureRef.current = null;
          }
          if (isCurrentWorkflow(generation)) {
            patch({
              draftSaveState: 'error',
              ...(!automatic ? { error: getApiError(error) } : {}),
            });
          }
          throw error;
        }
      });
    saveQueueRef.current = request;
    return request;
  }, [isCurrentWorkflow, loadDrafts, patch]);

  useEffect(() => {
    if (!state.preview || invalidManualPriceIds.size > 0) return undefined;
    if (state.draftConflicts.length > 0) return undefined;
    if (
      !state.activeDraft?.id
      && manualOverrides.length === 0
      && state.automaticProductIds.length === 0
      && state.reviewedProductIds.length === 0
    ) {
      return undefined;
    }
    const snapshot = {
      automaticProductIds: state.automaticProductIds,
      filter: state.filter,
      manualPrices: state.manualPrices,
      preview: state.preview,
      reviewFilter: state.reviewFilter,
      reviewedProductIds: state.reviewedProductIds,
      scenarioFilter: state.scenarioFilter,
      search: state.search,
      sort: state.sort,
    };
    const timeoutId = window.setTimeout(() => {
      saveDraft({ automatic: true, snapshot }).catch(() => {});
    }, 800);
    return () => window.clearTimeout(timeoutId);
  }, [
    invalidManualPriceIds.size,
    manualOverrides.length,
    saveDraft,
    state.activeDraft?.id,
    state.automaticProductIds,
    state.draftConflicts.length,
    state.filter,
    state.manualPrices,
    state.preview,
    state.reviewFilter,
    state.reviewedProductIds,
    state.scenarioFilter,
    state.search,
    state.sort,
  ]);

  const syncDraft = useCallback(async () => {
    const current = stateRef.current;
    if (!current.activeDraft || current.previewing) return;
    if (getInvalidManualPriceIds(current.manualPrices).length > 0) {
      patch({ error: 'Виправте некоректну ручну ціну перед оновленням чернетки.' });
      return;
    }
    if (current.draftConflicts.length > 0) {
      patch({ error: 'Спочатку вирішіть конфлікти ручних цін у чернетці.' });
      return;
    }
    const generation = workflowGenerationRef.current;
    patch({ error: '', previewing: true });
    try {
      const savedDraft = await saveDraft({ snapshot: current });
      if (!savedDraft || !isCurrentWorkflow(generation)) return;
      const response = await repricingApi.syncDraft(savedDraft.id);
      if (isCurrentWorkflow(generation)) applyDraftPayload(response.data);
    } catch (error) {
      if (isCurrentWorkflow(generation)) patch({ error: getApiError(error) });
    } finally {
      if (isCurrentWorkflow(generation)) patch({ previewing: false });
    }
  }, [applyDraftPayload, isCurrentWorkflow, patch, saveDraft]);

  const setManualPrice = useCallback((productId, value) => {
    dispatch({ type: 'manualPriceChanged', productId, value });
  }, [dispatch]);

  const resetManualPrice = useCallback((productId) => {
    dispatch({ type: 'manualPriceChanged', productId, value: undefined });
  }, [dispatch]);

  const keepCurrentManualPrice = useCallback((productId, priceUah) => {
    dispatch({
      type: 'manualPriceChanged',
      productId,
      value: formatDecimal(priceUah),
    });
    dispatch({ type: 'reviewMarked', productId });
  }, [dispatch]);

  const selectAutomaticPrice = useCallback((productId) => {
    dispatch({ type: 'automaticPriceSelected', productId });
  }, [dispatch]);

  const toggleReviewed = useCallback((productId) => {
    dispatch({ type: 'reviewToggled', productId });
  }, [dispatch]);

  const keepAllCurrentManualPrices = useCallback(() => {
    const current = stateRef.current;
    const next = keepCurrentManualPrices(
      current.preview?.items || [],
      current.manualPrices,
      current.reviewedProductIds,
      current.automaticProductIds
    );
    patch({
      automaticProductIds: next.automaticProductIds,
      manualPrices: next.manualPrices,
      reviewedProductIds: next.reviewedProductIds,
    });
  }, [patch]);

  const removeDraftConflicts = useCallback(() => {
    dispatch({ type: 'draftConflictsRemoved' });
  }, [dispatch]);

  const handleSort = useCallback((key) => {
    edit('sort', (sort) => ({
      key,
      direction: sort.key === key && sort.direction === 'asc' ? 'desc' : 'asc',
    }));
  }, [edit]);

  const handleManualPriceBlur = useCallback((productId, value, hasAutomaticResolution) => {
    if (hasAutomaticResolution) return;
    const normalizedPrice = parseManualPrice(value);
    if (normalizedPrice !== null) setManualPrice(productId, String(normalizedPrice));
  }, [setManualPrice]);

  const handleRecountApplied = useCallback(async ({ result }) => {
    const current = stateRef.current;
    if (!current.preview || current.previewing) return;
    const sourceProductId = Number(
      result?.source?.productId || current.recountTarget?.productId || 0
    );
    const nextState = {
      ...current,
      automaticProductIds: current.automaticProductIds
        .filter((productId) => Number(productId) !== sourceProductId),
      manualPrices: Object.fromEntries(
        Object.entries(current.manualPrices)
          .filter(([productId]) => Number(productId) !== sourceProductId)
      ),
      reviewedProductIds: current.reviewedProductIds
        .filter((productId) => Number(productId) !== sourceProductId),
    };
    const generation = workflowGenerationRef.current;
    patch({
      automaticProductIds: nextState.automaticProductIds,
      error: '',
      manualPrices: nextState.manualPrices,
      previewing: true,
      reviewedProductIds: nextState.reviewedProductIds,
    });
    try {
      if (current.activeDraft) {
        const savedDraft = await saveDraft({ snapshot: nextState });
        if (!savedDraft || !isCurrentWorkflow(generation)) return;
        const response = await repricingApi.syncDraft(savedDraft.id);
        if (!isCurrentWorkflow(generation)) return;
        applyDraftPayload(response.data);
        await loadDrafts();
      } else {
        const response = current.preview.scope === 'global'
          ? await repricingApi.previewGlobal()
          : await repricingApi.previewScenario(current.preview.scenario.id);
        if (isCurrentWorkflow(generation)) patch({ preview: response.data });
      }
    } catch (error) {
      if (isCurrentWorkflow(generation)) {
        patch({ error: `Переоблік виконано, але список не оновлено: ${getApiError(error)}` });
      }
    } finally {
      if (isCurrentWorkflow(generation)) patch({ previewing: false });
    }
  }, [applyDraftPayload, isCurrentWorkflow, loadDrafts, patch, saveDraft]);

  const handleCorrectionRequestCreated = useCallback(({ request }) => {
    dispatch({ type: 'correctionCreated', request });
  }, [dispatch]);

  const discardDraft = useCallback(async () => {
    const current = stateRef.current;
    if (!current.activeDraft || current.discardingDraft) return;
    const generation = workflowGenerationRef.current;
    patch({ discardingDraft: true, error: '' });
    try {
      await repricingApi.discardDraft(current.activeDraft.id);
      if (!isCurrentWorkflow(generation)) return;
      activeDraftRef.current = null;
      lastQueuedSaveSignatureRef.current = null;
      dispatch({ type: 'workflowCleared' });
      patch({ discardDraftOpen: false });
      await loadDrafts();
    } catch (error) {
      if (isCurrentWorkflow(generation)) patch({ error: getApiError(error) });
    } finally {
      if (isCurrentWorkflow(generation)) patch({ discardingDraft: false });
    }
  }, [dispatch, isCurrentWorkflow, loadDrafts, patch]);

  const applyPreview = useCallback(async () => {
    const current = stateRef.current;
    if (!current.preview || current.applying || applyInFlightRef.current) return;
    applyInFlightRef.current = true;
    const generation = workflowGenerationRef.current;
    patch({ applying: true, error: '' });
    try {
      let draftForApply = current.activeDraft;
      if (current.activeDraft) draftForApply = await saveDraft({ snapshot: current });
      if (!isCurrentWorkflow(generation)) return;
      const applyRequest = current.preview.scope === 'global'
        ? repricingApi.applyGlobal
        : repricingApi.applyScenario;
      const response = await applyRequest({
        scenarioId: current.preview.scenario?.id || null,
        previewToken: current.preview.previewToken,
        manualOverrides: getManualOverrides(current.manualPrices),
        automaticProductIds: current.automaticProductIds,
        draftId: draftForApply?.id || null,
      });
      if (!isCurrentWorkflow(generation)) return;
      activeDraftRef.current = null;
      lastQueuedSaveSignatureRef.current = null;
      dispatch({ type: 'workflowCleared' });
      patch({ appliedBatch: response.data.batch, confirmOpen: false });
      await Promise.all([loadBatches(), loadDrafts()]);
    } catch (error) {
      if (isCurrentWorkflow(generation)) {
        patch({ confirmOpen: false, error: getApiError(error) });
      }
    } finally {
      applyInFlightRef.current = false;
      if (isCurrentWorkflow(generation)) patch({ applying: false });
    }
  }, [dispatch, isCurrentWorkflow, loadBatches, loadDrafts, patch, saveDraft]);

  const downloadBatch = useCallback((batchId) => {
    repricingApi.downloadBatch(batchId)
      .then((response) => downloadBlob(response.data, `amber-repricing-${batchId}.csv`))
      .catch((error) => patch({ error: getApiError(error) }));
  }, [patch]);

  const downloadRollbackBatch = useCallback((batchId) => {
    repricingApi.downloadRollback(batchId)
      .then((response) => downloadBlob(
        response.data,
        `amber-repricing-rollback-${batchId}.csv`
      ))
      .catch((error) => patch({ error: getApiError(error) }));
  }, [patch]);

  const rollbackBatch = useCallback(async () => {
    const current = stateRef.current;
    if (!current.rollbackTarget || current.rollingBack || rollbackInFlightRef.current) return;
    rollbackInFlightRef.current = true;
    patch({ error: '', rollingBack: true });
    try {
      const response = await repricingApi.rollback(current.rollbackTarget.id);
      patch({
        appliedBatch: null,
        rollbackResult: response.data.batch,
        rollbackTarget: null,
      });
      await loadBatches();
    } catch (error) {
      patch({ error: getApiError(error), rollbackTarget: null });
    } finally {
      rollbackInFlightRef.current = false;
      patch({ rollingBack: false });
    }
  }, [loadBatches, patch]);

  return {
    ...state,
    activeCorrectionRequestByProductId,
    applyPreview,
    blockingCorrectionRequests,
    canApply,
    currentCalculationRate,
    discardDraft,
    downloadBatch,
    downloadRollbackBatch,
    effectiveSummary,
    globalDraft,
    handleCorrectionRequestCreated,
    handleManualPriceBlur,
    handleRecountApplied,
    handleSort,
    invalidManualPriceIds,
    keepAllCurrentManualPrices,
    keepCurrentManualPrice,
    manualOverrides,
    openGlobalRepricing,
    openSelectedRepricing,
    previewScenarios,
    removeDraftConflicts,
    resetManualPrice,
    reviewedProductIdSet,
    rollbackBatch,
    saveDraft,
    selectAutomaticPrice,
    selectedDraft,
    selectedScenario,
    selectScenario,
    setConfirmOpen: (value) => edit('confirmOpen', value),
    setDiscardDraftOpen: (value) => edit('discardDraftOpen', value),
    setFilter: (value) => edit('filter', value),
    setRecountTarget: (value) => edit('recountTarget', value),
    setReviewFilter: (value) => edit('reviewFilter', value),
    setRollbackTarget: (value) => edit('rollbackTarget', value),
    setScenarioFilter: (value) => edit('scenarioFilter', value),
    setSearch: (value) => edit('search', value),
    setManualPrice,
    syncDraft,
    toggleReviewed,
    unresolvedManualPriceItems,
    visibleItems,
  };
}
