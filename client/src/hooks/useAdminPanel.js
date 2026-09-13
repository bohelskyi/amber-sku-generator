import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { getValidationIssues } from '../lib/admin-validation';
import { useAuth } from '../auth/auth-context.js';
import { getPermissionUiState } from '../lib/permission-ui.js';
import { useAdminPricingController } from './admin/useAdminPricingController';
import { useAdminSchemaController } from './admin/useAdminSchemaController';

const emptyEditOption = { id: null, value_id: '', sku_code: '', label: '', visible_if_json: '', hidden_if_json: '', archived: false };
const emptyNewCategory = { code: '', name: '', requires_weight: true, skip_hidden_sku_questions: false };
const emptyNewQuestion = { key: '', label: '', display_order: '', sku_index: '', required: true, include_in_sku: true, input_type: 'options', sku_separator: '', visible_if_json: '' };
const emptyNewOption = { value_id: '', sku_code: '', label: '', visible_if_json: '', hidden_if_json: '', archived: false };
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

const formatMatchJson = (value) => {
  if (value === null || value === undefined) return '{}';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export function useAdminPanel() {
  const auth = useAuth();
  const { canManagePricing, canViewCatalog, canViewPricing } = getPermissionUiState(
    auth.permissions
  );
  const [config, setConfig] = useState(null);
  const [selectedCat, setSelectedCat] = useState(null);
  const [selectedQuestion, setSelectedQuestion] = useState(null);
  const [editCat, setEditCat] = useState({ code: '', name: '', requires_weight: true, skip_hidden_sku_questions: false });
  const [editQuestion, setEditQuestion] = useState({ key: '', label: '', display_order: '', sku_index: '', required: true, include_in_sku: true, input_type: 'options', sku_separator: '', visible_if_json: '' });
  const [newCat, setNewCat] = useState(emptyNewCategory);
  const [newQuest, setNewQuest] = useState(emptyNewQuestion);
  const [newOpt, setNewOpt] = useState(emptyNewOption);
  const [editOpt, setEditOpt] = useState(emptyEditOption);

  const fetchConfig = useCallback(() =>
    api.get(canViewCatalog ? '/admin/config' : '/config').then((res) => {
      setConfig(res.data);
      return res.data;
    }), [canViewCatalog]);

  const pricing = useAdminPricingController({ canViewPricing, formatMatchJson, selectedCat });
  const schema = useAdminSchemaController({ canViewCatalog, config, fetchConfig, selectedCat });

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
  }, [fetchConfig]);

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
    setEditOpt(emptyEditOption);
    setNewQuest(buildNewQuestionDefaults(categoryQuestions));
    schema.resetSchemaPublishState();
    pricing.selectCategory(category);
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
            pricing.fetchPricesForCategory(nextCategory.code);
          } else {
            pricing.clearCategory();
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
          pricing.clearCategory();
          setEditOpt(emptyEditOption);
        }
        if (type === 'scenario' || type === 'modifier') pricing.fetchPrices();
      })
      .catch((err) => alert(`Помилка видалення: ${err.response?.data?.error || err.message}`));
  };

  const currentCatQuestions = selectedCat ? (config?.questions[selectedCat.code] || []) : [];
  const currentOptions = selectedQuestion
    ? (currentCatQuestions.find((question) => question.id === selectedQuestion.id)?.options || [])
    : [];
  const selectedQuestionInputType = selectedQuestion ? (selectedQuestion.input_type || 'options') : 'options';
  const validationIssues = getValidationIssues(config);

  return {
    ...pricing,
    ...schema,
    addCategory,
    addOption,
    addQuestion,
    archiveOption,
    autoAssignSkuIndexes,
    beginOptionEdit,
    canManagePricing,
    canViewCatalog,
    canViewPricing,
    config,
    currentCatQuestions,
    currentOptions,
    deleteItem,
    editCat,
    editOpt,
    editQuestion,
    fillNextNewQuestionSkuIndex,
    formatMatchJson,
    handleSelectCategory,
    handleSelectQuestion,
    newCat,
    newOpt,
    newQuest,
    selectedCat,
    selectedQuestion,
    selectedQuestionInputType,
    setEditCat,
    setEditOpt,
    setEditQuestion,
    setNewCat,
    setNewOpt,
    setNewQuest,
    reorderQuestions,
    updateCategory,
    updateOption,
    updateQuestion,
    validationIssues,
  };
}
