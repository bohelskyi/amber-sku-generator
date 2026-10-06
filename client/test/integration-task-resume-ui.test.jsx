import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {MemoryRouter} from 'react-router-dom';
import CreationIntegrationResume from '../src/components/app/CreationIntegrationResume.jsx';
const mocks=vi.hoisted(()=>({get:vi.fn()}));
vi.mock('../src/lib/api.js',()=>({api:mocks}));
const id='11111111-1111-4111-8111-111111111111';
const config={categories:{NM:{name:'Намисто'}},questions:{NM:[{id:'extra',input_type:'options',options:[{id:1}]}]}};
const dto={id,categoryCode:'NM',categoryLabel:'Намисто',state:'open',resumeHref:'/products/create?integrationTask='+id,deliveryAccepted:false,
  creationContext:{product:{categoryCode:'NM',answers:{extra:1},weight:1,photoIds:[]},photoCount:0,photos:[],unavailablePhotoIds:[],canResume:true}};
beforeEach(()=>{mocks.get.mockReset();mocks.get.mockResolvedValue({data:dto});});afterEach(cleanup);
it('reads owner context but restores the form only after the explicit replacement action',async()=>{
  const onResume=vi.fn(()=>true);
  render(<MemoryRouter><CreationIntegrationResume taskId={id} config={config} canCreate dirty onResume={onResume}/></MemoryRouter>);
  const button=await screen.findByRole('button',{name:'Замінити форму збереженими даними'});
  expect(onResume).not.toHaveBeenCalled();expect(mocks.get).toHaveBeenCalledWith('/integration-tasks/'+id);
  expect(screen.getByText(/замінить поточні незбережені поля та фото/)).toBeTruthy();fireEvent.click(button);
  expect(onResume).toHaveBeenCalledWith({product:dto.creationContext.product,photos:[]},id);
  expect(screen.getByText(/Дані та фото відновлено/)).toBeTruthy();
});
it('unavailable photos or owner context keep existing inputs untouched',async()=>{
  mocks.get.mockResolvedValue({data:{...dto,creationContext:{...dto.creationContext,canResume:false}}});const onResume=vi.fn();
  render(<MemoryRouter><CreationIntegrationResume taskId={id} config={config} canCreate onResume={onResume}/></MemoryRouter>);
  await screen.findByRole('alert');expect(onResume).not.toHaveBeenCalled();expect(screen.queryByRole('button')).toBeNull();
});
it('busy or revoked creation access cannot replace the form',async()=>{
  const onResume=vi.fn();const {rerender}=render(<MemoryRouter><CreationIntegrationResume taskId={id} config={config} canCreate busy onResume={onResume}/></MemoryRouter>);
  const button=await screen.findByRole('button',{name:'Відновити введені дані та фото'});expect(button.disabled).toBe(true);
  rerender(<MemoryRouter><CreationIntegrationResume taskId={id} config={config} canCreate={false} onResume={onResume}/></MemoryRouter>);
  await waitFor(()=>expect(screen.queryByRole('button')).toBeNull());expect(onResume).not.toHaveBeenCalled();
});
