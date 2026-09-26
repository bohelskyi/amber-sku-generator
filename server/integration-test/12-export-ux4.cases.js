const { test, assert, pool, crypto, request, authenticateApplicationSession, authenticateIdentitySession, roleIdForKey } = require('./suite-context');
const sessions = require('../src/services/export-sessions.service');
const exportsService = require('../src/services/export.service');
const templates = require('../src/services/export-templates/template.service');
const { getExportHistory } = require('../src/services/export-history.service');
const { definition, installGoldenEvidence } = require('./12-export-templates.cases');
const options = (actor) => ({ mutationContext: { actorUserId: actor.applicationUser.id } });
const root = '/api/export/sessions';
const http = (path, actor, method = 'GET', body) => request(path, { authentication: actor, method, body });
let fixture;
async function setup() {
  if (fixture) return fixture;
  const owner = await authenticateApplicationSession(); await installGoldenEvidence();
  const member = await authenticateIdentitySession({ subject: 'ux4-member-' + crypto.randomUUID() });
  const viewer = await authenticateIdentitySession({ subject: 'ux4-viewer-' + crypto.randomUUID() });
  const admin = await authenticateIdentitySession({ subject: 'ux4-admin-' + crypto.randomUUID() });
  for (const [actor, permissions] of [[member, ['exports.view', 'exports.create']], [viewer, ['exports.view']]]) {
    const role = await http('/api/admin/roles', owner, 'POST', { displayName: 'UX4 ' + crypto.randomUUID(), description: 'Disposable UX4 fixture', permissionKeys: permissions });
    assert.equal(role.response.status, 201, role.text);
    assert.equal((await http(`/api/admin/users/${actor.applicationUser.id}/approve`, owner, 'POST', { roleId: role.data.role.id })).response.status, 200);
  }
  assert.equal((await http(`/api/admin/users/${admin.applicationUser.id}/approve`, owner, 'POST', { roleId: await roleIdForKey('administrator') })).response.status, 200);
  const family = await templates.createTemplate({ key: 'ux4-' + crypto.randomUUID(), displayName: 'UX4 catalog', definition: definition('UX4 stored') }, options(owner));
  const version = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options(owner));
  const active = await templates.getActivation();
  await templates.updateActivation({ expectedGeneration: active.generation, implementation: 'template', templateVersionId: version.id }, options(owner));
  fixture = { owner, member, viewer, admin, family, version }; return fixture;
}
async function workspace() {
  const f = await setup(); const sku = ('BR-UX4-' + crypto.randomUUID()).toUpperCase();
  const product = (await pool.query(`INSERT INTO products(full_sku,base_sku,category,weight,total_price_uah,details)
    VALUES($1,$1,'BR',10,100,'{"answers":{}}') RETURNING *`, [sku])).rows[0];
  const session = await sessions.createSession({ title: 'Каталог UX4', creationKey: crypto.randomUUID(), settings: {
    requestContract: 'template-v1', fromSku: sku, toSku: sku, selection: { mode: 'active' } } }, options(f.owner));
  return { ...f, product, session, condition: { expectedRevision: session.configurationRevision, expectedAccessEpoch: 'owner' } };
}
async function effects() {
  const result = {};
  for (const table of ['export_sessions', 'export_session_attempts', 'export_session_members', 'export_snapshots', 'price_export_snapshots', 'magento_export_artifacts', 'product_export_revisions', 'export_state', 'export_events', 'audit_events']) {
    result[table] = (await pool.query(`SELECT jsonb_agg(x ORDER BY x::text) AS data FROM (SELECT to_jsonb(t) x FROM ${table} t) q`)).rows[0].data;
  }
  return result;
}
async function listed(actor, scope) {
  const rows = []; let after = '';
  do { const page = await sessions.listSessions({ scope, order: 'recent', limit: 50, after }, options(actor)); rows.push(...page.items); after = page.next; } while (after);
  return rows;
}
async function join(w, actor) {
  const invite = await sessions.invite(w.session.id, { userId: actor.applicationUser.id, expectedAccessEpoch: 'owner' }, options(w.owner));
  return sessions.membership(w.session.id, { action: 'accept', expectedAccessEpoch: invite.epoch }, options(actor));
}

