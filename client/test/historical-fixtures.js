export const batchId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const intentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const capability = { historicalReactivation: { available: true, format: 'historical-reactivation-v1', administratorOnly: true, maxItems: 100, targetStatus: 2 } };
export const permissions = ['products.view', 'products.archive', 'history.view', 'export_templates.manage', 'export_templates.publish'];
export const makeAuth = () => ({ permissions: [...permissions], roles: [{key:'administrator'}], principalLifetime: {id:'historical-test', valid:true} });
export const makeReview = () => ({format:'historical-reactivation-v1', skus:['AR-000001','SV-000002','MISSING'], reviewNonce:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', reviewHash:'a'.repeat(64), reviewToken:'signed-test-only', reviewExpiresAt:new Date(Date.now()+300000).toISOString(), counts:{eligible:2,blocked:0,skipped:1}, items:[
 ...['AR-000001','SV-000002'].map((article,index)=>({inputSku:article,article,productId:index+1,category:index?'SV':'AR',disposition:'eligible',reasonCode:null,currentPriceUah:1200,currentWeight:12.3,currentRoute:'retired',currentBusinessExclusion:'archived',priorFacts:'unknown',remoteProductId:index+51,observedRemoteStatus:1,targetStatus:2,prerequisites:[{code:'ATOMIC_UPDATE_ONLY_SUPPORTED',met:true}],blockerCodes:[]})),
 {inputSku:'MISSING',disposition:'skipped',reasonCode:'HISTORICAL_PRODUCT_NOT_FOUND',priorFacts:'unknown',targetStatus:2,prerequisites:[],blockerCodes:['HISTORICAL_PRODUCT_NOT_FOUND']}
] });
export const makeReceipt = (state='queued') => ({ batchId,createdAt:new Date().toISOString(),items:[{intentId,productId:1,article:'AR-000001',state,reasonCode:null,targetStatus:2,hiddenVerifiedAt:state==='awaiting_native'||state==='completed'?new Date().toISOString():null,localActivatedAt:state==='awaiting_native'||state==='completed'?new Date().toISOString():null,nativeConfirmedAt:state==='completed'?new Date().toISOString():null}] });
export const makeInspection = () => ({intentId,article:'AR-000001',state:'dispatched',expectedMagentoId:51,observedMagentoId:51,observedStatus:2,targetStatus:2,canConfirm:true,reviewHash:'d'.repeat(64)});
