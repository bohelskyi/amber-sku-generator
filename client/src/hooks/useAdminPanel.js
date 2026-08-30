import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { getValidationIssues } from '../lib/admin-validation';
import { normalizeDecimalInput } from '../lib/number-input';

const emptyEditOption = { id: null, value_id: '', sku_code: '', label: '', visible_if_json: '', hidden_if_json: '', archived: false };
const emptyNewCategory = { code: '', name: '', requires_weight: true, skip_hidden_sku_questions: false };
const emptyNewQuestion = { key: '', label: '', display_order: '', sku_index: '', required: true, include_in_sku: true, input_type: 'options', sku_separator: '', visible_if_json: '' };
const emptyNewOption = { value_id: '', sku_code: '', label: '', visible_if_json: '', hidden_if_json: '', archived: false };
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

const getNextDisplayOrder = (questions = []) => {
  const maxOrder = questions.reduce((maxValue, question) => {
    const orderValue = Number(question.display_order ?? question.sku_index);
    return Number.isFinite(orderValue) ? Math.max(maxValue, orderValue) : maxValue;
  }, 0);
  return String(maxOrder + 1);
};

const getNextSkuIndex = (questions = []) => {
  const maxIndex = questions
    .filter((question) => question.include_in_sku === 1)
    .reduce((maxValue, question) => {
      const indexValue = Number(question.sku_index);
      return Number.isFinite(indexValue) ? Math.max(maxValue, indexValue) : maxValue;
    }, 0);
  return String(maxIndex + 1);
};

const buildNewQuestionDefaults = (questions = []) => ({
  ...emptyNewQuestion,
  display_order: getNextDisplayOrder(questions),
  sku_index: getNextSkuIndex(questions),
});

