const { test } = require('node:test');
const assert = require('node:assert/strict');
const helper = require('../src/services/magento/first-sync-local-apply');
const information = require('../src/services/product-information.service');
const previews = require('../src/services/magento/sync-preview-db');
const evaluator = require('../src/services/magento/binding-evidence-products');
const names = require('../src/services/magento/name-state');
const lifecycle = require('../src/services/full-product-export.service');
const audit = require('../src/audit/audit-events');
const reconciliation = require('../src/services/magento/name-reconciliation');
const c = require('../src/services/magento/binding-contract');

const bindingId = '11111111-1111-4111-8111-111111111111';
const config = { baseUrl: 'https://shop.example.test' };
function fixture() {
  const product = { id: 7, public_product_identity_id: '17', public_sku: 'AG-000017', full_sku: 'CH1', category: 'CH',
    status: 'active', corrected_to_product_id: null, details: { answers: {}, keep: 'unchanged' }, weight: '4.5', total_price_uah: '200' };
  const amber = { product, compiled: { hash: 'a'.repeat(64) }, revision: { id: bindingId, originHash: c.originHash(config.baseUrl) } };
  const observation = { amber, raw: { id: 77, sku: product.public_sku, name: 'Remote UA' },
    domainEvidence: { english: { id: 77, sku: product.public_sku, fields: { name: 'Remote EN' } } } };
  const projection = { fields: [], projection: [], plan: { fields: [] } }, acceptedFields = [];
  function add(target, scope, persistence, after, beforeValue) {
    const source = { kind: persistence, ...(persistence === 'name' ? { field: `magento_name_override.values.${scope}` } : { key: target }),
      bindingRevisionId: bindingId, definitionHash: amber.compiled.hash, routeKey: 'CH:all' };
    const metadata = { target, scope, persistence, source, mappingHash: 'b'.repeat(64),
      storagePath: persistence === 'information' ? `details.answers.${target}` : source.field, requiresRuntimeValidation: true };
    const input = { target, scope, mapping: { proven: true }, local: { known: true, present: beforeValue !== undefined,
      ...(beforeValue !== undefined ? { value: beforeValue } : {}) }, remote: { known: true, present: true, value: after } };
    const accepted = { target, scope, state: persistence === 'name' ? 'name_received' : 'imported', before: input.local,
      remote: input.remote, after, source: { ...source, productId: product.id }, mappingHash: metadata.mappingHash };
    projection.fields.push(input); projection.projection.push(metadata);
    projection.plan.fields.push({ target, scope, status: 'imported', importValue: after }); acceptedFields.push(accepted);
    return accepted;
  }
  return { product, amber, observation, projection, acceptedFields, add,
    options() { return { config, observation, projection, acceptedFields, actorUserId: 3 }; } };
}
async function withDependencies(f, operation, overrides = {}) {
  const calls = { sql: [], information: [], evaluations: [], audit: [], nameAudit: [], revisions: [], states: [], previewReads: 0 };
  const proof = new WeakSet([f.product, f.observation.amber.product]);
  const client = { async query(sql, values = []) {
    calls.sql.push({ sql, values });
    assert.doesNotMatch(sql, /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)/);
    if (sql.startsWith('UPDATE products SET details=')) { f.product.details.answers = JSON.parse(values[1]); return { rowCount: 1, rows: [] }; }
    if (sql.startsWith('UPDATE products SET magento_name_override=')) { f.product.magento_name_override = JSON.parse(values[1]); f.product.magento_name_review_required = false; return { rowCount: 1, rows: [] }; }
    if (sql.startsWith('INSERT INTO magento_name_sync_states')) {
      const state = { baseline: JSON.parse(values[3]), amber: JSON.parse(values[4]), remote: JSON.parse(values[5]),
        resolution: JSON.parse(values[6]), state: values[7] }; calls.states.push(state);
      f.amber.nameState = { remote_product_id: values[2], baseline_names: state.baseline,
        observed_amber_names: state.amber, observed_remote_names: state.remote, resolution: state.resolution, state: state.state };
      return { rows: [f.amber.nameState] };
    }
    if (overrides.query) return overrides.query(sql, values);
    assert.fail('Unexpected query: ' + sql);
  } };
  const patches = [
    [previews, 'readPreviewProductOnClient', async (received, options) => { assert.equal(received, client); assert.deepEqual(options, { productId: 7, bindingRevisionId: bindingId }); calls.previewReads++; return f.amber; }],
    [evaluator, 'evaluate', (amber, product) => {
      assert.ok([f.amber, f.observation.amber].includes(amber)); assert.ok(proof.has(product), 'private loader proof must survive');
      const size = product.details.answers.bead_length || 'empty';
      const mapped = { base: { name: `UA ${size}` }, english: { name: `EN ${size}` } };
      const generatedNames = reconciliation.applyNameOverride(mapped, product);
      calls.evaluations.push({ generated: structuredClone(generatedNames), answers: structuredClone(product.details.answers) });
      return { ...mapped, generatedNames, ready: true };
    }],
    [information, 'prepareProductInformationOnClient', overrides.information || (async (received, product, patch, options) => {
      assert.equal(received, client); assert.equal(product, f.product); calls.information.push({ patch, lockCatalog: options.lockCatalog });
      const newAnswers = { ...product.details.answers, ...patch };
      return { newAnswers, changes: Object.entries(patch).map(([key, after]) => ({ key, before: product.details.answers[key] || null, after })), fullRevision: '4' };
    })],
    [lifecycle, 'readFullProductStates', async (received, ids, options) => { assert.equal(received, client); assert.deepEqual(ids, [7]); assert.equal(options.lock, true); return [{ revision: '4' }]; }],
    [lifecycle, 'advanceFullProductRevision', async (received, id, revision) => { assert.equal(received, client); calls.revisions.push([id, revision]); return { revision: '5' }; }],
    [audit, 'writeAuditEvent', async (received, entry) => { assert.equal(received, client); calls.audit.push(entry); if (overrides.auditError) throw overrides.auditError; return { id: 1 }; }],
    [names, 'auditName', async (...args) => { assert.equal(args[0], client); calls.nameAudit.push(args.slice(1)); }],
  ];
  const restore = patches.map(([object, key, value]) => { const old = object[key]; object[key] = value; return () => { object[key] = old; }; });
  try { return await operation(client, calls); } finally { restore.reverse().forEach(fn => fn()); }
}

