const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const runner=require('../scripts/first-sync-local-batch'),batch=require('../src/services/magento/first-sync-batch-preflight'),c=require('../src/services/magento/binding-contract');
const binding='11111111-1111-4111-8111-111111111111',hash='a'.repeat(64);
const request={bindingRevisionId:binding,expectedDefinitionHash:hash,items:[{sku:'NM1',expectedProduct:batch.source({weight:null}),remoteProductId:1,
 fields:[{target:'meta_title',scope:'all',local:'Amber title',remote:'Magento title'}]}]};
const command={sku:'NM1',bindingRevisionId:binding,previewToken:hash,choices:[{target:'meta_title',scope:'all',choice:'keep_local'}]};
function plan(){return {contract:'first-sync-local-batch-plan-v1',actorUserId:7,database:'fixture_test',request:structuredClone(request),report:{contract:'first-sync-local-authority-batch-v1',readOnly:true,
 bindingRevisionId:binding,results:[{sku:'NM1',readyForApply:true,applyInput:command}],counts:{total:1,readyForApply:1,blocked:0}}};}
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'amber-batch-runner-'));t.after(()=>fs.rm(dir,{recursive:true}));
 const messages=[],calls=[];return {dir,messages,calls,dependencies:{env:{},config:{configured:true,baseUrl:'https://batch.invalid'},pool:{query:async()=>({rows:[{name:'fixture_test'}]})},
 print:s=>messages.push(JSON.parse(s)),printError:s=>messages.push(JSON.parse(s)),read:async()=>request,preflight:async()=>plan().report,
 apply:async(_c,input)=>{calls.push(input);return {receipt:{sessionId:binding,revision:'1'},readyForOutbound:true};}}};}
