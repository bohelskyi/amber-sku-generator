import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HistoricalReactivationReview } from '../src/components/app/HistoricalReactivationReview.jsx';
import { historicalManualNameRequest } from '../src/lib/historical-manual-name-review.js';
import { createHistoricalReactivationApi } from '../src/api/historical-reactivation-api.js';
import { makeAuth, batchId } from './historical-fixtures.js';
const protocol='standard-rest-v1',article='SV2314003',bindingRevisionId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const nextId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const config={historicalReactivation:{available:true,administratorOnly:true,format:'historical-reactivation-standard-v1',protocol,maxItems:100,createTargetStatus:2}};
const request={productId:4500,article,bindingRevisionId,intent:'historical-create'};
// Synthetic explicit inputs; these are not suggested titles for the user's item.
const pair={subjectUa:'Тестовий знак «А»',subjectEn:'Test sign A'};
const full={nameUa:pair.subjectUa+' з бурштину. Арт: '+article,nameEn:'Amber '+pair.subjectEn+'. Art: '+article};
const review=(eligible=false)=>({format:config.historicalReactivation.format,protocol,skus:[article,'MISSING'],reviewNonce:batchId,
  reviewHash:'a'.repeat(64),reviewToken:'synthetic-historical-review',reviewExpiresAt:new Date(Date.now()+300000).toISOString(),
  counts:{eligible:eligible?1:0,blocked:eligible?1:2,skipped:0},items:[
    {...request,protocol,inputSku:article,category:'SV',currentWeight:531,disposition:eligible?'eligible':'blocked',priorFacts:'unknown',deliveryMode:'create',
      remoteProductId:null,observedRemoteStatus:null,observedRemoteVisibility:null,targetStatus:2,targetVisibility:4,requiresExplicitCreate:true,deliveryPlanHash:'b'.repeat(64),
      currentName:eligible?full.nameUa:null,currentRoute:'retired',manualNameCompletion:!eligible,
      reasonCode:eligible?null:'HISTORICAL_DELIVERY_PLAN_BLOCKED',blockerCodes:eligible?[]:['HISTORICAL_DELIVERY_PLAN_BLOCKED'],
      deliveryBlockerCodes:eligible?[]:['PRODUCT_EVALUATION_NOT_READY','REQUIRED_NATIVE_FIELD_MISSING','REQUIRED_ATTRIBUTE_VALUE_MISSING'],
      prerequisites:[{code:'LOCAL_ARCHIVED_CURRENT',met:true},{code:'REVIEWED_REMOTE_OBSERVATION',met:true},{code:'CURRENT_DELIVERY_PLAN_VALID',met:eligible}]},
    {protocol,inputSku:'MISSING',disposition:'blocked',priorFacts:'unknown',reasonCode:'HISTORICAL_PRODUCT_NOT_FOUND',prerequisites:[],blockerCodes:['HISTORICAL_PRODUCT_NOT_FOUND']}
  ]});
