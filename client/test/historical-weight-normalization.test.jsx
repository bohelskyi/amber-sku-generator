import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HistoricalReactivationReview } from '../src/components/app/HistoricalReactivationReview.jsx';
import { historicalWeightRequest, validateWeightPreview } from '../src/lib/historical-weight-normalization-review.js';
import { createHistoricalReactivationApi } from '../src/api/historical-reactivation-api.js';
import { operationStorageKey } from '../src/lib/historical-review-operation.js';
import { makeAuth, batchId } from './historical-fixtures.js';
const protocol='standard-rest-v1',article='SV2314004',bindingRevisionId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const config={historicalReactivation:{available:true,administratorOnly:true,format:'historical-reactivation-standard-v1',protocol,maxItems:100,createTargetStatus:2}};
const request={productId:4506,article,bindingRevisionId,intent:'historical-weight-normalization'};
const weight={sourceWeight:'517,0',targetWeight:'517.0',canonicalWeight:'517.000'};
const review=(normalized=false)=>({format:config.historicalReactivation.format,protocol,skus:[article,'MISSING'],reviewNonce:batchId,
  reviewHash:'a'.repeat(64),reviewToken:'synthetic-historical-review',reviewExpiresAt:new Date(Date.now()+300000).toISOString(),
  counts:{eligible:0,blocked:2,skipped:0},items:[
    {...request,protocol,inputSku:article,category:'SV',currentWeight:517,disposition:'blocked',priorFacts:'unknown',deliveryMode:'create',
      remoteProductId:null,targetStatus:2,targetVisibility:4,requiresExplicitCreate:true,currentRoute:'retired',manualNameCompletion:normalized,
      ...(!normalized?{weightNormalization:weight}:{}),reasonCode:'HISTORICAL_DELIVERY_PLAN_BLOCKED',blockerCodes:['HISTORICAL_DELIVERY_PLAN_BLOCKED'],
      deliveryBlockerCodes:['PRODUCT_EVALUATION_NOT_READY','REQUIRED_NATIVE_FIELD_MISSING','REQUIRED_ATTRIBUTE_VALUE_MISSING'],
      prerequisites:[{code:'LOCAL_ARCHIVED_CURRENT',met:true},{code:'REVIEWED_REMOTE_OBSERVATION',met:true},{code:'CURRENT_DELIVERY_PLAN_VALID',met:false}]},
    {protocol,inputSku:'MISSING',disposition:'blocked',priorFacts:'unknown',reasonCode:'HISTORICAL_PRODUCT_NOT_FOUND',prerequisites:[],blockerCodes:['HISTORICAL_PRODUCT_NOT_FOUND']}
  ]});
const view=(extra={})=>({format:'historical-sv-weight-normalization-v1',productId:4506,article,bindingRevisionId,state:'archived',...weight,
  alreadyCompleted:false,remainingIssues:[{code:'manual_name_required',field:'name'}],previewToken:'c'.repeat(64),reviewExpiresAt:new Date(Date.now()+300000).toISOString(),...extra});
