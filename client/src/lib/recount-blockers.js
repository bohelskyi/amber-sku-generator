import {
  getVisibleOptionsForQuestion,
  isQuestionVisible,
  isTextQuestion,
} from './sku-visibility.js';

const hasAnswer = (value) =>
  value !== undefined && value !== null && String(value).trim() !== '';

const hasOptionValue = (options, value) =>
  options.some((option) => String(option.id) === String(value));

export function getRecountFieldBlockers({
  questions = [],
  answers = {},
  isCalibrated = answers.is_calibrated ?? null,
  serverMessage = '',
} = {}) {
  const blockers = [];

  for (const question of questions) {
    if (!isQuestionVisible(question, answers, isCalibrated)) continue;

    const value = answers[question.id];
    const answered = hasAnswer(value);
    if (question.required === 1 && !answered) {
      blockers.push({
        questionId: question.id,
        message: `Заповніть обов’язкове поле «${question.label}».`,
      });
      continue;
    }

    if (!answered || isTextQuestion(question)) continue;

    const configuredOptions = question.options || [];
    const isOptionalPlaceholder = question.required !== 1
      && Number(value) === 0
      && !hasOptionValue(configuredOptions, value);
    if (isOptionalPlaceholder) continue;

    const visibleOptions = getVisibleOptionsForQuestion(
      question,
      answers,
      isCalibrated
    );
    if (!hasOptionValue(visibleOptions, value)) {
      blockers.push({
        questionId: question.id,
        message: `Значення «${value}» недоступне для поля «${question.label}».`,
      });
    }
  }

  if (!serverMessage) return blockers;
  const matchingIndex = blockers.findIndex((blocker) => {
    const question = questions.find((item) => item.id === blocker.questionId);
    return question?.label && serverMessage.includes(`«${question.label}»`);
  });
  if (matchingIndex < 0) return blockers;

  return blockers.map((blocker, index) => (
    index === matchingIndex ? { ...blocker, message: serverMessage } : blocker
  ));
}

export function formatRecountBlockerSummary(count) {
  const normalizedCount = Number(count) || 0;
  const modulo10 = normalizedCount % 10;
  const modulo100 = normalizedCount % 100;
  const noun = modulo10 === 1 && modulo100 !== 11
    ? 'обов’язкове поле'
    : modulo10 >= 2 && modulo10 <= 4 && (modulo100 < 12 || modulo100 > 14)
      ? 'обов’язкові поля'
      : 'обов’язкових полів';
  return `Заповніть ${normalizedCount} ${noun}`;
}

export function focusFirstRecountBlocker(root) {
  const firstBlocker = root?.querySelector?.('[data-recount-blocker="true"]');
  if (!firstBlocker) return false;

  firstBlocker.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  firstBlocker.focus?.({ preventScroll: true });
  return true;
}
