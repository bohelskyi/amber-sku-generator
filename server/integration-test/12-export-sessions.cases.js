const { insertProductFixture } = require('./product-fixture');
const suite = require('./suite-context');
const { test, assert, pool, request, crypto, authenticateApplicationSession, authenticateIdentitySession, Pool, TEST_DATABASE_URL,
  fs, os, path, serverRoot, recreateTestDatabase, dropTestDatabase, runNodeInDatabase } = suite;
const sessions = require('../src/services/export-sessions.service');
const exportsService = require('../src/services/export.service');
const templates = require('../src/services/export-templates/template.service');
const { definition, installGoldenEvidence } = require('./12-export-templates.cases');
let fixture;
const options = (actor, databasePool = pool) => ({ databasePool, mutationContext: { actorUserId: Number(actor.applicationUser.id), requestId: 'shared-session-test' } });
const root = '/api/export/sessions';
async function http(pathname, actor, method = 'GET', body) {
  return request(pathname, { authentication: actor, method, ...(body ? { body } : {}) });
}
async function setup() {
  if (fixture) return fixture;
  const a = await authenticateApplicationSession();
  await installGoldenEvidence();
  async function user(capabilities) {
    const subject = `shared-${crypto.randomUUID()}`;
    const actor = await authenticateIdentitySession({ subject }); actor.subject = subject;
    const roleResult = await http('/api/admin/roles', a, 'POST', { displayName: `Shared ${crypto.randomUUID()}`, description: 'Isolated export fixture', permissionKeys: capabilities });
    assert.equal(roleResult.response.status, 201, roleResult.text);
    actor.role = roleResult.data.role;
    const approved = await http(`/api/admin/users/${actor.applicationUser.id}/approve`, a, 'POST', { roleId: actor.role.id });
    assert.equal(approved.response.status, 200, approved.text);
    return actor;
  }
  const b = await user(['exports.view','exports.create']); const c = await user(['exports.view','exports.create']); const viewer = await user(['exports.view']);
  const unrelatedAdmin = await authenticateIdentitySession({ subject: `shared-admin-${crypto.randomUUID()}` });
  const approvedAdmin = await http(`/api/admin/users/${unrelatedAdmin.applicationUser.id}/approve`, a, 'POST', { roleId: await suite.roleIdForKey('administrator') });
  assert.equal(approvedAdmin.response.status, 200, approvedAdmin.text);
  const family = await templates.createTemplate({ key: `shared-${crypto.randomUUID()}`, displayName: 'Shared fixture', definition: definition('Shared durable result') }, options(a));
  const version = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options(a));
  const selected = await templates.getActivation();
  await templates.updateActivation({ expectedGeneration: selected.generation, implementation: 'template', templateVersionId: version.id }, options(a));
  fixture = { a, b, c, viewer, unrelatedAdmin, version }; return fixture;
}
async function workspace() {
  const f = await setup(); const sku = `BR-SHARED-${crypto.randomUUID()}`.toUpperCase();
  const p = (await insertProductFixture(pool,"INSERT INTO products(full_sku,base_sku,category,weight,total_price_uah,details) VALUES($1,$1,'BR',10,100,'{\"answers\":{}}') RETURNING *", [sku])).rows[0];
  const input = { title: 'Мій приватний експорт', creationKey: crypto.randomUUID(), settings: { requestContract: 'template-v1', fromSku: sku, toSku: sku, selection: { mode: 'active' } } };
  const created = await http(root, f.a, 'POST', input); assert.equal(created.response.status, 201, created.text);
  return { ...f, p, input, s: created.data };
}
const command = (s, accessEpoch = 'owner') => ({ expectedRevision: s.configurationRevision, expectedAccessEpoch: accessEpoch });
async function join(w, actor = w.b) {
  const invite = await http(`${root}/${w.s.id}/invitations`, w.a, 'POST', { userId: actor.applicationUser.id, expectedAccessEpoch: 'owner' });
  assert.equal(invite.response.status, 200, invite.text);
  const accepted = await http(`${root}/${w.s.id}/membership`, actor, 'POST', { action: 'accept', expectedAccessEpoch: invite.data.epoch });
  assert.equal(accepted.response.status, 200, accepted.text); return accepted.data.epoch;
}
async function prepared(w, actor = w.a, epoch = 'owner') {
  const p = await http(`${root}/${w.s.id}/prepare`, actor, 'POST', command(w.s, epoch));
  assert.equal(p.response.status, 200, p.text); assert.equal(p.data.state, 'prepared'); return p.data;
}
async function effects(productId) {
  return { snapshots: (await pool.query('SELECT id FROM export_snapshots ORDER BY id')).rows,
    artifacts: (await pool.query('SELECT snapshot_id,group_code,csv_content FROM magento_export_artifacts ORDER BY snapshot_id,group_code')).rows,
    revisions: (await pool.query('SELECT * FROM product_export_revisions WHERE product_id=$1', [productId])).rows,
    cursor: (await pool.query('SELECT * FROM export_state')).rows,
    events: (await pool.query("SELECT id FROM audit_events WHERE event_key IN ('export_snapshot.created','export_session.generated') ORDER BY id")).rows };
}
async function worker() { const db = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 }); return { db, pid: (await db.query('SELECT pg_backend_pid() pid')).rows[0].pid }; }
async function blocked(pid, by) {
  const until = Date.now() + 10000;
  while (Date.now() < until) { if ((await pool.query('SELECT $2::int=ANY(pg_blocking_pids($1)) yes', [pid, by])).rows[0].yes) return; await new Promise((r) => setTimeout(r, 10)); }
  assert.fail(`Backend ${pid} did not block on ${by}`);
}
function gate(db, pattern, fail = false) {
  let release; let arrived; let once = false;
  const wait = new Promise((r) => { release = r; });
  return { arrived: new Promise((r) => { arrived = r; }), release, database: { query: (...a) => db.query(...a), connect: async () => {
    const c = await db.connect(); return { release: () => c.release(), query: async (...args) => {
      if (!once && (typeof pattern === 'function' ? pattern(args) : pattern.test(args[0]))) { once = true; arrived(); await wait; if (fail) throw new Error('injected result-link failure'); }
      return c.query(...args);
    } };
  } } };
}

