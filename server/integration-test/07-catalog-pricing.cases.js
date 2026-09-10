const suite = require('./suite-context');
const {
  assert,
  test,
  pool,
  request,
  authenticateApplicationSession,
  schemas,
} = suite;

test('duplicate question invariant is atomic across independent transactions', async () => {
  const questionKey = `concurrent_question_${Date.now()}`;
  const worker = async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO questions
         (category_code, key, label, sku_index, display_order, required, include_in_sku, input_type)
         VALUES ('ZZ', $1, 'Concurrent', 99, 99, 0, 0, 'text')`,
        [questionKey]
      );
      await client.query('SELECT pg_sleep(0.15)');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  const outcomes = await Promise.allSettled([worker(), worker()]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  assert.equal(outcomes.find((outcome) => outcome.status === 'rejected').reason.code, '23505');
  const stored = await pool.query(
    'SELECT count(*)::int AS count FROM questions WHERE category_code = $1 AND key = $2',
    ['ZZ', questionKey]
  );
  assert.equal(stored.rows[0].count, 1);
});

test('question-key updates rewrite every live reference while published schemas stay immutable', async () => {
  if (!suite.authenticatedSession) suite.authenticatedSession = await authenticateApplicationSession('/admin');
  const categoryCode = 'KR';
  const oldKey = 'old_key';
  const newKey = 'renamed_key';
  await pool.query(
    `INSERT INTO categories (code, name, requires_weight, skip_hidden_sku_questions)
     VALUES ($1, 'Key rewrite', 0, 0)`,
    [categoryCode]
  );
  const questions = await pool.query(
    `INSERT INTO questions
       (category_code, key, label, sku_index, display_order, required,
        include_in_sku, input_type, visible_if_json)
     VALUES
       ($1, $2, 'Original key', 1, 1, 1, 1, 'options', NULL),
       ($1, 'other_key', 'Other key', 2, 2, 1, 1, 'options', NULL),
       ($1, 'dependent_key', 'Dependent', 0, 3, 0, 0, 'text',
        '{"$and":[{"old_key":1},{"$or":[{"old_key":[1,2]},{"other_key":2}]}]}'::jsonb)
     RETURNING id, key`,
    [categoryCode, oldKey]
  );
  const questionIds = Object.fromEntries(
    questions.rows.map((question) => [question.key, Number(question.id)])
  );
  const options = await pool.query(
    `INSERT INTO options
       (question_id, value_id, sku_code, label, visible_if_json, hidden_if_json)
     VALUES
       ($1, 1, '1', 'Original one', NULL, NULL),
       ($2, 2, '2', 'Other two',
        '{"$or":[{"old_key":1},{"other_key":2}]}'::jsonb,
        '{"$and":[{"old_key":[2]},{"other_key":1}]}'::jsonb)
     RETURNING id, question_id`,
    [questionIds[oldKey], questionIds.other_key]
  );
  const dependentOptionId = Number(
    options.rows.find((option) => Number(option.question_id) === questionIds.other_key).id
  );
  const scenario = await pool.query(
    `INSERT INTO price_scenarios
       (category_code, name, match_json, axis_x_key, axis_y_key, price_mode, status)
     VALUES
       ($1, 'Rewrite scenario',
        '{"$or":[{"old_key":1},{"$and":[{"other_key":2},{"old_key":[1,2]}]}]}'::jsonb,
        'old_key+other_key', 'other_key+old_key', 'fixed_uah', 'active')
     RETURNING id`,
    [categoryCode]
  );
  const modifier = await pool.query(
    `INSERT INTO price_modifiers
       (category_code, trigger_key, trigger_val, match_json, factor)
     VALUES
       ($1, $2, 1,
        '{"$and":[{"old_key":1},{"$or":[{"other_key":2},{"old_key":2}]}]}'::jsonb,
        1.1)
     RETURNING id`,
    [categoryCode, oldKey]
  );

  const publication = await request(`/api/admin/sku-schema/${categoryCode}/publish`, {
    method: 'POST',
  });
  assert.equal(publication.response.status, 200, publication.text);
  const schemaVersionId = Number(publication.data.id);
  const publishedBefore = await pool.query(
    `SELECT sq.question_key, sq.visible_if_json, so.value_id, so.sku_code,
            so.visible_if_json AS option_visible_if_json,
            so.hidden_if_json AS option_hidden_if_json
     FROM sku_schema_questions sq
     LEFT JOIN sku_schema_options so ON so.schema_question_id = sq.id
     WHERE sq.schema_version_id = $1
     ORDER BY sq.question_key, so.value_id`,
    [schemaVersionId]
  );
  await pool.query(
    `INSERT INTO products
       (full_sku, base_sku, sequence_number, category, weight, total_price,
        total_price_uah, price_per_gram, uah_rate, details, sku_schema_version_id)
     VALUES
       ('KR12001', 'KR12', 1, $1, 0, 25, 1000, 0, 40,
        '{"answers":{"old_key":1,"other_key":2},"isCalibrated":0}'::jsonb, $2)`,
    [categoryCode, schemaVersionId]
  );

  const renamed = await request('/api/admin/question/update', {
    method: 'POST',
    body: {
      id: questionIds[oldKey],
      key: newKey,
      label: 'Original key',
      sku_index: 1,
      display_order: 1,
      required: 1,
      include_in_sku: 1,
      input_type: 'options',
      sku_separator: '',
      visible_if_json: null,
    },
  });
  assert.equal(renamed.response.status, 200, renamed.text);
  assert.deepEqual(renamed.data, { success: true, key: newKey });

  const rewritten = await pool.query(
    `SELECT
       (SELECT visible_if_json FROM questions WHERE id = $1) AS question_rule,
       (SELECT visible_if_json FROM options WHERE id = $2) AS option_visible_rule,
       (SELECT hidden_if_json FROM options WHERE id = $2) AS option_hidden_rule,
       (SELECT match_json FROM price_scenarios WHERE id = $3) AS scenario_rule,
       (SELECT axis_x_key FROM price_scenarios WHERE id = $3) AS axis_x_key,
       (SELECT axis_y_key FROM price_scenarios WHERE id = $3) AS axis_y_key,
       (SELECT match_json FROM price_modifiers WHERE id = $4) AS modifier_rule,
       (SELECT trigger_key FROM price_modifiers WHERE id = $4) AS trigger_key,
       (SELECT details->'answers' FROM products WHERE full_sku = 'KR12001') AS product_answers`,
    [
      questionIds.dependent_key,
      dependentOptionId,
      Number(scenario.rows[0].id),
      Number(modifier.rows[0].id),
    ]
  );
  assert.deepEqual(rewritten.rows[0], {
    question_rule: {
      $and: [
        { [newKey]: 1 },
        { $or: [{ [newKey]: [1, 2] }, { other_key: 2 }] },
      ],
    },
    option_visible_rule: { $or: [{ [newKey]: 1 }, { other_key: 2 }] },
    option_hidden_rule: { $and: [{ [newKey]: [2] }, { other_key: 1 }] },
    scenario_rule: {
      $or: [
        { [newKey]: 1 },
        { $and: [{ other_key: 2 }, { [newKey]: [1, 2] }] },
      ],
    },
    axis_x_key: `${newKey}+other_key`,
    axis_y_key: `other_key+${newKey}`,
    modifier_rule: {
      $and: [
        { [newKey]: 1 },
        { $or: [{ other_key: 2 }, { [newKey]: 2 }] },
      ],
    },
    trigger_key: newKey,
    product_answers: { [newKey]: 1, other_key: 2 },
  });

  const publishedAfter = await pool.query(
    `SELECT sq.question_key, sq.visible_if_json, so.value_id, so.sku_code,
            so.visible_if_json AS option_visible_if_json,
            so.hidden_if_json AS option_hidden_if_json
     FROM sku_schema_questions sq
     LEFT JOIN sku_schema_options so ON so.schema_question_id = sq.id
     WHERE sq.schema_version_id = $1
     ORDER BY sq.question_key, so.value_id`,
    [schemaVersionId]
  );
  assert.deepEqual(publishedAfter.rows, publishedBefore.rows);
  assert.ok(publishedAfter.rows.some((row) => row.question_key === oldKey));
  assert.ok(!publishedAfter.rows.some((row) => row.question_key === newKey));
});

test('used option semantic values are rejected without partially changing the option', async () => {
  if (!suite.authenticatedSession) suite.authenticatedSession = await authenticateApplicationSession('/admin');
  const categoryCode = 'UV';
  await pool.query(
    `INSERT INTO categories (code, name, requires_weight, skip_hidden_sku_questions)
     VALUES ($1, 'Used values', 0, 0)`,
    [categoryCode]
  );
  const question = await pool.query(
    `INSERT INTO questions
       (category_code, key, label, sku_index, display_order, required, include_in_sku, input_type)
     VALUES ($1, 'kind', 'Kind', 1, 1, 1, 1, 'options')
     RETURNING id`,
    [categoryCode]
  );
  const option = await pool.query(
    `INSERT INTO options (question_id, value_id, sku_code, label)
     VALUES ($1, 1, '1', 'Original meaning') RETURNING id`,
    [question.rows[0].id]
  );
  const publication = await request(`/api/admin/sku-schema/${categoryCode}/publish`, {
    method: 'POST',
  });
  assert.equal(publication.response.status, 200, publication.text);
  await pool.query(
    `INSERT INTO products
       (full_sku, base_sku, sequence_number, category, weight, total_price,
        total_price_uah, price_per_gram, uah_rate, details, sku_schema_version_id)
     VALUES
       ('UV1001', 'UV1', 1, $1, 0, 25, 1000, 0, 40,
        '{"answers":{"kind":1},"isCalibrated":0}'::jsonb, $2)`,
    [categoryCode, Number(publication.data.id)]
  );

  const rejected = await request('/api/admin/option', {
    method: 'PUT',
    body: {
      id: Number(option.rows[0].id),
      value_id: 9,
      sku_code: '9',
      label: 'Reinterpreted meaning',
      visible_if_json: null,
      hidden_if_json: null,
      archived: false,
    },
  });
  assert.equal(rejected.response.status, 409, rejected.text);
  assert.match(rejected.data.error, /використовується у 1 товарах і не може бути змінений/);

  const stored = await pool.query(
    `SELECT value_id, sku_code, label, visible_if_json, hidden_if_json, archived
     FROM options WHERE id = $1`,
    [Number(option.rows[0].id)]
  );
  assert.deepEqual(stored.rows[0], {
    value_id: 1,
    sku_code: '1',
    label: 'Original meaning',
    visible_if_json: null,
    hidden_if_json: null,
    archived: false,
  });
  const product = await pool.query(
    `SELECT details->'answers' AS answers FROM products WHERE full_sku = 'UV1001'`
  );
  assert.deepEqual(product.rows[0].answers, { kind: 1 });
});

test('price-cell API stores only positive prices and treats empty or missing price as deletion', async () => {
  const cell = {
    scenario_id: schemas.ZZScenario,
    x_val: 999,
    y_val: 0,
  };
  const readCell = () => pool.query(
    `SELECT price FROM price_matrix
     WHERE scenario_id = $1 AND x_val = $2 AND y_val = $3`,
    [cell.scenario_id, cell.x_val, cell.y_val]
  );

  try {
    const created = await request('/api/admin/price-cell', {
      method: 'POST',
      body: { ...cell, price: '12.50' },
    });
    assert.equal(created.response.status, 200, created.text);
    assert.equal(Number((await readCell()).rows[0].price), 12.5);

    const zero = await request('/api/admin/price-cell', {
      method: 'POST',
      body: { ...cell, price: 0 },
    });
    assert.equal(zero.response.status, 400, zero.text);
    assert.match(zero.data.error, /більшим за 0/);
    assert.equal(Number((await readCell()).rows[0].price), 12.5);

    const blank = await request('/api/admin/price-cell', {
      method: 'POST',
      body: { ...cell, price: '   ' },
    });
    assert.equal(blank.response.status, 200, blank.text);
    assert.equal((await readCell()).rows.length, 0);

    await request('/api/admin/price-cell', {
      method: 'POST',
      body: { ...cell, price: 8 },
    });
    const missing = await request('/api/admin/price-cell', {
      method: 'POST',
      body: cell,
    });
    assert.equal(missing.response.status, 200, missing.text);
    assert.equal((await readCell()).rows.length, 0);
  } finally {
    await pool.query(
      `DELETE FROM price_matrix
       WHERE scenario_id = $1 AND x_val = $2 AND y_val = $3`,
      [cell.scenario_id, cell.x_val, cell.y_val]
    );
  }
});

test('catalog and pricing configuration mutations write concise semantic audit events', async () => {
  if (!suite.authenticatedSession) suite.authenticatedSession = await authenticateApplicationSession('/admin');
  const categoryCode = `A${Date.now().toString().slice(-8)}`;
  const actorUserId = Number(suite.authenticatedSession.applicationUser.id);
  const mutationOptions = (requestId) => ({ headers: { 'X-Request-ID': requestId } });

  const createdCategory = await request('/api/admin/category', {
    method: 'POST',
    body: {
      code: categoryCode,
      name: 'Audit category',
      requires_weight: 0,
      skip_hidden_sku_questions: 0,
    },
    ...mutationOptions('audit-category-created'),
  });
  assert.equal(createdCategory.response.status, 200, createdCategory.text);

  const updatedCategory = await request('/api/admin/category', {
    method: 'PUT',
    body: {
      code: categoryCode,
      next_code: categoryCode,
      name: 'Audited category',
      requires_weight: 0,
      skip_hidden_sku_questions: 0,
    },
    ...mutationOptions('audit-category-updated'),
  });
  assert.equal(updatedCategory.response.status, 200, updatedCategory.text);

  const questionPayload = {
    category_code: categoryCode,
    key: 'audit_kind',
    label: 'Audit kind',
    sku_index: 1,
    display_order: 1,
    required: 1,
    include_in_sku: 1,
    input_type: 'options',
    sku_separator: '',
  };
  const createdQuestion = await request('/api/admin/question', {
    method: 'POST',
    body: questionPayload,
    ...mutationOptions('audit-question-created'),
  });
  assert.equal(createdQuestion.response.status, 200, createdQuestion.text);
  const questionId = Number(createdQuestion.data.id);

  const updatedQuestionPayload = {
    ...questionPayload,
    id: questionId,
    label: 'Audited kind',
  };
  const updatedQuestion = await request('/api/admin/question', {
    method: 'PUT',
    body: updatedQuestionPayload,
    ...mutationOptions('audit-question-updated'),
  });
  assert.equal(updatedQuestion.response.status, 200, updatedQuestion.text);
  const noOpQuestion = await request('/api/admin/question', {
    method: 'PUT',
    body: updatedQuestionPayload,
    ...mutationOptions('audit-question-no-op'),
  });
  assert.equal(noOpQuestion.response.status, 200, noOpQuestion.text);

  const reordered = await request('/api/admin/questions/order', {
    method: 'PUT',
    body: {
      category_code: categoryCode,
      questions: [{ id: questionId, display_order: 2, sku_index: 1 }],
    },
    ...mutationOptions('audit-question-reordered'),
  });
  assert.equal(reordered.response.status, 200, reordered.text);
  const noOpReorder = await request('/api/admin/questions/order', {
    method: 'PUT',
    body: {
      category_code: categoryCode,
      questions: [{ id: questionId, display_order: 2, sku_index: 1 }],
    },
    ...mutationOptions('audit-question-reorder-no-op'),
  });
  assert.equal(noOpReorder.response.status, 200, noOpReorder.text);

  const createdOption = await request('/api/admin/option', {
    method: 'POST',
    body: {
      question_id: questionId,
      value_id: 1,
      sku_code: '01',
      label: 'Audit option',
    },
    ...mutationOptions('audit-option-created'),
  });
  assert.equal(createdOption.response.status, 200, createdOption.text);
  const optionId = Number(createdOption.data.id);
  const updatedOption = await request('/api/admin/option', {
    method: 'PUT',
    body: {
      id: optionId,
      value_id: 1,
      sku_code: '01',
      label: 'Audited option',
    },
    ...mutationOptions('audit-option-updated'),
  });
  assert.equal(updatedOption.response.status, 200, updatedOption.text);
  const archivedOption = await request(`/api/admin/option/${optionId}/archive`, {
    method: 'PATCH',
    body: { archived: true },
    ...mutationOptions('audit-option-archived'),
  });
  assert.equal(archivedOption.response.status, 200, archivedOption.text);
  const noOpArchive = await request(`/api/admin/option/${optionId}/archive`, {
    method: 'PATCH',
    body: { archived: true },
    ...mutationOptions('audit-option-archive-no-op'),
  });
  assert.equal(noOpArchive.response.status, 200, noOpArchive.text);

  const scenarioPayload = {
    category_code: categoryCode,
    name: 'Audit scenario',
    group_name: 'Audit group',
    match_json: { audit_kind: 1 },
    axis_x_key: 'weight_band',
    axis_y_key: '',
    priority: 0,
    status: 'draft',
    price_mode: 'fixed_uah',
    apply_modifiers: true,
    weight_bands: [
      { label: 'Light', min_weight: 0, max_weight: 10 },
      { label: 'Heavy', min_weight: 10, max_weight: null },
    ],
  };
  const createdScenario = await request('/api/admin/scenario', {
    method: 'POST',
    body: scenarioPayload,
    ...mutationOptions('audit-scenario-created'),
  });
  assert.equal(createdScenario.response.status, 200, createdScenario.text);
  const scenarioId = Number(createdScenario.data.id);
  const storedBands = await pool.query(
    `SELECT id, label, min_weight, max_weight
     FROM price_weight_bands
     WHERE scenario_id = $1
     ORDER BY sort_order`,
    [scenarioId]
  );
  assert.equal(storedBands.rows.length, 2);

  const updatedScenarioPayload = {
    ...scenarioPayload,
    id: scenarioId,
    priority: 2,
    weight_bands: storedBands.rows.map((band, index) => ({
      id: Number(band.id),
      label: index === 0 ? 'Small' : band.label,
      min_weight: Number(band.min_weight),
      max_weight: band.max_weight === null ? null : Number(band.max_weight),
    })),
  };
  const updatedScenario = await request('/api/admin/scenario', {
    method: 'PUT',
    body: updatedScenarioPayload,
    ...mutationOptions('audit-scenario-updated'),
  });
  assert.equal(updatedScenario.response.status, 200, updatedScenario.text);
  const noOpScenario = await request('/api/admin/scenario', {
    method: 'PUT',
    body: updatedScenarioPayload,
    ...mutationOptions('audit-scenario-no-op'),
  });
  assert.equal(noOpScenario.response.status, 200, noOpScenario.text);

  const firstBandId = Number(storedBands.rows[0].id);
  const cell = { scenario_id: scenarioId, x_val: firstBandId, y_val: 0 };
  const setCell = await request('/api/admin/price-cell', {
    method: 'POST',
    body: { ...cell, price: 125.5 },
    ...mutationOptions('audit-matrix-set'),
  });
  assert.equal(setCell.response.status, 200, setCell.text);
  const noOpCell = await request('/api/admin/price-cell', {
    method: 'POST',
    body: { ...cell, price: 125.5 },
    ...mutationOptions('audit-matrix-no-op'),
  });
  assert.equal(noOpCell.response.status, 200, noOpCell.text);
  const invalidCell = await request('/api/admin/price-cell', {
    method: 'POST',
    body: { ...cell, price: 0 },
    ...mutationOptions('audit-matrix-invalid'),
  });
  assert.equal(invalidCell.response.status, 400, invalidCell.text);
  const deleteCell = await request('/api/admin/price-cell', {
    method: 'POST',
    body: cell,
    ...mutationOptions('audit-matrix-deleted'),
  });
  assert.equal(deleteCell.response.status, 200, deleteCell.text);
  const noOpDeleteCell = await request('/api/admin/price-cell', {
    method: 'POST',
    body: cell,
    ...mutationOptions('audit-matrix-delete-no-op'),
  });
  assert.equal(noOpDeleteCell.response.status, 200, noOpDeleteCell.text);

  const createdModifier = await request('/api/admin/modifier', {
    method: 'POST',
    body: {
      category_code: categoryCode,
      match_json: { audit_kind: 1 },
      factor: 1.1,
    },
    ...mutationOptions('audit-modifier-created'),
  });
  assert.equal(createdModifier.response.status, 200, createdModifier.text);
  const modifierId = Number(createdModifier.data.id);
  const updatedModifier = await request('/api/admin/modifier', {
    method: 'PUT',
    body: { id: modifierId, factor: 1.2 },
    ...mutationOptions('audit-modifier-updated'),
  });
  assert.equal(updatedModifier.response.status, 200, updatedModifier.text);
  const noOpModifier = await request('/api/admin/modifier', {
    method: 'PUT',
    body: { id: modifierId, factor: 1.2 },
    ...mutationOptions('audit-modifier-no-op'),
  });
  assert.equal(noOpModifier.response.status, 200, noOpModifier.text);

  const duplicatedScenario = await request('/api/admin/scenario/duplicate', {
    method: 'POST',
    body: { id: scenarioId },
    ...mutationOptions('audit-scenario-duplicated'),
  });
  assert.equal(duplicatedScenario.response.status, 200, duplicatedScenario.text);
  const duplicateScenarioId = Number(duplicatedScenario.data.id);

  const deletedModifier = await request('/api/admin/delete-item', {
    method: 'POST', body: { type: 'modifier', id: modifierId },
    ...mutationOptions('audit-modifier-deleted'),
  });
  assert.equal(deletedModifier.response.status, 200, deletedModifier.text);
  for (const deletedScenarioId of [duplicateScenarioId, scenarioId]) {
    const deletedScenario = await request('/api/admin/delete-item', {
      method: 'POST', body: { type: 'scenario', id: deletedScenarioId },
      ...mutationOptions(`audit-scenario-deleted-${deletedScenarioId}`),
    });
    assert.equal(deletedScenario.response.status, 200, deletedScenario.text);
  }
  for (const [type, id] of [['option', optionId], ['question', questionId], ['category', categoryCode]]) {
    const deleted = await request('/api/admin/delete-item', {
      method: 'POST', body: { type, id },
      ...mutationOptions(`audit-${type}-deleted`),
    });
    assert.equal(deleted.response.status, 200, deleted.text);
  }

  const auditEvents = await pool.query(
    `SELECT event_key, subject_type, subject_id, actor_user_id, request_id, details
     FROM audit_events
     WHERE details->>'categoryCode' = $1
        OR (event_key LIKE 'catalog.category.%' AND subject_id = $1)
     ORDER BY id`,
    [categoryCode]
  );
  assert.deepEqual(
    auditEvents.rows.map((event) => event.event_key),
    [
      'catalog.category.created',
      'catalog.category.updated',
      'catalog.question.created',
      'catalog.question.updated',
      'catalog.question.reordered',
      'catalog.option.created',
      'catalog.option.updated',
      'catalog.option.archived',
      'pricing.scenario.created',
      'pricing.scenario.updated',
      'pricing.matrix_cell.set',
      'pricing.matrix_cell.deleted',
      'pricing.modifier.created',
      'pricing.modifier.updated',
      'pricing.scenario.duplicated',
      'pricing.modifier.deleted',
      'pricing.scenario.deleted',
      'pricing.scenario.deleted',
      'catalog.option.deleted',
      'catalog.question.deleted',
      'catalog.category.deleted',
    ]
  );
  assert.equal(
    auditEvents.rows.every((event) => Number(event.actor_user_id) === actorUserId),
    true
  );
  assert.equal(
    auditEvents.rows.some((event) => /no-op|invalid/.test(event.request_id)),
    false
  );

  const questionUpdateEvent = auditEvents.rows.find(
    (event) => event.event_key === 'catalog.question.updated'
  );
  assert.deepEqual(questionUpdateEvent.details.changes, {
    label: { from: 'Audit kind', to: 'Audited kind' },
  });
  const scenarioUpdateEvent = auditEvents.rows.find(
    (event) => event.event_key === 'pricing.scenario.updated'
  );
  assert.deepEqual(scenarioUpdateEvent.details.changes, {
    priority: { from: 0, to: 2 },
  });
  assert.deepEqual(scenarioUpdateEvent.details.weightBandChanges, {
    created: 0,
    updated: 1,
    deleted: 0,
    matrixCellsDeleted: 0,
  });
  assert.equal(JSON.stringify(scenarioUpdateEvent.details).includes('audit_kind'), false);

  const matrixEvents = auditEvents.rows.filter(
    (event) => event.subject_type === 'pricing_matrix_cell'
  );
  assert.deepEqual(matrixEvents.map((event) => ({
    eventKey: event.event_key,
    oldPrice: event.details.oldPrice,
    newPrice: event.details.newPrice,
    xValue: event.details.xValue,
    yValue: event.details.yValue,
  })), [
    {
      eventKey: 'pricing.matrix_cell.set',
      oldPrice: null,
      newPrice: 125.5,
      xValue: firstBandId,
      yValue: 0,
    },
    {
      eventKey: 'pricing.matrix_cell.deleted',
      oldPrice: 125.5,
      newPrice: null,
      xValue: firstBandId,
      yValue: 0,
    },
  ]);
});

test('configuration audit failure rolls back catalog and pricing mutations', async () => {
  if (!suite.authenticatedSession) suite.authenticatedSession = await authenticateApplicationSession('/admin');
  const categoryCode = `F${Date.now().toString().slice(-8)}`;
  const xValue = 987654;
  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_test_configuration_audit()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.event_key IN ('catalog.category.created', 'pricing.matrix_cell.set') THEN
        RAISE EXCEPTION 'forced configuration audit failure';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER fail_test_configuration_audit
    BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION fail_test_configuration_audit();
  `);
  try {
    const category = await request('/api/admin/category', {
      method: 'POST',
      body: { code: categoryCode, name: 'Must roll back', requires_weight: 0 },
    });
    assert.equal(category.response.status, 500, category.text);
    assert.equal(Number((await pool.query(
      'SELECT count(*) FROM categories WHERE code = $1', [categoryCode]
    )).rows[0].count), 0);

    const matrix = await request('/api/admin/price-cell', {
      method: 'POST',
      body: { scenario_id: schemas.ZZScenario, x_val: xValue, y_val: 0, price: 777 },
    });
    assert.equal(matrix.response.status, 500, matrix.text);
    assert.equal(Number((await pool.query(
      `SELECT count(*) FROM price_matrix
       WHERE scenario_id = $1 AND x_val = $2 AND y_val = 0`,
      [schemas.ZZScenario, xValue]
    )).rows[0].count), 0);
  } finally {
    await pool.query('DROP TRIGGER fail_test_configuration_audit ON audit_events');
    await pool.query('DROP FUNCTION fail_test_configuration_audit()');
    await pool.query('DELETE FROM categories WHERE code = $1', [categoryCode]);
    await pool.query(
      'DELETE FROM price_matrix WHERE scenario_id = $1 AND x_val = $2 AND y_val = 0',
      [schemas.ZZScenario, xValue]
    );
  }
});
