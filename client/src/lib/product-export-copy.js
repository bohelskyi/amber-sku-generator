export function getNewProductCopy(rawCount) {
  const count = Number(rawCount) || 0;
  const plural = new Intl.PluralRules('uk').select(count);
  const noun = plural === 'one' ? 'новий товар'
    : plural === 'few' ? 'нові товари' : 'нових товарів';
  const countLabel = `${count} ${noun}`;
  return {
    countLabel,
    pendingLabel: `${countLabel} ${plural === 'one' ? 'очікує' : 'очікують'} експорту`,
    previewLabel: `Перевірити ${countLabel}`,
  };
}
