import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HistoricalReactivationReview } from '../src/components/app/HistoricalReactivationReview.jsx';
import { historicalManualNameRequest, renderHistoricalManualNames } from '../src/lib/historical-manual-name-review.js';
import { createHistoricalReactivationApi } from '../src/api/historical-reactivation-api.js';
import { operationStorageKey } from '../src/lib/historical-review-operation.js';
import { makeAuth, batchId } from './historical-fixtures.js';
const protocol='standard-rest-v1',article='SV2314003',bindingRevisionId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const nextId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const config={historicalReactivation:{available:true,administratorOnly:true,format:'historical-reactivation-standard-v1',protocol,maxItems:100,createTargetStatus:2}};
const request={productId:4500,article,bindingRevisionId,intent:'historical-create'};
// Explicit synthetic operator inputs, never suggested titles for the user's items.
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
const current=(extra={})=>({...request,deliveryMode:'create',remoteProductId:null,alreadyCompleted:false,subjectUa:null,subjectEn:null,
  nameRender:{format:'historical-manual-render-v1',ua:{prefix:'',suffix:' з бурштину. Арт: '+article},en:{prefix:'Amber ',suffix:'. Art: '+article}},
  preparationToken:'c'.repeat(64),reviewExpiresAt:new Date(Date.now()+300000).toISOString(),...extra});
const receipt=(extra={})=>({...request,remoteProductId:null,state:'archived',subjectsSaved:true,...pair,...extra});
const envelope=(id,result)=>({format:'historical-review-operation-v1',operationId:id,kind:'preview',state:'ready',skus:result.skus,selectedSkus:null,
  deadlineAt:new Date(Date.now()+300000).toISOString(),progress:{phase:'ready',completed:2,total:2},result,failureCode:null});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
let auth,client;
vi.mock('../src/auth/auth-context.js',()=>({useAuth:()=>auth}));
beforeEach(()=>{sessionStorage.clear();auth={...makeAuth(),applicationUser:{id:49},permissions:[...makeAuth().permissions,'exports.create']};
  client={preview:vi.fn().mockResolvedValue({data:review()}),confirm:vi.fn(),previewManualNames:vi.fn().mockResolvedValue({data:current()}),saveManualNames:vi.fn().mockResolvedValue({data:receipt()})};});
