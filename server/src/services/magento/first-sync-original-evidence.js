// Recover canonical observations from the exact immutable command that recorded
// this receipt. Never use today's product, later revisions, remote or after values.
const { hash } = require('./binding-contract');
const fail = () => { throw Object.assign(new Error('Original revision evidence unproven'),
  { auditReason: 'ORIGINAL_REVISION_EVIDENCE_UNPROVEN' }); };
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const own = (value, key) => Object.hasOwn(value || {}, key);
const present = value => value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
const counter = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)
  && BigInt(value) <= 9223372036854775807n;

async function readOriginalEvidence(client, field, session, compiled, cache, validateMapping) {
  if (!counter(field.revision) || !counter(session.revision) || BigInt(field.revision) > BigInt(session.revision)
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(session.id || '')) fail();
  const key = session.id + '/' + field.revision;
  if (!cache.has(key)) {
    if (cache.size >= 32) fail();
    cache.set(key, client.query(`SELECT session_id,revision,command_hash,command
      FROM magento_first_sync_progress WHERE session_id=$1 AND revision=$2`, [session.id, field.revision]));
  }
  const row = (await cache.get(key)).rows[0], command = row?.command;
  if (!row || row.session_id !== session.id || String(row.revision) !== field.revision
    || !plain(command) || Buffer.byteLength(JSON.stringify(command)) > 1048576
    || hash(command) !== row.command_hash || !plain(command.key) || !plain(command.identity)
    || command.key.originHash !== session.origin_hash
    || String(command.key.publicIdentityId) !== String(session.public_product_identity_id)
    || command.identity.installationKey !== session.installation_key
    || command.identity.publicSku !== session.public_sku
    || String(command.identity.remoteProductId) !== String(session.remote_product_id)
    || command.identity.initialProductId !== session.initial_product_id
    || command.identity.initialBindingRevisionId !== session.initial_binding_revision_id
    || !Array.isArray(command.fields) || command.fields.length > 500) fail();
  const slots = new Set();
  for (const peer of command.fields) {
    if (!plain(peer) || typeof peer.target !== 'string' || typeof peer.scope !== 'string') fail();
    const slot = peer.scope + '/' + peer.target;
    if (slots.has(slot)) fail(); slots.add(slot);
  }
  const original = command.fields.filter(peer => peer.target === field.target && peer.scope === field.scope);
  const record = Object.fromEntries(['target', 'scope', 'state', 'before', 'remote', 'after', 'source', 'mappingHash']
    .map(name => [name, field[name]]));
  if (original.length !== 1 || hash(original[0]) !== hash(record)) fail();

  const definition = compiled.definition, bindings = new Map(definition.bindings.map(item => [item.id, item.value]));
  let work = 0;
  const deref = raw => {
    let node = raw;
    while (node?.op === 'ref') { if (++work > 20000) fail(); node = bindings.get(node.id); }
    return node;
  };
  const ids = new Set();
  const ruleSources = rule => {
    for (const [id, value] of Object.entries(rule)) {
      if (id === '$and' || id === '$or') value.forEach(ruleSources); else ids.add(id);
    }
  };
  function visit(raw) {
    if (++work > 20000) fail();
    const node = deref(raw); if (!node) fail();
    if (node.op === 'source') {
      ids.add(node.id);
      for (const question of Object.values(definition.questionContracts)) {
        if (question.source === node.id) ruleSources(question.rule);
      }
    }
    if (node.op === 'questionValue' || node.op === 'catalogRule') {
      const question = definition.questionContracts[node.question];
      ids.add(question.source); ruleSources(question.rule);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(item => { if (item?.op) visit(item); });
      else if (value?.op) visit(value);
      else if (plain(value)) Object.values(value).forEach(item => { if (item?.op) visit(item); });
    }
  }
  const group = definition.groups.find(item => field.source.routeKey === item.route + ':all'
    || field.source.routeKey.startsWith(item.route + '.'));
  const cell = group?.rows.find(item => item.id === (field.scope === 'all' ? 'base' : 'english'))?.cells[field.target];
  if (!cell) fail();
  visit(cell);
  if (ids.size > 64) fail();
  const values = {}, seen = new Map();
  for (const peer of command.fields) {
    const source = peer?.source;
    if (source?.kind !== 'semantic') continue;
    const matches = [...ids].filter(id => definition.sources[id]?.kind === 'semantic'
      && definition.sources[id].category === group.route && definition.sources[id].key === source.key);
    if (!matches.length) continue;
    if (matches.length !== 1 || peer.scope !== 'all' || source.productId !== field.source.productId
      || source.bindingRevisionId !== field.source.bindingRevisionId || source.definitionHash !== compiled.hash
      || source.routeKey !== field.source.routeKey || source.manifestHash !== field.source.manifestHash
      || peer.state === 'imported' || source.decision === 'accept_remote') fail();
    const id = matches[0], expression = deref(validateMapping(peer));
    const question = expression?.op === 'questionValue' && definition.questionContracts[expression.question];
    if (!question?.exists || question.source !== id || !plain(peer.before)
      || peer.before.known !== true || typeof peer.before.present !== 'boolean'
      || peer.before.present !== present(peer.before.value)) fail();
    const value = peer.before.value;
    if (peer.before.present && (!['string', 'number'].includes(typeof value)
      || !/^(0|-?[1-9][0-9]*)$/.test(String(value)) || !Number.isSafeInteger(Number(value))
      || !question.allowed.includes(String(value)))) fail();
    if (!peer.before.present && own(peer.before, 'value')
      && !(value === null || typeof value === 'string' && value.trim() === '' && value.length <= 4096)) fail();
    const observation = { known: true, present: peer.before.present, ...(own(peer.before, 'value') ? { value } : {}) };
    if (seen.has(id) && hash(seen.get(id)) !== hash(observation)) fail();
    seen.set(id, observation); values[id] = observation;
  }
  return { version: 1, definitionHash: compiled.hash, routeKey: field.source.routeKey,
    target: field.target, scope: field.scope, values };
}
module.exports = { readOriginalEvidence };