test('information and both names use post-information anchor, preserve private proof, and advance once', async () => {
  const f = fixture(); f.add('bead_length', 'all', 'information', '20');
  f.add('name', 'all', 'name', 'Remote UA'); f.add('name', 'en', 'name', 'Remote EN');
  await withDependencies(f, async (client, calls) => {
    const before = structuredClone(f.product);
    const preview = await helper.prepareFirstSyncLocal(client, f.options());
    assert.equal(preview.supportedFields.length, 3); assert.deepEqual(preview.blockedFields, []);
    assert.deepEqual(f.product, before); assert.equal(calls.sql.length, 0);
    const result = await helper.applyFirstSyncLocal(client, f.options());
    assert.equal(result.fullRevision, '5'); assert.deepEqual(calls.revisions, [[7, '4']]);
    assert.deepEqual(f.product.magento_name_override, { generated: { all: 'UA 20', en: 'EN 20' }, values: { all: 'Remote UA', en: 'Remote EN' } });
    assert.deepEqual(f.product.details, { answers: { bead_length: '20' }, keep: 'unchanged' });
    assert.equal(f.product.weight, '4.5'); assert.equal(f.product.total_price_uah, '200');
    assert.deepEqual(calls.states[0].baseline, { all: 'Remote UA', en: 'Remote EN' }); assert.equal(calls.states[0].state, 'common');
    assert.equal(calls.audit.length, 1); assert.equal(calls.nameAudit.length, 1);
    assert.ok(calls.information.some(call => call.lockCatalog === true));
  });
});

test('partial remote names preserve active local other language without fabricating a common baseline', async () => {
  const f = fixture(); f.observation.domainEvidence.english.fields.name = '';
  f.product.magento_name_override = { generated: { all: 'UA empty', en: 'EN empty' }, values: { all: 'Manager UA', en: 'Manager EN' } };
  f.add('bead_length', 'all', 'information', '20'); f.add('name', 'all', 'name', 'Remote UA', 'Manager UA');
  f.projection.fields.push({ target: 'name', scope: 'en', remote: { known: true, present: false, value: '' } });
  await withDependencies(f, async (client, calls) => {
    await helper.applyFirstSyncLocal(client, f.options());
    assert.deepEqual(f.product.magento_name_override.values, { all: 'Remote UA', en: 'Manager EN' });
    assert.deepEqual(f.product.magento_name_override.generated, { all: 'UA 20', en: 'EN 20' });
    assert.equal(calls.states[0].baseline, null); assert.equal(calls.states[0].state, 'amber_changed');
    assert.deepEqual(calls.states[0].remote, { all: 'Remote UA', en: '' });
    assert.deepEqual(calls.states[0].resolution, { amber: { all: 'Remote UA', en: 'Manager EN' }, remote: { all: 'Remote UA', en: '' } });
  });
});

