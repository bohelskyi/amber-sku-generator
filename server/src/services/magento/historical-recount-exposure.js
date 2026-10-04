const stable = require('./stable-recount-exposure');
const c = require('./binding-contract');
const { observe } = require('./exposure-reconciliation');
const { buildLineageGraph } = require('../export-exposure/manifest');
const { readRepairInput } = require('../export-exposure/repair-loader');
const { buildRepairManifest } = require('../export-exposure/repair-manifest');
const cutover = require('./historical-cutover-baseline');

const FORMAT = 'magento-historical-recount-exposure-v1';
const legacy = m => (m.lifecycle?.evidence?.origin === 'migration_039' && m.lifecycle.evidence.coverage === 'unresolved_historical')
  || cutover.verified(m);
// Missing baseline pointers are not rewritten. Only actual, reciprocal recount
// records may prove the chain; modern pointers must still match exactly.
function lineageBlockers(members, corrections, currentId) {
  const out = [], graph = buildLineageGraph(members.map(m => m.product),corrections);
  const component = graph.components.get(currentId), current = members.find(m => m.product.id === currentId);
  if (!current || members.length > 30 || !component || component.issues.length || members.length < 2
    || component.productIds.length !== members.length || c.hash(graph.terminals(currentId)) !== c.hash([currentId])) out.push('CORRECTION_LINEAGE_CONFLICT');
  for (const member of members) {
    const { product: p, lifecycle: f, reservation } = member;
    const retired = p.id !== currentId && p.status === 'corrected' && f?.route === 'retired';
    if (!reservation || reservation.first_product_id !== p.id) out.push('SKU_RESERVATION_CONFLICT');
    if (p.id !== currentId && !retired) out.push('PREDECESSOR_NOT_RETIRED');
    const unknownBaseline = retired && legacy(member) && f.business_exclusion_state === 'unknown';
    if (retired && f?.evidence?.origin === 'cutover' && !cutover.verified(member)
      && (f.business_exclusion_state === 'unknown' || (p.corrected_from_product_id != null && f.source_correction_id == null))) out.push('CUTOVER_BASELINE_UNVERIFIED');
    if (!f || (!unknownBaseline && f.business_exclusion_state !== 'none') || f.evidence?.independentExclusion === true
      || f.evidence?.exclusionProvenance === 'independent_exclusion'
      || (f.evidence?.exclusionProvenance === 'unknown' && !unknownBaseline)) out.push('EXCLUSION_OR_UNKNOWN_POLICY');
    if (f?.recount_compatibility_excluded !== false) out.push('RECOUNT_COMPATIBILITY_EXCLUSION');
    if (p.corrected_from_product_id == null) {
      if (f?.source_correction_id != null) out.push('CORRECTION_LINEAGE_CONFLICT');
    } else {
      const links = corrections.filter(v => v.corrected_product_id === p.id);
      if (links.length !== 1 || (f?.source_correction_id !== links[0].id && !(retired && legacy(member) && f.source_correction_id == null))) out.push('CORRECTION_LINEAGE_CONFLICT');
    }
  }
  return [...new Set(out)];
}
async function read(client,config,sku,bindingRevisionId) {
  const local = await stable.read(client,config,sku,bindingRevisionId), s = local.state.stable;
  const baselines = await cutover.read(client,s.members);
  for (const member of s.members) member.cutoverBaseline = baselines.get(member.product.id) || null;
  const identities = [...new Set(s.members.map(m => String(m.product.public_product_identity_id)))].sort((a,b) => Number(a)-Number(b));
  const ids = s.members.map(m => m.product.id);
  const entry = buildRepairManifest(await readRepairInput(client)).repairEntries.find(e => e.productId === local.state.product.id);
  const exact = entry ? [...entry.generatedMemberships,...entry.confirmedMemberships] : [];
  const oldSkus = [...new Set([...s.members.flatMap(m => [m.product.public_sku,m.product.full_sku]),...exact.map(m => m.sku)])]
    .filter(sku => sku !== local.state.product.public_sku).sort();
  const outsideIdentity = (await client.query(`SELECT EXISTS(SELECT 1 FROM products WHERE public_product_identity_id=ANY($1::bigint[])
    AND NOT(id=ANY($2::int[]))) conflict`,[identities,ids])).rows[0].conflict;
  const jobs = (await client.query(`SELECT to_jsonb(j) job,(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.ordinal) FROM magento_sync_steps s WHERE s.job_id=j.id) steps
    FROM magento_sync_jobs j WHERE public_product_identity_id=ANY($1::bigint[]) OR product_id=ANY($2::int[])
      OR (origin_hash=$3 AND sku=ANY($4::text[])) ORDER BY j.id`,[identities,ids,c.originHash(config.baseUrl),[sku,...oldSkus]])).rows;
  const requests = (await client.query('SELECT * FROM magento_product_sync_requests WHERE public_product_identity_id=ANY($1::bigint[]) ORDER BY public_product_identity_id',[identities])).rows;
  const deletions = (await client.query('SELECT * FROM magento_test_deletions WHERE public_product_identity_id=ANY($1::bigint[]) ORDER BY id',[identities])).rows;
  s.jobs = JSON.parse(JSON.stringify(jobs)); s.deletions = JSON.parse(JSON.stringify(deletions));
  local.state.historical = JSON.parse(JSON.stringify({ identities, oldSkus, requests, outsideIdentity, retainedFingerprint: entry?.beforeFingerprint || null,
    retainedIssues: entry?.exposure.issues || ['LIFECYCLE_EVIDENCE_UNAVAILABLE'],
    unknownRetiredProductIds: s.members.filter(m => m.lifecycle?.business_exclusion_state === 'unknown').map(m => m.product.id),
    cutoverBaselines: [...baselines.values()],
    requiredEvidence: { oldSkus: [], files: [...new Set(exact.map(m => m.snapshotId))].sort(), historicalConfirmation: true } }));
  return local;
}
function blockers(state) {
  const h = state.historical, p = state.product;
  const out = [...stable.commonBlockers(state),...lineageBlockers(state.stable.members,state.stable.corrections,p.id)];
  if (!h?.retainedFingerprint || h.retainedIssues.length) out.push('LIFECYCLE_EVIDENCE_UNAVAILABLE');
  if (h?.outsideIdentity) out.push('CORRECTION_LINEAGE_CONFLICT');
  if (h?.oldSkus.length > 30) out.push('MAGENTO_HISTORY_TOO_LARGE');
  if (h?.requests.some(r => String(r.public_product_identity_id) !== String(p.public_product_identity_id)
    && (r.active_job_id != null || r.active_generation != null || r.reason_code === 'reconciliation_required' || !['synced','excluded'].includes(r.state)))) out.push('UNFINISHED_SYNC_WORK');
  return [...new Set(out)];
}
async function inspect(config,local,options) {
  const sync = await stable.inspectSync(config,local,options), oldArticles = [];
  for (const sku of local.state.historical.oldSkus) {
    const remote = await observe(config,sku,options);
    oldArticles.push({ sku,...remote });
    if (remote.status !== 'not_found') sync.reasons.push(remote.status === 'found' ? 'HISTORICAL_ARTICLE_STILL_PRESENT' : 'MAGENTO_LOOKUP_ERROR');
  }
  return { ...sync, oldArticles };
}
function validateEvidence(plan,evidence) {
  c.command(evidence,['files','confirmation']);
  const files = plan.historical.requiredEvidence.files;
  const text = value => typeof value === 'string' && value.trim().length >= 3 && value.length <= 2000;
  if (!Array.isArray(evidence.files) || evidence.files.length !== files.length || new Set(evidence.files.map(f => f?.snapshotId)).size !== files.length
    || evidence.files.some(f => !files.includes(f?.snapshotId) || !['quarantined_do_not_import','consumed_and_reconciled'].includes(f.disposition) || !text(f.evidence))
    || evidence.confirmation?.disposition !== 'current_update_only' || !text(evidence.confirmation.evidence)) {
    throw c.error(422,'RECONCILIATION_UNRESOLVED','Підтвердьте оновлення поточного товару та долю всіх старих файлів.');
  }
  c.safeData(evidence);
  return evidence;
}
module.exports = { FORMAT,lineageBlockers,blockers,validateEvidence,...stable.createRecipe({
  format: FORMAT,event: 'product.magento_historical_recount_exposure_reconciled',reader: read,check: blockers,inspect,
  // Full request/retained inventory remains fingerprint-bound on the server;
  // the reviewed package contains only the exact identities and dispositions.
  proof: state => {
    const { identities,oldSkus,retainedFingerprint,unknownRetiredProductIds,cutoverBaselines,requiredEvidence } = state.historical;
    return { historical: { identities,oldSkus,retainedFingerprint,unknownRetiredProductIds,cutoverBaselines,requiredEvidence } };
  },validateEvidence,
  source: 'historical_recount_exposure',action: 'magento_historical_recount_prior_exposure',resolutionPrefix: 'historical-recount-exposure',
  lanes: plan => plan.historical.identities,articles: plan => [...new Set([plan.sku,...plan.historical.oldSkus])].sort(),
}) };
