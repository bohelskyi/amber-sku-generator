import assert from 'node:assert/strict';
import test from 'node:test';
import { canUseHistoricalReactivation, historicalInput, historicalConfirmation, validateHistoricalPreview, validateHistoricalReceipt, validateHistoricalInspection } from '../src/lib/historical-reactivation.js';
import {batchId,capability,makeAuth,makeReview,makeReceipt,makeInspection,permissions} from './historical-fixtures.js';
test('actual Administrator and every effective capability required; manager with identical permissions denied',()=>{
 const auth=makeAuth();assert.equal(canUseHistoricalReactivation(auth,capability),true);
 assert.equal(canUseHistoricalReactivation({...auth,roles:[{key:'manager'}]},capability),false);
 for(const omitted of permissions)assert.equal(canUseHistoricalReactivation({...auth,permissions:permissions.filter(p=>p!==omitted)},capability),false);
 for(const config of [{},{historicalReactivation:{...capability.historicalReactivation,targetStatus:1}},{historicalReactivation:{...capability.historicalReactivation,available:false}}])assert.equal(canUseHistoricalReactivation(auth,config),false);
});
test('input retains exact spelling and confirmation binds original membership plus explicit eligible subset',()=>{
 assert.deepEqual(historicalInput(' ar-001 \n SV2/old '),['ar-001','SV2/old']);assert.throws(()=>historicalInput(''));
 assert.throws(()=>historicalInput(Array(101).fill('SKU').join('\n')));
 const review=makeReview(),cmd=historicalConfirmation(review,['AR-000001'],batchId);
 assert.deepEqual(cmd.skus,review.skus);assert.deepEqual(cmd.selectedSkus,['AR-000001']);assert.equal(cmd.confirmCurrentFactsAndHiddenUpdate,true);assert.equal(Object.isFrozen(cmd.selectedSkus),true);
 for(const selection of [[],['MISSING'],['AR-000001','AR-000001']])assert.throws(()=>historicalConfirmation(review,selection,batchId));
 review.reviewExpiresAt=new Date(Date.now()-1).toISOString();assert.throws(()=>historicalConfirmation(review,['AR-000001'],batchId));
});
test('malformed membership, false prerequisite, hidden target and unknown history proof fail closed',()=>{
 for(const mutate of [r=>r.items.pop(),r=>r.items[0].inputSku='OTHER',r=>r.items[0].prerequisites[0].met=false,r=>r.items[0].prerequisites=[],r=>r.items[0].targetStatus=1,r=>r.items[0].priorFacts='restored',r=>r.counts.eligible=3,r=>r.reviewToken='']){const r=makeReview();mutate(r);assert.throws(()=>validateHistoricalPreview(r));}
});
test('receipt completion requires all independent timestamps and exact IDs; inspection cannot authorize mismatched counterpart',()=>{
 assert.equal(validateHistoricalReceipt(makeReceipt(),batchId).items[0].state,'queued');
 assert.equal(validateHistoricalReceipt(makeReceipt('awaiting_native'),batchId).items[0].nativeConfirmedAt,null);
 for(const mutate of [r=>r.items[0].targetStatus=1,r=>r.batchId='other',r=>r.items[0].nativeConfirmedAt=null,r=>r.items.push({...r.items[0]})]){const r=makeReceipt('completed');mutate(r);assert.throws(()=>validateHistoricalReceipt(r,batchId));}
 const item=makeReceipt().items[0];assert.equal(validateHistoricalInspection(makeInspection(),item).canConfirm,true);
 for(const mutate of [r=>r.observedMagentoId=52,r=>r.observedStatus=1,r=>r.intentId=batchId]){const r=makeInspection();mutate(r);assert.throws(()=>validateHistoricalInspection(r,item));}
});