test('information-only adoption reanchors active accepted names and ignores unaccepted plan imports', async () => {
  const f = fixture(); const info = f.add('bead_length', 'all', 'information', '20'); f.add('name', 'all', 'name', 'Remote UA');
  f.product.magento_name_override = { generated: { all: 'UA empty', en: 'EN empty' }, values: { all: 'Manager UA', en: 'Manager EN' } };
  f.acceptedFields.splice(1); assert.equal(f.acceptedFields[0], info);
  await withDependencies(f, async (client, calls) => {
    await helper.applyFirstSyncLocal(client, f.options());
    assert.deepEqual(f.product.magento_name_override, { generated: { all: 'UA 20', en: 'EN 20' }, values: { all: 'Manager UA', en: 'Manager EN' } });
    assert.equal(calls.revisions.length, 1);
    f.product.magento_name_override.values.all = 'Later manager edit';
    const before = structuredClone(f.product), count = calls.sql.length;
    const repeated = await helper.applyFirstSyncLocal(client, { ...f.options(), acceptedFields: [] });
    assert.equal(repeated.changed, false); assert.deepEqual(f.product, before); assert.equal(calls.sql.length, count);
  });
});

test('per-field preparation keeps safe imports when runtime validation blocks another', async () => {
  const f = fixture(); f.add('bead_length', 'all', 'information', '20'); f.add('bead_width', 'all', 'information', '5');
  await withDependencies(f, async (client, calls) => {
    const result = await helper.prepareFirstSyncLocal(client, f.options());
    assert.deepEqual(result.supportedFields.map(field => field.target), ['bead_length']);
    assert.equal(result.blockedFields[0].code, 'CATALOG_CHANGED'); assert.equal(calls.sql.length, 0);
    await assert.rejects(helper.applyFirstSyncLocal(client, f.options()), { code: 'FIRST_SYNC_LOCAL_VALIDATION_FAILED' });
    assert.equal(calls.sql.length, 0);
  }, { information: async (_client, product, patch) => {
    if (Object.hasOwn(patch, 'bead_width')) throw Object.assign(new Error('Field now affects pricing'), { code: 'CATALOG_CHANGED' });
    return { newAnswers: { ...product.details.answers, ...patch }, changes: [], fullRevision: '4' };
  } });
});

test('actual information validator rejects a now-SKU field before any product writes', async () => {
  const f = fixture(); f.add('bead_length', 'all', 'information', '20');
  const realPrepare = information.prepareProductInformationOnClient;
  await withDependencies(f, async (client, calls) => {
    const result = await helper.prepareFirstSyncLocal(client, { ...f.options(), lockCatalog: true });
    assert.deepEqual(result.supportedFields, []); assert.match(result.blockedFields[0].reason, /безпечним інформаційним/);
    assert.ok(calls.sql.some(call => call.sql.includes('FROM questions') && call.sql.includes('FOR SHARE')));
    assert.ok(calls.sql.every(call => call.sql.startsWith('SELECT')));
  }, { information: realPrepare, query: async sql => {
    if (sql.includes('FROM correction_requests')) return { rows: [] };
    if (sql.includes('FROM questions')) return { rows: [{ key: 'bead_length', include_in_sku: 1, input_type: 'text' }] };
    assert.fail('Unexpected runtime validator query: ' + sql);
  } });
});

test('unsupported persistence, normalized values and forged provenance fail before writes', async () => {
  for (const persistence of ['price', 'weight', 'characteristic', 'photo', 'history']) {
    const f = fixture(); f.add('field', 'all', persistence, '10');
    await withDependencies(f, async (client, calls) => {
      await assert.rejects(helper.applyFirstSyncLocal(client, f.options()), { code: 'FIRST_SYNC_LOCAL_SETTER_UNSUPPORTED' });
      assert.equal(calls.sql.length, 0);
    });
  }
  const f = fixture(); const field = f.add('bead_length', 'all', 'information', ' 20 ');
  await withDependencies(f, async (client, calls) => {
    const result = await helper.prepareFirstSyncLocal(client, f.options());
    assert.equal(result.blockedFields[0].code, 'FIRST_SYNC_LOCAL_VALUE_NORMALIZED'); assert.equal(calls.sql.length, 0);
  }, { information: async () => ({ newAnswers: { bead_length: '20' } }) });
  field.source.mappingEscape = true;
  await withDependencies(f, async client => {
    const result = await helper.prepareFirstSyncLocal(client, f.options());
    assert.equal(result.blockedFields[0].code, 'FIRST_SYNC_LOCAL_EVIDENCE_MISMATCH');
  });
});

