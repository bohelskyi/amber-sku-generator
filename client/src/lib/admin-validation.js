import { parseConditionRows } from './admin-conditions';

const normalizeValue = (value) => {
  if (value === null || value === undefined) return '';
  return String(value);
};

const buildQuestionMap = (questions) =>
  new Map((questions || []).map((question) => [question.id, question]));

const getRuleDependencies = (ruleValue) => {
  const parsed = parseConditionRows(ruleValue);
  if (!parsed.isValid) return null;
  return parsed.rows.map((row) => row.key).filter(Boolean);
};

const validateRule = ({
  category,
  ownerLabel,
  ownerQuestionId,
  questionMap,
  ruleValue,
  validationIssues,
}) => {
  if (!ruleValue) return [];

  const parsed = parseConditionRows(ruleValue);
  if (!parsed.isValid) {
    validationIssues.push(`Категорія ${category.code}: ${ownerLabel} має некоректну умову видимості`);
    return [];
  }

  const dependencies = [];

  parsed.rows.forEach((row) => {
    if (!row.key) {
      validationIssues.push(`Категорія ${category.code}: ${ownerLabel} має умову без вибраного питання`);
      return;
    }

    if (row.key === ownerQuestionId) {
      validationIssues.push(`Категорія ${category.code}: ${ownerLabel} залежить від самого себе`);
    }

    if (row.key === 'is_calibrated') {
      dependencies.push(row.key);
      return;
    }

    const sourceQuestion = questionMap.get(row.key);
    if (!sourceQuestion) {
      validationIssues.push(`Категорія ${category.code}: ${ownerLabel} посилається на неіснуючий key ${row.key}`);
      return;
    }

    dependencies.push(row.key);

    if ((sourceQuestion.input_type || 'options') === 'text') return;

    const validValues = new Set((sourceQuestion.options || []).map((option) => normalizeValue(option.id)));
    row.values.forEach((value) => {
      if (!validValues.has(normalizeValue(value))) {
        validationIssues.push(
          `Категорія ${category.code}: ${ownerLabel} має неіснуюче значення ${value} для ${sourceQuestion.label || row.key}`
        );
      }
    });
  });

  return dependencies;
};

const findQuestionVisibilityCycles = (questions) => {
  const graph = new Map();
  const questionIds = new Set((questions || []).map((question) => question.id));

  (questions || []).forEach((question) => {
    const dependencies = getRuleDependencies(question.visible_if_json) || [];
    graph.set(
      question.id,
      dependencies.filter((dependency) => questionIds.has(dependency))
    );
  });

  const cycles = [];
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  const visit = (questionId) => {
    if (visiting.has(questionId)) {
      const cycleStart = stack.indexOf(questionId);
      if (cycleStart >= 0) {
        cycles.push([...stack.slice(cycleStart), questionId]);
      }
      return;
    }

    if (visited.has(questionId)) return;

    visiting.add(questionId);
    stack.push(questionId);

    (graph.get(questionId) || []).forEach(visit);

    stack.pop();
    visiting.delete(questionId);
    visited.add(questionId);
  };

  questionIds.forEach(visit);

  const uniqueCycles = [];
  const seen = new Set();

  cycles.forEach((cycle) => {
    const key = cycle.join('>');
    if (seen.has(key)) return;
    seen.add(key);
    uniqueCycles.push(cycle);
  });

  return uniqueCycles;
};

const validateBranchingSkuDependencies = ({ category, question, questionMap, validationIssues }) => {
  if (category.skip_hidden_sku_questions !== 1 || question.include_in_sku !== 1) return;

  const parsed = parseConditionRows(question.visible_if_json);
  if (!parsed.isValid) return;

  parsed.rows.forEach((row) => {
    if (!row.key || row.key === 'is_calibrated') return;

    const sourceQuestion = questionMap.get(row.key);
    if (!sourceQuestion) return;

    if (sourceQuestion.include_in_sku !== 1) {
      validationIssues.push(
        `Категорія ${category.code}: гілкове SKU питання ${question.label || question.id} залежить від ${sourceQuestion.label || row.key}, але це питання не додається в SKU`
      );
      return;
    }

    if (Number(sourceQuestion.sku_index) >= Number(question.sku_index)) {
      validationIssues.push(
        `Категорія ${category.code}: гілкове SKU питання ${question.label || question.id} має залежати тільки від попередніх SKU-питань`
      );
    }
  });
};

export function getValidationIssues(config) {
  const validationIssues = [];
  if (!config?.categories || !config?.questions) return validationIssues;

  Object.values(config.categories).forEach((category) => {
    const questions = config.questions[category.code] || [];
    const questionMap = buildQuestionMap(questions);
    const keySet = new Set();
    const indexSet = new Set();

    questions.forEach((question) => {
      if (!question.label || question.label.trim().length === 0) {
        validationIssues.push(`Категорія ${category.code}: питання ${question.id} без назви`);
      }
      if (keySet.has(question.id)) {
        validationIssues.push(`Категорія ${category.code}: дубль key ${question.id}`);
      }
      keySet.add(question.id);

      if (question.include_in_sku === 1) {
        if (indexSet.has(question.sku_index)) {
          validationIssues.push(`Категорія ${category.code}: дубль індексу ${question.sku_index}`);
        }
        indexSet.add(question.sku_index);
      }

      if ((question.input_type || 'options') !== 'text' && (!question.options || question.options.length === 0)) {
        validationIssues.push(`Категорія ${category.code}: питання ${question.id} без варіантів`);
      }

      validateRule({
        category,
        ownerLabel: `питання ${question.label || question.id}`,
        ownerQuestionId: question.id,
        questionMap,
        ruleValue: question.visible_if_json,
        validationIssues,
      });

      validateBranchingSkuDependencies({
        category,
        question,
        questionMap,
        validationIssues,
      });

      (question.options || []).forEach((option) => {
        validateRule({
          category,
          ownerLabel: `варіант ${option.label || option.id} у питанні ${question.label || question.id}`,
          ownerQuestionId: question.id,
          questionMap,
          ruleValue: option.visible_if_json,
          validationIssues,
        });
        validateRule({
          category,
          ownerLabel: `умова приховування варіанта ${option.label || option.id} у питанні ${question.label || question.id}`,
          ownerQuestionId: question.id,
          questionMap,
          ruleValue: option.hidden_if_json,
          validationIssues,
        });
      });
    });

    findQuestionVisibilityCycles(questions).forEach((cycle) => {
      validationIssues.push(`Категорія ${category.code}: цикл видимості питань ${cycle.join(' -> ')}`);
    });
  });

  return validationIssues;
}
