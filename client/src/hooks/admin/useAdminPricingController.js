import { useRef, useState } from 'react';
import { api } from '../../lib/api';
import { buildScenarioEditorDraft, findScenarioById } from '../../lib/admin-pricing-state';
import { formatDecimal } from '../../lib/formatters';
import { getApiError } from '../../lib/http-error';
import { normalizeDecimalInput } from '../../lib/number-input';

const emptyNewScenario = {
  name: '',
  group_name: '',
  match_json: '',
  axis_x_key: '',
  axis_y_key: '',
  priority: '0',
  status: 'draft',
  price_mode: 'category_default',
  apply_modifiers: true,
  weight_bands: [],
};
const emptyNewModifier = { match_json: '', factor: '' };

const matrixCellKey = (scenarioId, xVal, yVal) => `${scenarioId}:${xVal}:${yVal}`;

export function useAdminPricingController({ canViewPricing, formatMatchJson, onFeedback, selectedCat }) {
  const [pricesData, setPricesData] = useState(null);
  const [pricesError, setPricesError] = useState('');
  const [newScenario, setNewScenario] = useState(emptyNewScenario);
  const [editScenario, setEditScenario] = useState(null);
  const [newModifier, setNewModifier] = useState(emptyNewModifier);
  const [editModifier, setEditModifier] = useState(null);
  const [matrixCellSaveStates, setMatrixCellSaveStates] = useState({});
  const pricesRequestId = useRef(0);
  const cellRequestIds = useRef(new Map());
  const categorySelectionEpoch = useRef(0);
  const activeCategoryCode = useRef(selectedCat?.code || null);
  const feedback = (tone, title, message) => onFeedback?.({ tone, title, message });

  const fetchPricesForCategory = (categoryCode, selectionEpoch = categorySelectionEpoch.current) => {
    const requestId = ++pricesRequestId.current;
    return api.get(`/admin/prices/${categoryCode}`).then((response) => {
      if (requestId === pricesRequestId.current
        && selectionEpoch === categorySelectionEpoch.current
        && activeCategoryCode.current === categoryCode) {
        setPricesData(response.data);
        setPricesError('');
      }
      return response.data;
    }).catch((error) => {
      if (requestId === pricesRequestId.current
        && selectionEpoch === categorySelectionEpoch.current
        && activeCategoryCode.current === categoryCode) setPricesError(getApiError(error));
      throw error;
    });
  };

  const fetchPrices = () => {
    if (!selectedCat) return undefined;
    return fetchPricesForCategory(selectedCat.code);
  };

  const selectCategory = (category) => {
    categorySelectionEpoch.current += 1;
    activeCategoryCode.current = category.code;
    setEditScenario(null);
    setEditModifier(null);
    setPricesData(null);
    setPricesError('');
    setMatrixCellSaveStates({});
    if (canViewPricing) fetchPricesForCategory(category.code, categorySelectionEpoch.current).catch(() => {});
  };

  const clearCategory = () => {
    categorySelectionEpoch.current += 1;
    activeCategoryCode.current = null;
    pricesRequestId.current += 1;
    setPricesData(null);
    setPricesError('');
    setEditScenario(null);
    setEditModifier(null);
    setMatrixCellSaveStates({});
  };

  const handlePriceChange = (scenarioId, xVal, yVal, newPrice) => {
    const categoryCode = selectedCat?.code;
    const selectionEpoch = categorySelectionEpoch.current;
    const normalizedPrice = normalizeDecimalInput(newPrice);
    const isBlank = normalizedPrice.trim() === '';
    if (!isBlank) {
      const parsedPrice = Number(normalizedPrice);
      if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) return Promise.resolve();
    }

    const cellKey = matrixCellKey(scenarioId, xVal, yVal);
    const requestId = (cellRequestIds.current.get(cellKey) || 0) + 1;
    cellRequestIds.current.set(cellKey, requestId);
    setMatrixCellSaveStates((current) => ({ ...current, [cellKey]: { state: 'saving', message: 'Зберігаємо…' } }));

    return api.post('/admin/price-cell', {
      scenario_id: scenarioId,
      x_val: xVal,
      y_val: yVal,
      price: isBlank ? null : normalizedPrice,
    }).catch((error) => {
      if (cellRequestIds.current.get(cellKey) === requestId
        && selectionEpoch === categorySelectionEpoch.current
        && activeCategoryCode.current === categoryCode) {
        setMatrixCellSaveStates((current) => ({ ...current, [cellKey]: { state: 'error', message: getApiError(error) } }));
      }
      throw error;
    }).then(async () => {
      if (cellRequestIds.current.get(cellKey) === requestId
        && selectionEpoch === categorySelectionEpoch.current
        && activeCategoryCode.current === categoryCode) {
        setMatrixCellSaveStates((current) => ({ ...current, [cellKey]: { state: 'saved', message: 'Збережено' } }));
      }
      if (selectionEpoch !== categorySelectionEpoch.current || activeCategoryCode.current !== categoryCode) return undefined;
      try {
        return await fetchPricesForCategory(categoryCode, selectionEpoch);
      } catch (error) {
        if (cellRequestIds.current.get(cellKey) === requestId
          && selectionEpoch === categorySelectionEpoch.current
          && activeCategoryCode.current === categoryCode) {
          setMatrixCellSaveStates((current) => ({ ...current, [cellKey]: { state: 'saved', message: 'Збережено; оновіть дані' } }));
        }
        feedback('warning', 'Ціну збережено, але дані не оновлено', getApiError(error));
        return undefined;
      }
      });
  };

  const refreshAfterWrite = async (categoryCode, successTitle, selectionEpoch) => {
    feedback('success', successTitle);
    if (selectionEpoch !== categorySelectionEpoch.current || activeCategoryCode.current !== categoryCode) return null;
    try {
      return await fetchPricesForCategory(categoryCode, selectionEpoch);
    } catch (error) {
      feedback('warning', `${successTitle}, але дані не оновлено`, getApiError(error));
      return null;
    }
  };

  const addScenario = async () => {
    if (!newScenario.name || !newScenario.axis_x_key) {
      return feedback('error', 'Сценарій не створено', 'Заповніть назву та вісь рядків матриці.');
    }

    let parsedJson;
    try {
      parsedJson = JSON.parse(newScenario.match_json || '{}');
    } catch {
      return feedback('error', 'Перевірте умову сценарію', 'Умова має бути коректним JSON.');
    }

    const categoryCode = selectedCat.code;
    const selectionEpoch = categorySelectionEpoch.current;
    try {
      await api.post('/admin/scenario', {
        ...newScenario,
        match_json: parsedJson,
        priority: Number(newScenario.priority || 0),
        category_code: categoryCode,
      });
    } catch (error) {
      feedback('error', 'Не вдалося створити сценарій', getApiError(error));
      return null;
    }
    if (selectionEpoch === categorySelectionEpoch.current && activeCategoryCode.current === categoryCode) {
      setNewScenario(emptyNewScenario);
    }
    return refreshAfterWrite(categoryCode, 'Сценарій створено', selectionEpoch);
  };

  const beginScenarioEdit = (scenario) => {
    setEditScenario(buildScenarioEditorDraft(scenario));
  };

  const updateScenario = async () => {
    if (!editScenario?.id) return undefined;
    if (!editScenario.name || !editScenario.axis_x_key) {
      return feedback('error', 'Сценарій не збережено', 'Потрібні назва сценарію та вісь рядків матриці.');
    }

    let parsedJson;
    try {
      parsedJson = JSON.parse(editScenario.match_json || '{}');
    } catch {
      return feedback('error', 'Перевірте умову сценарію', 'Умова має бути коректним JSON.');
    }

    const scenarioId = editScenario.id;
    const categoryCode = selectedCat?.code;
    const selectionEpoch = categorySelectionEpoch.current;
    try {
      await api.put('/admin/scenario', {
        id: scenarioId,
        name: editScenario.name,
        group_name: editScenario.group_name,
        match_json: parsedJson,
        axis_x_key: editScenario.axis_x_key,
        axis_y_key: editScenario.axis_y_key || null,
        priority: Number(editScenario.priority || 0),
        status: editScenario.status,
        price_mode: editScenario.price_mode,
        apply_modifiers: editScenario.apply_modifiers !== false,
        weight_bands: editScenario.weight_bands || [],
      });
    } catch (error) {
      feedback('error', 'Не вдалося зберегти сценарій', getApiError(error));
      return null;
    }
    const nextPricesData = await refreshAfterWrite(categoryCode, 'Сценарій збережено', selectionEpoch);
    if (!nextPricesData || selectionEpoch !== categorySelectionEpoch.current || activeCategoryCode.current !== categoryCode) return null;
    const savedScenario = findScenarioById(nextPricesData, scenarioId);
    setEditScenario(buildScenarioEditorDraft(savedScenario));
    return savedScenario;
  };

  const duplicateScenario = async (scenarioId) => {
    const categoryCode = selectedCat?.code;
    const selectionEpoch = categorySelectionEpoch.current;
    try {
      await api.post('/admin/scenario/duplicate', { id: scenarioId });
    } catch (error) {
      feedback('error', 'Не вдалося продублювати сценарій', getApiError(error));
      return null;
    }
    return refreshAfterWrite(categoryCode, 'Сценарій продубльовано', selectionEpoch);
  };

  const addModifier = async () => {
    if (!newModifier.match_json || !newModifier.factor) {
      return feedback('error', 'Модифікатор не створено', 'Заповніть умову та множник.');
    }

    let parsedJson;
    try {
      parsedJson = JSON.parse(newModifier.match_json || '{}');
    } catch {
      return feedback('error', 'Перевірте умову модифікатора', 'Умова має бути коректним JSON.');
    }

    const categoryCode = selectedCat.code;
    const selectionEpoch = categorySelectionEpoch.current;
    try {
      await api.post('/admin/modifier', {
        ...newModifier,
        match_json: parsedJson,
        category_code: categoryCode,
      });
    } catch (error) {
      feedback('error', 'Не вдалося створити модифікатор', getApiError(error));
      return null;
    }
    if (selectionEpoch === categorySelectionEpoch.current && activeCategoryCode.current === categoryCode) {
      setNewModifier(emptyNewModifier);
    }
    return refreshAfterWrite(categoryCode, 'Модифікатор створено', selectionEpoch);
  };

  const beginModifierEdit = (modifier) => {
    setEditModifier({
      id: modifier.id,
      match_json: formatMatchJson(
        modifier.match_json || (modifier.trigger_key ? { [modifier.trigger_key]: modifier.trigger_val } : {})
      ),
      factor: formatDecimal(modifier.factor),
    });
  };

  const updateModifier = async (payloadOrId, newFactor) => {
    const payload = typeof payloadOrId === 'object'
      ? payloadOrId
      : { id: payloadOrId, factor: parseFloat(newFactor) };

    const categoryCode = selectedCat?.code;
    const selectionEpoch = categorySelectionEpoch.current;
    try {
      await api.put('/admin/modifier', payload);
    } catch (error) {
      feedback('error', 'Не вдалося зберегти модифікатор', getApiError(error));
      return null;
    }
    if (selectionEpoch === categorySelectionEpoch.current && activeCategoryCode.current === categoryCode) {
      setEditModifier(null);
    }
    return refreshAfterWrite(categoryCode, 'Модифікатор збережено', selectionEpoch);
  };

  const saveModifierEdit = () => {
    if (!editModifier?.id) return undefined;
    if (!editModifier.match_json || !editModifier.factor) {
      return feedback('error', 'Модифікатор не збережено', 'Заповніть умову та множник.');
    }

    let parsedJson;
    try {
      parsedJson = JSON.parse(editModifier.match_json || '{}');
    } catch {
      return feedback('error', 'Перевірте умову модифікатора', 'Умова має бути коректним JSON.');
    }

    return updateModifier({
      id: editModifier.id,
      match_json: parsedJson,
      factor: parseFloat(editModifier.factor),
    });
  };

  const discardLocalChanges = () => {
    setNewScenario(emptyNewScenario);
    setEditScenario(null);
    setNewModifier(emptyNewModifier);
    setEditModifier(null);
  };

  return {
    addModifier,
    addScenario,
    beginModifierEdit,
    beginScenarioEdit,
    clearCategory,
    duplicateScenario,
    discardLocalChanges,
    editModifier,
    editScenario,
    fetchPrices,
    fetchPricesForCategory,
    handlePriceChange,
    matrixCellSaveStates,
    newModifier,
    newScenario,
    pricesData,
    pricesError,
    retryPrices: () => selectedCat?.code
      ? fetchPricesForCategory(selectedCat.code, categorySelectionEpoch.current).catch(() => {})
      : undefined,
    saveModifierEdit,
    selectCategory,
    setEditModifier,
    setEditScenario,
    setNewModifier,
    setNewScenario,
    updateModifier,
    updateScenario,
  };
}