const current=(extra={})=>({...request,deliveryMode:'create',remoteProductId:null,alreadyCompleted:false,subjectUa:null,subjectEn:null,...extra});
const names=(extra={})=>current({...pair,...full,previewToken:'c'.repeat(64),reviewExpiresAt:new Date(Date.now()+300000).toISOString(),...extra});
const receipt=(extra={})=>({...request,remoteProductId:null,state:'archived',subjectsSaved:true,...pair,...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
let auth,client;
vi.mock('../src/auth/auth-context.js',()=>({useAuth:()=>auth}));
beforeEach(()=>{sessionStorage.clear();auth={...makeAuth(),applicationUser:{id:49},permissions:[...makeAuth().permissions,'exports.create']};
  client={preview:vi.fn().mockResolvedValue({data:review()}),confirm:vi.fn(),previewManualNames:vi.fn(payload=>Promise.resolve({data:payload.subjectUa?names():current()})),saveManualNames:vi.fn().mockResolvedValue({data:receipt()})};});
afterEach(()=>{cleanup();vi.restoreAllMocks();sessionStorage.clear();});
const mount=(props={})=>render(<HistoricalReactivationReview open config={config} apiClient={client} createRequestId={()=>batchId} {...props}/>);
async function begin(){fireEvent.change(screen.getByLabelText('Точні артикули, по одному в рядку'),{target:{value:article+'\nMISSING'}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити товари'}));await screen.findByText('Можна відновити: 0. Потребують уваги: 2.');}
async function openNames(){fireEvent.click(screen.getByRole('button',{name:'Ввести ручну UA/EN назву'}));await waitFor(()=>expect(screen.getByLabelText('Назва UA').disabled).toBe(false));}
const save=()=>screen.getByRole('button',{name:'Зберегти ручну пару'});
const show=()=>screen.getByRole('button',{name:'Переглянути повні назви'});
const consent=()=>screen.getByRole('checkbox',{name:/Підтверджую цю ручну UA\/EN пару/});
function fill(){fireEvent.change(screen.getByLabelText('Назва UA'),{target:{value:pair.subjectUa}});fireEvent.change(screen.getByLabelText('Назва EN'),{target:{value:pair.subjectEn}});}
async function proposed(){fill();fireEvent.click(show());await screen.findByText(full.nameEn);}

it('opens a guarded manual pair form without inventing subjects, saving or restoring',async()=>{
  mount();await begin();await openNames();expect(client.previewManualNames).toHaveBeenCalledExactlyOnceWith(request);
  expect(screen.getByLabelText('Назва UA').value).toBe('');expect(screen.getByLabelText('Назва EN').value).toBe('');expect(show().disabled).toBe(true);expect(save().disabled).toBe(true);
  expect(client.saveManualNames).not.toHaveBeenCalled();expect(client.confirm).not.toHaveBeenCalled();
});
it('requires both explicit languages and reviews generated full names with unchecked consent; editing invalidates the preview',async()=>{
  mount();await begin();await openNames();fireEvent.change(screen.getByLabelText('Назва UA'),{target:{value:pair.subjectUa}});expect(show().disabled).toBe(true);
  await proposed();expect(client.previewManualNames).toHaveBeenLastCalledWith({...request,...pair});expect(screen.getByText(full.nameUa)).toBeTruthy();expect(consent().checked).toBe(false);expect(save().disabled).toBe(true);
  fireEvent.click(consent());expect(save().disabled).toBe(false);fireEvent.change(screen.getByLabelText('Назва EN'),{target:{value:'Edited by operator'}});
  expect(screen.queryByText(full.nameEn)).toBeNull();expect(save().disabled).toBe(true);expect(client.saveManualNames).not.toHaveBeenCalled();
});
it('declining and reopening performs a fresh read and discards the previous manual draft',async()=>{
  mount();await begin();await openNames();await proposed();fireEvent.click(consent());fireEvent.click(screen.getByRole('button',{name:'Закрити перевірку назв'}));await openNames();
  expect(screen.getByLabelText('Назва UA').value).toBe('');expect(client.previewManualNames).toHaveBeenCalledTimes(3);expect(client.saveManualNames).not.toHaveBeenCalled();expect(client.confirm).not.toHaveBeenCalled();
});
it('double clicks never duplicate an in-flight manual preview',async()=>{
  mount();await begin();await openNames();fill();const pending=deferred();client.previewManualNames.mockReturnValueOnce(pending.promise);fireEvent.click(show());fireEvent.click(show());
  await waitFor(()=>expect(client.previewManualNames).toHaveBeenCalledTimes(2));await act(async()=>pending.resolve({data:names()}));expect(consent().checked).toBe(false);expect(client.saveManualNames).not.toHaveBeenCalled();
});
it('explicit double-click save writes one reviewed pair and starts a new full-list preview without CREATE or activation',async()=>{
  const envelope=(id,result)=>({format:'historical-review-operation-v1',operationId:id,kind:'preview',state:'ready',skus:result.skus,selectedSkus:null,
    deadlineAt:new Date(Date.now()+300000).toISOString(),progress:{phase:'ready',completed:2,total:2},result,failureCode:null});
  client.operation=vi.fn(id=>Promise.resolve({data:envelope(id,review(id===nextId))}));client.preview.mockResolvedValueOnce({data:envelope(batchId,review())}).mockResolvedValueOnce({data:envelope(nextId,review(true))});
  const uuid=vi.fn().mockReturnValueOnce(batchId).mockReturnValueOnce(nextId);mount({createRequestId:uuid});await begin();await openNames();await proposed();fireEvent.click(consent());
  const pending=deferred();client.saveManualNames.mockReturnValueOnce(pending.promise);const button=save();fireEvent.click(button);fireEvent.click(button);await waitFor(()=>expect(client.saveManualNames).toHaveBeenCalledTimes(1));
  expect(client.saveManualNames.mock.calls[0][0]).toEqual({...request,...pair,previewToken:'c'.repeat(64),reviewExpiresAt:expect.any(String)});
  await act(async()=>pending.resolve({data:receipt()}));await screen.findByText('Можна відновити: 1. Потребують уваги: 1.');
  expect(client.preview.mock.calls).toEqual([[[article,'MISSING'],batchId],[[article,'MISSING'],nextId]]);
  expect(screen.getByRole('checkbox',{name:'Обрати '+article}).checked).toBe(false);expect(screen.getByRole('checkbox',{name:'Окремо дозволити CREATE '+article}).checked).toBe(false);
  expect(screen.getByRole('checkbox',{name:/Погоджую відновлення/}).checked).toBe(false);expect(client.confirm).not.toHaveBeenCalled();
});
it('a lost save reply permits only a read of the saved pair and a new restore review',async()=>{
  client.saveManualNames.mockRejectedValueOnce(new Error('Lost manual save'));mount();await begin();await openNames();await proposed();fireEvent.click(consent());fireEvent.click(save());
  await screen.findByText(/Результат збереження ще не підтверджено/);expect(save().disabled).toBe(true);
  client.previewManualNames.mockResolvedValueOnce({data:current({...pair,...full,alreadyCompleted:true})});fireEvent.click(screen.getByRole('button',{name:'Прочитати збережені назви'}));
  await screen.findByText(/Ручну пару вже збережено/);client.preview.mockResolvedValueOnce({data:review(true)});fireEvent.click(screen.getByRole('button',{name:'Повторити перевірку відновлення'}));
  await screen.findByText('Можна відновити: 1. Потребують уваги: 1.');expect(client.saveManualNames).toHaveBeenCalledTimes(1);expect(client.confirm).not.toHaveBeenCalled();
});
it('a stale save clears the preview and never automatically repeats the write',async()=>{
  client.saveManualNames.mockRejectedValueOnce({response:{status:409,data:{error:'CREATE-кандидат змінився.'}}});mount();await begin();await openNames();await proposed();fireEvent.click(consent());fireEvent.click(save());
  await screen.findByText('CREATE-кандидат змінився.');expect(save().disabled).toBe(true);expect(client.saveManualNames).toHaveBeenCalledTimes(1);expect(client.preview).toHaveBeenCalledTimes(1);
});
it.each([['identity',{productId:5011}],['remote appearance',{remoteProductId:5797}],['missing EN',{nameEn:''}],['wrong subject',{subjectEn:'Other subject'}]])('rejects a foreign or incomplete manual preview: %s',async(_label,change)=>{
  mount();await begin();await openNames();client.previewManualNames.mockResolvedValueOnce({data:names(change)});fill();fireEvent.click(show());await screen.findByText(/Сервер не підтвердив ручну пару/);
  expect(save().disabled).toBe(true);expect(client.saveManualNames).not.toHaveBeenCalled();
});
it('expired manual review stops save before transport',async()=>{
  mount();await begin();await openNames();await proposed();fireEvent.click(consent());const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+300001);fireEvent.click(save());
  await screen.findByText(/Сервер не підтвердив ручну пару/);expect(client.saveManualNames).not.toHaveBeenCalled();
});
it('only the server-confirmed missing-name CREATE scope and current permission expose completion',async()=>{
  const item=review().items[0];expect(historicalManualNameRequest(item)).toEqual(request);
  for(const change of [{manualNameCompletion:false},{deliveryMode:'update'},{category:'AR'},{prerequisites:[{code:'LINEAGE_CLEAR',met:false}]}])expect(historicalManualNameRequest({...item,...change})).toBeNull();
  auth={...auth,permissions:makeAuth().permissions};mount();await begin();expect(screen.queryByRole('button',{name:'Ввести ручну UA/EN назву'})).toBeNull();expect(client.previewManualNames).not.toHaveBeenCalled();
});
it('a late reply from an old actor never enables manual save',async()=>{
  const pending=deferred();client.previewManualNames.mockReturnValueOnce(pending.promise);const view=mount();await begin();fireEvent.click(screen.getByRole('button',{name:'Ввести ручну UA/EN назву'}));
  auth={...makeAuth(),applicationUser:{id:50},permissions:[...makeAuth().permissions,'exports.create']};view.rerender(<HistoricalReactivationReview open config={config} apiClient={client}/>);
  await act(async()=>pending.resolve({data:current()}));expect(screen.queryByLabelText('Назва UA')).toBeNull();expect(client.saveManualNames).not.toHaveBeenCalled();expect(client.confirm).not.toHaveBeenCalled();
});
it('losing name permission during manual save requires another exact read after regrant',async()=>{
  const view=mount();await begin();await openNames();await proposed();fireEvent.click(consent());
  const pending=deferred();client.saveManualNames.mockReturnValueOnce(pending.promise);fireEvent.click(save());
  auth={...auth,permissions:makeAuth().permissions};view.rerender(<HistoricalReactivationReview open config={config} apiClient={client}/>);
  await act(async()=>pending.resolve({data:receipt()}));expect(client.preview).toHaveBeenCalledTimes(1);expect(save().disabled).toBe(true);
  auth={...auth,permissions:[...makeAuth().permissions,'exports.create']};view.rerender(<HistoricalReactivationReview open config={config} apiClient={client}/>);
  expect(save().disabled).toBe(true);client.previewManualNames.mockResolvedValueOnce({data:current({...pair,...full,alreadyCompleted:true})});
  fireEvent.click(screen.getByRole('button',{name:'Прочитати збережені назви'}));await screen.findByText(/Ручну пару вже збережено/);
  expect(client.saveManualNames).toHaveBeenCalledTimes(1);expect(client.confirm).not.toHaveBeenCalled();
});
it('closing during a manual preview ignores the late full-name reply and reopening requires a fresh preview',async()=>{
  const view=mount();await begin();await openNames();fill();const pending=deferred();client.previewManualNames.mockReturnValueOnce(pending.promise);fireEvent.click(show());
  view.rerender(<HistoricalReactivationReview open={false} config={config} apiClient={client}/>);await act(async()=>pending.resolve({data:names()}));
  view.rerender(<HistoricalReactivationReview open config={config} apiClient={client}/>);expect(screen.queryByText(full.nameEn)).toBeNull();expect(save().disabled).toBe(true);
  fireEvent.click(show());await screen.findByText(full.nameEn);expect(consent().checked).toBe(false);expect(client.saveManualNames).not.toHaveBeenCalled();
});
it('a foreign save receipt requires read recovery and cannot start a restore preview',async()=>{
  client.saveManualNames.mockResolvedValueOnce({data:receipt({subjectEn:'Foreign pair'})});mount();await begin();await openNames();await proposed();fireEvent.click(consent());fireEvent.click(save());
  await screen.findByText(/Результат збереження ще не підтверджено/);expect(client.preview).toHaveBeenCalledTimes(1);expect(client.confirm).not.toHaveBeenCalled();
});
it('manual transport reuses subject preview/apply and keeps normal historical confirmation separate',async()=>{
  const transport={post:vi.fn().mockResolvedValue({data:{}})},api=createHistoricalReactivationApi(transport);
  await api.previewManualNames({...request,...pair});await api.saveManualNames({...request,...pair,previewToken:'c'.repeat(64),reviewExpiresAt:'synthetic'});
  expect(transport.post.mock.calls).toEqual([['/product-magento-name/preview',{...request,...pair}],['/product-magento-name/apply',{...request,...pair,previewToken:'c'.repeat(64),reviewExpiresAt:'synthetic'}]]);
});
