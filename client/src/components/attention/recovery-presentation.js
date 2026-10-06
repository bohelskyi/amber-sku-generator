const dispositions = Object.freeze({
  quarantined_do_not_import: 'Оператор підтвердив: файл вилучено з подальшого імпорту.',
  consumed_and_reconciled: 'Оператор підтвердив: файл імпортовано, результат імпорту узгоджено.',
  verified_absent: 'Оператор підтвердив перевірку відсутності попереднього артикула в Magento.',
  retired_reconciled: 'Оператор підтвердив: попередню версію виведено з обігу та узгоджено.',
  resolved: 'Оператор підтвердив: зовнішню історію узгоджено.',
  authorized: 'Оператор явно підтвердив дозвіл на повторну доставку.',
});

export function selectedEvidence(disposition) {
  return dispositions[disposition] || '';
}

export function missingRecoveryEvidence(requirements, evidence) {
  if (!requirements || !evidence) return [];
  const missing = [];
  if (requirements.historicalConfirmation && evidence.confirmation?.disposition !== 'current_update_only') {
    missing.push('Підтвердіть, що поточний товар можна оновлювати.');
  }
  if ((requirements.files || []).some((_, index) => !evidence.files?.[index]?.disposition || !evidence.files[index].evidence?.trim())) {
    missing.push('Вкажіть долю кожного старого файлу: не імпортуватиметься або імпорт уже узгоджено.');
  }
  if ((requirements.oldSkus || []).some((_, index) => !evidence.oldSkus?.[index]?.disposition || !evidence.oldSkus[index].evidence?.trim())) {
    missing.push('Підтвердіть перевірений стан кожного попереднього артикула.');
  }
  for (const [required, key, message] of [
    ['externalHistory', 'externalHistory', 'Підтвердіть узгодження зовнішньої історії.'],
    ['exclusionResolution', 'exclusionResolution', 'Вкажіть підставу для зняття виключення із синхронізації.'],
    ['redeliveryEvidence', 'redeliveryAuthorization', 'Підтвердіть дозвіл на повторну доставку.'],
  ]) {
    if (requirements[required] && (!evidence[key]?.disposition || evidence[key].evidence?.trim().length < 3)) missing.push(message);
  }
  return missing;
}

// Facts already sealed in the server review stay in that review. This text
// records the action selected by the operator, never invents a remote fact.
export function decisionReason(kind, comment = '') {
  const decisions = {
    historical_recount_exposure: 'Оператор підтвердив оновлення поточної версії за перевіреним сервером планом і явно вибраними свідченнями щодо старих файлів.',
    stable_recount_exposure: 'Оператор підтвердив узгодження поточної версії після переобліку за перевіреним сервером планом.',
    prior_exposure: 'Оператор підтвердив запис перевіреної сервером наявності поточного товару.',
    reconcile: 'Оператор підтвердив запис перевіреного сервером результату початкової операції.',
    continue: 'Оператор підтвердив надсилання лише перевірених ненадісланих кроків початкової операції.',
  };
  const note = String(comment || '').trim();
  const selected = decisions[kind];
  return selected ? `${selected}${note ? ` Коментар: ${note}` : ''}`.slice(0, 2000) : note;
}

export function verifiedRecoveryFacts(lifecycle) {
  const review = lifecycle?.review;
  if (!review) return [];
  const facts = [];
  const remote = review.payload?.sync?.remote || review.payload?.remote;
  if (remote?.status === 'found' || Number.isSafeInteger(remote?.id) && remote.id > 0) {
    facts.push({ key: 'current', label: 'Поточний товар знайдено в Magento', value: remote.sku || review.article });
  }
  const previous = review.payload?.sync?.oldArticles;
  if (previous?.length && previous.every((item) => item.status === 'not_found')) {
    facts.push({ key: 'previous', label: 'Попередні артикули відсутні в Magento', value: `${previous.length} перевірено` });
  }
  if (review.kind === 'historical_recount_exposure' && lifecycle.eligible === true && !lifecycle.blockers?.length) {
    facts.push({ key: 'history', label: 'Історію версій і доставки перевірено', value: 'Умови серверної перевірки виконано' });
  }
  return facts;
}