export function useAdminPanel() {
  const [config, setConfig] = useState(null);
  const [selectedCat, setSelectedCat] = useState(null);
  const [selectedQuestion, setSelectedQuestion] = useState(null);
  const [pricesData, setPricesData] = useState(null);
  const [editCat, setEditCat] = useState({ code: '', name: '', requires_weight: true, skip_hidden_sku_questions: false });
  const [editQuestion, setEditQuestion] = useState({ key: '', label: '', display_order: '', sku_index: '', required: true, include_in_sku: true, input_type: 'options', sku_separator: '', visible_if_json: '' });
  const [newCat, setNewCat] = useState(emptyNewCategory);
  const [newQuest, setNewQuest] = useState(emptyNewQuestion);
  const [newOpt, setNewOpt] = useState(emptyNewOption);
  const [editOpt, setEditOpt] = useState(emptyEditOption);
  const [newScenario, setNewScenario] = useState(emptyNewScenario);
  const [editScenario, setEditScenario] = useState(null);
  const [newModifier, setNewModifier] = useState(emptyNewModifier);
  const [editModifier, setEditModifier] = useState(null);
  const [schemaStatus, setSchemaStatus] = useState(null);
  const [schemaPublishState, setSchemaPublishState] = useState({ loading: false, error: '' });

  const fetchConfig = () =>
    api.get('/admin/config').then((res) => {
      setConfig(res.data);
      return res.data;
    });

  const fetchSchemaStatus = (categoryCode) => {
    if (!categoryCode) {
      setSchemaStatus(null);
      return Promise.resolve(null);
    }
    return api.get(`/admin/sku-schema/${categoryCode}`).then((res) => {
      setSchemaStatus(res.data);
      return res.data;
    });
  };

  const fetchPricesForCategory = (categoryCode) => {
    api.get(`/admin/prices/${categoryCode}`).then((res) => setPricesData(res.data));
  };

  const fetchPrices = () => {
    if (!selectedCat) return;
    fetchPricesForCategory(selectedCat.code);
  };

  const updateSelectedQuestionState = (question) => {
    if (!question) return;
    setSelectedQuestion(question);
    setEditQuestion({
      key: question.id,
      label: question.label,
      display_order: question.display_order ?? question.sku_index,
      sku_index: question.sku_index,
      required: question.required === 1,
      include_in_sku: question.include_in_sku === 1,
      input_type: question.input_type || 'options',
      sku_separator: question.sku_separator || '',
      visible_if_json: question.visible_if_json ? formatMatchJson(question.visible_if_json) : '',
    });
  };

  const applyConfigWithSelection = (nextConfig, categoryCode, questionDbId = selectedQuestion?.q_db_id) => {
    const nextCategory = nextConfig.categories?.[categoryCode];
    setSelectedCat(nextCategory || null);
    setNewQuest(buildNewQuestionDefaults(nextConfig.questions?.[categoryCode] || []));

    if (!questionDbId) {
      setSelectedQuestion(null);
      return;
    }

    const refreshedQuestion = (nextConfig.questions?.[categoryCode] || [])
      .find((question) => question.q_db_id === questionDbId);
    if (refreshedQuestion) {
      updateSelectedQuestionState(refreshedQuestion);
    } else {
      setSelectedQuestion(null);
    }
  };

  useEffect(() => {
    fetchConfig();
  }, []);

  useEffect(() => {
    if (!selectedCat?.code || !config) return undefined;
    let cancelled = false;
    api.get(`/admin/sku-schema/${selectedCat.code}`).then((res) => {
      if (!cancelled) setSchemaStatus(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, [config, selectedCat?.code]);

  const formatMatchJson = (value) => {
    if (value === null || value === undefined) return '{}';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };

  const parseVisibleRuleInput = (value) => {
    try {
      return {
        ok: true,
        value: value ? JSON.parse(value) : null,
      };
    } catch {
      return {
        ok: false,
        value: null,
      };
    }
  };

  const handleSelectCategory = (category) => {
    const categoryQuestions = config?.questions?.[category.code] || [];
    setSelectedCat(category);
    setSelectedQuestion(null);
    setEditCat({
      code: category.code,
      name: category.name,
      requires_weight: category.requires_weight === 1,
      skip_hidden_sku_questions: category.skip_hidden_sku_questions === 1,
      code_mutable: category.code_mutable !== false,
    });
    setEditScenario(null);
    setEditModifier(null);
    setEditOpt(emptyEditOption);
    setNewQuest(buildNewQuestionDefaults(categoryQuestions));
    setPricesData(null);
    setSchemaPublishState({ loading: false, error: '' });
    fetchPricesForCategory(category.code);
  };

  const handleSelectQuestion = (question) => {
    setSelectedQuestion(question);
    setEditOpt(emptyEditOption);
    updateSelectedQuestionState(question);
  };

  const addCategory = () => {
    if (!newCat.code) return;
    api.post('/admin/category', {
      ...newCat,
      requires_weight: newCat.requires_weight ? 1 : 0,
      skip_hidden_sku_questions: newCat.skip_hidden_sku_questions ? 1 : 0,
    })
      .then(() => {
        setNewCat(emptyNewCategory);
        fetchConfig();
      })
      .catch((err) => alert(`Помилка створення категорії: ${err.response?.data?.error || err.message}`));
  };

  const updateCategory = () => {
    if (!selectedCat) return;
    const nextCode = String(editCat.code || '').trim().toUpperCase();
    if (!nextCode) return alert('Вкажіть код категорії');

    api.put('/admin/category', {
      code: selectedCat.code,
      next_code: nextCode,
      name: editCat.name,
      requires_weight: editCat.requires_weight ? 1 : 0,
      skip_hidden_sku_questions: editCat.skip_hidden_sku_questions ? 1 : 0,
    })
      .then((res) => {
        const savedCode = res.data?.code || nextCode;
        return fetchConfig().then((nextConfig) => {
          const nextCategory = nextConfig.categories?.[savedCode];
          setSelectedCat(nextCategory || null);
          if (nextCategory) {
            setEditCat({
              code: nextCategory.code,
              name: nextCategory.name,
              requires_weight: nextCategory.requires_weight === 1,
              skip_hidden_sku_questions: nextCategory.skip_hidden_sku_questions === 1,
              code_mutable: nextCategory.code_mutable !== false,
            });
            fetchPricesForCategory(nextCategory.code);
          } else {
            setPricesData(null);
          }
        });
      })
      .catch((err) => alert(`Помилка оновлення категорії: ${err.response?.data?.error || err.message}`));
  };

  const addQuestion = () => {
    if (!selectedCat) return;
    const isNewTextQuestion = newQuest.input_type === 'text';
    const shouldAddNewQuestionToSku = !isNewTextQuestion && newQuest.include_in_sku;
    const parsedVisibleRule = parseVisibleRuleInput(newQuest.visible_if_json);
    if (!parsedVisibleRule.ok) return alert('Помилка JSON в visible_if питання');

    api.post('/admin/question', {
      ...newQuest,
      sku_index: shouldAddNewQuestionToSku ? newQuest.sku_index : 0,
      required: newQuest.required ? 1 : 0,
      include_in_sku: shouldAddNewQuestionToSku ? 1 : 0,
      input_type: isNewTextQuestion ? 'text' : 'options',
      sku_separator: shouldAddNewQuestionToSku ? newQuest.sku_separator : '',
      display_order: newQuest.display_order !== ''
        ? newQuest.display_order
        : shouldAddNewQuestionToSku
          ? newQuest.sku_index
          : 0,
      visible_if_json: parsedVisibleRule.value,
      category_code: selectedCat.code,
    }).then(() => {
      fetchConfig().then((nextConfig) => {
        applyConfigWithSelection(nextConfig, selectedCat.code, null);
      });
    });
  };

  const updateQuestion = () => {
    if (!selectedQuestion) return;
    const isEditedTextQuestion = editQuestion.input_type === 'text';
    const shouldAddEditedQuestionToSku = !isEditedTextQuestion && editQuestion.include_in_sku;
    const parsedVisibleRule = parseVisibleRuleInput(editQuestion.visible_if_json);
    if (!parsedVisibleRule.ok) return alert('Помилка JSON в visible_if питання');

    api.post('/admin/question/update', {
      id: selectedQuestion.q_db_id,
      key: editQuestion.key,
      label: editQuestion.label,
      display_order: editQuestion.display_order !== ''
        ? editQuestion.display_order
        : shouldAddEditedQuestionToSku
          ? editQuestion.sku_index
          : 0,
      sku_index: shouldAddEditedQuestionToSku ? editQuestion.sku_index : 0,
      required: editQuestion.required ? 1 : 0,
      include_in_sku: shouldAddEditedQuestionToSku ? 1 : 0,
      input_type: isEditedTextQuestion ? 'text' : 'options',
      sku_separator: shouldAddEditedQuestionToSku ? editQuestion.sku_separator : '',
      visible_if_json: parsedVisibleRule.value,
    })
      .then(() => fetchConfig())
      .then((nextConfig) => {
        applyConfigWithSelection(nextConfig, selectedCat.code, selectedQuestion.q_db_id);
        alert('Збережено');
      })
      .catch((err) => {
        alert(`Помилка збереження: ${err.response?.data?.error || err.message}`);
      });
  };

  const addOption = () => {
    if (!selectedQuestion) return;
    if ((selectedQuestion.input_type || 'options') === 'text') {
      return alert('Для текстового питання варіанти не потрібні');
    }

    const parsedVisibleRule = parseVisibleRuleInput(newOpt.visible_if_json);
    const parsedHiddenRule = parseVisibleRuleInput(newOpt.hidden_if_json);
    if (!parsedVisibleRule.ok) return alert('Помилка в умові показу варіанта');
    if (!parsedHiddenRule.ok) return alert('Помилка в умові приховування варіанта');

    api.post('/admin/option', {
      question_id: selectedQuestion.q_db_id,
      value_id: newOpt.value_id,
      sku_code: newOpt.sku_code || newOpt.value_id,
      label: newOpt.label,
      visible_if_json: parsedVisibleRule.value,
      hidden_if_json: parsedHiddenRule.value,
    }).then(() => {
      setNewOpt(emptyNewOption);
      fetchConfig();
    });
  };

  const beginOptionEdit = (option) => {
    setEditOpt({
      id: option.db_id,
      value_id: String(option.id),
      sku_code: String(option.sku_code ?? option.id),
      label: option.label,
      visible_if_json: option.visible_if_json ? formatMatchJson(option.visible_if_json) : '',
      hidden_if_json: option.hidden_if_json ? formatMatchJson(option.hidden_if_json) : '',
      archived: option.archived === 1 || option.archived === true,
    });
  };

  const updateOption = () => {
    if (!editOpt.id) return;

    const parsedVisibleRule = parseVisibleRuleInput(editOpt.visible_if_json);
    const parsedHiddenRule = parseVisibleRuleInput(editOpt.hidden_if_json);
    if (!parsedVisibleRule.ok) return alert('Помилка в умові показу варіанта');
    if (!parsedHiddenRule.ok) return alert('Помилка в умові приховування варіанта');

    api.put('/admin/option', {
      id: editOpt.id,
      value_id: editOpt.value_id,
      sku_code: editOpt.sku_code,
      label: editOpt.label,
      visible_if_json: parsedVisibleRule.value,
      hidden_if_json: parsedHiddenRule.value,
      archived: editOpt.archived,
    })
      .then(() => {
        setEditOpt(emptyEditOption);
        fetchConfig();
      })
      .catch((err) => alert(`Помилка оновлення опції: ${err.response?.data?.error || err.message}`));
  };

  const archiveOption = (option, archived) => {
    api.patch(`/admin/option/${option.db_id}/archive`, { archived })
      .then(() => {
        if (editOpt.id === option.db_id) setEditOpt(emptyEditOption);
        return fetchConfig();
      })
      .catch((err) => alert(`Помилка архівування: ${err.response?.data?.error || err.message}`));
  };

  const publishSkuSchema = () => {
    if (!selectedCat || !schemaStatus?.draftChanged || schemaPublishState.loading) return;
    setSchemaPublishState({ loading: true, error: '' });
    api.post(`/admin/sku-schema/${selectedCat.code}/publish`)
      .then(() => Promise.all([fetchConfig(), fetchSchemaStatus(selectedCat.code)]))
      .catch((err) => {
        setSchemaPublishState({
          loading: false,
          error: err.response?.data?.error || err.message,
        });
      })
      .finally(() => {
        setSchemaPublishState((state) => ({ ...state, loading: false }));
      });
  };

  const persistQuestionOrder = (orderedQuestions, { reindexSku = false } = {}) => {
    if (!selectedCat) return Promise.resolve();

    const normalizedQuestions = orderedQuestions.map((question, index) => ({
      ...question,
      display_order: reindexSku
        ? question.display_order ?? index + 1
        : index + 1,
    }));

    let nextSkuIndex = 1;
    const payloadQuestions = normalizedQuestions.map((question) => {
      const payload = {
        id: question.q_db_id,
        display_order: question.display_order,
      };

      if (reindexSku) {
        payload.sku_index = question.include_in_sku === 1 ? nextSkuIndex++ : 0;
      }

      return payload;
    });

    setConfig((prevConfig) => {
      if (!prevConfig) return prevConfig;
      const optimisticQuestions = reindexSku
        ? normalizedQuestions.map((question) => ({
            ...question,
            sku_index: question.include_in_sku === 1
              ? payloadQuestions.find((item) => item.id === question.q_db_id)?.sku_index
              : question.sku_index,
          }))
        : normalizedQuestions;

      return {
        ...prevConfig,
        questions: {
          ...prevConfig.questions,
          [selectedCat.code]: optimisticQuestions,
        },
      };
    });

    return api.put('/admin/questions/order', {
      category_code: selectedCat.code,
      questions: payloadQuestions,
    })
      .then(() => fetchConfig())
      .then((nextConfig) => {
        applyConfigWithSelection(nextConfig, selectedCat.code);
      })
      .catch((err) => {
        fetchConfig();
        alert(`Помилка збереження порядку: ${err.response?.data?.error || err.message}`);
      });
  };

  const reorderQuestions = (orderedQuestions) => persistQuestionOrder(orderedQuestions);

  const autoAssignSkuIndexes = () => {
    if (!selectedCat) return;
    const skuQuestionCount = currentCatQuestions.filter((question) => question.include_in_sku === 1).length;
    if (skuQuestionCount === 0) {
      alert('У цій категорії немає питань, які додаються в SKU');
      return;
    }

    persistQuestionOrder(currentCatQuestions, { reindexSku: true });
  };

  const fillNextNewQuestionSkuIndex = () => {
    setNewQuest((prevQuestion) => ({
      ...prevQuestion,
      display_order: prevQuestion.display_order || getNextDisplayOrder(currentCatQuestions),
      sku_index: getNextSkuIndex(currentCatQuestions),
    }));
  };

  const deleteItem = (type, id) => {
    if (!window.confirm('Видалити цей елемент?')) return;
    api.post('/admin/delete-item', { type, id })
      .then(() => {
        fetchConfig();
        if (type === 'category') {
          setSelectedCat(null);
          setSelectedQuestion(null);
          setPricesData(null);
          setEditScenario(null);
          setEditModifier(null);
          setEditOpt(emptyEditOption);
        }
        if (type === 'scenario' || type === 'modifier') fetchPrices();
      })
      .catch((err) => alert(`Помилка видалення: ${err.response?.data?.error || err.message}`));
  };

  const handlePriceChange = (scenarioId, xVal, yVal, newPrice) => {
    const normalizedPrice = normalizeDecimalInput(newPrice);
    const parsedPrice = Number(normalizedPrice);
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) return;

    api.post('/admin/price-cell', {
      scenario_id: scenarioId,
      x_val: xVal,
      y_val: yVal,
      price: parsedPrice,
    });
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

    api.post('/admin/scenario', {
      ...newScenario,
      match_json: parsedJson,
      priority: Number(newScenario.priority || 0),
      category_code: selectedCat.code,
    })
      .then(() => {
        setNewScenario(emptyNewScenario);
        fetchPrices();
      })
      .catch((err) => alert(`Помилка створення сценарію: ${err.response?.data?.error || err.message}`));
  };

  const beginScenarioEdit = (scenario) => {
    setEditScenario({
      id: scenario.id,
      name: scenario.name,
      group_name: scenario.group_name || '',
      match_json: formatMatchJson(scenario.match_json),
      axis_x_key: scenario.axis_x_key || '',
      axis_y_key: scenario.axis_y_key || '',
      priority: String(scenario.priority ?? 0),
      status: scenario.status || 'active',
      price_mode: scenario.price_mode || 'category_default',
      apply_modifiers: scenario.apply_modifiers !== false,
      weight_bands: scenario.weight_bands || [],
    });
  };

  const updateScenario = () => {
    if (!editScenario?.id) return;
    if (!editScenario.name || !editScenario.axis_x_key) {
      return alert('Потрібні назва сценарію та вісь X');
    }

    let parsedJson;
    try {
      parsedJson = JSON.parse(editScenario.match_json || '{}');
    } catch {
      return alert('Помилка в JSON умови');
    }

    api.put('/admin/scenario', {
      id: editScenario.id,
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
      .then(() => {
        setEditScenario(null);
        fetchPrices();
      })
      .catch((err) => alert(`Помилка оновлення сценарію: ${err.response?.data?.error || err.message}`));
  };

  const duplicateScenario = (scenarioId) => {
    api.post('/admin/scenario/duplicate', { id: scenarioId })
      .then(() => fetchPrices())
      .catch((err) => alert(`Помилка дублювання: ${err.response?.data?.error || err.message}`));
  };

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

    api.post('/admin/modifier', {
      ...newModifier,
      match_json: parsedJson,
      category_code: selectedCat.code,
    })
      .then(() => {
        setNewModifier(emptyNewModifier);
        fetchPrices();
      });
  };

  const beginModifierEdit = (modifier) => {
    setEditModifier({
      id: modifier.id,
      match_json: formatMatchJson(
        modifier.match_json || (modifier.trigger_key ? { [modifier.trigger_key]: modifier.trigger_val } : {})
      ),
      factor: String(modifier.factor ?? ''),
    });
  };

  const updateModifier = (payloadOrId, newFactor) => {
    const payload = typeof payloadOrId === 'object'
      ? payloadOrId
      : { id: payloadOrId, factor: parseFloat(newFactor) };

    return api.put('/admin/modifier', payload)
      .then(() => {
        setEditModifier(null);
        fetchPrices();
      })
      .catch((err) => alert(`Помилка оновлення модифікатора: ${err.response?.data?.error || err.message}`));
  };

  const saveModifierEdit = () => {
    if (!editModifier?.id) return;
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

  const currentCatQuestions = selectedCat ? (config?.questions[selectedCat.code] || []) : [];
  const currentOptions = selectedQuestion
    ? (currentCatQuestions.find((question) => question.id === selectedQuestion.id)?.options || [])
    : [];
  const selectedQuestionInputType = selectedQuestion ? (selectedQuestion.input_type || 'options') : 'options';
  const validationIssues = getValidationIssues(config);

  return {
    addCategory,
    addModifier,
    addOption,
    addQuestion,
    addScenario,
    archiveOption,
    autoAssignSkuIndexes,
    beginModifierEdit,
    beginOptionEdit,
    beginScenarioEdit,
    config,
    currentCatQuestions,
    currentOptions,
    deleteItem,
    duplicateScenario,
    editCat,
    editModifier,
    editOpt,
    editQuestion,
    editScenario,
    fillNextNewQuestionSkuIndex,
    formatMatchJson,
    handlePriceChange,
    handleSelectCategory,
    handleSelectQuestion,
    newCat,
    newModifier,
    newOpt,
    newQuest,
    pricesData,
    publishSkuSchema,
    schemaPublishState,
    schemaStatus,
    selectedCat,
    selectedQuestion,
    selectedQuestionInputType,
    saveModifierEdit,
    setEditCat,
    setEditModifier,
    setEditOpt,
    setEditQuestion,
    setEditScenario,
    setNewCat,
    setNewModifier,
    setNewOpt,
    setNewQuest,
    setNewScenario,
    newScenario,
    reorderQuestions,
    updateCategory,
    updateModifier,
    updateOption,
    updateQuestion,
    updateScenario,
    validationIssues,
  };
}
