function getAnswerChanges(previousAnswers = {}, nextAnswers = {}) {
  const keys = new Set([
    ...Object.keys(previousAnswers),
    ...Object.keys(nextAnswers),
  ]);

  return Array.from(keys)
    .filter((key) => String(previousAnswers[key] ?? '') !== String(nextAnswers[key] ?? ''))
    .map((key) => ({
      key,
      from: previousAnswers[key] ?? null,
      to: nextAnswers[key] ?? null,
    }));
}

module.exports = { getAnswerChanges };
