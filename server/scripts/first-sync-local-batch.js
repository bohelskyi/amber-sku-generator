// Bounded canonical first-sync adapter. Never starts the app, workers or migrations.
const fs=require('node:fs/promises');
const c=require('../src/services/magento/binding-contract');
const batch=require('../src/services/magento/first-sync-batch-preflight');
const first=require('../src/services/magento/first-sync.service');
const MAX_BYTES=4*1024*1024;
const HELP='node scripts/first-sync-local-batch.js --mode preview|apply --input FILE --output NEW_FILE '
  +'--expected-database NAME --actor-id ID [--plan-sha256 HASH]\n'
  +'Preview reads one exact packet (1..10 products); apply requires the reviewed preview file and its printed SHA256. '
  +'Apply records canonical local choices and the reviewed initial imports shown in the plan. Neither mode enqueues jobs or writes Magento. '
  +'Reviewed initial imports may stage ordinary automatic requests through existing triggers. Delivery uses canonical preview/enqueue/apply/readback. Output never overwrites.';
const fail=code=>{throw Object.assign(Error(code),{code});};
function argumentsFor(args) {
  if(args.length===1&&args[0]==='--help')return {help:true};
  const names={'--mode':'mode','--input':'input','--output':'output','--expected-database':'database',
    '--actor-id':'actor','--plan-sha256':'planHash'},out={};
  for(let i=0;i<args.length;i+=2) {
    const key=names[args[i]],value=args[i+1];
    if(!key||Object.hasOwn(out,key)||typeof value!=='string'||!value.trim()||value.startsWith('--')
      ||/[\u0000-\u001f\u007f]/.test(value))fail('BATCH_RUNNER_ARGUMENTS');
    out[key]=value;
  }
  if(!['preview','apply'].includes(out.mode)||!out.input||!out.output||!out.database
    ||!/^\d+$/.test(out.actor||'')||!Number.isSafeInteger(Number(out.actor))||Number(out.actor)<=0
    ||out.mode==='apply'&&!/^[a-f0-9]{64}$/.test(out.planHash||'')
    ||out.mode==='preview'&&out.planHash)fail('BATCH_RUNNER_ARGUMENTS');
  out.actor=Number(out.actor);return out;
}
async function readJson(file) {
  const handle=await fs.open(file,'r');
  try {
    const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_BYTES)fail('BATCH_RUNNER_INPUT_LIMIT');
    const data=Buffer.alloc(MAX_BYTES+1);let bytes=0;
    while(bytes<data.length){const read=await handle.read(data,bytes,data.length-bytes,bytes);if(!read.bytesRead)break;bytes+=read.bytesRead;}
    if(bytes>MAX_BYTES)fail('BATCH_RUNNER_INPUT_LIMIT');
    return JSON.parse(data.subarray(0,bytes).toString('utf8'));
  }finally{await handle.close();}
}
function planInput(plan,options) {
  c.command(plan,['contract','actorUserId','database','request','report']);
  if(plan.contract!=='first-sync-local-batch-plan-v1'||plan.actorUserId!==options.actor||plan.database!==options.database
    ||c.hash(plan)!==options.planHash)fail('BATCH_RUNNER_PLAN_MISMATCH');
  batch.command(plan.request);
  const r=plan.report;
  if(r.contract!=='first-sync-local-authority-batch-v1'||r.readOnly!==true||r.globalFailure
    ||r.bindingRevisionId!==plan.request.bindingRevisionId||!Array.isArray(r.results)
    ||r.results.length!==plan.request.items.length)fail('BATCH_RUNNER_PLAN_MISMATCH');
  const commands=[];
  for(let i=0;i<r.results.length;i++) {
    const result=r.results[i],item=plan.request.items[i];
    if(result.sku!==item.sku)fail('BATCH_RUNNER_PLAN_MISMATCH');
    if(!result.readyForApply)continue;
    const command=result.applyInput;
    if(!command||command.sku!==item.sku||command.bindingRevisionId!==plan.request.bindingRevisionId
      ||!Array.isArray(command.choices)||!command.choices.length||command.choices.some(choice=>choice.choice!=='keep_local'
        || !((choice.target==='price'||['decor_weight','vaha_vyrobu'].includes(choice.target))&&choice.scope==='all'
          || ['meta_title','meta_description'].includes(choice.target)&&['all','en'].includes(choice.scope))
        ||!item.fields.some(f=>f.target===choice.target&&f.scope===choice.scope)))fail('BATCH_RUNNER_PLAN_MISMATCH');
    c.command(command,['sku','bindingRevisionId','previewToken','choices']);first.decisions(command);
    if(!/^[a-f0-9]{64}$/.test(command.previewToken||''))fail('BATCH_RUNNER_PLAN_MISMATCH');
    commands.push(command);
  }
  if(!commands.length)fail('BATCH_RUNNER_NO_READY_CHOICES');
  return commands;
}
function getOnly(fetchImpl) {
  return (url,init={})=>{
    if((init.method||'GET').toUpperCase()!=='GET')fail('BATCH_RUNNER_REMOTE_WRITE_DENIED');
    return fetchImpl(url,init);
  };
}
async function persist(handle,artifact,config,secrets) {
  require('../src/services/magento/binding-evidence-audit').assertEvidenceSafe(artifact,config,secrets);
  const data=Buffer.from(JSON.stringify(artifact)+'\n');if(data.length>MAX_BYTES)fail('BATCH_RUNNER_OUTPUT_LIMIT');
  await handle.truncate(0);
  for(let offset=0;offset<data.length;)offset+=(await handle.write(data,offset,data.length-offset,offset)).bytesWritten;
  await handle.sync();
}
async function appendReceipt(handle,artifact,config,secrets) {
  require('../src/services/magento/binding-evidence-audit').assertEvidenceSafe(artifact,config,secrets);
  const data=Buffer.from(JSON.stringify(artifact)+'\n');
  if((await handle.stat()).size+data.length>MAX_BYTES)fail('BATCH_RUNNER_OUTPUT_LIMIT');
  for(let offset=0;offset<data.length;)offset+=(await handle.write(data,offset,data.length-offset,null)).bytesWritten;
  await handle.sync();
}
async function main(args=process.argv.slice(2),dependencies={}) {
  const {env=process.env,print=console.log,printError=console.error}=dependencies;
  let owned,output,applyStarted=false;
  try {
    const options=argumentsFor(args);if(options.help){print(HELP);return 0;}
    const document=await (dependencies.read||readJson)(options.input);
    const commands=options.mode==='apply'?planInput(document,options):null;
    if(!commands)batch.command(document);
    const config=dependencies.config||require('../src/config/magento').parseMagentoConfig(env);
    if(!config.configured)fail('MAGENTO_NOT_CONFIGURED');
    let pool=dependencies.pool;
    if(!pool) {
      const configuration=require('../src/config/env').loadConfig(env);
      pool=owned=new (require('pg').Pool)({...configuration.databaseOptions,
        ssl:configuration.useSsl?{rejectUnauthorized:false}:false,max:4,
        connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000});
    }
    if((await pool.query('SELECT current_database() AS name')).rows[0]?.name!==options.database)fail('BATCH_RUNNER_DATABASE_MISMATCH');
    // Reserve private evidence before any local choice. Existing paths cannot be reused.
    output=await fs.open(options.output,'wx',0o600);
    const run={databasePool:pool,actorUserId:options.actor,fetchImpl:getOnly(dependencies.fetchImpl||globalThis.fetch),
      sensitiveValues:require('./magento-binding-evidence-audit').databaseSecrets(env)};
    let artifact;
    if(!commands) {
      const report=await (dependencies.preflight||batch.preflight)(config,document,run);
      artifact={contract:'first-sync-local-batch-plan-v1',actorUserId:options.actor,database:options.database,request:document,report};
    }else {
      const results=[];
      await appendReceipt(output,{contract:'first-sync-local-batch-journal-v1',planHash:options.planHash,total:commands.length},config,run.sensitiveValues);
      for(const command of commands) {
        applyStarted=true;
        try{results.push({sku:command.sku,status:'recorded',result:await (dependencies.apply||first.apply)(config,command,{...run,validateFirstSyncDecision:(base,report,choices)=>batch.validatePacketDecision(base,report,document.request,document.request.items.find(i=>i.sku===command.sku),choices)})});}
        catch(e){results.push({sku:command.sku,status:e.statusCode>=400&&e.statusCode<500?'blocked':'unconfirmed',code:safeCode(e)});}
        // Persist every committed receipt before moving to another product.
        await appendReceipt(output,{contract:'first-sync-local-batch-receipt-v1',...results.at(-1)},config,run.sensitiveValues);
        if(results.at(-1).status!=='recorded')break;
      }
      artifact={contract:'first-sync-local-batch-result-v1',planHash:options.planHash,results,
        checked:results.length,total:commands.length,recorded:results.filter(r=>r.status==='recorded').length,
        failed:results.filter(r=>r.status==='blocked').length,unconfirmed:results.filter(r=>r.status==='unconfirmed').length,
        notChecked:commands.length-results.length,complete:results.length===commands.length&&results.every(r=>r.status==='recorded'),
        directRemoteWrites:0,directlyEnqueuedJobs:0};
    }
    if(commands)await appendReceipt(output,artifact,config,run.sensitiveValues);else await persist(output,artifact,config,run.sensitiveValues);
    print(JSON.stringify({ok:commands?artifact.complete:true,mode:options.mode,output:options.output,planSha256:commands?options.planHash:c.hash(artifact),
      ...(commands?{automaticSyncRequestsPossible:document.report.results.some(r=>r.readyForApply&&r.initialImports?.length>0)}:{}),
      ...(commands?Object.fromEntries(['checked','total','recorded','failed','unconfirmed','notChecked','complete'].map(k=>[k,artifact[k]])):artifact.report.counts),directRemoteWrites:0,directlyEnqueuedJobs:0}));
    return commands?!artifact.complete?2:0
      :artifact.report.counts.blocked||artifact.report.counts.notChecked||artifact.report.counts.ordinaryPreviewRequired?2:0;
  }catch(e){printError(JSON.stringify({ok:false,code:safeCode(e),...(applyStarted?{localResultUnconfirmed:true}:{}),directRemoteWrites:0,directlyEnqueuedJobs:0}));return 1;}
  finally{if(output)await output.close().catch(()=>{});if(owned)await owned.end().catch(()=>{});}
}
function safeCode(e){return e?.code==='EEXIST'?'BATCH_RUNNER_OUTPUT_EXISTS':typeof e?.code==='string'&&/^[A-Z0-9_]{1,160}$/.test(e.code)?e.code:'BATCH_RUNNER_FAILED';}
if(require.main===module)main().then(code=>{process.exitCode=code;});
module.exports={argumentsFor,planInput,getOnly,main};
