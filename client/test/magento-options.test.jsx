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