test('audited accept-remote conflict works, but keep-local and non-import evidence cannot mutate', async () => {
  const f = fixture(); f.product.details.answers.bead_length = '10';
  const field = f.add('bead_length', 'all', 'information', '20', '10');
  f.projection.plan.fields[0] = { target: 'bead_length', scope: 'all', status: 'conflict' };
  field.source.manifestHash = 'c'.repeat(64); field.source.decision = 'accept_remote';
  await withDependencies(f, async (client, calls) => {
    await helper.applyFirstSyncLocal(client, f.options()); assert.equal(f.product.details.answers.bead_length, '20');
    assert.equal(calls.revisions.length, 1);
  });
  for (const mutate of [f => { f.acceptedFields[0].source.decision = 'keep_local'; }, f => { f.acceptedFields[0].state = 'equal'; }]) {
    const f = fixture(); f.add('bead_length', 'all', 'information', '20'); mutate(f);
    await withDependencies(f, async (client, calls) => {
      await assert.rejects(helper.applyFirstSyncLocal(client, f.options()), { code: 'FIRST_SYNC_LOCAL_VALIDATION_FAILED' }); assert.equal(calls.sql.length, 0);
    });
  }
});

test('audit failures propagate to caller transaction without local commit or rollback', async () => {
  const f = fixture(); f.add('bead_length', 'all', 'information', '20');
  const failure = new Error('audit failed');
  await withDependencies(f, async (client, calls) => {
    await assert.rejects(helper.applyFirstSyncLocal(client, f.options()), failure);
    assert.ok(calls.sql.every(call => !/^(BEGIN|COMMIT|ROLLBACK)/.test(call.sql)));
  }, { auditError: failure });
});

test('equal first names establish truthful receipt without product rewrite or revision', async () => {
  const f = fixture(); f.observation.raw.name = 'UA empty'; f.observation.domainEvidence.english.fields.name = 'EN empty';
  f.add('name', 'all', 'name', 'UA empty', 'UA empty'); f.add('name', 'en', 'name', 'EN empty', 'EN empty');
  f.projection.plan.fields.forEach(field => { field.status = 'equal'; delete field.importValue; });
  await withDependencies(f, async (client, calls) => {
    const before = structuredClone(f.product);
    const result = await helper.applyFirstSyncLocal(client, f.options());
    assert.equal(result.changed, false); assert.equal(result.nameChanged, false); assert.deepEqual(calls.revisions, []);
    assert.deepEqual(f.product, before); assert.ok(calls.sql.every(call => !call.sql.startsWith('UPDATE products')));
    assert.deepEqual(calls.states[0].baseline, { all: 'UA empty', en: 'EN empty' }); assert.equal(calls.states[0].state, 'common');
  });
});

test('partial name with missing other language blocks only names while valid information remains supported', async () => {
  const f = fixture(); f.add('bead_width', 'all', 'information', '5'); f.add('name', 'all', 'name', 'Remote UA');
  await withDependencies(f, async (client, calls) => {
    const evaluate = evaluator.evaluate;
    evaluator.evaluate = (amber, product) => { const mapped = evaluate(amber, product); mapped.english.name = ''; mapped.generatedNames.en = ''; return mapped; };
    try {
      const result = await helper.prepareFirstSyncLocal(client, f.options());
      assert.deepEqual(result.supportedFields.map(field => field.target), ['bead_width']);
      assert.deepEqual(result.blockedFields.map(field => field.code), ['FIRST_SYNC_LOCAL_NAME_PAIR_REQUIRED']);
      assert.equal(calls.sql.length, 0);
    } finally { evaluator.evaluate = evaluate; }
  });
});

