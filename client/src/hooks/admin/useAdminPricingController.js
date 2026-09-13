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

export function useAdminPricingController({ canViewPricing, formatMatchJson, selectedCat }) {
  const [pricesData, setPricesData] = useState(null);
  const [newScenario, setNewScenario] = useState(emptyNewScenario);
  const [editScenario, setEditScenario] = useState(null);
  const [newModifier, setNewModifier] = useState(emptyNewModifier);
  const [editModifier, setEditModifier] = useState(null);
  const pricesRequestId = useRef(0);

  const fetchPricesForCategory = (categoryCode) => {
    const requestId = ++pricesRequestId.current;
    return api.get(`/admin/prices/${categoryCode}`).then((response) => {
      if (requestId === pricesRequestId.current) setPricesData(response.data);
      return response.data;
    });
  };

  const fetchPrices = () => {
    if (!selectedCat) return undefined;
    return fetchPricesForCategory(selectedCat.code);
  };

  const selectCategory = (category) => {
    setEditScenario(null);
    setEditModifier(null);
    setPricesData(null);
    if (canViewPricing) fetchPricesForCategory(category.code);
  };

  const clearCategory = () => {
    pricesRequestId.current += 1;
    setPricesData(null);
    setEditScenario(null);
    setEditModifier(null);
  };

  const handlePriceChange = (scenarioId, xVal, yVal, newPrice) => {
    const categoryCode = selectedCat?.code;
    const normalizedPrice = normalizeDecimalInput(newPrice);
    const isBlank = normalizedPrice.trim() === '';
    if (!isBlank) {
      const parsedPrice = Number(normalizedPrice);
      if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) return Promise.resolve();
    }

    return api.post('/admin/price-cell', {
      scenario_id: scenarioId,
      x_val: xVal,
      y_val: yVal,
      price: isBlank ? null : normalizedPrice,
    }).then(() => fetchPricesForCategory(categoryCode));
  };

  const addScenario = () => {
    if (!newScenario.name || !newScenario.axis_x_key) {
      return alert('Заповніть назву та вісь рядків матриці');
    }

    let parsedJson;
    try {
      parsedJson = JSON.parse(newScenario.match_json || '{}');
    } catch {
      return alert('Помилка в умові сценарію');
    }

    return api.post('/admin/scenario', {
      ...newScenario,
      match_json: parsedJson,
      priority: Number(newScenario.priority || 0),
      category_code: selectedCat.code,
    })
      .then(() => {
        setNewScenario(emptyNewScenario);
        return fetchPrices();
      })
      .catch((error) => alert(`Помилка створення сценарію: ${getApiError(error)}`));
  };

  const beginScenarioEdit = (scenario) => {
    setEditScenario(buildScenarioEditorDraft(scenario));
  };

  const updateScenario = () => {
    if (!editScenario?.id) return undefined;
    if (!editScenario.name || !editScenario.axis_x_key) {
      return alert('Потрібні назва сценарію та вісь X');
    }

    let parsedJson;
    try {
      parsedJson = JSON.parse(editScenario.match_json || '{}');
    } catch {
      return alert('Помилка в JSON умови');
    }

    const scenarioId = editScenario.id;
    const categoryCode = selectedCat?.code;
    return api.put('/admin/scenario', {
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
    })
      .then(() => fetchPricesForCategory(categoryCode))
      .then((nextPricesData) => {
        const savedScenario = findScenarioById(nextPricesData, scenarioId);
        setEditScenario(buildScenarioEditorDraft(savedScenario));
        return savedScenario;
      })
      .catch((error) => {
        alert(`Помилка оновлення сценарію: ${getApiError(error)}`);
        return null;
      });
  };

  const duplicateScenario = (scenarioId) => api.post('/admin/scenario/duplicate', { id: scenarioId })
    .then(() => fetchPrices())
    .catch((error) => alert(`Помилка дублювання: ${getApiError(error)}`));

  const addModifier = () => {
    if (!newModifier.match_json || !newModifier.factor) {
      return alert('Заповніть умови модифікатора та множник');
    }

    let parsedJson;
    try {
      parsedJson = JSON.parse(newModifier.match_json || '{}');
    } catch {
      return alert('Помилка в умові модифікатора');
    }

    return api.post('/admin/modifier', {
      ...newModifier,
      match_json: parsedJson,
      category_code: selectedCat.code,
    }).then(() => {
      setNewModifier(emptyNewModifier);
      return fetchPrices();
    });
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

  const updateModifier = (payloadOrId, newFactor) => {
    const payload = typeof payloadOrId === 'object'
      ? payloadOrId
      : { id: payloadOrId, factor: parseFloat(newFactor) };

    return api.put('/admin/modifier', payload)
      .then(() => {
        setEditModifier(null);
        return fetchPrices();
      })
      .catch((error) => alert(`Помилка оновлення модифікатора: ${getApiError(error)}`));
  };

  const saveModifierEdit = () => {
    if (!editModifier?.id) return undefined;
    if (!editModifier.match_json || !editModifier.factor) {
      return alert('Заповніть умови модифікатора та множник');
    }

    let parsedJson;
    try {
      parsedJson = JSON.parse(editModifier.match_json || '{}');
    } catch {
      return alert('Помилка в умові модифікатора');
    }

    return updateModifier({
      id: editModifier.id,
      match_json: parsedJson,
      factor: parseFloat(editModifier.factor),
    });
  };

  return {
    addModifier,
    addScenario,
    beginModifierEdit,
    beginScenarioEdit,
    clearCategory,
    duplicateScenario,
    editModifier,
    editScenario,
    fetchPrices,
    fetchPricesForCategory,
    handlePriceChange,
    newModifier,
    newScenario,
    pricesData,
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
