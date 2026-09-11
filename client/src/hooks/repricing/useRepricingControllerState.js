import { useMemo, useReducer } from 'react';

export const initialRepricingControllerState = Object.freeze({
  activeDraft: null,
  automaticProductIds: [],
  draftConflicts: [],
  draftSaveState: 'idle',
  draftSync: null,
  filter: 'changed',
  manualPrices: {},
  preview: null,
  reviewFilter: 'all',
  reviewedProductIds: [],
  scenarioFilter: 'all',
  search: '',
  sort: { key: 'sku', direction: 'asc' },
});

export function repricingControllerReducer(state, action) {
  if (action.type !== 'set' || !(action.field in initialRepricingControllerState)) {
    return state;
  }

  const nextValue = typeof action.value === 'function'
    ? action.value(state[action.field])
    : action.value;
  if (Object.is(nextValue, state[action.field])) return state;
  return { ...state, [action.field]: nextValue };
}

export function useRepricingControllerState() {
  const [state, dispatch] = useReducer(
    repricingControllerReducer,
    initialRepricingControllerState
  );

  const setters = useMemo(() => Object.fromEntries(
    Object.keys(initialRepricingControllerState).map((field) => {
      const setterName = `set${field[0].toUpperCase()}${field.slice(1)}`;
      return [setterName, (value) => dispatch({ type: 'set', field, value })];
    })
  ), []);

  return { ...state, ...setters };
}
