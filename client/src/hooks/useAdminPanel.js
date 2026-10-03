import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { getValidationIssues } from '../lib/admin-validation';
import { useAuth } from '../auth/auth-context.js';
import { getPermissionUiState } from '../lib/permission-ui.js';
import { useAdminPricingController } from './admin/useAdminPricingController';
import { useAdminSchemaController } from './admin/useAdminSchemaController';
import { getApiError } from '../lib/http-error';

const emptyEditOption = { id: null, value_id: '', sku_code: '', label: '', label_en: '', visible_if_json: '', hidden_if_json: '', archived: false };
const emptyNewCategory = { code: '', name: '', requires_weight: true, skip_hidden_sku_questions: false, marketing_rounding_enabled: true };
const emptyNewQuestion = { key: '', label: '', display_order: '', sku_index: '', required: true, include_in_sku: true, input_type: 'options', sku_separator: '', visible_if_json: '' };
const emptyNewOption = { value_id: '', sku_code: '', label: '', label_en: '', visible_if_json: '', hidden_if_json: '', archived: false };
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

export function useAdminPanel({ mode = 'auto' } = {}) {
  const auth = useAuth();
  const { canManagePricing, canViewCatalog, canViewPricing } = getPermissionUiState(
    auth.permissions
  );
  const effectiveMode = mode === 'auto' ? (canViewCatalog ? 'catalog' : 'pricing') : mode;
  const catalogWorkspaceEnabled = effectiveMode === 'catalog' && canViewCatalog;
  const pricingWorkspaceEnabled = effectiveMode === 'pricing' && canViewPricing;
  const canPublishSchema = auth.permissions.includes('sku_schemas.publish');
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [selectedCat, setSelectedCat] = useState(null);
  const [selectedQuestion, setSelectedQuestion] = useState(null);
  const [editCat, setEditCat] = useState(emptyNewCategory);
  const [editQuestion, setEditQuestion] = useState({ key: '', label: '', display_order: '', sku_index: '', required: true, include_in_sku: true, input_type: 'options', sku_separator: '', visible_if_json: '' });
  const [newCat, setNewCat] = useState(emptyNewCategory);
  const [newQuest, setNewQuest] = useState(emptyNewQuestion);
  const [newOpt, setNewOpt] = useState(emptyNewOption);
  const [editOpt, setEditOpt] = useState(emptyEditOption);

  const showFeedback = useCallback(({ tone = 'success', title, message = '' }) => {
    setFeedback({ tone, title, message, id: Date.now() });
  }, []);

  const showRefreshWarning = (successTitle, error) => showFeedback({
    tone: 'warning',
    title: `${successTitle}, але дані не оновлено`,
    message: getApiError(error),
  });

  const fetchConfig = useCallback(() =>
    api.get(effectiveMode === 'catalog' ? '/admin/config' : '/admin/pricing/config').then((res) => {
      setConfig(res.data);
      return res.data;
    }), [effectiveMode]);

  const pricing = useAdminPricingController({ canViewPricing: pricingWorkspaceEnabled, formatMatchJson, onFeedback: showFeedback, selectedCat });
  const schema = useAdminSchemaController({ canPublishSchema, canViewCatalog: catalogWorkspaceEnabled, config, fetchConfig, onFeedback: showFeedback, selectedCat });

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
    if (!catalogWorkspaceEnabled && !pricingWorkspaceEnabled) return;
    fetchConfig().catch((error) => setConfigError(getApiError(error)));
  }, [catalogWorkspaceEnabled, fetchConfig, pricingWorkspaceEnabled]);

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
      marketing_rounding_enabled: category.marketing_rounding_enabled !== 0,
      code_mutable: category.code_mutable !== false,
    });
    setEditOpt(emptyEditOption);
    setNewQuest(buildNewQuestionDefaults(categoryQuestions));
    if (catalogWorkspaceEnabled) schema.selectSchemaCategory(category);
    if (pricingWorkspaceEnabled) pricing.selectCategory(category);
  };

  const handleSelectQuestion = (question) => {
    setSelectedQuestion(question);
    setEditOpt(emptyEditOption);
    updateSelectedQuestionState(question);
  };

  const addCategory = async () => {
    if (!newCat.code) return;
    try {
      await api.post('/admin/category', {
        ...newCat,
        requires_weight: newCat.requires_weight ? 1 : 0,
        skip_hidden_sku_questions: newCat.skip_hidden_sku_questions ? 1 : 0,
        marketing_rounding_enabled: newCat.marketing_rounding_enabled ? 1 : 0,
      });
    } catch (error) {
      showFeedback({ tone: 'error', title: 'Не вдалося створити категорію', message: getApiError(error) });
      return false;
    }
    setNewCat(emptyNewCategory);
    showFeedback({ title: 'Категорію створено' });
    try {
      await fetchConfig();
    } catch (error) {
      showRefreshWarning('Категорію створено', error);
    }
    return true;
  };

  const updateCategory = async () => {
    if (!selectedCat) return;
    const nextCode = String(editCat.code || '').trim().toUpperCase();
    if (!nextCode) return showFeedback({ tone: 'error', title: 'Категорію не збережено', message: 'Вкажіть код категорії.' });

    let response;
    try {
      response = await api.put('/admin/category', {
        code: selectedCat.code,
        next_code: nextCode,
        name: editCat.name,
        requires_weight: editCat.requires_weight ? 1 : 0,
        skip_hidden_sku_questions: editCat.skip_hidden_sku_questions ? 1 : 0,
        marketing_rounding_enabled: editCat.marketing_rounding_enabled ? 1 : 0,
      });
    } catch (error) {
      showFeedback({ tone: 'error', title: 'Не вдалося зберегти категорію', message: getApiError(error) });
      return false;
    }
    const savedCode = response.data?.code || nextCode;
    showFeedback({ title: 'Категорію збережено' });
    try {
      const nextConfig = await fetchConfig();
      const nextCategory = nextConfig.categories?.[savedCode];
      if (nextCategory) schema.selectSchemaCategory(nextCategory);
      setSelectedCat(nextCategory || null);
      if (nextCategory) {
        setEditCat({
          code: nextCategory.code,
          name: nextCategory.name,
          requires_weight: nextCategory.requires_weight === 1,
          skip_hidden_sku_questions: nextCategory.skip_hidden_sku_questions === 1,
          marketing_rounding_enabled: nextCategory.marketing_rounding_enabled !== 0,
          code_mutable: nextCategory.code_mutable !== false,
        });
      }
    } catch (error) {
      showRefreshWarning('Категорію збережено', error);
    }
    return true;
  };

  const addQuestion = async () => {
    if (!selectedCat) return;
    const isNewTextQuestion = newQuest.input_type === 'text';
    const shouldAddNewQuestionToSku = !isNewTextQuestion && newQuest.include_in_sku;
    const parsedVisibleRule = parseVisibleRuleInput(newQuest.visible_if_json);
    if (!parsedVisibleRule.ok) return showFeedback({ tone: 'error', title: 'Питання не створено', message: 'Перевірте умову показу.' });

    try {
      await api.post('/admin/question', {
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
      });
    } catch (error) {
      showFeedback({ tone: 'error', title: 'Не вдалося створити питання', message: getApiError(error) });
      return false;
    }
    setNewQuest(buildNewQuestionDefaults(currentCatQuestions));
    showFeedback({ title: 'Питання створено' });
    try {
      const nextConfig = await fetchConfig();
      applyConfigWithSelection(nextConfig, selectedCat.code, null);
    } catch (error) {
      showRefreshWarning('Питання створено', error);
    }
    return true;
  };

  const updateQuestion = async () => {
    if (!selectedQuestion) return;
    const isEditedTextQuestion = editQuestion.input_type === 'text';
    const shouldAddEditedQuestionToSku = !isEditedTextQuestion && editQuestion.include_in_sku;
    const parsedVisibleRule = parseVisibleRuleInput(editQuestion.visible_if_json);
    if (!parsedVisibleRule.ok) return showFeedback({ tone: 'error', title: 'Питання не збережено', message: 'Перевірте умову показу.' });

    try {
      await api.post('/admin/question/update', {
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
      });
    } catch (error) {
      showFeedback({ tone: 'error', title: 'Не вдалося зберегти питання', message: getApiError(error) });
      return false;
    }
    showFeedback({ title: 'Питання збережено' });
    try {
      const nextConfig = await fetchConfig();
      applyConfigWithSelection(nextConfig, selectedCat.code, selectedQuestion.q_db_id);
    } catch (error) {
      showRefreshWarning('Питання збережено', error);
    }
    return true;
  };

  const addOption = async () => {
    if (!selectedQuestion) return;
    if ((selectedQuestion.input_type || 'options') === 'text') {
      return showFeedback({ tone: 'error', title: 'Варіант не створено', message: 'Для текстового питання варіанти не використовуються.' });
    }

    const parsedVisibleRule = parseVisibleRuleInput(newOpt.visible_if_json);
    const parsedHiddenRule = parseVisibleRuleInput(newOpt.hidden_if_json);
    if (!parsedVisibleRule.ok) return showFeedback({ tone: 'error', title: 'Варіант не створено', message: 'Перевірте умову показу.' });
    if (!parsedHiddenRule.ok) return showFeedback({ tone: 'error', title: 'Варіант не створено', message: 'Перевірте умову приховування.' });

    try {
      await api.post('/admin/option', {
        question_id: selectedQuestion.q_db_id,
        value_id: newOpt.value_id,
        sku_code: newOpt.sku_code || newOpt.value_id,
        label: newOpt.label,
        label_en: newOpt.label_en || null,
        visible_if_json: parsedVisibleRule.value,
        hidden_if_json: parsedHiddenRule.value,
      });
    } catch (error) {
      showFeedback({ tone: 'error', title: 'Не вдалося створити варіант', message: getApiError(error) });
      return false;
    }
    setNewOpt(emptyNewOption);
    showFeedback({ title: 'Варіант створено' });
    try {
      await fetchConfig();
    } catch (error) {
      showRefreshWarning('Варіант створено', error);
    }
    return true;
  };

  const beginOptionEdit = (option) => {
    setEditOpt({
      id: option.db_id,
      value_id: String(option.id),
      sku_code: String(option.sku_code ?? option.id),
      label: option.label,
      label_en: option.label_en ?? '',
      visible_if_json: option.visible_if_json ? formatMatchJson(option.visible_if_json) : '',
      hidden_if_json: option.hidden_if_json ? formatMatchJson(option.hidden_if_json) : '',
      archived: option.archived === 1 || option.archived === true,
    });
  };

  const updateOption = async () => {
    if (!editOpt.id) return;

    const parsedVisibleRule = parseVisibleRuleInput(editOpt.visible_if_json);
    const parsedHiddenRule = parseVisibleRuleInput(editOpt.hidden_if_json);
    if (!parsedVisibleRule.ok) return showFeedback({ tone: 'error', title: 'Варіант не збережено', message: 'Перевірте умову показу.' });
    if (!parsedHiddenRule.ok) return showFeedback({ tone: 'error', title: 'Варіант не збережено', message: 'Перевірте умову приховування.' });

    try {
      await api.put('/admin/option', {
        id: editOpt.id,
        value_id: editOpt.value_id,
        sku_code: editOpt.sku_code,
        label: editOpt.label,
        label_en: editOpt.label_en || null,
        visible_if_json: parsedVisibleRule.value,
        hidden_if_json: parsedHiddenRule.value,
        archived: editOpt.archived,
      });
    } catch (error) {
      showFeedback({ tone: 'error', title: 'Не вдалося зберегти варіант', message: getApiError(error) });
      return false;
    }
    setEditOpt(emptyEditOption);
    showFeedback({ title: 'Варіант збережено' });
    try {
      await fetchConfig();
    } catch (error) {
      showRefreshWarning('Варіант збережено', error);
    }
    return true;
  };

  const archiveOption = async (option, archived) => {
    try {
      await api.patch(`/admin/option/${option.db_id}/archive`, { archived });
    } catch (error) {
      showFeedback({ tone: 'error', title: 'Не вдалося змінити стан варіанта', message: getApiError(error) });
      return false;
    }
    if (editOpt.id === option.db_id) setEditOpt(emptyEditOption);
    const successTitle = archived ? 'Варіант перенесено в архів' : 'Варіант повернено з архіву';
    showFeedback({ title: successTitle });
    try {
      await fetchConfig();
    } catch (error) {
      showRefreshWarning(successTitle, error);
    }
    return true;
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
    }).then(async () => {
      showFeedback({ title: 'Порядок питань збережено' });
      try {
        const nextConfig = await fetchConfig();
        applyConfigWithSelection(nextConfig, selectedCat.code);
      } catch (error) {
        showRefreshWarning('Порядок питань збережено', error);
      }
      return true;
    }).catch((error) => {
      fetchConfig().catch(() => {});
      showFeedback({ tone: 'error', title: 'Не вдалося зберегти порядок', message: getApiError(error) });
      return false;
    });
  };

  const reorderQuestions = (orderedQuestions) => persistQuestionOrder(orderedQuestions);

  const autoAssignSkuIndexes = () => {
    if (!selectedCat) return;
    const skuQuestionCount = currentCatQuestions.filter((question) => question.include_in_sku === 1).length;
    if (skuQuestionCount === 0) {
      showFeedback({ tone: 'error', title: 'Переіндексацію не виконано', message: 'У цій категорії немає питань, які додаються у внутрішній SKU.' });
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
    const labels = {
      category: selectedCat?.name,
      question: selectedQuestion?.label,
      option: currentOptions.find((option) => option.db_id === id)?.label,
      scenario: pricing.pricesData?.scenarios?.find((scenario) => scenario.id === id)?.name,
      modifier: pricing.pricesData?.modifiers?.find((modifier) => modifier.id === id)
        ? `модифікатор ×${pricing.pricesData.modifiers.find((modifier) => modifier.id === id).factor}`
        : '',
    };
    const typeLabels = { category: 'Категорія', question: 'Питання', option: 'Варіант', scenario: 'Сценарій', modifier: 'Модифікатор' };
    const descriptions = {
      category: 'Буде видалено всю конфігурацію цієї категорії.',
      question: 'Буде видалено питання з каталогу.',
      option: 'Буде видалено варіант відповіді.',
      scenario: 'Буде видалено ціновий сценарій.',
      modifier: 'Буде видалено ціновий модифікатор.',
    };
    const consequences = {
      category: 'Разом із категорією зникнуть її питання, варіанти, цінові сценарії, матриці, вагові діапазони та модифікатори.',
      question: 'Разом із питанням зникнуть усі його варіанти.',
      option: 'Варіант, який уже використано в товарах, видалити не можна — його можна перенести в архів.',
      scenario: 'Разом зі сценарієм зникнуть його матриця цін і вагові діапазони.',
      modifier: 'Правило та його множник більше не застосовуватимуться до нових розрахунків.',
    };
    setDeleteError('');
    setDeleteConfirmation({ type, id, label: labels[type] || typeLabels[type] || 'Елемент', description: descriptions[type], consequence: consequences[type] });
  };

  const cancelDelete = () => {
    if (!deleteBusy) {
      setDeleteConfirmation(null);
      setDeleteError('');
    }
  };

  const confirmDelete = async () => {
    if (!deleteConfirmation || deleteBusy) return;
    const { type, id } = deleteConfirmation;
    const successTitles = { category: 'Категорію видалено', question: 'Питання видалено', option: 'Варіант видалено', scenario: 'Сценарій видалено', modifier: 'Модифікатор видалено' };
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await api.post('/admin/delete-item', { type, id });
    } catch (error) {
      setDeleteError(getApiError(error));
      setDeleteBusy(false);
      return;
    }

    setDeleteConfirmation(null);
    setDeleteError('');
    if (type === 'category') {
      setSelectedCat(null);
      setSelectedQuestion(null);
      setEditOpt(emptyEditOption);
    }
    showFeedback({ title: successTitles[type] || 'Елемент видалено' });

    const refreshes = type === 'scenario' || type === 'modifier'
      ? [pricing.fetchPrices()]
      : [fetchConfig()];
    const refreshResults = await Promise.allSettled(refreshes);
    if (refreshResults.some((result) => result.status === 'rejected')) {
      showFeedback({
        tone: 'warning',
        title: `${successTitles[type] || 'Елемент видалено'}, але дані не оновлено`,
        message: 'Оновіть сторінку перед наступною зміною.',
      });
    }
    setDeleteBusy(false);
  };

  const discardLocalChanges = () => {
    setNewCat(emptyNewCategory);
    setNewQuest(buildNewQuestionDefaults(selectedCat ? (config?.questions?.[selectedCat.code] || []) : []));
    setNewOpt(emptyNewOption);
    setEditOpt(emptyEditOption);
    if (selectedCat) {
      setEditCat({
        code: selectedCat.code,
        name: selectedCat.name,
        requires_weight: selectedCat.requires_weight === 1,
        skip_hidden_sku_questions: selectedCat.skip_hidden_sku_questions === 1,
        marketing_rounding_enabled: selectedCat.marketing_rounding_enabled !== 0,
        code_mutable: selectedCat.code_mutable !== false,
      });
    }
    if (selectedQuestion) updateSelectedQuestionState(selectedQuestion);
    pricing.discardLocalChanges();
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
    canPublishSchema,
    canViewCatalog,
    canViewPricing,
    cancelDelete,
    config,
    configError,
    confirmDelete,
    deleteBusy,
    deleteConfirmation,
    deleteError,
    discardLocalChanges,
    canManageCatalog: auth.permissions.includes('catalog.manage'),
    clearFeedback: () => setFeedback(null),
    effectiveMode,
    feedback,
    retryConfig: () => { setConfigError(''); fetchConfig().catch((error) => setConfigError(getApiError(error))); },
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