test('UX4 recent owned/shared/invitation projections preserve minimal disclosure, same-session join and current membership epochs', async () => {
  const w = await workspace(); const id = w.session.id;
  assert.ok((await listed(w.owner, 'owned')).some((s) => s.id === id));
  for (const actor of [w.member, w.viewer, w.admin]) {
    assert.ok(!(await listed(actor, 'owned')).some((s) => s.id === id));
    assert.ok(!(await listed(actor, 'shared')).some((s) => s.id === id));
    assert.equal((await http(`${root}/${id}`, actor)).response.status, 404);
  }
  const invite = await sessions.invite(id, { userId: w.member.applicationUser.id, expectedAccessEpoch: 'owner' }, options(w.owner));
  const pending = (await listed(w.member, 'invitations')).find((s) => s.id === id);
  assert.deepEqual(Object.keys(pending).sort(), ['accessEpoch', 'id', 'ownerName', 'ownerUserId', 'state', 'title']);
  assert.equal(pending.ownerUserId, String(w.owner.applicationUser.id));
  assert.ok(!(await listed(w.member, 'shared')).some((s) => s.id === id));
  const declined = await sessions.membership(id, { action: 'decline', expectedAccessEpoch: invite.epoch }, options(w.member));
  assert.equal((await http(`${root}/${id}`, w.member)).response.status, 404);
  assert.ok(!(await listed(w.member, 'shared')).some((s) => s.id === id));
  const reinvite = await sessions.invite(id, { userId: w.member.applicationUser.id, expectedAccessEpoch: 'owner' }, options(w.owner));
  assert.ok(BigInt(reinvite.epoch) > BigInt(declined.epoch));
  await assert.rejects(sessions.membership(id, { action: 'accept', expectedAccessEpoch: invite.epoch }, options(w.member)), { code: 'EXPORT_MEMBERSHIP_CHANGED' });
  const accepted = await sessions.membership(id, { action: 'accept', expectedAccessEpoch: reinvite.epoch }, options(w.member));
  const shared = (await listed(w.member, 'shared')).find((s) => s.id === id);
  assert.equal(shared.id, id); assert.equal(shared.participantCount, 2); assert.equal(shared.snapshot, null);
  assert.equal((await sessions.detail(id, options(w.member))).accessEpoch, accepted.epoch);
  await assert.rejects(sessions.membership(id, { action: 'revoke', userId: w.owner.applicationUser.id, expectedAccessEpoch: 'owner', expectedMemberEpoch: '1' }, options(w.owner)), { code: 'EXPORT_NOT_FOUND' });
  await sessions.membership(id, { action: 'leave', expectedAccessEpoch: accepted.epoch }, options(w.member));
  assert.equal((await http(`${root}/${id}`, w.member)).response.status, 404);
  assert.equal((await sessions.detail(id, options(w.owner))).id, id);
  const again = await join(w, w.member);
  await sessions.membership(id, { action: 'revoke', userId: w.member.applicationUser.id, expectedMemberEpoch: again.epoch, expectedAccessEpoch: 'owner' }, options(w.owner));
  assert.ok(!(await listed(w.member, 'shared')).some((s) => s.id === id));
  assert.equal((await http(`${root}/${id}`, w.member)).response.status, 404);
});

