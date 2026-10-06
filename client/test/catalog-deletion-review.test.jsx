import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CatalogDeletionReview } from '../src/components/admin/CatalogDeletionReview.jsx';
afterEach(cleanup);
const target={bindingRevisionId:'00000000-0000-0000-0000-000000000001',expectedRevision:'1',type:'option',questionId:'10',optionId:'20',attributeCode:'shade',attributeId:6001,remoteOptionId:'701'};
const review={previewToken:'fixture-review',confirmationText:'DELETE OPTION 20 / MAGENTO shade#6001:701',localTarget:{label:'Blue'},remote:{attributeLabel:'Shade',selectedRemoteLabel:'Blue',products:[],sets:[]},
  affected:{products:[],options:[{id:20,valueId:0}],pricing:[],rules:[],templates:[],bindings:[],historicalSchemas:[{id:1,version:1}]},blockers:[],futureSkuPublicationRequired:true};
it('Manager cannot open destructive confirmation or call the destructive endpoints',()=>{
  const apiClient={get:vi.fn(),post:vi.fn()}; render(<CatalogDeletionReview target={target} isAdministrator={false} apiClient={apiClient}/>);
  expect(screen.getByText(/потребує ролі Адміністратора/)).toBeTruthy(); expect(screen.queryByText('Перевірити наслідки')).toBeNull();
  expect(apiClient.get).not.toHaveBeenCalled(); expect(apiClient.post).not.toHaveBeenCalled();
});
it('shows exact option scope and requires every attestation and exact text before applying',async()=>{
  const apiClient={get:vi.fn().mockResolvedValue({data:[]}),post:vi.fn().mockResolvedValue({data:review})};
  render(<CatalogDeletionReview target={target} isAdministrator apiClient={apiClient}/>);
  expect(screen.getByText(/Manager question #10, option #20; Magento shade #6001, option #701/)).toBeTruthy();
  fireEvent.click(screen.getByText('Перевірити наслідки')); await screen.findByText('Blue → Shade / Blue');
  const apply=screen.getByText('Підтвердити видалення з Manager і Magento'); expect(apply.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Причина'),{target:{value:'Unused reviewed value'}});
  fireEvent.change(screen.getByLabelText('Точне підтвердження видалення'),{target:{value:review.confirmationText}});
  const checks=screen.getAllByRole('checkbox'); checks.slice(0,-1).forEach(check=>fireEvent.click(check)); expect(apply.disabled).toBe(true);
  fireEvent.click(checks.at(-1)); expect(apply.disabled).toBe(false);
});
it('a dependency blocks confirmation while exposing the exact retained historical schema',async()=>{
  const apiClient={get:vi.fn().mockResolvedValue({data:[]}),post:vi.fn().mockResolvedValue({data:{...review,blockers:['SHARED_ATTRIBUTE_SETS']}})};
  render(<CatalogDeletionReview target={target} isAdministrator apiClient={apiClient}/>);
  fireEvent.click(screen.getByText('Перевірити наслідки')); await screen.findByText(/Атрибут доступний у кількох наборах/);
  expect(screen.queryByText('Підтвердити видалення з Manager і Magento')).toBeNull();
  expect(screen.getByText(/Історичні SKU схеми: #1 v1/)).toBeTruthy();
});
it('reload restores saved uncertain receipts and GET-only reconciliation without another apply',async()=>{
  const uncertain={id:'00000000-0000-0000-0000-000000000002',state:'dispatched',localTarget:{label:'Blue'},canReconcile:true,message:'Результат ще не підтверджено.'};
  const completed={...uncertain,state:'completed',localDeleted:true,remoteAbsent:true,canReconcile:false,message:'Вилучено з обох каталогів.'};
  const apiClient={get:vi.fn().mockResolvedValue({data:[uncertain]}),post:vi.fn().mockResolvedValue({data:completed})}; const onCompleted=vi.fn();
  render(<CatalogDeletionReview target={target} isAdministrator apiClient={apiClient} onCompleted={onCompleted}/>);
  fireEvent.click(await screen.findByText('Перевірити та завершити без повторного DELETE'));
  await waitFor(()=>expect(onCompleted).toHaveBeenCalledWith(completed));
  expect(apiClient.post).toHaveBeenCalledTimes(1); expect(apiClient.post).toHaveBeenCalledWith('/admin/catalog-deletion/reconcile',{actionId:uncertain.id});
});
it('changing selection remounts the review and clears a previous typed confirmation',async()=>{
  const apiClient={get:vi.fn().mockResolvedValue({data:[]}),post:vi.fn().mockResolvedValue({data:review})};
  const {rerender}=render(<CatalogDeletionReview target={target} isAdministrator apiClient={apiClient}/>);
  fireEvent.click(screen.getByText('Перевірити наслідки')); await screen.findByText('Blue → Shade / Blue');
  fireEvent.change(screen.getByLabelText('Точне підтвердження видалення'),{target:{value:review.confirmationText}});
  rerender(<CatalogDeletionReview target={{...target,optionId:'21',remoteOptionId:'702'}} isAdministrator apiClient={apiClient}/>);
  expect(screen.queryByLabelText('Точне підтвердження видалення')).toBeNull();
});


it('TEST remote-only review has separate attestations and preserves the local archive in its completion receipt',async()=>{
  const testTarget={...target,attributeCode:'test_fixture'};
  const proof={...review,localArchiveRetained:true,localDeleted:false,confirmationText:'DELETE MAGENTO ONLY test_fixture#6001:701 / KEEP ARCHIVED QUESTION 10 OPTION 20'};
  const done={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',state:'completed',localArchived:true,localDeleted:false,historicalEvidencePreserved:true,remoteAbsent:true,canReconcile:false,localTarget:{label:'TEST fixture'},message:'Архів збережено.'};
  const apiClient={get:vi.fn().mockResolvedValue({data:[]}),post:vi.fn().mockResolvedValueOnce({data:proof}).mockResolvedValueOnce({data:done})};
  const onCompleted=vi.fn();render(<CatalogDeletionReview target={testTarget} remoteOnly isAdministrator apiClient={apiClient} onCompleted={onCompleted}/>);
  expect(apiClient.post).not.toHaveBeenCalled();
  await waitFor(()=>expect(apiClient.get).toHaveBeenCalledWith('/admin/catalog-deletion/remote-only/actions'));
  fireEvent.click(screen.getByText('Перевірити наслідки'));await screen.findByLabelText('Точне підтвердження видалення');
  const apply=screen.getByRole('button',{name:'Підтвердити видалення лише з Magento'});expect(apply.disabled).toBe(true);
  expect(screen.queryByRole('button',{name:'Підтвердити видалення з Manager і Magento'})).toBeNull();
  fireEvent.change(screen.getByLabelText('Причина'),{target:{value:'Remove exact owned TEST fixture'}});
  fireEvent.change(screen.getByLabelText('Точне підтвердження видалення'),{target:{value:proof.confirmationText}});
  screen.getAllByRole('checkbox').forEach(check=>fireEvent.click(check));fireEvent.click(apply);
  await waitFor(()=>expect(onCompleted).toHaveBeenCalledWith(done));
  const [url,command]=apiClient.post.mock.calls[1];expect(url).toBe('/admin/catalog-deletion/remote-only/apply');
  expect(command.ackRemoteOnly).toBe(true);expect(command.ackBothCatalogs).toBeUndefined();expect(command.attributeCode).toBe('test_fixture');
});


it('remote-only blockers identify active remote dependencies and require a separate decision without offering deletion',async()=>{
  const apiClient={get:vi.fn().mockResolvedValue({data:[]}),post:vi.fn().mockResolvedValue({data:{...review,blockers:['ACTIVE_TEMPLATE_DEPENDENCY','BINDING_DEPENDENCY']}})};
  render(<CatalogDeletionReview target={{...target,attributeCode:'test_fixture'}} remoteOnly isAdministrator apiClient={apiClient}/>);
  fireEvent.click(screen.getByText('Перевірити наслідки'));
  await screen.findByText('Поточний активний шаблон виводить цей атрибут до Magento.');
  expect(screen.getByText('Чинна опублікована відповідність використовує цей атрибут. Потрібне окреме рішення щодо цієї залежності.')).toBeTruthy();
  expect(screen.queryByText(/або чернетці/)).toBeNull();
  expect(screen.queryByText(/Спершу опублікуйте/)).toBeNull();
  expect(screen.queryByRole('button',{name:'Підтвердити видалення лише з Magento'})).toBeNull();
  expect(apiClient.post).toHaveBeenCalledTimes(1);
  expect(apiClient.post.mock.calls[0][0]).toBe('/admin/catalog-deletion/remote-only/preview');
});