test('Shared export private/invited/joined access, bounded directory, safe preparation retries and independent own session', async () => {
  const w = await workspace(); const before = await effects(w.p.id);
  assert.equal((await http(`${root}/${w.s.id}`, w.b)).response.status, 404);
  assert.equal((await http(`${root}/${w.s.id}`, w.unrelatedAdmin)).response.status, 404, 'Administrator role does not grant session membership');
  assert.equal((await http(`${root}/${crypto.randomUUID()}`, w.b)).response.status, 404);
  assert.equal((await http(`${root}/${w.s.id}/membership`, w.c, 'POST', { action: 'accept', expectedAccessEpoch: '1' })).response.status, 404);
  const retry = await http(root, w.a, 'POST', w.input); assert.equal(retry.data.id, w.s.id);
  assert.equal((await http(root, w.a, 'POST', { ...w.input, title: 'different' })).response.status, 409);
  const invited = await http(`${root}/${w.s.id}/invitations`, w.a, 'POST', { userId: w.b.applicationUser.id, expectedAccessEpoch: 'owner' });
  const invites = await http(`${root}?scope=invitations&limit=1`, w.b);
  assert.equal(invites.data.items[0].id, w.s.id);
  assert.deepEqual(Object.keys(invites.data.items[0]).sort(), ['accessEpoch','id','ownerName','ownerUserId','state','title']);
  assert.equal((await http(`${root}/${w.s.id}`, w.b)).response.status, 404);
  const independent = await http(root, w.b, 'POST', { ...w.input, creationKey: crypto.randomUUID(), title: 'Свій експорт B' });
  assert.notEqual(independent.data.id, w.s.id);
  const accepted = await http(`${root}/${w.s.id}/membership`, w.b, 'POST', { action: 'accept', expectedAccessEpoch: invited.data.epoch });
  assert.equal(accepted.response.status, 200, accepted.text);
  assert.equal((await http(`${root}?scope=shared`, w.b)).data.items[0].id, w.s.id);
  assert.equal((await http(`${root}/${w.s.id}/recipients?q=sh`, w.b)).response.status, 404);
  const recipients = await http(`${root}/${w.s.id}/recipients?q=Critical`, w.a);
  assert.ok(recipients.data.users.length <= 20);
  for (const u of recipients.data.users) assert.deepEqual(Object.keys(u).sort(), ['display_name','id','preferred_username']);
  const p = await prepared(w); const duplicate = await prepared(w, w.b, accepted.data.epoch); assert.equal(duplicate.id, p.id);
  const detail = await http(`${root}/${w.s.id}`, w.b); assert.equal(detail.data.attempt.id, p.id);
  assert.ok(!JSON.stringify(detail.data).includes('preview_proof')); assert.ok(!JSON.stringify(detail.data).includes('ep1.'));
  assert.deepEqual(await effects(w.p.id), before, 'all metadata preparation leaves export/product state untouched');
});

