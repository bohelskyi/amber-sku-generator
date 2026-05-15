import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { getValidationIssues } from '../lib/admin-validation';

const emptyEditOption = { id: null, value_id: '', label: '', visible_if_json: '' };
const emptyNewCategory = { code: '', name: '', requires_weight: true };
const emptyNewQuestion = { key: '', label: '', sku_index: '', required: true, include_in_sku: true, input_type: 'options', sku_separator: '', visible_if_json: '' };
const emptyNewOption = { value_id: '', label: '', visible_if_json: '' };
const emptyNewScenario = { name: '', match_json: '', axis_x_key: '', axis_y_key: '' };
const emptyNewModifier = { trigger_key: '', trigger_val: '', factor: '' };

export function useAdminPanel() {
  const [config, setConfig] = useState(null);
  const [selectedCat, setSelectedCat] = useState(null);
  const [selectedQuestion, setSelectedQuestion] = useState(null);
  const [pricesData, setPricesData] = useState(null);
  const [editCat, setEditCat] = useState({ name: '', requires_weight: true });
  const [editQuestion, setEditQuestion] = useState({ label: '', sku_index: '', required: true, include_in_sku: true, input_type: 'options', sku_separator: '', visible_if_json: '' });
  const [newCat, setNewCat] = useState(emptyNewCategory);
  const [newQuest, setNewQuest] = useState(emptyNewQuestion);
  const [newOpt, setNewOpt] = useState(emptyNewOption);
  const [editOpt, setEditOpt] = useState(emptyEditOption);
  const [newScenario, setNewScenario] = useState(emptyNewScenario);
  const [editScenario, setEditScenario] = useState(null);
  const [newModifier, setNewModifier] = useState(emptyNewModifier);

  const fetchConfig = () => {
    api.get('/config').then((res) => setConfig(res.data));
  };

  const fetchPricesForCategory = (categoryCode) => {
    api.get(`/admin/prices/${categoryCode}`).then((res) => setPricesData(res.data));
  };

  const fetchPrices = () => {
    if (!selectedCat) return;
    fetchPricesForCategory(selectedCat.code);
  };

  useEffect(() => {
    fetchConfig();
  }, []);

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
    setSelectedCat(category);
    setSelectedQuestion(null);
    setEditCat({ name: category.name, requires_weight: category.requires_weight === 1 });
    setEditScenario(null);
    setEditOpt(emptyEditOption);
    setPricesData(null);
    fetchPricesForCategory(category.code);
  };

  const handleSelectQuestion = (question) => {
    setSelectedQuestion(question);
    setEditOpt(emptyEditOption);
    setEditQuestion({
      label: question.label,
      sku_index: question.sku_index,
      required: question.required === 1,
      include_in_sku: question.include_in_sku === 1,
      input_type: question.input_type || 'options',
      sku_separator: question.sku_separator || '',
      visible_if_json: question.visible_if_json ? formatMatchJson(question.visible_if_json) : '',
    });
  };

  const addCategory = () => {
    if (!newCat.code) return;
    api.post('/admin/category', { ...newCat, requires_weight: newCat.requires_weight ? 1 : 0 })
      .then(() => {
        setNewCat(emptyNewCategory);
        fetchConfig();
      })
      .catch((err) => alert(`Помилка створення категорії: ${err.response?.data?.error || err.message}`));
  };

  const updateCategory = () => {
    if (!selectedCat) return;
    api.put('/admin/category', {
      code: selectedCat.code,
      name: editCat.name,
      requires_weight: editCat.requires_weight ? 1 : 0,
    })
      .then(() => fetchConfig())
      .catch((err) => alert(`Помилка оновлення категорії: ${err.response?.data?.error || err.message}`));
  };

  const addQuestion = () => {
    if (!selectedCat) return;
    const isNewTextQuestion = newQuest.input_type === 'text';
    const parsedVisibleRule = parseVisibleRuleInput(newQuest.visible_if_json);
    if (!parsedVisibleRule.ok) return alert('Помилка JSON в visible_if питання');

    api.post('/admin/question', {
      ...newQuest,
      required: newQuest.required ? 1 : 0,
      include_in_sku: isNewTextQuestion ? 0 : (newQuest.include_in_sku ? 1 : 0),
      input_type: isNewTextQuestion ? 'text' : 'options',
      sku_separator: isNewTextQuestion || !newQuest.include_in_sku ? '' : newQuest.sku_separator,
      visible_if_json: parsedVisibleRule.value,
      category_code: selectedCat.code,
    }).then(() => {
      setNewQuest(emptyNewQuestion);
      fetchConfig();
    });
  };

  const updateQuestion = () => {
    if (!selectedQuestion) return;
    const isEditedTextQuestion = editQuestion.input_type === 'text';
    const parsedVisibleRule = parseVisibleRuleInput(editQuestion.visible_if_json);
    if (!parsedVisibleRule.ok) return alert('Помилка JSON в visible_if питання');

    api.post('/admin/question/update', {
      id: selectedQuestion.q_db_id,
      label: editQuestion.label,
      sku_index: editQuestion.sku_index,
      required: editQuestion.required ? 1 : 0,
      include_in_sku: isEditedTextQuestion ? 0 : (editQuestion.include_in_sku ? 1 : 0),
      input_type: isEditedTextQuestion ? 'text' : 'options',
      sku_separator: isEditedTextQuestion || !editQuestion.include_in_sku ? '' : editQuestion.sku_separator,
      visible_if_json: parsedVisibleRule.value,
    })
      .then(() => {
        fetchConfig();
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

    let parsedRule = null;
    try {
      parsedRule = newOpt.visible_if_json ? JSON.parse(newOpt.visible_if_json) : null;
    } catch {
      return alert('Помилка JSON в visible_if');
    }

    api.post('/admin/option', {
      question_id: selectedQuestion.q_db_id,
      value_id: newOpt.value_id,
      label: newOpt.label,
      visible_if_json: parsedRule,
    }).then(() => {
      setNewOpt(emptyNewOption);
      fetchConfig();
    });
  };

  const beginOptionEdit = (option) => {
    setEditOpt({
      id: option.db_id,
      value_id: String(option.id),
      label: option.label,
      visible_if_json: option.visible_if_json ? formatMatchJson(option.visible_if_json) : '',
    });
  };

  const updateOption = () => {
    if (!editOpt.id) return;

    let parsedRule = null;
    try {
      parsedRule = editOpt.visible_if_json ? JSON.parse(editOpt.visible_if_json) : null;
    } catch {
      return alert('Помилка JSON в visible_if');
    }

    api.put('/admin/option', {
      id: editOpt.id,
      value_id: editOpt.value_id,
      label: editOpt.label,
      visible_if_json: parsedRule,
    })
      .then(() => {
        setEditOpt(emptyEditOption);
        fetchConfig();
      })
      .catch((err) => alert(`Помилка оновлення опції: ${err.response?.data?.error || err.message}`));
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
          setEditOpt(emptyEditOption);
        }
        if (type === 'scenario' || type === 'modifier') fetchPrices();
      });
  };

  const handlePriceChange = (scenarioId, xVal, yVal, newPrice) => {
    api.post('/admin/price-cell', {
      scenario_id: scenarioId,
      x_val: xVal,
      y_val: yVal,
      price: parseFloat(newPrice),
    });
  };

  const addScenario = () => {
    if (!newScenario.name || !newScenario.match_json || !newScenario.axis_x_key) {
      return alert('Заповніть назву, JSON умови та вісь X');
    }

    let parsedJson;
    try {
      parsedJson = JSON.parse(newScenario.match_json);
    } catch {
      return alert('Помилка в JSON! Формат: {"key": value}');
    }

    api.post('/admin/scenario', {
      ...newScenario,
      match_json: parsedJson,
      category_code: selectedCat.code,
    }).then(() => {
      setNewScenario(emptyNewScenario);
      fetchPrices();
    });
  };

  const beginScenarioEdit = (scenario) => {
    setEditScenario({
      id: scenario.id,
      name: scenario.name,
      match_json: formatMatchJson(scenario.match_json),
      axis_x_key: scenario.axis_x_key || '',
      axis_y_key: scenario.axis_y_key || '',
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
      match_json: parsedJson,
      axis_x_key: editScenario.axis_x_key,
      axis_y_key: editScenario.axis_y_key || null,
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
    if (!newModifier.trigger_key || !newModifier.factor) return;
    api.post('/admin/modifier', { ...newModifier, category_code: selectedCat.code })
      .then(() => {
        setNewModifier(emptyNewModifier);
        fetchPrices();
      });
  };

  const updateModifier = (id, newFactor) => {
    api.put('/admin/modifier', { id, factor: parseFloat(newFactor) });
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
    beginOptionEdit,
    beginScenarioEdit,
    config,
    currentCatQuestions,
    currentOptions,
    deleteItem,
    duplicateScenario,
    editCat,
    editOpt,
    editQuestion,
    editScenario,
    formatMatchJson,
    handlePriceChange,
    handleSelectCategory,
    handleSelectQuestion,
    newCat,
    newModifier,
    newOpt,
    newQuest,
    pricesData,
    selectedCat,
    selectedQuestion,
    selectedQuestionInputType,
    setEditCat,
    setEditOpt,
    setEditQuestion,
    setEditScenario,
    setNewCat,
    setNewModifier,
    setNewOpt,
    setNewQuest,
    setNewScenario,
    newScenario,
    updateCategory,
    updateModifier,
    updateOption,
    updateQuestion,
    updateScenario,
    validationIssues,
  };
}
