import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { CatalogDeletionEntry } from '../src/components/admin/CatalogDeletionEntry.jsx';
import { resolveCatalogDeletionTarget } from '../src/lib/catalog-deletion-target.js';
afterEach(cleanup);
const revision={id:'00000000-0000-0000-0000-000000000001',revision:'12'};
const questions=[{id:'shade',q_db_id:10,cat:'AA',label:'Колір',options:[{id:0,db_id:20,label:'Синій'},{id:1,db_id:21,label:'Червоний'}]}];
const attributeEntry={kind:'attribute',target:'shade',group:'AA',routeKey:'AA:all',row:'base',identity:6001,label:'shade',reviewState:'approved'};
const optionEntry={kind:'option',target:'shade',group:'AA',routeKey:'AA:all',row:'base',source:'AA.shade=value_id:0',identity:'701',reviewState:'approved'};
const field={revision,attribute:{code:'shade',target:'shade',sources:[{kind:'semantic',category:'AA',key:'shade'}]},entries:[attributeEntry,optionEntry],options:[{value:'701',label:'Синій'}]};
const permissions=['catalog.manage','export_templates.manage','export_templates.publish'];
const base={categoryCode:'AA',questions,revision,field,isAdministrator:true,permissions};
const expected={bindingRevisionId:revision.id,expectedRevision:'12',type:'option',questionId:'10',optionId:'20',attributeCode:'shade',attributeId:6001,remoteOptionId:'701'};
const mount=props=>render(<MemoryRouter><CatalogDeletionEntry {...base} {...props}/></MemoryRouter>);
it('resolves exact question/option scope while preserving semantic zero separately from row/remote IDs',()=>{
  expect(resolveCatalogDeletionTarget({...base,optionEntry}).target).toEqual(expected);
  expect(resolveCatalogDeletionTarget(base).target).toEqual({...expected,type:'question',optionId:null,remoteOptionId:null});
});
it('fails closed for incomplete, stale, ambiguous or unapproved IDs without using labels as identifiers',()=>{
  const invalid=[
    {questions:[{...questions[0],q_db_id:null}]},
    {questions:[{...questions[0],options:[{id:0,label:'Синій'}]}]},
    {questions:[questions[0],questions[0]]},
    {field:{...field,revision:{...revision,revision:'11'}}},
    {field:{...field,entries:[{...attributeEntry,identity:'shade'},optionEntry]}},
    {field:{...field,entries:[{...attributeEntry,reviewState:'proposed'},optionEntry]}},
    {field:{...field,attribute:{...field.attribute,attributeId:6002}}},
    {optionEntry:{...optionEntry,identity:'Синій'}},
    {optionEntry:{...optionEntry,identity:'702'}},
    {optionEntry:{...optionEntry,source:'OTHER.shade=value_id:0'}},
    {optionEntry:{...optionEntry,reviewState:'review_required'}},
    {optionEntry:{...optionEntry,routeKey:'AA.other=value_id:1'}},
  ];
  for(const patch of invalid) expect(resolveCatalogDeletionTarget({...base,optionEntry,...patch}).target).toBeNull();
  expect(resolveCatalogDeletionTarget({...base,field:{...field,attribute:{...field.attribute,sources:[...field.attribute.sources,{kind:'semantic',category:'AA',key:'other'}]}}}).target).toBeNull();
});
it('non-Administrator has no destructive action and makes no request',()=>{
  const apiClient={get:vi.fn(),post:vi.fn()}; mount({optionEntry,isAdministrator:false,apiClient});
  expect(screen.queryByRole('button',{name:/Видалити/})).toBeNull();
  expect(screen.getByText(/доступне лише Адміністратору/)).toBeTruthy(); expect(apiClient.get).not.toHaveBeenCalled(); expect(apiClient.post).not.toHaveBeenCalled();
});
it('missing permissions or exact context disables the action with a reason and no requests',()=>{
  const apiClient={get:vi.fn(),post:vi.fn()};
  const view=mount({optionEntry,permissions:permissions.slice(1),apiClient});
  expect(screen.getByRole('button',{name:'Видалити один варіант з Manager і Magento'}).disabled).toBe(true);
  expect(screen.getByText(/бракує дозволів: catalog.manage/)).toBeTruthy();
  view.rerender(<MemoryRouter><CatalogDeletionEntry {...base} optionEntry={{...optionEntry,reviewState:'proposed'}} apiClient={apiClient}/></MemoryRouter>);
  expect(screen.getByRole('button',{name:'Видалити один варіант з Manager і Magento'}).disabled).toBe(true);
  expect(screen.getByText(/не має підтвердженої точної відповідності/)).toBeTruthy();
  expect(apiClient.get).not.toHaveBeenCalled(); expect(apiClient.post).not.toHaveBeenCalled();
});
it('archive remains separate; opening deletion makes only a receipt GET until explicit preview with exact IDs',async()=>{
  const proof={previewToken:'review',confirmationText:'DELETE OPTION 20 / shade#6001:701',localTarget:{label:'Синій'},remote:{attributeLabel:'Колір',selectedRemoteLabel:'Синій',products:[],sets:[]},
    affected:{products:[],options:[{id:20,valueId:0}],rules:[],pricing:[],templates:[],bindings:[],historicalSchemas:[]},blockers:[],futureSkuPublicationRequired:false};
  const apiClient={get:vi.fn().mockResolvedValue({data:[]}),post:vi.fn().mockResolvedValue({data:proof})}; const onReviewChange=vi.fn();
  mount({optionEntry,apiClient,onReviewChange});
  const archive=screen.getByRole('link',{name:'Архівування лише у Manager'}); expect(archive.href).toContain('action=edit-option'); expect(archive.href).toContain('value=0');
  expect(archive.href).toContain('optionId=20'); expect(new URL(archive.href).searchParams.get('returnTo')).toBe('/admin/magento/categories/AA?tab=attributes&field=shade');
  expect(apiClient.get).not.toHaveBeenCalled(); expect(apiClient.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Видалити один варіант з Manager і Magento'}));
  await waitFor(()=>expect(apiClient.get).toHaveBeenCalledWith('/admin/catalog-deletion/actions'));
  expect(screen.getByText(/Manager question #10, option #20; Magento shade #6001, option #701/)).toBeTruthy();
  expect(onReviewChange).toHaveBeenCalledWith(JSON.stringify(expected)); expect(apiClient.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Перевірити наслідки'}));
  await waitFor(()=>expect(apiClient.post).toHaveBeenCalledWith('/admin/catalog-deletion/preview',expected));
  expect(apiClient.post).toHaveBeenCalledTimes(1); expect(screen.getByRole('button',{name:'Підтвердити видалення з Manager і Magento'}).disabled).toBe(true);
});
it('whole-question entry explicitly states its wider scope and sends null option IDs',async()=>{
  const apiClient={get:vi.fn().mockResolvedValue({data:[]}),post:vi.fn()}; mount({apiClient});
  fireEvent.click(screen.getByRole('button',{name:'Видалити характеристику з Manager і Magento'}));
  expect(screen.getByText(/Manager question #10, усі варіанти; Magento shade #6001, весь атрибут/)).toBeTruthy();
  expect(apiClient.post).not.toHaveBeenCalled();
});