test('Shared export exact recovery after lost response, independently authenticated collaborator, private direct paths and actual attribution', async () => {
  const w = await workspace(); const epoch = await join(w); const p = await prepared(w);
  // Deliberately discard the generation response. A fresh authenticated HTTP read
  // locates the original attempt/result with no browser token or snapshot/key.
  const made = await http(`${root}/${w.s.id}/generate`, w.b, 'POST', { ...command(w.s, epoch), attemptId: p.id });
  assert.equal(made.response.status, 201, made.text);
  const list = await http(`${root}?scope=owned`, w.a); assert.ok(list.data.items.some((s) => s.id === w.s.id));
  const recovered = await http(`${root}/${w.s.id}`, w.a); assert.equal(recovered.data.snapshotId, made.data.id);
  const stored = (await pool.query('SELECT * FROM export_snapshots WHERE id=$1', [recovered.data.snapshotId])).rows[0];
  assert.equal(stored.created_by_user_id, String(w.b.applicationUser.id)); assert.equal(stored.export_session_id, w.s.id);
  const originalBytes = (await http(`/api/export/snapshots/${stored.id}/magento/BR/csv`, w.a)).text;
  for (const actor of [w.c, w.unrelatedAdmin]) for (const suffix of ['', '/csv', '/magento/BR/csv']) assert.equal((await http(`/api/export/snapshots/${stored.id}${suffix}`, actor)).response.status, 404);
  assert.equal((await http(`/api/export/snapshots/${stored.id}/confirm`, w.c, 'POST', { expectedAccessEpoch: 'owner' })).response.status, 404);
  const row = (await pool.query('SELECT * FROM export_session_attempts WHERE id=$1', [p.id])).rows[0];
  const directRetry = { ...row.request_intent, idempotencyKey: row.idempotency_key };
  assert.equal((await http('/api/export/snapshots', w.c, 'POST', directRetry)).response.status, 404);
  assert.equal((await http('/api/export/snapshots', w.b, 'POST', directRetry)).data.id, stored.id);
  await pool.query('UPDATE products SET total_price_uah=101 WHERE id=$1', [w.p.id]);
  const again = await http(`${root}/${w.s.id}/generate`, w.a, 'POST', { ...command(w.s), attemptId: p.id }); assert.equal(again.data.id, stored.id);
  assert.equal((await http(`/api/export/snapshots/${stored.id}/magento/BR/csv`, w.b)).text, originalBytes);
  assert.equal((await http(`${root}/${w.s.id}`, w.a, 'PUT', { ...command(w.s), settings: w.input.settings, title: 'changed' })).data.code, 'EXPORT_SESSION_FROZEN');
  const viewerEpoch = await join(w, w.viewer);
  assert.equal((await http(`/api/export/snapshots/${stored.id}`, w.viewer)).response.status, 200);
  assert.equal((await http(`${root}/${w.s.id}/generate`, w.viewer, 'POST', { ...command(w.s, viewerEpoch), attemptId: p.id })).response.status, 403);
  assert.equal((await http(`/api/export/snapshots/${stored.id}/confirm`, w.viewer, 'POST', { expectedAccessEpoch: viewerEpoch })).response.status, 403);
  const confirmed = await http(`/api/export/snapshots/${stored.id}/confirm`, w.a, 'POST', { expectedAccessEpoch: 'owner' }); assert.equal(confirmed.response.status, 200, confirmed.text);
  assert.equal((await http(`/api/export/snapshots/${stored.id}/confirm`, w.b, 'POST', { expectedAccessEpoch: epoch })).response.status, 200);
  const final = (await pool.query('SELECT * FROM export_snapshots WHERE id=$1', [stored.id])).rows[0]; assert.equal(final.confirmed_by_user_id, String(w.a.applicationUser.id));
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE subject_id=$1 AND event_key='export_snapshot.confirmed'", [stored.id])).rows[0].n, 1);
});

