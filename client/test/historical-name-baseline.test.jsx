import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HistoricalReactivationReview } from '../src/components/app/HistoricalReactivationReview.jsx';
import { createHistoricalReactivationApi } from '../src/api/historical-reactivation-api.js';
import { historicalNameRepairRequest } from '../src/lib/historical-name-review.js';
import { makeAuth, batchId } from './historical-fixtures.js';
const protocol='standard-rest-v1', article='AR1-1-000007', bindingRevisionId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const nextId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const config={historicalReactivation:{available:true,administratorOnly:true,format:'historical-reactivation-standard-v1',protocol,maxItems:100,createTargetStatus:2}};
const request={productId:4107,article,remoteProductId:5817,bindingRevisionId,choice:'magento',intent:'historical'};
const names={all:'Ікона Божої Матері «Остробрамська» з бурштину. Арт: AR1-1-000007',en:'Amber icon of Our Lady of the Dawn Gate. Item: AR1-1-000007'};
const review=(eligible=false)=>({format:config.historicalReactivation.format,protocol,skus:[article,'MISSING'],reviewNonce:batchId,
  reviewHash:'a'.repeat(64),reviewToken:'synthetic-historical-review',reviewExpiresAt:new Date(Date.now()+300000).toISOString(),
  counts:{eligible:eligible?1:0,blocked:eligible?1:2,skipped:0},items:[
    {...request,protocol,inputSku:article,disposition:eligible?'eligible':'blocked',priorFacts:'unknown',deliveryMode:'update',
      observedRemoteStatus:1,observedRemoteVisibility:4,targetStatus:1,targetVisibility:4,requiresExplicitCreate:false,deliveryPlanHash:'b'.repeat(64),
      currentName:eligible?names.all:'Ікона з бурштину. Арт: AR1-1-000007',currentRoute:'retired',
      reasonCode:eligible?null:'HISTORICAL_DELIVERY_PLAN_BLOCKED',blockerCodes:eligible?[]:['HISTORICAL_DELIVERY_PLAN_BLOCKED'],
      deliveryBlockerCodes:eligible?[]:['NAME_BASELINE_REQUIRED'],prerequisites:[{code:'LOCAL_ARCHIVED_CURRENT',met:true},{code:'CURRENT_DELIVERY_PLAN_VALID',met:eligible}]},
    {protocol,inputSku:'MISSING',disposition:'blocked',priorFacts:'unknown',reasonCode:'HISTORICAL_PRODUCT_NOT_FOUND',prerequisites:[],blockerCodes:['HISTORICAL_PRODUCT_NOT_FOUND']}
  ]});
const namePreview=(extra={})=>({...request,amber:{all:'Ікона з бурштину. Арт: AR1-1-000007',en:'Amber icon. Item: AR1-1-000007'},magento:{...names},
  previewToken:'c'.repeat(64),reviewExpiresAt:new Date(Date.now()+300000).toISOString(),alreadyAccepted:false,...extra});
const receipt=()=>({...request,state:'archived',baselineSaved:true});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
let auth,client;
vi.mock('../src/auth/auth-context.js',()=>({useAuth:()=>auth}));
beforeEach(()=>{sessionStorage.clear();auth={...makeAuth(),applicationUser:{id:49},permissions:[...makeAuth().permissions,'exports.create']};
  client={preview:vi.fn().mockResolvedValue({data:review()}),confirm:vi.fn(),previewNames:vi.fn().mockResolvedValue({data:namePreview()}),acceptNames:vi.fn().mockResolvedValue({data:receipt()})};});
