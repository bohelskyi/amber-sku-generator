const fs = require('node:fs/promises');
const path = require('node:path');
const service = require('../src/services/canonical-weight-repair');
const manifest = require('../src/services/canonical-weight-manifest');
const { createReadOnlyPool } = require('./magento-binding-evidence-audit');
const { createReceiptWriter } = require('./exposure-bulk-receipt');
function parseArguments(args) {
  const flags = { '--mode':'mode', '--expected-database':'expectedDatabase', '--installation-key':'installationKey',
    '--binding-revision':'bindingRevisionId', '--actor-user-id':'actorUserId', '--output':'output', '--plan':'planPath',
    '--confirm-plan-hash':'expectedHash', '--product-ids':'productIds', '--receipt-ids':'rollbackReceiptIds' };
  const values = {};
  for (let i=0;i<args.length;i+=2) {
    const key=flags[args[i]],value=args[i+1];
    if (!key || Object.hasOwn(values,key) || !value || value.startsWith('--') || /[\u0000-\u001f\u007f]/.test(value)) throw manifest.error('SV_CANONICAL_WEIGHT_ARGUMENTS',422);
    values[key]=value;
  }
  values.mode ||= 'preview';
  if (!['preview','rollback-preview','apply'].includes(values.mode) || !values.expectedDatabase || !values.installationKey
    || !values.bindingRevisionId || !values.output || !/^[1-9]\d*$/.test(values.actorUserId || '')
    || !Number.isSafeInteger(Number(values.actorUserId)) || !manifest.uuid(values.bindingRevisionId)) throw manifest.error('SV_CANONICAL_WEIGHT_ARGUMENTS',422);
  if (values.mode==='apply') {
    if (!values.planPath || !manifest.fingerprint(values.expectedHash) || !values.productIds || values.rollbackReceiptIds) throw manifest.error('SV_CANONICAL_WEIGHT_ARGUMENTS',422);
    values.productIds=values.productIds.split(',').map(text=>/^[1-9]\d*$/.test(text)?Number(text):NaN);
    if (!values.productIds.length || values.productIds.length>manifest.LIMIT || values.productIds.some(value=>!manifest.id(value))
      || new Set(values.productIds).size!==values.productIds.length) throw manifest.error('SV_CANONICAL_WEIGHT_ARGUMENTS',422);
  } else {
    if (values.planPath || values.expectedHash || values.productIds || (values.mode==='rollback-preview')!==Boolean(values.rollbackReceiptIds)) throw manifest.error('SV_CANONICAL_WEIGHT_ARGUMENTS',422);
    if (values.rollbackReceiptIds) {
      values.rollbackReceiptIds=values.rollbackReceiptIds.split(',');
      if (values.rollbackReceiptIds.length>manifest.LIMIT || values.rollbackReceiptIds.some(id=>!manifest.uuid(id))
        || new Set(values.rollbackReceiptIds).size!==values.rollbackReceiptIds.length) throw manifest.error('SV_CANONICAL_WEIGHT_ARGUMENTS',422);
    }
  }
  return values;
}
async function run(args=process.argv.slice(2)) {
  let pool,file;
  try {
    const input=parseArguments(args),config=require('../src/config/env').magento;
    pool=input.mode==='apply'?require('../src/db/pool'):createReadOnlyPool(process.env);
    const options={...input,databasePool:pool,config,mutationContext:{actorUserId:input.actorUserId,requestId:'canonical-weight-cli'}};
    if (input.mode==='apply') {
      const stat=await fs.stat(input.planPath);
      if (stat.size>manifest.MAX_PLAN_BYTES+1024) throw manifest.error('SV_CANONICAL_WEIGHT_PLAN_LIMIT',422);
      const plan=JSON.parse(await fs.readFile(input.planPath,'utf8'));
      service.verify(plan,input.expectedHash,input.expectedDatabase,input.installationKey);
      const checkpoint=await createReceiptWriter(input.output);
      const result=await service.apply(plan,{...options,checkpoint});
      console.log(JSON.stringify({output:input.output,planHash:plan.planHash,counts:result.counts}));
      return result.counts.failed || result.counts.conflicted || result.counts.not_attempted?2:0;
    }
    file=await fs.open(input.output,'wx');
    const plan=await service.preview(options);
    await file.writeFile(JSON.stringify(plan)+'\n'); await file.sync();
    console.log(JSON.stringify({output:input.output,planHash:plan.planHash,summary:plan.summary,examples:plan.entries.filter(e=>e.eligible).slice(0,5).map(e=>({productId:e.productId,publicSku:e.publicSku,sourceAnswer:e.sourceAnswer,targetWeight:e.targetWeight}))}));
    return 0;
  } catch (cause) {
    console.error(/^SV_CANONICAL_WEIGHT_|^ADMIN_PERMISSION_REVOKED$/.test(cause.code || '')?cause.code:'SV_CANONICAL_WEIGHT_FAILED');
    return 1;
  } finally { if(file)await file.close(); if(pool)await pool.end(); }
}
if(require.main===module) {
  require('dotenv').config({path:path.resolve(__dirname,'../../.env'),override:false,quiet:true});
  run().then(code=>{process.exitCode=code;});
}
module.exports={parseArguments,run};