test('Shared export concurrent A/B prepare and generation use one identity and committed result while status reports executing', async () => {
  const w = await workspace(); const epoch = await join(w); const one = await worker(); const two = await worker();
  try {
    const prepGate = gate(one.db, /INSERT INTO export_session_attempts/);
    const first = sessions.prepare(w.s.id, command(w.s), options(w.a, prepGate.database)); await prepGate.arrived;
    const second = sessions.prepare(w.s.id, command(w.s, epoch), options(w.b, two.db)); await blocked(two.pid, one.pid);
    prepGate.release(); const [p1,p2] = await Promise.all([first,second]); assert.equal(p1.id,p2.id);
    const createGate = gate(one.db, /INSERT INTO export_snapshots/);
    const generating = sessions.generate(w.s.id, { ...command(w.s), attemptId:p1.id }, options(w.a, createGate.database)); await createGate.arrived;
    const pending = await http(`${root}/${w.s.id}`, w.b); assert.equal(pending.data.executing,true); assert.equal(pending.data.attempt.state,'executing'); assert.equal(pending.data.snapshotId,null);
    const retry = sessions.generate(w.s.id, { ...command(w.s,epoch), attemptId:p2.id }, options(w.b,two.db)); await blocked(two.pid,one.pid);
    createGate.release(); const [a,b] = await Promise.all([generating,retry]); assert.equal(a.id,b.id);
    assert.equal((await pool.query('SELECT count(*)::int n FROM export_snapshots WHERE export_session_id=$1',[w.s.id])).rows[0].n,1);
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE subject_id=$1 AND event_key='export_snapshot.created'",[a.id])).rows[0].n,1);
  } finally { await one.db.end(); await two.db.end(); }
});

test('Shared export rollback of artifact, audit and result link leaves no snapshot/exposure; retry and supersede fence old work', async () => {
  for (const pattern of [/INSERT INTO magento_export_artifacts/, (args) => /INSERT INTO audit_events/.test(args[0]) && args[1][0] === 'export_snapshot.created', /UPDATE export_sessions SET snapshot_id/]) {
    const w=await workspace(); const p=await prepared(w); const before=await effects(w.p.id); const db=await worker();
    try {
      const injected=gate(db.db,pattern,true); const work=sessions.generate(w.s.id,{...command(w.s),attemptId:p.id},options(w.a,injected.database));
      const rejected=assert.rejects(work,/injected/); await injected.arrived; injected.release(); await rejected;
      assert.deepEqual(await effects(w.p.id),before);
      assert.equal((await sessions.detail(w.s.id,options(w.a))).attempt.state,'failed');
      const updated=await sessions.saveSession(w.s.id,{...command(w.s),title:'changed',settings:w.input.settings},options(w.a));
      assert.equal(updated.configurationRevision,'2');
      await assert.rejects(sessions.generate(w.s.id,{...command(w.s),attemptId:p.id},options(w.a)),{code:'EXPORT_SESSION_CONFLICT'});
      const fresh=await sessions.prepare(w.s.id,command(updated),options(w.a)); assert.notEqual(fresh.id,p.id);
      await sessions.generate(w.s.id,{...command(updated),attemptId:fresh.id},options(w.a));
    } finally {await db.db.end();}
  }
});

test('Shared export membership ABA, decline/leave/revoke, CAS and prior revocation while generation waits', async () => {
  const w=await workspace(); const epoch=await join(w); const p=await prepared(w);
  await sessions.membership(w.s.id,{action:'leave',expectedAccessEpoch:epoch},options(w.b));
  const nextEpoch=await join(w); assert.notEqual(nextEpoch,epoch);
  await assert.rejects(sessions.generate(w.s.id,{...command(w.s,epoch),attemptId:p.id},options(w.b)),{code:'EXPORT_MEMBERSHIP_CHANGED'});
  const one=await worker(); const two=await worker();
  try {
    const hold=gate(one.db,/UPDATE export_session_members SET state/);
    const revoke=sessions.membership(w.s.id,{action:'revoke',userId:w.b.applicationUser.id,expectedMemberEpoch:nextEpoch,expectedAccessEpoch:'owner'},options(w.a,hold.database)); await hold.arrived;
    const denied=assert.rejects(sessions.generate(w.s.id,{...command(w.s,nextEpoch),attemptId:p.id},options(w.b,two.db)),{code:'EXPORT_NOT_FOUND'});
    await blocked(two.pid,one.pid);hold.release();await revoke;await denied;
    assert.equal((await pool.query('SELECT count(*)::int n FROM export_snapshots WHERE export_session_id=$1',[w.s.id])).rows[0].n,0);
    assert.equal((await http(`${root}/${w.s.id}`,w.b)).response.status,404);
  } finally {await one.db.end();await two.db.end();}
  await sessions.saveSession(w.s.id,{...command(w.s),title:'revision 2',settings:w.input.settings},options(w.a));
  await assert.rejects(sessions.saveSession(w.s.id,{...command(w.s),title:'lost update',settings:w.input.settings},options(w.a)),{code:'EXPORT_SESSION_CONFLICT'});
});