test('fresh relevant source changes block adoption while an authorized pricing change is permitted', async () => {
  for (const change of ['information', 'override', 'price']) {
    const f = fixture(); f.add('bead_length', 'all', 'information', '20');
    f.observation.amber = { ...f.amber, product: structuredClone(f.product) };
    if (change === 'information') f.product.details.answers.bead_length = 'Manager edit';
    if (change === 'override') f.product.magento_name_override = { generated: {}, values: { all: 'Manager', en: 'Manager' } };
    if (change === 'price') f.product.total_price_uah = '250';
    await withDependencies(f, async (client, calls) => {
      if (change === 'override') await assert.rejects(helper.prepareFirstSyncLocal(client, f.options()), { code: 'FIRST_SYNC_LOCAL_SOURCE_CHANGED' });
      else {
        const result = await helper.prepareFirstSyncLocal(client, f.options());
        if (change === 'information') assert.equal(result.blockedFields[0].code, 'FIRST_SYNC_LOCAL_SOURCE_CHANGED');
        else assert.equal(result.supportedFields.length, 1);
      }
      assert.equal(calls.sql.length, 0);
    });
  }
});

test('a prior same-transaction pricing change cannot detach the originally active manual-name anchor', async () => {
  const f = fixture(); f.product.magento_name_override = { generated: { all: 'UA 200', en: 'EN 200' }, values: { all: 'Manager UA', en: 'Manager EN' } };
  f.observation.amber = { ...f.amber, product: structuredClone(f.product) };
  f.product.total_price_uah = '250'; f.add('bead_width', 'all', 'information', '5');
  await withDependencies(f, async (client, calls) => {
    const evaluate = evaluator.evaluate;
    evaluator.evaluate = (amber, product) => {
      evaluate(amber, product); // Retain the private object-identity assertions.
      const mapped = { base: { name: `UA ${product.total_price_uah}` }, english: { name: `EN ${product.total_price_uah}` } };
      return { ...mapped, generatedNames: reconciliation.applyNameOverride(mapped, product), ready: true };
    };
    try {
      await helper.applyFirstSyncLocal(client, f.options());
      assert.deepEqual(f.product.magento_name_override, { generated: { all: 'UA 250', en: 'EN 250' }, values: { all: 'Manager UA', en: 'Manager EN' } });
      assert.equal(calls.revisions.length, 1);
    } finally { evaluator.evaluate = evaluate; }
  });
});

test('unknown English read and mismatched raw names cannot establish a fabricated common baseline', async () => {
  const f = fixture(); f.add('name', 'all', 'name', 'Remote UA');
  f.observation.domainEvidence.english.fields.name = 'EN empty';
  f.projection.fields.push({ target: 'name', scope: 'en', remote: { known: false } });
  await withDependencies(f, async (client, calls) => {
    await helper.applyFirstSyncLocal(client, f.options());
    assert.equal(calls.states[0].baseline, null); assert.deepEqual(calls.states[0].remote, { all: 'Remote UA' });
  });
  const changed = fixture(); changed.add('name', 'all', 'name', 'Remote UA'); changed.observation.raw.name = 'Other remote name';
  await withDependencies(changed, async (client, calls) => {
    const result = await helper.prepareFirstSyncLocal(client, changed.options());
    assert.equal(result.blockedFields[0].code, 'FIRST_SYNC_LOCAL_EVIDENCE_MISMATCH'); assert.equal(calls.sql.length, 0);
  });
});

test('price-only apply reanchors existing received names without any new name receipt or baseline', async () => {
  for (const dependsOnPrice of [true, false]) {
    const f = fixture();
    const generated = dependsOnPrice ? { all: 'UA 200', en: 'EN 200' } : { all: 'UA empty', en: 'EN empty' };
    f.product.magento_name_override = { generated, values: { all: 'Later manager UA', en: 'Received EN' } };
    f.observation.amber = { ...f.amber, product: structuredClone(f.product) }; f.product.total_price_uah = '250';
    await withDependencies(f, async (client, calls) => {
      const evaluate = evaluator.evaluate;
      if (dependsOnPrice) evaluator.evaluate = (amber, product) => {
        evaluate(amber, product);
        const mapped = { base: { name: `UA ${product.total_price_uah}` }, english: { name: `EN ${product.total_price_uah}` } };
        return { ...mapped, generatedNames: reconciliation.applyNameOverride(mapped, product), ready: true };
      };
      try {
        const preview = await helper.prepareFirstSyncLocal(client, { ...f.options(), reanchorAfterPrice: true });
        assert.deepEqual(preview, { supportedFields: [], blockedFields: [] }); assert.equal(calls.previewReads, 0);
        const result = await helper.applyFirstSyncLocal(client, { ...f.options(), reanchorAfterPrice: true });
        assert.equal(result.nameChanged, dependsOnPrice);
        assert.deepEqual(f.product.magento_name_override.values, { all: 'Later manager UA', en: 'Received EN' });
        assert.deepEqual(f.product.magento_name_override.generated, dependsOnPrice ? { all: 'UA 250', en: 'EN 250' } : generated);
        assert.equal(calls.revisions.length, dependsOnPrice ? 1 : 0); assert.deepEqual(calls.states, []);
        if (dependsOnPrice) {
          assert.equal(calls.nameAudit[0][2], 'first_sync_reanchored');
          assert.equal(calls.nameAudit[0][3].reason, 'preserve_existing_names');
        } else assert.deepEqual(calls.nameAudit, []);
      } finally { evaluator.evaluate = evaluate; }
    });
  }
});

