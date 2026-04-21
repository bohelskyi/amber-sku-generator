import { useEffect, useState } from 'react';
import { AdminHeader } from '../components/admin/AdminHeader';
import { AdminPricingEditor } from '../components/admin/AdminPricingEditor';
import { AdminStructureEditor } from '../components/admin/AdminStructureEditor';
import { ValidationIssues } from '../components/admin/ValidationIssues';
import { api } from '../lib/api';
import { getValidationIssues } from '../lib/admin-validation';

export default function AdminPage() {
  const [config, setConfig] = useState(null);
  const [selectedCat, setSelectedCat] = useState(null);
  const [selectedQuestion, setSelectedQuestion] = useState(null);
  const [pricesData, setPricesData] = useState(null);
  const [editCat, setEditCat] = useState({ name: '', requires_weight: true });
  const [editQuestion, setEditQuestion] = useState({ label: '', sku_index: '', required: true, include_in_sku: true, input_type: 'options' });
  const [newCat, setNewCat] = useState({ code: '', name: '', requires_weight: true });
  const [newQuest, setNewQuest] = useState({ key: '', label: '', sku_index: '', required: true, include_in_sku: true, input_type: 'options' });
  const [newOpt, setNewOpt] = useState({ value_id: '', label: '', visible_if_json: '' });
  const [editOpt, setEditOpt] = useState({ id: null, value_id: '', label: '', visible_if_json: '' });
  const [newScenario, setNewScenario] = useState({ name: '', match_json: '', axis_x_key: '', axis_y_key: '' });
  const [editScenario, setEditScenario] = useState(null);
  const [newModifier, setNewModifier] = useState({ trigger_key: '', trigger_val: '', factor: '' });

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

  const handleSelectCategory = (category) => {
    setSelectedCat(category);
    setSelectedQuestion(null);
    setEditCat({ name: category.name, requires_weight: category.requires_weight === 1 });
    setEditScenario(null);
    setEditOpt({ id: null, value_id: '', label: '', visible_if_json: '' });
    setPricesData(null);
    fetchPricesForCategory(category.code);
  };

  const handleSelectQuestion = (question) => {
    setSelectedQuestion(question);
    setEditOpt({ id: null, value_id: '', label: '', visible_if_json: '' });
    setEditQuestion({
      label: question.label,
      sku_index: question.sku_index,
      required: question.required === 1,
      include_in_sku: question.include_in_sku === 1,
      input_type: question.input_type || 'options',
    });
  };

  const addCategory = () => {
    if (!newCat.code) return;
    api.post('/admin/category', { ...newCat, requires_weight: newCat.requires_weight ? 1 : 0 })
      .then(() => {
        setNewCat({ code: '', name: '', requires_weight: true });
        fetchConfig();
      });
  };

  const updateCategory = () => {
    if (!selectedCat) return;
    api.put('/admin/category', {
      code: selectedCat.code,
      name: editCat.name,
      requires_weight: editCat.requires_weight ? 1 : 0,
    }).then(() => fetchConfig());
  };

  const addQuestion = () => {
    if (!selectedCat) return;
    const isNewTextQuestion = newQuest.input_type === 'text';
    api.post('/admin/question', {
      ...newQuest,
      required: newQuest.required ? 1 : 0,
      include_in_sku: isNewTextQuestion ? 0 : (newQuest.include_in_sku ? 1 : 0),
      input_type: isNewTextQuestion ? 'text' : 'options',
      category_code: selectedCat.code,
    }).then(() => {
      setNewQuest({ key: '', label: '', sku_index: '', required: true, include_in_sku: true, input_type: 'options' });
      fetchConfig();
    });
  };

  const updateQuestion = () => {
    if (!selectedQuestion) return;
    const isEditedTextQuestion = editQuestion.input_type === 'text';
    api.post('/admin/question/update', {
      id: selectedQuestion.q_db_id,
      label: editQuestion.label,
      sku_index: editQuestion.sku_index,
      required: editQuestion.required ? 1 : 0,
      include_in_sku: isEditedTextQuestion ? 0 : (editQuestion.include_in_sku ? 1 : 0),
      input_type: isEditedTextQuestion ? 'text' : 'options',
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
      setNewOpt({ value_id: '', label: '', visible_if_json: '' });
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
        setEditOpt({ id: null, value_id: '', label: '', visible_if_json: '' });
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
          setEditOpt({ id: null, value_id: '', label: '', visible_if_json: '' });
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
      setNewScenario({ name: '', match_json: '', axis_x_key: '', axis_y_key: '' });
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
        setNewModifier({ trigger_key: '', trigger_val: '', factor: '' });
        fetchPrices();
      });
  };

  const updateModifier = (id, newFactor) => {
    api.put('/admin/modifier', { id, factor: parseFloat(newFactor) });
  };

  if (!config) {
    return (
      <div className="min-h-screen app-bg flex items-center justify-center">
        <div className="card p-8 text-center">
          <div className="text-lg font-semibold text-slate-700">Завантаження...</div>
          <div className="mt-2 text-sm text-slate-500">Збираємо конфігурацію та цінові сценарії.</div>
        </div>
      </div>
    );
  }

  const currentCatQuestions = selectedCat ? (config.questions[selectedCat.code] || []) : [];
  const currentOptions = selectedQuestion
    ? (currentCatQuestions.find((question) => question.id === selectedQuestion.id)?.options || [])
    : [];
  const selectedQuestionInputType = selectedQuestion ? (selectedQuestion.input_type || 'options') : 'options';
  const validationIssues = getValidationIssues(config);

  return (
    <div className="min-h-screen app-bg">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-12 pb-28 space-y-8">
        <AdminHeader />
        <ValidationIssues issues={validationIssues} />
        <AdminStructureEditor
          config={config}
          selectedCat={selectedCat}
          selectedQuestion={selectedQuestion}
          currentCatQuestions={currentCatQuestions}
          currentOptions={currentOptions}
          selectedQuestionInputType={selectedQuestionInputType}
          editCat={editCat}
          setEditCat={setEditCat}
          editQuestion={editQuestion}
          setEditQuestion={setEditQuestion}
          newCat={newCat}
          setNewCat={setNewCat}
          newQuest={newQuest}
          setNewQuest={setNewQuest}
          newOpt={newOpt}
          setNewOpt={setNewOpt}
          editOpt={editOpt}
          setEditOpt={setEditOpt}
          onSelectCategory={handleSelectCategory}
          onSelectQuestion={handleSelectQuestion}
          addCategory={addCategory}
          updateCategory={updateCategory}
          addQuestion={addQuestion}
          updateQuestion={updateQuestion}
          addOption={addOption}
          beginOptionEdit={beginOptionEdit}
          updateOption={updateOption}
          deleteItem={deleteItem}
          formatMatchJson={formatMatchJson}
        />
        <AdminPricingEditor
          selectedCat={selectedCat}
          pricesData={pricesData}
          currentCatQuestions={currentCatQuestions}
          editScenario={editScenario}
          setEditScenario={setEditScenario}
          newScenario={newScenario}
          setNewScenario={setNewScenario}
          newModifier={newModifier}
          setNewModifier={setNewModifier}
          beginScenarioEdit={beginScenarioEdit}
          updateScenario={updateScenario}
          duplicateScenario={duplicateScenario}
          deleteItem={deleteItem}
          formatMatchJson={formatMatchJson}
          handlePriceChange={handlePriceChange}
          addScenario={addScenario}
          updateModifier={updateModifier}
          addModifier={addModifier}
        />
      </div>
    </div>
  );
}