test('Shared export interrupted durable attempt resumes original identity; immutable evidence and no retroactive ownership', async () => {
  const w=await workspace(); const p=await prepared(w);
  // Actual independent Node process dies after durable execution metadata and
  // exposure writes, before snapshot insertion. PostgreSQL rolls back capture
  // and releases the session advisory lock on connection loss, without a TTL.
  const before=await effects(w.p.id);
  const source=`const pool=require('./src/db/pool');const svc=require('./src/services/export-sessions.service');
    const database={query:(...a)=>pool.query(...a),connect:async()=>{const c=await pool.connect();return{release:()=>c.release(),query:async(...a)=>{
      if(/INSERT INTO export_snapshots/.test(a[0]))process.exit(86);return c.query(...a)}}}};
    svc.generate(${JSON.stringify(w.s.id)},${JSON.stringify({...command(w.s),attemptId:p.id})},{databasePool:database,mutationContext:{actorUserId:${w.a.applicationUser.id}}}).catch(e=>{console.error(e);process.exit(1)});`;
  await assert.rejects(runNodeInDatabase(TEST_DATABASE_URL,source),(e)=>e.code===86);
  assert.deepEqual(await effects(w.p.id),before);
  const recovered=await sessions.detail(w.s.id,options(w.a));assert.equal(recovered.attempt.state,'interrupted');assert.equal(recovered.attempt.id,p.id);
  assert.equal((await pool.query('SELECT count(*)::int n FROM export_snapshots WHERE export_session_id=$1',[w.s.id])).rows[0].n,0);
  const epoch=await join(w);
  const result=await sessions.generate(w.s.id,{...command(w.s,epoch),attemptId:p.id},options(w.b));
  assert.equal(result.created_by_user_id,String(w.b.applicationUser.id));
  assert.equal((await pool.query('SELECT initiated_by_user_id FROM export_session_attempts WHERE id=$1',[p.id])).rows[0].initiated_by_user_id,String(w.a.applicationUser.id));
  await assert.rejects(pool.query("UPDATE export_session_attempts SET idempotency_key='replaced' WHERE id=$1",[p.id]),/immutable/);
  await assert.rejects(pool.query('UPDATE export_snapshots SET export_session_id=NULL,export_attempt_id=NULL WHERE id=$1',[result.id]),/immutable/);
  await assert.rejects(pool.query('UPDATE export_sessions SET snapshot_id=NULL WHERE id=$1',[w.s.id]),/immutable/);
  const legacy=await exportsService.createExportSnapshot({fromSku:w.p.full_sku,toSku:w.p.full_sku,profile:'internal-legacy',idempotencyKey:crypto.randomUUID()},options(w.a));
  assert.equal((await http(`/api/export/snapshots/${legacy.id}`,w.c)).response.status,200);
});