test('first EN receipt preserves an already received UA conflict in the actual ordinary name guard', async () => {
  const { compileDefinition } = require('../src/services/export-templates/definition');
  const definition = require('./fixtures/magento-v4').definition(['CH']);
  for (const source of Object.values(definition.sources)) if (source.category === 'XG') source.category = 'CH';
  definition.groups[0].rows[0].cells.name = { op: 'literal', value: 'UA empty' };
  definition.groups[0].rows[1].cells.name = { op: 'literal', value: 'EN empty' };
  for (const previousResolution of [null, { amber: { all: 'Old reviewed UA', en: 'Old reviewed EN' },
    remote: { all: 'Old remote UA', en: 'Old remote EN' } }]) {
    const f = fixture(); f.amber.compiled = compileDefinition(definition);
    f.product.magento_name_override = { generated: { all: 'UA empty', en: 'EN empty' }, values: { all: 'Manager changed UA', en: 'EN empty' } };
    const baseline = { all: 'Previously common UA', en: 'EN empty' };
    f.amber.nameState = { remote_product_id: 77, baseline_names: baseline, resolution: previousResolution, state: 'conflict' };
    f.observation.raw.name = 'Magento independently changed UA';
    f.add('name', 'en', 'name', 'Remote EN', 'EN empty');
    f.projection.fields.push({ target: 'name', scope: 'all', receipt: { state: 'name_received' },
      local: { known: true, present: true, value: 'Manager changed UA' },
      remote: { known: true, present: true, value: f.observation.raw.name } });
    await withDependencies(f, async (client, calls) => {
      await helper.applyFirstSyncLocal(client, f.options());
      assert.deepEqual(f.product.magento_name_override.values, { all: 'Manager changed UA', en: 'Remote EN' });
      assert.deepEqual(calls.states[0].baseline, baseline); assert.equal(calls.states[0].resolution, null);
      assert.equal(calls.states[0].state, 'conflict');
      // name-state captured the real evaluator at module load: no mocked decision
      // or expected-action substitute is involved in this guard assertion.
      const ordinary = names.decisionFor(f.observation);
      assert.deepEqual(ordinary.amber, { all: 'Manager changed UA', en: 'Remote EN' });
      assert.equal(ordinary.action, 'conflict');
    });
  }
});

test('new language receipt never reviews populated or received-empty other-language differences', async () => {
  for (const [received, remoteUa] of [[false, 'Different populated UA'], [true, '']]) {
    const f = fixture(); f.observation.raw.name = remoteUa;
    f.add('name', 'en', 'name', 'Remote EN');
    f.projection.fields.push({ target: 'name', scope: 'all', ...(received ? { receipt: { state: 'name_received' } } : {}),
      remote: { known: true, present: remoteUa !== '', value: remoteUa } });
    await withDependencies(f, async (client, calls) => {
      await helper.applyFirstSyncLocal(client, f.options());
      assert.equal(calls.states[0].resolution, null); assert.equal(calls.states[0].baseline, null);
      assert.equal(calls.states[0].state, 'baseline_required');
    });
  }
});

test('an existing exact reviewed resolution survives a new receipt without broadening its pair', async () => {
  const f = fixture(); f.add('name', 'en', 'name', 'Remote EN');
  f.projection.fields.push({ target: 'name', scope: 'all', receipt: { state: 'name_received' },
    remote: { known: true, present: true, value: 'Remote UA' } });
  const resolution = { amber: { all: 'UA empty', en: 'Remote EN' }, remote: { all: 'Remote UA', en: 'Remote EN' } };
  f.amber.nameState = { remote_product_id: 77, baseline_names: null, resolution };
  await withDependencies(f, async (client, calls) => {
    await helper.applyFirstSyncLocal(client, f.options());
    assert.deepEqual(calls.states[0].resolution, resolution); assert.equal(calls.states[0].baseline, null);
    assert.equal(calls.states[0].state, 'amber_changed');
  });
});
