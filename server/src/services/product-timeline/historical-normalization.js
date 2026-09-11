const { getAnswerChanges } = require('../../utils/answer-changes');
const { asRuleObject, isRuleMatched } = require('../../utils/rules');

const CALIBRATION_STATES = new Map([
  [0, 'Некалібрована'],
  [1, 'Калібрована'],
  [2, 'Напівкалібрована'],
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sameValue(first, second) {
  if (first === null || first === undefined || first === '') {
    return second === null || second === undefined || second === '';
  }
  if (second === null || second === undefined || second === '') return false;
  const firstNumber = Number(first);
  const secondNumber = Number(second);
  if (Number.isFinite(firstNumber) && Number.isFinite(secondNumber)) {
    return firstNumber === secondNumber;
  }
  return String(first) === String(second);
}

function buildSchemaMap(rows) {
  const schemas = new Map();
  for (const row of rows) {
    const schemaId = Number(row.schema_version_id);
    if (!schemas.has(schemaId)) schemas.set(schemaId, new Map());
    const questions = schemas.get(schemaId);
    if (!questions.has(row.question_key)) {
      questions.set(row.question_key, {
        key: row.question_key,
        label: row.question_label,
        options: [],
      });
    }
    if (row.option_id !== null && row.option_id !== undefined) {
      questions.get(row.question_key).options.push({
        value: row.value_id,
        label: row.option_label,
        visibleIf: row.visible_if_json,
        hiddenIf: row.hidden_if_json,
      });
    }
  }
  return schemas;
}

function findSchemaOption(question, value, answers) {
  if (!question) return null;
  const candidates = question.options.filter((option) => sameValue(option.value, value));
  return candidates.find((option) => (
    option.visibleIf
    && isRuleMatched(asRuleObject(option.visibleIf), answers)
    && !(option.hiddenIf && isRuleMatched(asRuleObject(option.hiddenIf), answers))
  )) || candidates.find((option) => !option.visibleIf && !option.hiddenIf) || candidates[0] || null;
}

function getDecodedAnswer(payload, key, value) {
  return (Array.isArray(payload?.decodedAnswers) ? payload.decodedAnswers : [])
    .find((answer) => answer.key === key && sameValue(answer.value_id, value)) || null;
}

function normalizeValue(value, payload, schema, key) {
  if (value === null || value === undefined || value === '') {
    return { value: null, label: null };
  }
  const historical = getDecodedAnswer(payload, key, value);
  if (historical?.value_label) {
    return { value, label: historical.value_label };
  }
  const answers = asObject(payload?.answers);
  const option = findSchemaOption(schema?.get(key), value, answers);
  if (option?.label) return { value, label: option.label };
  if (key === 'is_calibrated' && CALIBRATION_STATES.has(Number(value))) {
    return { value, label: CALIBRATION_STATES.get(Number(value)) };
  }
  if (Number(value) === 0) return { value, label: 'Не вказано' };
  return { value, label: null };
}

function getPayloadSchema(schemas, payload, fallbackSchemaId) {
  const payloadSchemaId = nullableNumber(payload?.skuSchemaVersionId);
  return schemas.get(payloadSchemaId) || schemas.get(nullableNumber(fallbackSchemaId));
}

function normalizeStoredChanges({
  oldPayload,
  newPayload,
  oldSchema,
  newSchema,
  storedChanges,
}) {
  const oldAnswers = asObject(oldPayload?.answers);
  const newAnswers = asObject(newPayload?.answers);
  const answerChanges = Array.isArray(storedChanges)
    ? storedChanges.filter((change) => change?.key && change.key !== 'weight')
    : getAnswerChanges(oldAnswers, newAnswers);
  const changes = answerChanges.map((change) => {
    const key = String(change.key);
    const historical = getDecodedAnswer(oldPayload, key, change.from);
    const question = oldSchema?.get(key) || newSchema?.get(key);
    const fieldLabel = question?.label || (key === 'is_calibrated' ? 'Калібрування' : null);
    return {
      kind: 'answer',
      fieldKey: key,
      fieldLabel: historical?.label || fieldLabel,
      before: normalizeValue(change.from, oldPayload, oldSchema, key),
      after: normalizeValue(change.to, newPayload, newSchema, key),
      labelStatus: historical?.label || question?.label
        ? 'historical_schema'
        : fieldLabel ? 'stable_domain' : 'not_recorded',
    };
  });
  const storedWeight = Array.isArray(storedChanges)
    ? storedChanges.find((change) => change?.key === 'weight')
    : null;
  const oldWeight = storedWeight ? storedWeight.from : oldPayload?.weight;
  const newWeight = storedWeight ? storedWeight.to : newPayload?.weight;
  if (storedWeight || !sameValue(oldWeight, newWeight)) {
    changes.push({
      kind: 'weight',
      fieldKey: 'weight',
      fieldLabel: null,
      before: { value: nullableNumber(oldWeight), label: null },
      after: { value: nullableNumber(newWeight), label: null },
      labelStatus: 'not_applicable',
    });
  }
  return changes;
}

module.exports = {
  asObject,
  buildSchemaMap,
  getPayloadSchema,
  normalizeStoredChanges,
  nullableNumber,
};