test('UX4 recent session pagination preserves microseconds, immutable creation order and old ID callers', async () => {
  const w = await workspace(); const ids = [];
  for (let i = 0; i < 7; i++) {
    const id = crypto.randomUUID(); ids.push(id);
    await pool.query(`INSERT INTO export_sessions(id,owner_user_id,creation_key,creation_intent,title,settings,created_at)
      VALUES($1,$2,$1,$3::jsonb,'Pagination UX4',$4::jsonb,$5::timestamptz)`,
    [id, w.member.applicationUser.id, JSON.stringify({ title: 'Pagination UX4', settings: w.session.settings }), JSON.stringify(w.session.settings), `2099-01-01T00:00:00.12345${i % 2}Z`]);
  }
  const expected = (await pool.query('SELECT id FROM export_sessions WHERE owner_user_id=$1 ORDER BY created_at DESC,id DESC', [w.member.applicationUser.id])).rows.map((s) => s.id);
  const before = await effects(); const found = []; let after = ''; let first;
  do {
    const page = await sessions.listSessions({ scope: 'owned', order: 'recent', limit: 2, after }, options(w.member));
    first ||= page.next; found.push(...page.items.map((s) => s.id)); after = page.next;
  } while (after);
  assert.deepEqual(found, expected); assert.equal(new Set(found).size, expected.length);
  assert.deepEqual(await effects(), before);
  await assert.rejects(sessions.listSessions({ scope: 'shared', order: 'recent', after: first }, options(w.member)), { code: 'EXPORT_PAGE_INVALID' });
  const old = await sessions.listSessions({ scope: 'owned', limit: 2 }, options(w.member));
  assert.deepEqual(old.items.map((s) => s.id), [...ids].sort().slice(0, 2));
  assert.equal(old.next, old.items[1].id);
  const next = await sessions.listSessions({ scope: 'owned', limit: 2, after: old.next }, options(w.member));
  assert.deepEqual(next.items.map((s) => s.id), [...ids].sort().slice(2, 4));
});

test('UX4 activity, file identity and confirmation reuse UX3 history metadata; all list/history/detail reads are observational', async () => {
  const w = await workspace(); const id = w.session.id;
  const initial = await sessions.detail(id, options(w.owner));
  assert.equal(initial.attempt, null); assert.equal(initial.participantCount, 1);
  await join(w, w.viewer);
  const preview = await sessions.previewSession(id, options(w.owner));
  const prepared = await sessions.prepare(id, { ...w.condition, expectedPreviewFingerprint: preview.tableFingerprint }, options(w.owner));
  const viewEpoch = (await sessions.detail(id, options(w.viewer))).accessEpoch;
  assert.equal((await http(`${root}/${id}/generate`, w.viewer, 'POST', { ...w.condition, expectedAccessEpoch: viewEpoch, attemptId: prepared.id })).response.status, 403);
  const made = await sessions.generate(id, { ...w.condition, attemptId: prepared.id }, options(w.owner));
  let owned = (await listed(w.owner, 'owned')).find((s) => s.id === id);
  assert.equal(owned.snapshot.status, 'generated'); assert.equal(owned.snapshot.id, made.id); assert.equal(owned.snapshot.sessionId, id);
  assert.equal(owned.participantCount, 2); assert.equal(owned.template.displayName, 'UX4 catalog');
  assert.equal((await http(`/api/export/snapshots/${made.id}/magento/BR/csv`, w.viewer)).response.status, 200);
  assert.equal((await http(`/api/export/snapshots/${made.id}/confirm`, w.viewer, 'POST', { expectedAccessEpoch: viewEpoch })).response.status, 403);
  await exportsService.confirmExportSnapshot(made.id, { ...options(w.owner), expectedAccessEpoch: 'owner' });
  const before = await effects();
  owned = (await listed(w.owner, 'owned')).find((s) => s.id === id);
  const shared = (await listed(w.viewer, 'shared')).find((s) => s.id === id);
  const detail = await sessions.detail(id, options(w.viewer));
  let after; let history;
  do { const page = await getExportHistory({ stream: 'product', limit: 50, ...(after ? { after } : {}) }, options(w.viewer)); history = page.items.find((s) => s.id === made.id); after = page.next; } while (!history && after);
  assert.deepEqual(owned.snapshot, shared.snapshot); assert.deepEqual(detail.snapshot, owned.snapshot);
  // Optional current display labels enrich history; immutable identity stays shared.
  const { sessionTitle, createdByName, confirmedByName, ...historyIdentity } = history;
  const { createdByName: ownCreator, confirmedByName: ownConfirmer, ...ownedIdentity } = owned.snapshot;
  assert.equal(ownCreator, null); assert.equal(ownConfirmer, null);
  assert.ok(sessionTitle); assert.ok(createdByName); assert.ok(confirmedByName);
  assert.deepEqual(JSON.parse(JSON.stringify(ownedIdentity)), JSON.parse(JSON.stringify(historyIdentity)));
  assert.equal(owned.snapshot.status, 'confirmed');
  assert.ok(new Date(owned.lastRecordedActivityAt) >= new Date(owned.snapshot.confirmedAt));
  assert.ok(new Date(owned.lastRecordedActivityAt) > new Date(initial.lastRecordedActivityAt));
  assert.deepEqual(await effects(), before);
  assert.equal((await http(`/api/export/snapshots/${made.id}`, w.admin)).response.status, 404);
});

