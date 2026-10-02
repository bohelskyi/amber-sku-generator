import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AuthContext} from '../src/auth/auth-context.js';
import {api} from '../src/lib/api.js';
import MagentoOptionActions from '../src/components/workspace/MagentoOptionActions.jsx';
vi.mock('../src/lib/api.js',()=>({api:{get:vi.fn(),post:vi.fn()}}));
afterEach(cleanup);beforeEach(()=>{vi.resetAllMocks();api.get.mockResolvedValue({data:[]});});
const revision={id:'draft',revision:'1',state:'draft',schema:{attributes:[{attribute_id:1471,attribute_code:'fixture_choice',frontend_input:'select'}]}};
const category={code:'XG',values:[{questionKey:'kind',questionLabel:'Вид',valueId:'8',label:'Скриньки',state:'missing'}]};
const labelCategory={...category,values:category.values.map(value=>({...value,state:'approved',mappings:[{attribute:'fixture_choice',optionId:'123'}]}))};
const roles=[{key:'administrator'}];
const permissions=['export_templates.manage','export_templates.publish'];
const shell=(grants=permissions,assignedRoles=roles,props={})=>render(<AuthContext.Provider value={{permissions:grants,roles:assignedRoles}}><MagentoOptionActions revision={revision} category={category} {...props}/></AuthContext.Provider>);
const labels=(props={},assignedRoles=roles)=>shell(permissions,assignedRoles,{revision:{...revision,state:'published'},category:labelCategory,mode:'labels',currentPublishedId:'draft',...props});
async function openHistory(){const summary=await screen.findByText('Історія дій цього типу (1)');fireEvent.click(summary.closest('summary'));}
it('English is read from Amber by the server; no caller-authored label or authority control remains',async()=>{
  shell();expect(screen.queryByRole('textbox',{name:/англійською/})).toBeNull();
  fireEvent.change(screen.getByRole('combobox',{name:'Значення Amber'}),{target:{value:'kind:8'}});
  fireEvent.change(screen.getByRole('combobox',{name:'Атрибут Magento'}),{target:{value:'fixture_choice'}});
  api.post.mockRejectedValueOnce({response:{data:{error:'Заповніть англійську назву в каталозі Amber.'}}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити значення Magento'}));
  await screen.findByText('Заповніть англійську назву в каталозі Amber.');
  expect(api.post.mock.calls[0][1]).toEqual({bindingRevisionId:'draft',expectedRevision:'1',attributeCode:'fixture_choice',amberGroup:'XG',questionKey:'kind',valueId:'8'});
});
it('approved published option labels use a separate reviewed adapter action and GET-only uncertain recovery',async()=>{
  api.get.mockResolvedValue({data:[{id:'put-action',kind:'option_label',state:'dispatched',attributeCode:'fixture_choice',label:'Скриньки',message:'Непідтверджена зміна',canReconcile:true}]});
  labels();await openHistory();
  await screen.findByText(/Непідтверджена зміна/);
  api.post.mockResolvedValueOnce({data:{state:'verified'}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити результат читанням'}));
  expect(api.post).toHaveBeenCalledWith('/admin/magento-integration/option-labels/reconcile',{actionId:'put-action'});
  expect(screen.queryByRole('button',{name:/Повторно надіслати/})).toBeNull();
});
it('existing-option label update shows exact UA/EN differences and requires explicit confirmation',async()=>{
  labels();
  fireEvent.change(screen.getByRole('combobox',{name:'Значення Amber'}),{target:{value:'kind:8'}});
  fireEvent.change(screen.getByRole('combobox',{name:'Атрибут Magento'}),{target:{value:'fixture_choice'}});
  api.post.mockResolvedValueOnce({data:{target:{label:'Скриньки',englishLabel:'Boxes'},attribute:{attribute_code:'fixture_choice',attribute_id:1471},metadataFingerprint:'fingerprint',warning:'Потрібен адаптер.'}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити значення Magento'}));await screen.findByText('Потрібен адаптер.');
  fireEvent.click(screen.getByRole('checkbox',{name:/Я перевірив/}));fireEvent.click(screen.getByRole('checkbox',{name:/Розумію обмеження/}));
  fireEvent.change(screen.getByRole('textbox',{name:'Підстава перевірки'}),{target:{value:'Перевірено для цієї дії'}});
  api.post.mockResolvedValueOnce({data:{id:'attestation'}}).mockResolvedValueOnce({data:{kind:'option_label',label:'Скриньки',target:{attributeCode:'fixture_choice',englishLabel:'Boxes'},differences:[{scope:'en',before:'Old',after:'Boxes'}],previewToken:'proof'}});
  fireEvent.click(screen.getByRole('button',{name:'Підтвердити можливість і переглянути зміни'}));
  await screen.findByText('Англійська: Old → Boxes');expect(api.post).toHaveBeenCalledTimes(3);
  api.post.mockResolvedValueOnce({data:{state:'verified'}});fireEvent.click(screen.getByRole('button',{name:'Підтвердити зміну назв у Magento'}));
  expect(api.post.mock.calls[3][0]).toBe('/admin/magento-integration/option-labels/apply');
  expect(api.post.mock.calls[3][1]).toMatchObject({attestationId:'attestation',previewToken:'proof'});
});
it('requires current Administrator review and explicit preview/apply; creation never approves a binding',async()=>{
  shell();fireEvent.change(screen.getByRole('combobox',{name:'Значення Amber'}),{target:{value:'kind:8'}});
  fireEvent.change(screen.getByRole('combobox',{name:'Атрибут Magento'}),{target:{value:'fixture_choice'}});
  api.post.mockResolvedValueOnce({data:{target:{label:'Скриньки'},attribute:{attribute_code:'fixture_choice',attribute_id:1471},metadataFingerprint:'fingerprint',candidates:[],warning:'REST не доводить відсутність swatch.'}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити значення Magento'}));await screen.findByText('REST не доводить відсутність swatch.');
  const attest=screen.getByRole('button',{name:'Підтвердити можливість і переглянути створення'});expect(attest.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox',{name:/Я перевірив/}));fireEvent.click(screen.getByRole('checkbox',{name:/Розумію обмеження/}));
  fireEvent.change(screen.getByRole('textbox',{name:'Підстава перевірки'}),{target:{value:'Перевірено для цієї дії'}});
  api.post.mockResolvedValueOnce({data:{id:'attestation'}}).mockResolvedValueOnce({data:{label:'Скриньки',target:{attributeCode:'fixture_choice'},previewToken:'proof'}});
  fireEvent.click(attest);const apply=await screen.findByRole('button',{name:'Створити значення в Magento'});expect(api.post).toHaveBeenCalledTimes(3);
  api.post.mockResolvedValueOnce({data:{state:'verified'}});fireEvent.click(apply);
  expect(api.post.mock.calls[3][1]).toMatchObject({attestationId:'attestation',previewToken:'proof'});
  expect(api.post.mock.calls.every(([url])=>!url.includes('binding'))).toBe(true);
});
it('delegated integration capabilities retain inspection without Administrator attestation or apply',async()=>{
  shell(permissions,[]);
  fireEvent.change(screen.getByRole('combobox',{name:'Значення Amber'}),{target:{value:'kind:8'}});
  fireEvent.change(screen.getByRole('combobox',{name:'Атрибут Magento'}),{target:{value:'fixture_choice'}});
  api.post.mockResolvedValueOnce({data:{target:{label:'Скриньки'},attribute:{attribute_code:'fixture_choice'},metadataFingerprint:'fingerprint',candidates:[]}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити значення Magento'}));
  await screen.findByText(/Для створення або зміни значення потрібне/);
  expect(screen.queryByRole('checkbox',{name:/Я перевірив/})).toBeNull();
  expect(screen.queryByRole('button',{name:/Підтвердити можливість|Створити значення в Magento/})).toBeNull();
});
it('uncertain dispatched option offers no blind retry',async()=>{
  api.get.mockResolvedValue({data:[{id:'action',kind:'option',state:'dispatched',attributeCode:'fixture_choice',label:'Скриньки',message:'Не підтверджено',canReconcile:false}]});
  shell();await openHistory();await screen.findByText(/Не підтверджено/);expect(screen.queryByRole('button',{name:/Повтор|Перевірити результат/})).toBeNull();
});
it('missing label adapter permits effective read comparison but exposes no attestation or write action',async()=>{
  labels();
  fireEvent.change(screen.getByRole('combobox',{name:'Значення Amber'}),{target:{value:'kind:8'}});
  fireEvent.change(screen.getByRole('combobox',{name:'Атрибут Magento'}),{target:{value:'fixture_choice'}});
  api.post.mockResolvedValueOnce({data:{target:{label:'Скриньки',englishLabel:'Boxes'},attribute:{attribute_code:'fixture_choice',attribute_id:1471},
    updateUnavailable:'Безпечне оновлення недоступне без адаптера Magento.',comparisonKind:'effective',
    comparison:[{scope:'all',before:'Скриньки',after:'Скриньки'},{scope:'en',before:'Old English',after:'Boxes'}]}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити значення Magento'}));
  await screen.findByText(/Безпечне оновлення недоступне/);
  expect(screen.getByText(/Magento: Old English.*Amber: Boxes/)).toBeTruthy();
  expect(screen.getByText(/успадкованою/)).toBeTruthy();
  expect(screen.queryByRole('checkbox',{name:/Я перевірив/})).toBeNull();
  expect(screen.queryByRole('button',{name:/Підтвердити можливість|Підтвердити зміну назв/})).toBeNull();
  expect(api.post).toHaveBeenCalledTimes(1);expect(api.post.mock.calls[0][0]).toBe('/admin/magento-integration/option-labels/inspect');
});
it('read-only label comparison exposes no Administrator mutation or action-history reads',async()=>{
  labels({readOnly:true});
  fireEvent.change(screen.getByRole('combobox',{name:'Значення Amber'}),{target:{value:'kind:8'}});
  fireEvent.change(screen.getByRole('combobox',{name:'Атрибут Magento'}),{target:{value:'fixture_choice'}});
  api.post.mockResolvedValueOnce({data:{target:{label:'Скриньки',optionId:'123',attributeCode:'fixture_choice'},attribute:{attribute_code:'fixture_choice'},comparison:[],metadataFingerprint:'fingerprint'}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити значення Magento'}));
  await screen.findByText(/Це порівняння лише для перегляду/);
  expect(screen.queryByRole('checkbox',{name:/Я перевірив/})).toBeNull();expect(api.get).not.toHaveBeenCalled();
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-integration/option-labels/inspect',expect.objectContaining({valueId:'8'}));
});
it('label maintenance requires current publication and limits choices to approved semantic mappings',()=>{
  labels({currentPublishedId:'newer'});expect(screen.queryByRole('button',{name:'Перевірити значення Magento'})).toBeNull();
  cleanup();labels({category:{...labelCategory,values:[...labelCategory.values,...category.values.map(value=>({...value,valueId:'9',label:'Не затверджено'}))]}});
  expect(screen.queryByRole('option',{name:/Не затверджено/})).toBeNull();
  expect(screen.queryByRole('option',{name:'fixture_choice'})).toBeNull();
  fireEvent.change(screen.getByRole('combobox',{name:'Значення Amber'}),{target:{value:'kind:8'}});
  expect(screen.getByRole('option',{name:'fixture_choice'})).toBeTruthy();
});
it('mode and category changes discard a late option inspection',async()=>{
  let resolveInspection;api.post.mockReturnValueOnce(new Promise(resolve=>{resolveInspection=resolve;}));
  const view=shell();
  fireEvent.change(screen.getByRole('combobox',{name:'Значення Amber'}),{target:{value:'kind:8'}});
  fireEvent.change(screen.getByRole('combobox',{name:'Атрибут Magento'}),{target:{value:'fixture_choice'}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити значення Magento'}));
  view.rerender(<AuthContext.Provider value={{permissions,roles}}><MagentoOptionActions revision={{...revision,state:'published'}} category={labelCategory} mode="labels" currentPublishedId="draft"/></AuthContext.Provider>);
  await act(async()=>resolveInspection({data:{target:{label:'Old inspection'},attribute:{attribute_code:'fixture_choice'},candidates:[],warning:'Old attestation'}}));
  expect(screen.queryByText(/Old inspection|Old attestation/)).toBeNull();
  expect(screen.queryByRole('checkbox',{name:/Я перевірив/})).toBeNull();
});
it('only exact approved option identity is shown as current work; equal labels remain history',async()=>{
  api.get.mockResolvedValue({data:[
    {id:'exact',kind:'option_label',attributeCode:'fixture_choice',remoteId:'123',label:'Спільна назва',state:'dispatched',message:'Точна поточна дія',canReconcile:true},
    {id:'other',kind:'option_label',attributeCode:'fixture_choice',remoteId:'999',label:'Спільна назва',state:'dispatched',message:'Інший варіант',canReconcile:true},
    {id:'creation',kind:'option',attributeCode:'fixture_choice',remoteId:'123',label:'Спільна назва',state:'verified',message:'Інший тип дії'},
  ]});
  labels();
  fireEvent.change(screen.getByRole('combobox',{name:'Значення Amber'}),{target:{value:'kind:8'}});
  fireEvent.change(screen.getByRole('combobox',{name:'Атрибут Magento'}),{target:{value:'fixture_choice'}});
  api.post.mockResolvedValueOnce({data:{target:{label:'Скриньки',attributeCode:'fixture_choice',optionId:'123'},attribute:{attribute_code:'fixture_choice'},comparison:[],updateUnavailable:'Немає адаптера'}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити значення Magento'}));await screen.findByText(/Точна поточна дія/);
  expect(screen.queryByText(/Інший варіант/)).toBeNull();expect(screen.queryByText(/Інший тип дії/)).toBeNull();
  await openHistory();expect(screen.getByText(/Інший варіант/)).toBeTruthy();
});
it('verified option creation reports the resource change even when its auxiliary history refresh fails',async()=>{
  const changed=vi.fn();shell(permissions,roles,{onResourceChanged:changed});
  fireEvent.change(screen.getByRole('combobox',{name:'Значення Amber'}),{target:{value:'kind:8'}});
  fireEvent.change(screen.getByRole('combobox',{name:'Атрибут Magento'}),{target:{value:'fixture_choice'}});
  api.post.mockResolvedValueOnce({data:{target:{label:'Скриньки'},attribute:{attribute_code:'fixture_choice'},metadataFingerprint:'proof',candidates:[],warning:'Перевірка'}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити значення Magento'}));await screen.findByText('Перевірка');
  fireEvent.click(screen.getByRole('checkbox',{name:/Я перевірив/}));fireEvent.click(screen.getByRole('checkbox',{name:/Розумію обмеження/}));
  fireEvent.change(screen.getByLabelText('Підстава перевірки'),{target:{value:'Перевірено атрибут'}});
  api.post.mockResolvedValueOnce({data:{id:'attestation'}}).mockResolvedValueOnce({data:{label:'Скриньки',target:{attributeCode:'fixture_choice'},previewToken:'proof'}});
  fireEvent.click(screen.getByRole('button',{name:'Підтвердити можливість і переглянути створення'}));
  const apply=await screen.findByRole('button',{name:'Створити значення в Magento'});
  api.post.mockResolvedValueOnce({data:{id:'created',kind:'option',state:'verified',attributeCode:'fixture_choice',label:'Скриньки',message:'Створено, зв’язок ще не підтверджено'}});
  api.get.mockRejectedValueOnce(new Error('History failed'));fireEvent.click(apply);
  await screen.findByText(/Не вдалося оновити історію дій/);
  expect(changed).toHaveBeenCalledExactlyOnceWith();expect(screen.getByText(/Створено, зв’язок ще не підтверджено/)).toBeTruthy();
  expect(api.post).toHaveBeenCalledTimes(4);
});