const receipt=(extra={})=>({...view(),weightNormalized:true,...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
let auth,client;
vi.mock('../src/auth/auth-context.js',()=>({useAuth:()=>auth}));
beforeEach(()=>{sessionStorage.clear();auth={...makeAuth(),applicationUser:{id:49},permissions:[...makeAuth().permissions,'exports.create','products.recount']};
  client={preview:vi.fn().mockResolvedValue({data:review()}),confirm:vi.fn(),previewWeightNormalization:vi.fn().mockResolvedValue({data:view()}),saveWeightNormalization:vi.fn().mockResolvedValue({data:receipt()})};});
afterEach(()=>{cleanup();vi.restoreAllMocks();sessionStorage.clear();});
const mount=(props={})=>render(<HistoricalReactivationReview open config={config} apiClient={client} createRequestId={()=>batchId} {...props}/>);
async function begin(){fireEvent.change(screen.getByLabelText('Точні артикули, по одному в рядку'),{target:{value:article+'\nMISSING'}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити товари'}));await screen.findByText('Можна відновити: 0. Потребують уваги: 2.');}
async function openWeight(){fireEvent.click(screen.getByRole('button',{name:'Перевірити формат ваги'}));await screen.findByRole('checkbox',{name:/Погоджую лише виправлення формату/});}
const consent=()=>screen.getByRole('checkbox',{name:/Погоджую лише виправлення формату/});
const save=()=>screen.getByRole('button',{name:'Виправити формат ваги'});
it('shows the exact arrow and canonical weight with unchecked consent; opening or closing never saves or restores',async()=>{
  mount();await begin();await openWeight();expect(client.previewWeightNormalization).toHaveBeenCalledExactlyOnceWith(request);
  expect(screen.getByText('517,0 → 517.0 г')).toBeTruthy();expect(screen.getByText(/Збережена вага: 517.000 г/)).toBeTruthy();
  expect(consent().checked).toBe(false);expect(save().disabled).toBe(true);expect(screen.getByLabelText('Точні артикули, по одному в рядку').disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Закрити перевірку ваги'}));expect(client.saveWeightNormalization).not.toHaveBeenCalled();expect(client.confirm).not.toHaveBeenCalled();
});
it('double-click saves one exact approved representation, keeps the list, and explicit fresh review exposes manual names',async()=>{
  const pending=deferred();client.saveWeightNormalization.mockReturnValue(pending.promise);client.preview.mockResolvedValueOnce({data:review()}).mockResolvedValue({data:review(true)});
  mount();await begin();await openWeight();fireEvent.click(consent());fireEvent.click(save());fireEvent.click(save());
  expect(client.saveWeightNormalization).toHaveBeenCalledExactlyOnceWith({...request,previewToken:'c'.repeat(64),reviewExpiresAt:expect.any(String),confirmEquivalentWeightNormalization:true});
  expect(client.preview).toHaveBeenCalledTimes(1);expect(client.confirm).not.toHaveBeenCalled();
  await act(async()=>pending.resolve({data:receipt()}));await screen.findByText(/Формат ваги узгоджений/);
  expect(screen.getByText('Не знайдено у Manager: 1. Ці артикули не відновлюватимуться.')).toBeTruthy();expect(client.preview).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'Перевірити товари після виправлення'}));await screen.findByRole('button',{name:'Ввести ручну UA/EN назву'});
  expect(client.preview).toHaveBeenCalledTimes(2);expect(client.preview).toHaveBeenLastCalledWith([article,'MISSING']);expect(client.confirm).not.toHaveBeenCalled();
});
it('lost save reply permits exact read recovery and fresh review without a second apply',async()=>{
  client.saveWeightNormalization.mockRejectedValue(new Error('Synthetic lost reply'));
  mount();await begin();await openWeight();fireEvent.click(consent());fireEvent.click(save());await screen.findByText(/Відповідь виправлення не підтверджена/);
  expect(screen.queryByRole('button',{name:'Виправити формат ваги'})).toBeNull();expect(client.preview).toHaveBeenCalledTimes(1);
  client.previewWeightNormalization.mockResolvedValue({data:view({sourceWeight:'517.0',alreadyCompleted:true})});
  fireEvent.click(screen.getByRole('button',{name:'Прочитати вагу цього товару'}));await screen.findByText(/Формат ваги узгоджений/);
  expect(client.previewWeightNormalization).toHaveBeenLastCalledWith(request);expect(client.saveWeightNormalization).toHaveBeenCalledTimes(1);expect(client.confirm).not.toHaveBeenCalled();
});
it('stale apply clears consent and demands a fresh exact read; no automatic apply or full-list retry',async()=>{
  client.saveWeightNormalization.mockRejectedValue({response:{status:409,data:{code:'HISTORICAL_REVIEW_STALE',error:'Synthetic stale weight'}}});
  mount();await begin();await openWeight();fireEvent.click(consent());fireEvent.click(save());await screen.findByRole('button',{name:'Прочитати вагу цього товару'});
  expect(client.saveWeightNormalization).toHaveBeenCalledTimes(1);expect(client.preview).toHaveBeenCalledTimes(1);expect(client.previewWeightNormalization).toHaveBeenCalledTimes(1);
});
it('expired evidence cannot send an apply after prior consent',async()=>{
  const value=view();client.previewWeightNormalization.mockResolvedValue({data:value});mount();await begin();await openWeight();fireEvent.click(consent());
  vi.spyOn(Date,'now').mockReturnValue(Date.parse(value.reviewExpiresAt)+1);
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1100));});
  expect(save().disabled).toBe(true);fireEvent.click(save());expect(client.saveWeightNormalization).not.toHaveBeenCalled();
});
it('revoked recount permission hides entry and a late preview cannot enable save',async()=>{
  const pending=deferred();client.previewWeightNormalization.mockReturnValue(pending.promise);const app=mount();await begin();
  fireEvent.click(screen.getByRole('button',{name:'Перевірити формат ваги'}));
  auth={...auth,permissions:auth.permissions.filter(p=>p!=='products.recount')};app.rerender(<HistoricalReactivationReview open config={config} apiClient={client}/>);
  await act(async()=>pending.resolve({data:view()}));expect(screen.queryByRole('button',{name:'Виправити формат ваги'})).toBeNull();expect(client.saveWeightNormalization).not.toHaveBeenCalled();
});
it('foreign receipt cannot authorize another item or automatic restore',async()=>{
  client.saveWeightNormalization.mockResolvedValue({data:receipt({productId:999})});mount();await begin();await openWeight();fireEvent.click(consent());fireEvent.click(save());
  await screen.findByText(/Відповідь виправлення не підтверджена/);expect(client.preview).toHaveBeenCalledTimes(1);expect(client.confirm).not.toHaveBeenCalled();
});
it('a save attempt discards the old durable review before any response, and reload cannot recover it',async()=>{
  const pending=deferred(),result=review();client.operation=vi.fn();
  client.preview.mockResolvedValue({data:{format:'historical-review-operation-v1',operationId:batchId,kind:'preview',state:'ready',skus:result.skus,selectedSkus:null,deadlineAt:new Date(Date.now()+300000).toISOString(),progress:{phase:'ready',completed:2,total:2},result,failureCode:null}});
  client.saveWeightNormalization.mockReturnValue(pending.promise);mount();await begin();await openWeight();expect(sessionStorage.getItem(operationStorageKey(49))).not.toBeNull();
  fireEvent.click(consent());fireEvent.click(save());expect(sessionStorage.getItem(operationStorageKey(49))).toBeNull();
  await act(async()=>pending.resolve({data:receipt()}));client.operation.mockClear();cleanup();mount();await act(async()=>{});expect(client.operation).not.toHaveBeenCalled();
});
it('malformed or conflicting capabilities and previews cannot present a writable repair',()=>{
  const item=review().items[0];expect(historicalWeightRequest(item)).toEqual(request);
  for(const weightNormalization of [{...weight,targetWeight:'518.0'},{...weight,canonicalWeight:'0.000'},{...weight,sourceWeight:'517,000000000000000001',targetWeight:'517.000000000000000001'}])
    expect(historicalWeightRequest({...item,weightNormalization})).toBeNull();
  expect(()=>validateWeightPreview(view({targetWeight:'518.0'}),request)).toThrow();expect(()=>validateWeightPreview(view({state:'active'}),request)).toThrow();
});
it('weight transport uses separate protected endpoints and omits internal UI intent',async()=>{
  const transport={post:vi.fn().mockResolvedValue({data:{}})},api=createHistoricalReactivationApi(transport);
  await api.previewWeightNormalization(request);expect(transport.post).toHaveBeenLastCalledWith('/products/historical-reactivation/weight-normalization/preview',{productId:4506,article,bindingRevisionId});
  const payload={...request,previewToken:'c'.repeat(64),reviewExpiresAt:'2026-10-07T23:00:00.000Z',confirmEquivalentWeightNormalization:true};
  await api.saveWeightNormalization(payload);const {intent,...body}=payload;expect(intent).toBe('historical-weight-normalization');
  expect(transport.post).toHaveBeenLastCalledWith('/products/historical-reactivation/weight-normalization/apply',body);
});