afterEach(()=>{cleanup();vi.restoreAllMocks();sessionStorage.clear();});
const mount=(props={})=>render(<HistoricalReactivationReview open config={config} apiClient={client} createRequestId={()=>batchId} {...props}/>);
async function begin(){fireEvent.change(screen.getByLabelText('Точні артикули, по одному в рядку'),{target:{value:article+'\nMISSING'}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити товари'}));await screen.findByText('Можна відновити: 0. Потребують уваги: 2.');}
async function read(){fireEvent.click(screen.getByRole('button',{name:'Перевірити назви Magento'}));await screen.findByText(names.en);}
const save=()=>screen.getByRole('button',{name:'Зберегти назви Magento'});
const consent=()=>screen.getByRole('checkbox',{name:/Зберегти ці українську й англійську назви/});
const agree=()=>fireEvent.click(consent());

it('exposes the precise baseline blocker and reads exact UA/EN names without accepting or restoring',async()=>{
  mount();await begin();expect(screen.getByText(/Спільні підтверджені назви ще не збережено/).closest('details')).toBeNull();await read();
  expect(client.previewNames).toHaveBeenCalledExactlyOnceWith(request);expect(screen.getByText(names.all)).toBeTruthy();
  expect(screen.getByText(/^Magento ID: 5817/ )).toBeTruthy();expect(save().disabled).toBe(true);expect(consent().checked).toBe(false);
  expect(client.acceptNames).not.toHaveBeenCalled();expect(client.confirm).not.toHaveBeenCalled();
});
it('declining and closing discard consent; reopening performs a fresh exact read with no write',async()=>{
  const onClose=vi.fn();mount({onClose});await begin();await read();agree();fireEvent.click(screen.getByRole('button',{name:'Закрити перевірку назв'}));
  expect(screen.queryByText(names.en)).toBeNull();expect(client.acceptNames).not.toHaveBeenCalled();await read();expect(consent().checked).toBe(false);
  expect(client.previewNames).toHaveBeenCalledTimes(2);fireEvent.click(screen.getByRole('button',{name:'Закрити історичне рішення'}));expect(onClose).toHaveBeenCalledTimes(1);
  expect(client.confirm).not.toHaveBeenCalled();
});
it('another read clears prior acceptance and duplicate clicks issue only one in-flight request',async()=>{
  mount();await begin();await read();agree();const pending=deferred();client.previewNames.mockReturnValueOnce(pending.promise);
  const button=screen.getByRole('button',{name:'Перевірити назви ще раз'});fireEvent.click(button);fireEvent.click(button);
  await waitFor(()=>expect(client.previewNames).toHaveBeenCalledTimes(2));expect(screen.queryByRole('checkbox',{name:/Зберегти ці українську/})).toBeNull();
  await act(async()=>pending.resolve({data:namePreview({previewToken:'d'.repeat(64)})}));expect(consent().checked).toBe(false);expect(save().disabled).toBe(true);
  expect(client.acceptNames).not.toHaveBeenCalled();
});
it('explicit double-click acceptance writes once and repeats the full restore preview without restoring or selecting',async()=>{
  mount();await begin();await read();agree();const pending=deferred();client.acceptNames.mockReturnValueOnce(pending.promise);client.preview.mockResolvedValueOnce({data:review(true)});
  const button=save();fireEvent.click(button);fireEvent.click(button);await waitFor(()=>expect(client.acceptNames).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button',{name:'Закрити історичне рішення'}).disabled).toBe(true);
  expect(client.acceptNames.mock.calls[0][0]).toEqual({...request,previewToken:'c'.repeat(64),reviewExpiresAt:expect.any(String)});
  await act(async()=>pending.resolve({data:receipt()}));await screen.findByText('Можна відновити: 1. Потребують уваги: 1.');
  expect(client.preview).toHaveBeenLastCalledWith([article,'MISSING']);expect(client.preview).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('checkbox',{name:'Обрати '+article}).checked).toBe(false);expect(screen.getByRole('checkbox',{name:/Погоджую відновлення/}).checked).toBe(false);
  expect(screen.getByText(/Він залишиться увімкненим; видимість — каталог і пошук/)).toBeTruthy();expect(client.confirm).not.toHaveBeenCalled();
});
it('a stale acceptance never retries; a fresh read and new explicit consent are required',async()=>{
  client.acceptNames.mockRejectedValueOnce({response:{status:409,data:{error:'Назви змінилися після перегляду.'}}});mount();await begin();await read();agree();fireEvent.click(save());
  await screen.findByText('Назви змінилися після перегляду.');expect(save().disabled).toBe(true);expect(client.acceptNames).toHaveBeenCalledTimes(1);
  client.previewNames.mockResolvedValueOnce({data:namePreview({previewToken:'d'.repeat(64)})});fireEvent.click(screen.getByRole('button',{name:'Перевірити назви ще раз'}));
  await screen.findByText(names.en);expect(consent().checked).toBe(false);expect(client.preview).toHaveBeenCalledTimes(1);expect(client.confirm).not.toHaveBeenCalled();
});
it('a lost local save reply recovers by reading the same accepted baseline and then explicitly repeating restore review',async()=>{
  client.acceptNames.mockRejectedValueOnce(new Error('lost name response'));mount();await begin();await read();agree();fireEvent.click(save());
  await screen.findByText(/Результат збереження назв ще не підтверджено/);expect(save().disabled).toBe(true);expect(client.preview).toHaveBeenCalledTimes(1);
  client.previewNames.mockResolvedValueOnce({data:namePreview({alreadyAccepted:true})});fireEvent.click(screen.getByRole('button',{name:'Перевірити назви ще раз'}));
  await screen.findByText(/Ці назви Magento вже збережено/);expect(screen.queryByRole('button',{name:'Зберегти назви Magento'})).toBeNull();
  client.preview.mockResolvedValueOnce({data:review(true)});fireEvent.click(screen.getByRole('button',{name:'Повторити перевірку відновлення'}));
  await screen.findByText('Можна відновити: 1. Потребують уваги: 1.');expect(client.acceptNames).toHaveBeenCalledTimes(1);expect(client.confirm).not.toHaveBeenCalled();
});
it.each([['remote ID',{remoteProductId:5797}],['binding',{bindingRevisionId:batchId}],['incomplete EN',{magento:{...names,en:''}}]])('rejects an invalid names response: %s',async(_label,change)=>{
  client.previewNames.mockResolvedValueOnce({data:namePreview(change)});mount();await begin();fireEvent.click(screen.getByRole('button',{name:'Перевірити назви Magento'}));
  await screen.findByText(/Сервер не підтвердив точні назви й відповідник/);expect(save().disabled).toBe(true);expect(client.acceptNames).not.toHaveBeenCalled();
});
it('a foreign local receipt cannot replace the product or launch the restore preview',async()=>{
  client.acceptNames.mockResolvedValueOnce({data:{...receipt(),productId:5011}});mount();await begin();await read();agree();fireEvent.click(save());
  await screen.findByText(/Результат збереження назв ще не підтверджено/);expect(client.preview).toHaveBeenCalledTimes(1);expect(client.confirm).not.toHaveBeenCalled();
});
it('expiry at the time of acceptance stops the request before transport',async()=>{
  mount();await begin();await read();agree();const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+300001);fireEvent.click(save());
  await screen.findByText(/Сервер не підтвердив точні назви й відповідник/);expect(client.acceptNames).not.toHaveBeenCalled();expect(save().disabled).toBe(true);
});
it('only the exact historical baseline case exposes repair; missing permission or other local blockers do not',async()=>{
  const item=review().items[0];expect(historicalNameRepairRequest(item)).toEqual(request);
  expect(historicalNameRepairRequest({...item,prerequisites:[...item.prerequisites,{code:'LINEAGE_CLEAR',met:false}]})).toBeNull();
  expect(historicalNameRepairRequest({...item,remoteProductId:null})).toBeNull();
  auth={...auth,permissions:makeAuth().permissions};mount();await begin();expect(screen.queryByRole('button',{name:'Перевірити назви Magento'})).toBeNull();
  expect(screen.getByText(/Прийняття назв потребує також/)).toBeTruthy();expect(client.previewNames).not.toHaveBeenCalled();
});
it('a late names reply from the previous actor is ignored and never starts a save or restore',async()=>{
  const pending=deferred();client.previewNames.mockReturnValueOnce(pending.promise);const view=mount();await begin();fireEvent.click(screen.getByRole('button',{name:'Перевірити назви Magento'}));
  auth={...makeAuth(),applicationUser:{id:50},permissions:[...makeAuth().permissions,'exports.create']};
  view.rerender(<HistoricalReactivationReview open config={config} apiClient={client}/>);await act(async()=>pending.resolve({data:namePreview()}));
  expect(screen.queryByText(names.en)).toBeNull();expect(screen.getByLabelText('Точні артикули, по одному в рядку').value).toBe('');
  expect(client.acceptNames).not.toHaveBeenCalled();expect(client.confirm).not.toHaveBeenCalled();
});
it('a ready durable review is replaced by a new UUID after name acceptance, with the original complete SKU list',async()=>{
  const envelope=(id,result)=>({format:'historical-review-operation-v1',operationId:id,kind:'preview',state:'ready',skus:result.skus,selectedSkus:null,
    deadlineAt:new Date(Date.now()+300000).toISOString(),progress:{phase:'ready',completed:2,total:2},result,failureCode:null});
  client.operation=vi.fn(id=>Promise.resolve({data:envelope(id,review(id===nextId))}));client.preview.mockResolvedValueOnce({data:envelope(batchId,review())}).mockResolvedValueOnce({data:envelope(nextId,review(true))});
  const uuid=vi.fn().mockReturnValueOnce(batchId).mockReturnValueOnce(nextId);mount({createRequestId:uuid});await begin();await read();agree();fireEvent.click(save());
  await screen.findByText('Можна відновити: 1. Потребують уваги: 1.');expect(client.preview.mock.calls).toEqual([[[article,'MISSING'],batchId],[[article,'MISSING'],nextId]]);
  expect(client.operation.mock.calls.every(([id])=>[batchId,nextId].includes(id))).toBe(true);expect(client.confirm).not.toHaveBeenCalled();expect(client.acceptNames).toHaveBeenCalledTimes(1);
});
it('closing the parent while a names read is pending ignores its reply and reopening requires another read',async()=>{
  const pending=deferred();client.previewNames.mockReturnValueOnce(pending.promise);const view=mount();await begin();fireEvent.click(screen.getByRole('button',{name:'Перевірити назви Magento'}));
  view.rerender(<HistoricalReactivationReview open={false} config={config} apiClient={client}/>);await act(async()=>pending.resolve({data:namePreview()}));
  view.rerender(<HistoricalReactivationReview open config={config} apiClient={client}/>);expect(screen.queryByText(names.en)).toBeNull();expect(save().disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Перевірити назви ще раз'}));await screen.findByText(names.en);expect(consent().checked).toBe(false);expect(client.acceptNames).not.toHaveBeenCalled();
});
it.each([['received reply',false],['lost reply',true]])('losing the name-edit permission during save requires a read after regrant: %s',async(_label,lost)=>{
  const pending=deferred();client.acceptNames.mockReturnValueOnce(pending.promise);const view=mount();await begin();await read();agree();fireEvent.click(save());
  auth={...auth,permissions:makeAuth().permissions};view.rerender(<HistoricalReactivationReview open config={config} apiClient={client}/>);
  await act(async()=>lost ? pending.reject(new Error('lost during permission change')) : pending.resolve({data:receipt()}));expect(client.preview).toHaveBeenCalledTimes(1);expect(save().disabled).toBe(true);
  auth={...auth,permissions:[...makeAuth().permissions,'exports.create']};view.rerender(<HistoricalReactivationReview open config={config} apiClient={client}/>);
  expect(save().disabled).toBe(true);client.previewNames.mockResolvedValueOnce({data:namePreview({alreadyAccepted:true})});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити назви ще раз'}));await screen.findByText(/Ці назви Magento вже збережено/);
  expect(client.acceptNames).toHaveBeenCalledTimes(1);expect(client.confirm).not.toHaveBeenCalled();
});
it('transport reuses the existing authenticated preview/apply endpoints without changing the historical confirmation',async()=>{
  const transport={post:vi.fn().mockResolvedValue({data:{}})};const api=createHistoricalReactivationApi(transport);
  await api.previewNames(request);await api.acceptNames({...request,previewToken:'c'.repeat(64),reviewExpiresAt:'synthetic'});
  expect(transport.post.mock.calls).toEqual([['/magento/name-resolution/preview',request],['/magento/name-resolution/apply',{...request,previewToken:'c'.repeat(64),reviewExpiresAt:'synthetic'}]]);
});