test('UX4 read recovery distinguishes held non-generation lock, interrupted marker, stale original retry and exact stored result', async () => {
  const w = await workspace(); const id = w.session.id; const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock(hashtext($1),hashtext($2))', ['amber:export-session:v1', id]);
    const held = await sessions.detail(id, options(w.owner)); assert.equal(held.executing, true); assert.equal(held.attempt, null);
  } finally { await lock.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))', ['amber:export-session:v1', id]); lock.release(); }
  const prepared = await sessions.prepare(id, w.condition, options(w.owner));
  const unchanged = await effects(); const realNow = Date.now;
  try {
    Date.now = () => realNow() + 3600000;
    assert.equal((await sessions.detail(id, options(w.owner))).attempt.preparationIssue, 'expired');
  } finally { Date.now = realNow; }
  assert.deepEqual(await effects(), unchanged, 'expiry observation never replaces preparation');
  await pool.query("UPDATE export_session_attempts SET state='executing',started_at=CURRENT_TIMESTAMP WHERE id=$1", [prepared.id]);
  const before = await effects();
  assert.equal((await sessions.detail(id, options(w.owner))).attempt.state, 'interrupted');
  const list = (await listed(w.owner, 'owned')).find((s) => s.id === id);
  assert.equal(list.attempt.state, 'executing'); assert.equal(list.executing, undefined, 'list cannot claim an active lock');
  assert.deepEqual(await effects(), before);
  await pool.query('UPDATE products SET total_price_uah=101 WHERE id=$1', [w.product.id]);
  const newer = await sessions.previewSession(id, options(w.owner)); assert.notEqual(newer.tableFingerprint, prepared.preview.tableFingerprint);
  await assert.rejects(sessions.generate(id, { ...w.condition, attemptId: prepared.id }, options(w.owner)), { code: 'EXPORT_PREVIEW_STALE' });
  const failed = await sessions.detail(id, options(w.owner)); assert.equal(failed.attempt.id, prepared.id); assert.equal(failed.attempt.state, 'failed'); assert.equal(failed.snapshotId, null);
  await pool.query('UPDATE products SET total_price_uah=100 WHERE id=$1', [w.product.id]);
  const made = await sessions.generate(id, { ...w.condition, attemptId: prepared.id }, options(w.owner));
  const stored = await sessions.detail(id, options(w.owner)); assert.equal(stored.snapshot.id, made.id); assert.equal(stored.attempt.id, prepared.id);
  assert.equal((await pool.query('SELECT count(*)::int n FROM export_session_attempts WHERE session_id=$1', [id])).rows[0].n, 1);
});
