import { useReducer } from 'react';

export const initialRepricingControllerState = Object.freeze({
  activeDraft: null,
  appliedBatch: null,
  applying: false,
  automaticProductIds: [],
  batches: [],
  config: null,
  confirmOpen: false,
  correctionRequests: [],
  createdCorrectionRequest: null,
  discardDraftOpen: false,
  discardingDraft: false,
  draftConflicts: [],
  drafts: [],
  draftSaveState: 'idle',
  draftSync: null,
  error: '',
  filter: 'changed',
  loading: true,
  manualPrices: {},
  preview: null,
  previewing: false,
  recountTarget: null,
  reviewFilter: 'all',
  reviewedProductIds: [],
  rollbackResult: null,
  rollbackTarget: null,
  rollingBack: false,
  scenarioFilter: 'all',
  scenarioId: '',
  scenarios: [],
  search: '',
  sort: { key: 'sku', direction: 'asc' },
});

const editableFields = new Set([
  'confirmOpen',
  'discardDraftOpen',
  'filter',
  'recountTarget',
  'reviewFilter',
  'rollbackTarget',
  'scenarioFilter',
  'search',
  'sort',
]);

const emptyWorkflow = Object.freeze({
  activeDraft: null,
  automaticProductIds: [],
  draftConflicts: [],
  draftSaveState: 'idle',
  draftSync: null,
  manualPrices: {},
  preview: null,
  reviewFilter: 'all',
  reviewedProductIds: [],
  scenarioFilter: 'all',
});

function sortedIds(ids) {
  return [...new Set(ids.map(Number))].sort((first, second) => first - second);
}

export function repricingControllerReducer(state, action) {
  switch (action.type) {
    case 'patch':
      return { ...state, ...action.value };
    case 'edit': {
      if (!editableFields.has(action.field)) return state;
      const nextValue = typeof action.value === 'function'
        ? action.value(state[action.field])
        : action.value;
      return Object.is(nextValue, state[action.field])
        ? state
        : { ...state, [action.field]: nextValue };
    }
    case 'scenarioSelected':
      return {
        ...state,
        ...emptyWorkflow,
        appliedBatch: null,
        previewing: false,
        scenarioId: action.scenarioId,
      };
    case 'workflowStarted':
      return {
        ...state,
        ...emptyWorkflow,
        appliedBatch: null,
        error: '',
        previewing: true,
      };
    case 'previewLoaded':
      return {
        ...state,
        preview: action.preview,
        filter: action.preview.summary.errorCount > 0 ? 'error' : 'changed',
      };
    case 'draftPayloadLoaded':
      return {
        ...state,
        activeDraft: action.draft,
        automaticProductIds: action.automaticProductIds,
        draftConflicts: action.conflicts,
        draftSaveState: 'saved',
        draftSync: action.sync,
        filter: action.uiState.filter
          || (action.preview?.summary?.errorCount > 0 ? 'error' : 'changed'),
        manualPrices: action.manualPrices,
        preview: action.preview || state.preview,
        reviewFilter: action.uiState.reviewFilter || 'all',
        reviewedProductIds: action.reviewedProductIds,
        scenarioFilter: action.uiState.scenarioFilter || 'all',
        search: action.uiState.search || '',
        sort: action.uiState.sort || { key: 'sku', direction: 'asc' },
      };
    case 'manualPriceChanged': {
      const automaticProductIds = state.automaticProductIds
        .filter((item) => Number(item) !== Number(action.productId));
      const manualPrices = { ...state.manualPrices };
      if (action.value === undefined) delete manualPrices[action.productId];
      else manualPrices[action.productId] = action.value;
      return { ...state, automaticProductIds, manualPrices };
    }
    case 'automaticPriceSelected':
      return {
        ...state,
        automaticProductIds: sortedIds([...state.automaticProductIds, action.productId]),
        manualPrices: Object.fromEntries(
          Object.entries(state.manualPrices)
            .filter(([productId]) => Number(productId) !== Number(action.productId))
        ),
        reviewedProductIds: sortedIds([...state.reviewedProductIds, action.productId]),
      };
    case 'reviewMarked':
      return {
        ...state,
        reviewedProductIds: sortedIds([...state.reviewedProductIds, action.productId]),
      };
    case 'reviewToggled': {
      const productId = Number(action.productId);
      const reviewedProductIds = state.reviewedProductIds.includes(productId)
        ? state.reviewedProductIds.filter((item) => item !== productId)
        : sortedIds([...state.reviewedProductIds, productId]);
      return { ...state, reviewedProductIds };
    }
    case 'draftConflictsRemoved': {
      const conflictIds = new Set(state.draftConflicts.map((item) => Number(item.productId)));
      return {
        ...state,
        automaticProductIds: state.automaticProductIds
          .filter((productId) => !conflictIds.has(Number(productId))),
        draftConflicts: [],
        draftSaveState: 'saving',
        manualPrices: Object.fromEntries(
          Object.entries(state.manualPrices)
            .filter(([productId]) => !conflictIds.has(Number(productId)))
        ),
      };
    }
    case 'workflowCleared':
      return { ...state, ...emptyWorkflow };
    case 'correctionCreated': {
      const request = action.request;
      return {
        ...state,
        correctionRequests: [
          request,
          ...state.correctionRequests
            .filter((item) => Number(item.id) !== Number(request.id)),
        ],
        createdCorrectionRequest: request,
        recountTarget: null,
        reviewedProductIds: sortedIds([
          ...state.reviewedProductIds,
          request.sourceProductId,
        ]),
      };
    }
    default:
      return state;
  }
}

export function useRepricingControllerState() {
  return useReducer(repricingControllerReducer, initialRepricingControllerState);
}
