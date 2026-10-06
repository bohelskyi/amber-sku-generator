import test from 'node:test';import assert from 'node:assert/strict';
import {validateIntegrationResume} from '../src/lib/integration-task-resume.js';
const id='11111111-1111-4111-8111-111111111111';
const photoId='22222222-2222-4222-8222-222222222222';
const config={categories:{NM:{name:'Necklace'}},questions:{NM:[{id:'extra',input_type:'options',options:[{id:1}]}]}};
function task() {return {id,state:'open',categoryCode:'NM',resumeHref:'/products/create?integrationTask='+id,deliveryAccepted:false,
  creationContext:{product:{categoryCode:'NM',answers:{extra:1},weight:1,photoIds:[photoId]},photoCount:1,canResume:true,unavailablePhotoIds:[],
    photos:[{id:photoId,name:'photo.png',mimeType:'image/png',available:true,expiresAt:'2099-01-01T00:00:00.000Z'}]}};}
test('explicit resume retains exact creation fields and photo ordering',()=>{
  const value=task();const restored=validateIntegrationResume(value,id,config);
  assert.deepEqual(restored.product,value.creationContext.product);assert.equal(restored.photos[0].id,photoId);
});
test('expired, attached, foreign, malformed and changed semantic evidence cannot silently remove photos/answers',()=>{
  for(const mutate of [value=>value.creationContext.photos[0].expiresAt='2000-01-01',
    value=>value.creationContext.photos[0].expiresAt='invalid',value=>value.creationContext.canResume=false,
    value=>value.creationContext.photos=[],value=>value.resumeHref=null,value=>value.creationContext.product.answers.extra=99,
    value=>value.creationContext.product.answers.unknown=1]) {
    const value=task();mutate(value);assert.throws(()=>validateIntegrationResume(value,id,config));
  }
});