test('Shared export capture wins before revocation; concurrent confirmation preserves first actor and later price high water', async () => {
  const w=await workspace();const epoch=await join(w);
  await pool.query('INSERT INTO product_export_revisions(product_id,revision,confirmed_revision,has_product_snapshot) VALUES($1,2,0,false)',[w.p.id]);
  const p=await prepared(w);const one=await worker();const two=await worker();
  try {
    const hold=gate(one.db,/INSERT INTO export_snapshots/);
    const create=sessions.generate(w.s.id,{...command(w.s,epoch),attemptId:p.id},options(w.b,hold.database));await hold.arrived;
    const revoke=sessions.membership(w.s.id,{action:'revoke',userId:w.b.applicationUser.id,expectedMemberEpoch:epoch,expectedAccessEpoch:'owner'},options(w.a,two.db));await blocked(two.pid,one.pid);
    hold.release();const result=await create;await revoke;
    assert.equal(result.created_by_user_id,String(w.b.applicationUser.id));
    assert.equal((await http(`/api/export/snapshots/${result.id}`,w.b)).response.status,404);
    assert.equal((await sessions.detail(w.s.id,options(w.a))).snapshotId,result.id);
    const rejoined=await join(w);
    await pool.query('UPDATE product_export_revisions SET revision=3 WHERE product_id=$1',[w.p.id]);
    const confirmation=gate(one.db,/INSERT INTO export_state/);
    const first=exportsService.confirmExportSnapshot(result.id,{...options(w.a,confirmation.database),expectedAccessEpoch:'owner'});await confirmation.arrived;
    const second=exportsService.confirmExportSnapshot(result.id,{...options(w.b,two.db),expectedAccessEpoch:rejoined});await blocked(two.pid,one.pid);
    confirmation.release();await Promise.all([first,second]);
    const row=(await pool.query('SELECT * FROM product_export_revisions WHERE product_id=$1',[w.p.id])).rows[0];assert.equal(row.revision,'3');assert.equal(row.confirmed_revision,'2');
    const saved=(await pool.query('SELECT * FROM export_snapshots WHERE id=$1',[result.id])).rows[0];assert.equal(saved.confirmed_by_user_id,String(w.a.applicationUser.id));
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE subject_id=$1 AND event_key='export_snapshot.confirmed'",[result.id])).rows[0].n,1);
    const outsiderStatus=await http('/api/export/status',w.c);assert.equal(outsiderStatus.data.lastExport.id,undefined);assert.equal(outsiderStatus.data.lastExport.fromSku,undefined);
  } finally {await one.db.end();await two.db.end();}
});

