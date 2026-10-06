const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src/services/historical-reactivation-state');

const context = () => ({ product: { id: 5, status: 'archived', corrected_to_product_id: null, total_price_uah: 120 },
  lifecycle: { route: 'retired', business_exclusion_state: 'unknown', evidence: {} }, facts: {} });
test('new current-facts decision does not manufacture an old archive or prior visibility proof', () => {
  assert.equal(s.localIssue(context()), null);
  const c = context(); c.lifecycle.evidence.independentExclusion = true;
  assert.equal(s.localIssue(c), 'HISTORICAL_BUSINESS_EXCLUSION_REVIEW_REQUIRED');
  assert.equal(require('../src/services/product-lifecycle-state').restoreProof(context().product, context().lifecycle, {}, null).eligible, false);
});
test('historical current-fact prerequisites reject every ancestor, deletion, media and unresolved job', () => {
  for (const [key, expected] of [['newerRevision', 'HISTORICAL_LINEAGE_BLOCKED'], ['activeSuccessor', 'HISTORICAL_LINEAGE_BLOCKED'],
    ['correctionSource', 'HISTORICAL_LINEAGE_BLOCKED'], ['testDeletion','HISTORICAL_TEST_DELETION'], ['unfinishedMedia','HISTORICAL_MEDIA_UNRESOLVED'],
    ['unfinishedJob','HISTORICAL_SYNC_UNRESOLVED'], ['unresolvedStep','HISTORICAL_SYNC_UNRESOLVED'], ['unresolvedVisibility','HISTORICAL_SYNC_UNRESOLVED']]) {
    const c = context(); c.facts[key] = true; assert.equal(s.localIssue(c), expected);
  }
  for (const price of [0, -1, NaN, Infinity, null]) { const c=context();c.product.total_price_uah=price;assert.equal(s.localIssue(c),'HISTORICAL_PRICE_INVALID'); }
});
test('signed five-minute reviews bind actor, exact scope and time without accepting caller-chosen expiry', () => {
  const now=1000000, secret='0123456789abcdef0123456789abcdef';
  const review={ format:s.FORMAT, reviewNonce:'receipt', reviewExpiresAt:new Date(now+s.TTL).toISOString(), items:[{article:'KL3/1'}] };
  const token=s.signReview(10,review,secret);
  s.verifyReview(10,review,token,secret,now);
  for(const changed of [{...review,items:[]},{...review,reviewExpiresAt:new Date(now+s.TTL+1).toISOString()}])
    assert.throws(()=>s.verifyReview(10,changed,token,secret,now),{code:'HISTORICAL_REVIEW_STALE'});
  assert.throws(()=>s.verifyReview(11,review,token,secret,now),{code:'HISTORICAL_REVIEW_STALE'});
  assert.throws(()=>s.verifyReview(10,review,token,secret,now+s.TTL),{code:'HISTORICAL_REVIEW_STALE'});
});
test('remote proof pins exact existing identity and all nonstatus fields; missing counterpart never matches', () => {
  const raw={id:91,sku:'KL3/1',status:1,name:'Original',price:120,updated_at:'yesterday'};
  const intent={public_sku:raw.sku,remote_product_id:raw.id,remote_fingerprint:s.remoteFingerprint(raw)};
  assert.equal(s.remoteMatches(intent,null),false);
  assert.equal(s.remoteMatches(intent,{...raw,id:92}),false);
  assert.equal(s.remoteMatches(intent,{...raw,sku:'KL3/other'}),false);
  assert.equal(s.remoteMatches(intent,{...raw,price:121}),false);
  assert.equal(s.remoteMatches(intent,{...raw,status:2,updated_at:'today'},true),true);
  assert.equal(s.remoteMatches(intent,raw,true),false);
});
test('historical receipt reports independent verified timestamps, not guessed old visibility', () => {
  assert.deepEqual(s.receipt({id:'x',product_id:'5',public_sku:'KL3/1',state:'queued'}),{
    intentId:'x',productId:5,article:'KL3/1',state:'queued',reasonCode:null,targetStatus:2,
    hiddenVerifiedAt:null,localActivatedAt:null,nativeConfirmedAt:null });
});