const args=(f,mode='preview')=>['--mode',mode,'--input',path.join(f.dir,'input.json'),'--output',path.join(f.dir,'output.json'),'--expected-database','fixture_test','--actor-id','7'];
test('preview creates private exclusive review artifact and prints its canonical SHA256',async t=>{
 const f=await fixture(t);assert.equal(await runner.main(args(f),f.dependencies),0);
 const file=path.join(f.dir,'output.json'),saved=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(f.messages[0].planSha256,c.hash(saved));
 assert.equal((await fs.stat(file)).mode&0o777,0o600);assert.equal(saved.report.readOnly,true);assert.equal(f.calls.length,0);
 assert.equal(await runner.main(args(f),f.dependencies),1);assert.equal(f.messages[1].code,'BATCH_RUNNER_OUTPUT_EXISTS');
});
test('plan digest/actor/database, mixed decisions and remote choice are rejected before execution',()=>{
 const p=plan(),options={actor:7,database:'fixture_test',planHash:c.hash(p)};assert.equal(runner.planInput(p,options).length,1);
 for(const o of [{...options,actor:8},{...options,database:'amber'},{...options,planHash:'b'.repeat(64)}])assert.throws(()=>runner.planInput(p,o),{code:'BATCH_RUNNER_PLAN_MISMATCH'});
 const remote=structuredClone(p);remote.report.results[0].applyInput.choices[0].choice='accept_remote';assert.throws(()=>runner.planInput(remote,{...options,planHash:c.hash(remote)}),{code:'BATCH_RUNNER_PLAN_MISMATCH'});
 const mixed=structuredClone(p);mixed.report.results[0].applyInput.target='meta_title';assert.throws(()=>runner.planInput(mixed,{...options,planHash:c.hash(mixed)}));
 const other=structuredClone(p);other.request.items[0].fields[0].target='kolir';other.report.results[0].applyInput.choices[0].target='kolir';
 assert.throws(()=>runner.planInput(other,{...options,planHash:c.hash(other)}),{code:'BATCH_RUNNER_PLAN_MISMATCH'});
});
test('apply persists each receipt and stops at first rejected product without enqueue or remote mutation',async t=>{
 const f=await fixture(t),p=plan();
 for(let i=2;i<=3;i++){p.request.items.push({...structuredClone(p.request.items[0]),sku:'NM'+i});p.report.results.push({...structuredClone(p.report.results[0]),sku:'NM'+i,applyInput:{...structuredClone(command),sku:'NM'+i}});}
 f.dependencies.read=async()=>p;f.dependencies.apply=async(_c,input)=>{f.calls.push(input);if(input.sku==='NM2')throw Object.assign(Error('Stale'),{statusCode:409,code:'MAGENTO_FIRST_SYNC_PREVIEW_STALE'});return {receipt:{revision:'1'},readyForOutbound:false};};
 assert.equal(await runner.main([...args(f,'apply'),'--plan-sha256',c.hash(p)],f.dependencies),2,JSON.stringify(f.messages));
 const lines=(await fs.readFile(path.join(f.dir,'output.json'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)),saved=lines.at(-1);
 assert.equal(lines.length,4);assert.equal(lines[1].status,'recorded');assert.equal(lines[2].status,'blocked');
 assert.equal(saved.results.length,2);assert.equal(saved.checked,2);assert.equal(saved.total,3);assert.equal(saved.complete,false);
 assert.equal(f.messages[0].ok,false);assert.equal(f.messages[0].notChecked,1);
 assert.equal(saved.results[0].status,'recorded');assert.equal(saved.results[1].code,'MAGENTO_FIRST_SYNC_PREVIEW_STALE');assert.equal(f.calls.length,2);
 assert.equal(saved.directRemoteWrites,0);assert.equal(saved.directlyEnqueuedJobs,0);
});
test('real database name mismatch aborts before output and before any decision',async t=>{
 const f=await fixture(t);f.dependencies.pool.query=async()=>({rows:[{name:'wrong_test'}]});assert.equal(await runner.main(args(f),f.dependencies),1);
 assert.equal(f.messages[0].code,'BATCH_RUNNER_DATABASE_MISMATCH');assert.equal(f.calls.length,0);await assert.rejects(fs.stat(path.join(f.dir,'output.json')),{code:'ENOENT'});
});
test('unknown commit outcome remains unconfirmed and retains previous receipts without starting another product',async t=>{
 const f=await fixture(t),p=plan();
 for(let i=2;i<=3;i++){p.request.items.push({...structuredClone(p.request.items[0]),sku:'NM'+i});p.report.results.push({...structuredClone(p.report.results[0]),sku:'NM'+i,applyInput:{...structuredClone(command),sku:'NM'+i}});}
 f.dependencies.read=async()=>p;f.dependencies.apply=async(_c,input)=>{f.calls.push(input);if(input.sku==='NM2')throw Object.assign(Error('Commit connection lost'),{code:'ECONNRESET'});return {receipt:{revision:'1'}};};
 assert.equal(await runner.main([...args(f,'apply'),'--plan-sha256',c.hash(p)],f.dependencies),2,JSON.stringify(f.messages));
 const lines=(await fs.readFile(path.join(f.dir,'output.json'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(lines[1].status,'recorded');assert.equal(lines[2].status,'unconfirmed');assert.equal(lines.at(-1).unconfirmed,1);
 assert.equal(f.messages[0].recorded,1);assert.equal(f.messages[0].notChecked,1);assert.equal(f.messages[0].complete,false);assert.equal(f.calls.length,2);
});
test('transport firewall permits only GET and never delegates POST/PUT/DELETE',async()=>{
 let reads=0;const get=runner.getOnly(async()=>{reads++;return 'read';});assert.equal(await get('https://batch.invalid',{method:'GET'}),'read');
 for(const method of ['POST','PUT','DELETE','PATCH'])assert.throws(()=>get('https://batch.invalid',{method}),{code:'BATCH_RUNNER_REMOTE_WRITE_DENIED'});assert.equal(reads,1);
});
test('apply requires explicit mode/hash and refuses sparse or oversized input',()=>{
 for(const args of [[],['--mode','apply'],['--mode','preview','--input','a','--output','b','--expected-database','fixture_test','--actor-id','7','--plan-sha256',hash]])assert.throws(()=>runner.argumentsFor(args),{code:'BATCH_RUNNER_ARGUMENTS'});
 const p=plan();p.request.items=Array(1);assert.throws(()=>runner.planInput(p,{actor:7,database:'fixture_test',planHash:c.hash(p)}));
});