afterEach(()=>{cleanup();vi.restoreAllMocks();sessionStorage.clear();});
const mount=(props={})=>render(<HistoricalReactivationReview open config={config} apiClient={client} createRequestId={()=>batchId} {...props}/>);
async function begin(){fireEvent.change(screen.getByLabelText('Точні артикули, по одному в рядку'),{target:{value:article+'\nMISSING'}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити товари'}));await screen.findByText('Можна відновити: 0. Потребують уваги: 2.');}
async function openNames(){fireEvent.click(screen.getAllByRole('button',{name:'Ввести ручну UA/EN назву'})[0]);await waitFor(()=>expect(screen.getByLabelText('Назва UA').disabled).toBe(false));}
const save=()=>screen.getByRole('button',{name:'Зберегти ручну пару'});
const show=()=>screen.getByRole('button',{name:'Переглянути повні назви'});
const consent=()=>screen.getByRole('checkbox',{name:/Підтверджую цю ручну UA\/EN пару/});
function fill(){fireEvent.change(screen.getByLabelText('Назва UA'),{target:{value:pair.subjectUa}});fireEvent.change(screen.getByLabelText('Назва EN'),{target:{value:pair.subjectEn}});}
async function proposed(){fill();fireEvent.click(show());await screen.findByText(full.nameEn);}

it('opens a guarded local form without inventing subjects, saving or restoring',async()=>{
  mount();await begin();await openNames();expect(client.previewManualNames).toHaveBeenCalledExactlyOnceWith(request);
  expect(screen.getByLabelText('Назва UA').value).toBe('');expect(screen.getByLabelText('Назва EN').value).toBe('');expect(show().disabled).toBe(true);expect(save().disabled).toBe(true);
  expect(client.saveManualNames).not.toHaveBeenCalled();expect(client.confirm).not.toHaveBeenCalled();
});
it('formed-name preview and repeated previews have zero additional network calls; every edit clears consent',async()=>{
  mount();await begin();await openNames();fireEvent.change(screen.getByLabelText('Назва UA'),{target:{value:pair.subjectUa}});expect(show().disabled).toBe(true);
  await proposed();expect(client.previewManualNames).toHaveBeenCalledTimes(1);expect(screen.getByText(full.nameUa)).toBeTruthy();expect(consent().checked).toBe(false);
  fireEvent.click(consent());expect(save().disabled).toBe(false);fireEvent.click(show());expect(consent().checked).toBe(false);
  fireEvent.click(consent());fireEvent.change(screen.getByLabelText('Назва EN'),{target:{value:'Edited by operator'}});
  expect(screen.queryByText(full.nameEn)).toBeNull();expect(save().disabled).toBe(true);expect(client.previewManualNames).toHaveBeenCalledTimes(1);expect(client.saveManualNames).not.toHaveBeenCalled();
});
it('declining and reopening reads locally again and discards the draft; old restore selection stays unusable',async()=>{
  mount();await begin();await openNames();await proposed();fireEvent.click(consent());fireEvent.click(screen.getByRole('button',{name:'Закрити перевірку назв'}));await openNames();
  expect(screen.getByLabelText('Назва UA').value).toBe('');expect(client.previewManualNames).toHaveBeenCalledTimes(2);expect(client.saveManualNames).not.toHaveBeenCalled();expect(client.confirm).not.toHaveBeenCalled();
});
it('duplicate opening requests never issue a second local preparation while the first is in flight',async()=>{
  const pending=deferred();client.previewManualNames.mockReturnValueOnce(pending.promise);mount();await begin();const button=screen.getByRole('button',{name:'Ввести ручну UA/EN назву'});
  fireEvent.click(button);fireEvent.click(button);expect(client.previewManualNames).toHaveBeenCalledTimes(1);await act(async()=>pending.resolve({data:current()}));expect(show().disabled).toBe(true);
});
it('double-click save writes one exact reviewed pair, retains rows and requires explicit final full-list review',async()=>{
  client.operation=vi.fn(id=>Promise.resolve({data:envelope(id,review(id===nextId))}));
  client.preview.mockResolvedValueOnce({data:envelope(batchId,review())}).mockResolvedValueOnce({data:envelope(nextId,review(true))});
  mount({createRequestId:vi.fn().mockReturnValueOnce(batchId).mockReturnValueOnce(nextId)});await begin();await openNames();await proposed();fireEvent.click(consent());
  const pending=deferred();client.saveManualNames.mockReturnValueOnce(pending.promise);const button=save();fireEvent.click(button);fireEvent.click(button);expect(client.saveManualNames).toHaveBeenCalledTimes(1);
  expect(client.saveManualNames.mock.calls[0][0]).toEqual({...request,...pair,preparationToken:'c'.repeat(64),reviewExpiresAt:expect.any(String),reviewedNameUa:full.nameUa,reviewedNameEn:full.nameEn});
  await act(async()=>pending.resolve({data:receipt()}));await screen.findByText(/Ручну пару вже збережено/);
  expect(client.preview).toHaveBeenCalledTimes(1);expect(sessionStorage.getItem(operationStorageKey(49))).toBeNull();expect(client.confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole('button',{name:'Перевірити перед відновленням'}).find(button=>!button.disabled));
  await screen.findByText('Можна відновити: 1. Потребують уваги: 1.');
  expect(client.preview.mock.calls).toEqual([[[article,'MISSING'],batchId],[[article,'MISSING'],nextId]]);
  expect(screen.getByRole('checkbox',{name:'Обрати '+article}).checked).toBe(false);expect(screen.getByRole('checkbox',{name:'Окремо дозволити CREATE '+article}).checked).toBe(false);
  expect(screen.getByRole('checkbox',{name:/Погоджую відновлення/}).checked).toBe(false);expect(client.confirm).not.toHaveBeenCalled();
});
it('editing invalidates the whole-list token before save, including cancelled edits and old durable ready replies',async()=>{
  client.operation=vi.fn().mockResolvedValue({data:envelope(batchId,review())});client.preview.mockResolvedValue({data:envelope(batchId,review())});
  mount();await begin();await openNames();fill();expect(sessionStorage.getItem(operationStorageKey(49))).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Закрити перевірку назв'}));
  expect(screen.queryByRole('button',{name:'Відновити вибране (0)'})).toBeNull();
  fireEvent.change(screen.getByLabelText('Номер операції UUID'),{target:{value:batchId}});fireEvent.click(screen.getByRole('button',{name:'Прочитати стан рішення'}));
  await screen.findByText('Дані редагувалися. Почніть нову перевірку перед відновленням.');expect(sessionStorage.getItem(operationStorageKey(49))).toBeNull();expect(client.confirm).not.toHaveBeenCalled();
});
it('reload after an edit cannot recover the discarded general review operation',async()=>{
  client.operation=vi.fn().mockResolvedValue({data:envelope(batchId,review())});client.preview.mockResolvedValue({data:envelope(batchId,review())});
  const view=mount();await begin();await openNames();fill();view.unmount();client.operation.mockClear();mount();await act(async()=>new Promise(resolve=>setTimeout(resolve,1100)));
  expect(screen.queryByText('Можна відновити: 0. Потребують уваги: 2.')).toBeNull();expect(sessionStorage.getItem(operationStorageKey(49))).toBeNull();expect(client.operation).not.toHaveBeenCalled();
});
it('next item opens without refreshing the list and receives its own local preparation',async()=>{
  const secondArticle='SV2314005',second={...request,productId:4501,article:secondArticle};const list=review();
  list.skus=[article,secondArticle];list.items[1]={...list.items[0],...second,inputSku:secondArticle};client.preview.mockResolvedValueOnce({data:list});
  const form=current({...second,nameRender:{format:'historical-manual-render-v1',ua:{prefix:'',suffix:' з бурштину. Арт: '+secondArticle},en:{prefix:'Amber ',suffix:'. Art: '+secondArticle}}});
  mount();await begin();await openNames();await proposed();fireEvent.click(consent());fireEvent.click(save());await screen.findByText(/Ручну пару вже збережено/);
  client.previewManualNames.mockResolvedValueOnce({data:form});fireEvent.click(screen.getByRole('button',{name:'Наступний товар: '+secondArticle}));
  await screen.findByText('Ручна назва для '+secondArticle);expect(screen.getByLabelText('Назва UA').value).toBe('');
  expect(client.previewManualNames.mock.calls).toEqual([[request],[second]]);expect(client.preview).toHaveBeenCalledTimes(1);expect(client.confirm).not.toHaveBeenCalled();
});
it('lost save reply permits only an exact read, followed by explicit final review without another write',async()=>{
  client.saveManualNames.mockRejectedValueOnce(new Error('Lost manual save'));mount();await begin();await openNames();await proposed();fireEvent.click(consent());fireEvent.click(save());
  await screen.findByText(/Результат збереження ще не підтверджено/);expect(save().disabled).toBe(true);
  client.previewManualNames.mockResolvedValueOnce({data:current({...pair,...full,alreadyCompleted:true})});fireEvent.click(screen.getByRole('button',{name:'Прочитати збережені назви'}));
  await screen.findByText(/Ручну пару вже збережено/);expect(client.preview).toHaveBeenCalledTimes(1);
  client.preview.mockResolvedValueOnce({data:review(true)});fireEvent.click(screen.getAllByRole('button',{name:'Перевірити перед відновленням'}).find(button=>!button.disabled));
  await screen.findByText('Можна відновити: 1. Потребують уваги: 1.');expect(client.saveManualNames).toHaveBeenCalledTimes(1);expect(client.confirm).not.toHaveBeenCalled();
});
it('a stale save clears preparation and never automatically retries or refreshes the list',async()=>{
  client.saveManualNames.mockRejectedValueOnce({response:{status:409,data:{error:'CREATE-кандидат змінився.'}}});mount();await begin();await openNames();await proposed();fireEvent.click(consent());fireEvent.click(save());
  await screen.findByText('CREATE-кандидат змінився.');expect(save().disabled).toBe(true);expect(client.saveManualNames).toHaveBeenCalledTimes(1);expect(client.preview).toHaveBeenCalledTimes(1);
});
it.each([['identity',{productId:5011}],['remote identity',{remoteProductId:5797}],['missing token',{preparationToken:null}],['unsupported renderer',{nameRender:{format:'other'}}]])('rejects foreign or incomplete local preparation: %s',async(_label,change)=>{
  client.previewManualNames.mockResolvedValueOnce({data:current(change)});mount();await begin();await openNames();await screen.findByText(/Сервер не підтвердив ручну пару/);
  fill();fireEvent.click(show());expect(save().disabled).toBe(true);expect(client.saveManualNames).not.toHaveBeenCalled();
});
it('expiry blocks local review and save without transport, even after consent',async()=>{
  mount();await begin();await openNames();await proposed();fireEvent.click(consent());const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+300001);fireEvent.click(save());
  await screen.findByText(/Сервер не підтвердив ручну пару/);expect(client.saveManualNames).not.toHaveBeenCalled();expect(client.previewManualNames).toHaveBeenCalledTimes(1);
});
it('only server-confirmed missing-name CREATE scope with current permissions exposes completion',async()=>{
  const item=review().items[0];expect(historicalManualNameRequest(item)).toEqual(request);
  for(const change of [{manualNameCompletion:false},{deliveryMode:'update'},{category:'AR'},{prerequisites:[{code:'LINEAGE_CLEAR',met:false}]}])expect(historicalManualNameRequest({...item,...change})).toBeNull();
  auth={...auth,permissions:makeAuth().permissions};mount();await begin();expect(screen.queryByRole('button',{name:'Ввести ручну UA/EN назву'})).toBeNull();expect(client.previewManualNames).not.toHaveBeenCalled();
});
it('a late local preparation from an old actor never enables manual save',async()=>{
  const pending=deferred();client.previewManualNames.mockReturnValueOnce(pending.promise);const view=mount();await begin();fireEvent.click(screen.getByRole('button',{name:'Ввести ручну UA/EN назву'}));
  auth={...makeAuth(),applicationUser:{id:50},permissions:[...makeAuth().permissions,'exports.create']};view.rerender(<HistoricalReactivationReview open config={config} apiClient={client}/>);
  await act(async()=>pending.resolve({data:current()}));expect(screen.queryByLabelText('Назва UA')).toBeNull();expect(client.saveManualNames).not.toHaveBeenCalled();expect(client.confirm).not.toHaveBeenCalled();
});
it('permission loss during save requires exact read recovery after regrant',async()=>{
  const view=mount();await begin();await openNames();await proposed();fireEvent.click(consent());const pending=deferred();client.saveManualNames.mockReturnValueOnce(pending.promise);fireEvent.click(save());
  auth={...auth,permissions:makeAuth().permissions};view.rerender(<HistoricalReactivationReview open config={config} apiClient={client}/>);await act(async()=>pending.resolve({data:receipt()}));
  expect(client.preview).toHaveBeenCalledTimes(1);expect(save().disabled).toBe(true);auth={...auth,permissions:[...makeAuth().permissions,'exports.create']};view.rerender(<HistoricalReactivationReview open config={config} apiClient={client}/>);
  expect(save().disabled).toBe(true);client.previewManualNames.mockResolvedValueOnce({data:current({...pair,...full,alreadyCompleted:true})});fireEvent.click(screen.getByRole('button',{name:'Прочитати збережені назви'}));
  await screen.findByText(/Ручну пару вже збережено/);expect(client.saveManualNames).toHaveBeenCalledTimes(1);expect(client.confirm).not.toHaveBeenCalled();
});
it('closing during local preparation ignores its late reply; reopening requires an explicit fresh read',async()=>{
  const view=mount();await begin();const pending=deferred();client.previewManualNames.mockReturnValueOnce(pending.promise);fireEvent.click(screen.getByRole('button',{name:'Ввести ручну UA/EN назву'}));
  view.rerender(<HistoricalReactivationReview open={false} config={config} apiClient={client}/>);await act(async()=>pending.resolve({data:current()}));
  view.rerender(<HistoricalReactivationReview open config={config} apiClient={client}/>);fill();fireEvent.click(show());expect(screen.queryByText(full.nameEn)).toBeNull();expect(save().disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Прочитати збережені назви'}));await waitFor(()=>expect(client.previewManualNames).toHaveBeenCalledTimes(2));await proposed();expect(consent().checked).toBe(false);
});
it('foreign save receipt requires read recovery and cannot trigger a full-list refresh',async()=>{
  client.saveManualNames.mockResolvedValueOnce({data:receipt({subjectEn:'Foreign pair'})});mount();await begin();await openNames();await proposed();fireEvent.click(consent());fireEvent.click(save());
  await screen.findByText(/Результат збереження ще не підтверджено/);expect(client.preview).toHaveBeenCalledTimes(1);expect(client.confirm).not.toHaveBeenCalled();
});
it('the local renderer preserves explicit normalized subjects, rejects control characters and does not invent translations',()=>{
  expect(renderHistoricalManualNames(current(),request,{subjectUa:' '+pair.subjectUa+' ',subjectEn:pair.subjectEn})).toMatchObject({...pair,...full});
  for(const subjects of [{...pair,subjectEn:''},{...pair,subjectUa:'Bad\ninput'},{...pair,subjectEn:'x'.repeat(201)}])expect(()=>renderHistoricalManualNames(current(),request,subjects)).toThrow();
});
it('manual transport reuses existing protected preview/apply endpoints and keeps ordinary confirmation separate',async()=>{
  const post=vi.fn().mockResolvedValue({data:{}}),api=createHistoricalReactivationApi({post});await api.previewManualNames(request);await api.saveManualNames({...request,...pair,preparationToken:'c'.repeat(64),reviewExpiresAt:'synthetic',reviewedNameUa:full.nameUa,reviewedNameEn:full.nameEn});
  expect(post.mock.calls.map(call=>call[0])).toEqual(['/product-magento-name/preview','/product-magento-name/apply']);
});

it('successful retry reads an already completed pair authoritatively instead of retaining unsaved edits', async () => {
  mount(); await begin(); await openNames(); await proposed();
  fireEvent.change(screen.getByLabelText('Назва UA'), { target: { value: 'Unsaved UA draft' } });
  fireEvent.change(screen.getByLabelText('Назва EN'), { target: { value: 'Unsaved EN draft' } });
  client.previewManualNames.mockResolvedValueOnce({ data: current({ ...pair, ...full, alreadyCompleted: true }) });
  fireEvent.click(screen.getByRole('button', { name: 'Прочитати збережені назви' }));
  await screen.findByText(/Ручну пару вже збережено/);
  expect(screen.getByLabelText('Назва UA').value).toBe(pair.subjectUa); expect(screen.getByLabelText('Назва EN').value).toBe(pair.subjectEn);
  expect(screen.getByLabelText('Назва UA').disabled).toBe(true); expect(screen.queryByRole('button', { name: 'Зберегти ручну пару' })).toBeNull();
  expect(client.saveManualNames).not.toHaveBeenCalled(); expect(client.confirm).not.toHaveBeenCalled();
});

it('failed preparation explains the server error inside the form and disables preview until an explicit successful retry', async () => {
  const message = 'Ручна пара потрібна лише архівованому CREATE-кандидату SV.';
  client.previewManualNames.mockRejectedValueOnce({ response: { status: 409, data: { error: message } } });
  mount(); await begin(); await openNames();
  const form = screen.getByRole('region', { name: 'Ручні назви ' + article });
  await waitFor(() => expect(form.querySelector('[role="alert"]')?.textContent).toBe(message));
  fill(); expect(show().disabled).toBe(true); expect(save().disabled).toBe(true);
  fireEvent.click(show()); expect(client.previewManualNames).toHaveBeenCalledTimes(1);
  const pending = deferred(); client.previewManualNames.mockReturnValueOnce(pending.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Прочитати збережені назви' }));
  expect(screen.getByLabelText('Назва UA').value).toBe(pair.subjectUa); expect(screen.getByLabelText('Назва EN').value).toBe(pair.subjectEn);
  expect(show().disabled).toBe(true);
  await act(async () => pending.resolve({ data: current() }));
  expect(screen.getByLabelText('Назва UA').value).toBe(pair.subjectUa); expect(screen.getByLabelText('Назва EN').value).toBe(pair.subjectEn);
  expect(form.querySelector('[role="alert"]')).toBeNull(); expect(show().disabled).toBe(false);
  fireEvent.click(show()); await screen.findByText(full.nameEn); expect(consent().checked).toBe(false);
  expect(client.previewManualNames.mock.calls).toEqual([[request], [request]]);
  expect(client.preview).toHaveBeenCalledTimes(1); expect(client.saveManualNames).not.toHaveBeenCalled(); expect(client.confirm).not.toHaveBeenCalled();
});
it('repeated preparation failures preserve edited subjects; successful reread uses only its fresh descriptor and clears consent', async () => {
  mount(); await begin(); await openNames(); await proposed(); fireEvent.click(consent());
  client.previewManualNames.mockRejectedValueOnce({ response: { status: 409, data: { error: 'Повторна підготовка не вдалася.' } } });
  fireEvent.click(screen.getByRole('button', { name: 'Прочитати збережені назви' }));
  await screen.findByText('Повторна підготовка не вдалася.');
  expect(screen.getByLabelText('Назва UA').value).toBe(pair.subjectUa); expect(screen.getByLabelText('Назва EN').value).toBe(pair.subjectEn);
  expect(show().disabled).toBe(true); expect(save().disabled).toBe(true); expect(screen.queryByText(full.nameEn)).toBeNull();
  client.previewManualNames.mockResolvedValueOnce({ data: current({ nameRender: { format: 'historical-manual-render-v1',
    ua: { prefix: 'Fresh ', suffix: ' Арт: ' + article }, en: { prefix: 'Current ', suffix: '. Art: ' + article } } }) });
  fireEvent.click(screen.getByRole('button', { name: 'Прочитати збережені назви' }));
  await waitFor(() => expect(show().disabled).toBe(false)); fireEvent.click(show());
  await screen.findByText('Current ' + pair.subjectEn + '. Art: ' + article);
  expect(consent().checked).toBe(false); expect(save().disabled).toBe(true);
  expect(client.saveManualNames).not.toHaveBeenCalled(); expect(client.confirm).not.toHaveBeenCalled();
});