test('Shared export current capability/disablement rechecked after access lock and owner has no mutation bypass', async () => {
  const w=await workspace();const epoch=await join(w);const p=await prepared(w);
  const { APPLICATION_USER_ADMIN_LOCK_KEY }=require('../src/services/access-admin-transaction');
  for(const disable of [false,true]) {
    const hold=await pool.connect();const workerConnection=await worker();
    try {
      await hold.query('BEGIN');await hold.query('SELECT pg_advisory_xact_lock(hashtext($1))',[APPLICATION_USER_ADMIN_LOCK_KEY]);const pid=(await hold.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const denied=assert.rejects(sessions.generate(w.s.id,{...command(w.s,epoch),attemptId:p.id},options(w.b,workerConnection.db)),{code:'ADMIN_PERMISSION_REVOKED'});await blocked(workerConnection.pid,pid);
      if(disable)await hold.query("UPDATE application_users SET status='disabled' WHERE id=$1",[w.b.applicationUser.id]);
      else await hold.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_key='exports.create'",[w.b.role.id]);
      await hold.query('COMMIT');await denied;
      assert.equal((await pool.query('SELECT count(*)::int n FROM export_snapshots WHERE export_session_id=$1',[w.s.id])).rows[0].n,0);
    } finally {
      await hold.query('ROLLBACK');hold.release();await workerConnection.db.end();
      await pool.query("UPDATE application_users SET status='active' WHERE id=$1",[w.b.applicationUser.id]);
      await pool.query("INSERT INTO role_permissions(role_id,permission_key) VALUES($1,'exports.create') ON CONFLICT DO NOTHING",[w.b.role.id]);
    }
  }
  const owned=await sessions.createSession({...w.input,creationKey:crypto.randomUUID()},options(w.b));
  await pool.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_key='exports.create'",[w.b.role.id]);
  try {await assert.rejects(sessions.invite(owned.id,{userId:w.c.applicationUser.id,expectedAccessEpoch:'owner'},options(w.b)),{code:'ADMIN_PERMISSION_REVOKED'});}
  finally {await pool.query("INSERT INTO role_permissions(role_id,permission_key) VALUES($1,'exports.create')",[w.b.role.id]);}
});

test('Shared export authentication, CSRF, non-active version authority, decline and durable lifecycle audit rollback', async () => {
  const w=await workspace();
  assert.equal((await request(root,{authentication:null})).response.status,401);
  assert.equal((await request(root,{method:'POST',authentication:w.a,csrfToken:null,body:w.input})).response.status,403);
  const invited=await sessions.invite(w.s.id,{userId:w.b.applicationUser.id,expectedAccessEpoch:'owner'},options(w.a));
  await sessions.membership(w.s.id,{action:'decline',expectedAccessEpoch:invited.epoch},options(w.b));
  assert.equal((await http(`${root}/${w.s.id}`,w.b)).response.status,404);
  const selected=await templates.getActivation();await templates.updateActivation({expectedGeneration:selected.generation,implementation:'legacy',templateVersionId:null},options(w.a));
  try {
    const explicit={...w.input,creationKey:crypto.randomUUID(),settings:{...w.input.settings,selection:{mode:'explicit',templateId:w.version.templateId,versionId:w.version.id}}};
    await assert.rejects(sessions.createSession(explicit,options(w.b)),{code:'INSUFFICIENT_PERMISSION'});
  } finally {const s=await templates.getActivation();await templates.updateActivation({expectedGeneration:s.generation,implementation:'template',templateVersionId:w.version.id},options(w.a));}
  const db=await worker();const key=crypto.randomUUID();
  try {
    const injected=gate(db.db,/INSERT INTO audit_events/,true);
    const denied=assert.rejects(sessions.createSession({...w.input,creationKey:key},options(w.a,injected.database)),/injected/);await injected.arrived;injected.release();await denied;
    assert.equal((await pool.query('SELECT count(*)::int n FROM export_sessions WHERE creation_key=$1',[key])).rows[0].n,0);
  } finally {await db.db.end();}
});

test('Shared export concurrent configuration CAS and queued stale attempt are fenced after the winning edit', async () => {
  const w=await workspace();const epoch=await join(w);const p=await prepared(w);const one=await worker();const two=await worker();
  try {
    const hold=gate(one.db,/UPDATE export_sessions SET title/);
    const first=sessions.saveSession(w.s.id,{...command(w.s),title:'A revision wins',settings:w.input.settings},options(w.a,hold.database));await hold.arrived;
    const stale=assert.rejects(sessions.generate(w.s.id,{...command(w.s,epoch),attemptId:p.id},options(w.b,two.db)),{code:'EXPORT_SESSION_CONFLICT'});
    await blocked(two.pid,one.pid);hold.release();const saved=await first;await stale;
    assert.equal(saved.configurationRevision,'2');assert.equal((await pool.query('SELECT state FROM export_session_attempts WHERE id=$1',[p.id])).rows[0].state,'superseded');
    const editGate=gate(one.db,/UPDATE export_sessions SET title/);
    const winner=sessions.saveSession(w.s.id,{...command(saved),title:'A next revision',settings:w.input.settings},options(w.a,editGate.database));await editGate.arrived;
    const loser=assert.rejects(sessions.saveSession(w.s.id,{...command(saved,epoch),title:'B stale revision',settings:w.input.settings},options(w.b,two.db)),{code:'EXPORT_SESSION_CONFLICT'});
    await blocked(two.pid,one.pid);editGate.release();await winner;await loser;
    const final=await sessions.detail(w.s.id,options(w.b));assert.equal(final.title,'A next revision');assert.equal(final.configurationRevision,'3');assert.equal(final.snapshotId,null);
  } finally {await one.db.end();await two.db.end();}
});

test('Shared export real HTTP response loss after commit, new login/client and expired-proof completed recovery', async () => {
  const w=await workspace();const epoch=await join(w);
  const app=suite.express();
  app.use((req,res,next)=>{const json=res.json.bind(res);res.json=(data)=>{
    if(req.method==='POST' && res.statusCode<300 && (req.originalUrl===root || req.originalUrl.endsWith('/prepare') || req.originalUrl.endsWith('/generate'))) {res.destroy();return res;}
    return json(data);
  };next();});
  app.use(suite.createApp({oidcAdapter:suite.integrationOidcAdapter}));
  const server=await new Promise((resolve)=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const post=(url,body)=>fetch(`http://127.0.0.1:${server.address().port}${url}`,{method:'POST',headers:{Cookie:w.b.cookie,'X-CSRF-Token':w.b.csrfToken,'Content-Type':'application/json'},body:JSON.stringify(body)});
  try {
    const key=crypto.randomUUID();await assert.rejects(post(root,{...w.input,creationKey:key,title:'Lost preparation response'}),/fetch failed/);
    const original=(await pool.query('SELECT id FROM export_sessions WHERE creation_key=$1',[key])).rows[0];
    const afterLogin=await authenticateIdentitySession({subject:w.b.subject});assert.equal(afterLogin.applicationUser.id,w.b.applicationUser.id);assert.notEqual(afterLogin.cookie,w.b.cookie);
    const owned=await http(`${root}?scope=owned&limit=50`,afterLogin);assert.ok(owned.data.items.some((s)=>s.id===original.id));
    await assert.rejects(post(`${root}/${w.s.id}/prepare`,command(w.s,epoch)),/fetch failed/);
    const recovered=await http(`${root}/${w.s.id}`,afterLogin);const p=recovered.data.attempt;assert.equal(p.state,'prepared');
    await assert.rejects(post(`${root}/${w.s.id}/generate`,{...command(w.s,epoch),attemptId:p.id}),/fetch failed/);
    const result=await http(`${root}/${w.s.id}`,afterLogin);assert.equal(result.data.attempt.id,p.id);assert.ok(result.data.snapshotId);
    const before=await effects(w.p.id);
    const source=`const now=Date.now();Date.now=()=>now+3600000;
      require('./src/services/export-templates/definition').compileDefinition=()=>{throw Error('compiler unavailable')};
      const svc=require('./src/services/export-sessions.service');const pool=require('./src/db/pool');
      svc.generate(${JSON.stringify(w.s.id)},${JSON.stringify({...command(w.s,epoch),attemptId:p.id})},{mutationContext:{actorUserId:${w.b.applicationUser.id}}})
      .then(s=>{if(s.id!==${JSON.stringify(result.data.snapshotId)})throw Error('wrong result')}).finally(()=>pool.end()).catch(e=>{console.error(e);process.exitCode=1});`;
    await runNodeInDatabase(TEST_DATABASE_URL,source);assert.deepEqual(await effects(w.p.id),before);
    assert.equal((await http(`/api/export/snapshots/${result.data.snapshotId}`,afterLogin)).response.status,200);
  } finally {await new Promise((resolve)=>server.close(resolve));}
});

test('Shared export 036 upgrade rollback, repeat startup, checksum preservation and old snapshot bytes', async () => {
  const name='amber_shared_upgrade_test';const url=await recreateTestDatabase(name);const directory=await fs.mkdtemp(path.join(os.tmpdir(),'amber-shared-migrations-'));const db=new Pool({connectionString:url});
  try {
    for(const file of (await fs.readdir(path.join(serverRoot,'migrations'))).filter((f)=>f.endsWith('.sql')&&f<'037_'))await fs.copyFile(path.join(serverRoot,'migrations',file),path.join(directory,file));
    const run=(dir)=>runNodeInDatabase(url,`require('./src/db/run-migrations').runMigrations(${dir?`{directory:${JSON.stringify(dir)}}`:''}).catch(e=>{console.error(e);process.exitCode=1})`);
    await run(directory);const checksums=(await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
    await db.query("INSERT INTO export_snapshots(id,idempotency_key,from_sku,resolved_to_sku,exported_to_product_id,row_count,file_name,csv_content) VALUES('old','old','A','A',1,1,'old.csv','unchanged bytes')");
    const file='037_shared_export_sessions.sql';const sql=await fs.readFile(path.join(serverRoot,'migrations',file),'utf8');await fs.writeFile(path.join(directory,file),sql+"\nSELECT 'shared migration rollback'::integer;");
    await assert.rejects(run(directory),/shared migration rollback/);assert.equal((await db.query("SELECT to_regclass('export_sessions') AS name")).rows[0].name,null);
    await run();await run();assert.deepEqual((await db.query("SELECT name,checksum FROM schema_migrations WHERE name<'037_' ORDER BY name")).rows,checksums);
    const old=(await db.query("SELECT * FROM export_snapshots WHERE id='old'")).rows[0];assert.equal(old.csv_content,'unchanged bytes');assert.equal(old.export_session_id,null);
  } finally {
    await db.end();assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('amber-shared-migrations-'));await fs.rm(directory,{recursive:true,force:true});await dropTestDatabase(name);
  }
});
