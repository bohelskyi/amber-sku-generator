import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AuthContext} from '../src/auth/auth-context.js';
import {api} from '../src/lib/api.js';
import MagentoOptionActions from '../src/components/workspace/MagentoOptionActions.jsx';
vi.mock('../src/lib/api.js',()=>({api:{get:vi.fn(),post:vi.fn()}}));
afterEach(cleanup);beforeEach(()=>{vi.resetAllMocks();api.get.mockResolvedValue({data:[]});});
const revision={id:'draft',revision:'1',state:'draft',schema:{attributes:[{attribute_id:1471,attribute_code:'fixture_choice',frontend_input:'select'}]}};
const category={code:'XG',values:[{questionKey:'kind',questionLabel:'Вид',valueId:'8',label:'Скриньки'}]};
const shell=(permissions=['users.manage','export_templates.manage','export_templates.publish'])=>render(<AuthContext.Provider value={{permissions}}><MagentoOptionActions revision={revision} category={category}/></AuthContext.Provider>);
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
  render(<AuthContext.Provider value={{permissions:['users.manage','export_templates.manage','export_templates.publish']}}><MagentoOptionActions revision={{...revision,state:'published'}} category={category}/></AuthContext.Provider>);
  await screen.findByText(/Непідтверджена зміна/);
  api.post.mockResolvedValueOnce({data:{state:'verified'}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити результат читанням'}));
  expect(api.post).toHaveBeenCalledWith('/admin/magento-integration/option-labels/reconcile',{actionId:'put-action'});
  expect(screen.queryByRole('button',{name:/Повторно надіслати/})).toBeNull();
});
it('existing-option label update shows exact UA/EN differences and requires explicit confirmation',async()=>{
  render(<AuthContext.Provider value={{permissions:['users.manage','export_templates.manage','export_templates.publish']}}><MagentoOptionActions revision={{...revision,state:'published'}} category={category}/></AuthContext.Provider>);
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
it('option creation needs Administrator visibility without changing existing permission grants',()=>{
  shell(['export_templates.manage','export_templates.publish']);expect(screen.queryByRole('button',{name:'Перевірити значення Magento'})).toBeNull();
});
it('uncertain dispatched option offers no blind retry',async()=>{
  api.get.mockResolvedValue({data:[{id:'action',kind:'option',state:'dispatched',attributeCode:'fixture_choice',label:'Скриньки',message:'Не підтверджено',canReconcile:false}]});
  shell();await screen.findByText(/Не підтверджено/);expect(screen.queryByRole('button',{name:/Повтор|Перевірити результат/})).toBeNull();
});
it('missing label adapter permits effective read comparison but exposes no attestation or write action',async()=>{
  render(<AuthContext.Provider value={{permissions:['users.manage','export_templates.manage','export_templates.publish']}}><MagentoOptionActions revision={{...revision,state:'published'}} category={category}/></AuthContext.Provider>);
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
