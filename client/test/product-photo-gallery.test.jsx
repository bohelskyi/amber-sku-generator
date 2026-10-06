import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProductPhotos } from '../src/components/app/ProductPhotos.jsx';
import { useProductPhotos } from '../src/hooks/useProductPhotos.js';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), defaults: {baseURL:'/api'} }));
vi.mock('../src/lib/api.js', () => ({api:mocks}));
const ids = ['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];
const photos = ids.map((id,index) => ({id,name:'photo-'+index+'.png',mimeType:'image/png'}));
const file = (name='picked.png') => new File([new Uint8Array(68)],name,{type:'image/png'});
const cameraDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'capture');
function controller(overrides={}) { return {photos:[],failedUploads:[],contentUrl:(id)=>'/api/photos/'+id,addFiles:vi.fn(),reorderPhotos:vi.fn(),removePhoto:vi.fn(),setEnableWhenVerified:vi.fn(),retryUploads:vi.fn(),discardFailed:vi.fn(),...overrides}; }
beforeEach(() => { mocks.get.mockReset(); mocks.post.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); if(cameraDescriptor)Object.defineProperty(HTMLInputElement.prototype,'capture',cameraDescriptor);else delete HTMLInputElement.prototype.capture; });
it('uses one primary picker with hidden browser chrome; exact multiple files stage only after explicit selection',()=>{
  const p=controller();render(<ProductPhotos controller={p}/>);const input=screen.getByLabelText('Додати фото');const button=screen.getByRole('button',{name:'Додати фото'});const click=vi.spyOn(input,'click');
  expect(screen.getByRole('heading',{name:'Фотографії'}).parentElement.contains(button)).toBe(true);
  expect(screen.queryByText(/МБ|МіБ/)).toBeNull();
 expect(input.className).toContain('product-photos-input');expect(input.multiple).toBe(true);expect(input.tabIndex).toBe(-1);expect(button.className).toContain('btn-outline');expect(p.addFiles).not.toHaveBeenCalled();
 fireEvent.click(button);expect(click).toHaveBeenCalledOnce();expect(p.addFiles).not.toHaveBeenCalled();const picked=[file(),file('second.png')];fireEvent.change(input,{target:{files:picked}});expect(p.addFiles).toHaveBeenCalledExactlyOnceWith(picked);expect(input.value).toBe('');
});
it('puts camera behind optional closed disclosure and uses the same staging path',()=>{
 Object.defineProperty(HTMLInputElement.prototype,'capture',{configurable:true,writable:true,value:''});const p=controller();const {container}=render(<ProductPhotos controller={p}/>);const details=container.querySelector('.product-photos-camera');expect(details.open).toBe(false);fireEvent.click(screen.getByText('Камера, якщо доступна'));expect(details.open).toBe(true);const input=screen.getByLabelText('Зробити фото камерою');expect(input.getAttribute('capture')).toBe('environment');expect(input.multiple).toBe(false);expect(input.className).toContain('product-photos-input');const click=vi.spyOn(input,'click');fireEvent.click(screen.getByRole('button',{name:'Зробити фото'}));expect(click).toHaveBeenCalledOnce();const picked=file('camera.png');fireEvent.change(input,{target:{files:[picked]}});expect(p.addFiles).toHaveBeenCalledExactlyOnceWith([picked]);
});
it('does not advertise camera when capture is unsupported',()=>{
 if(cameraDescriptor?.configurable===false)return;delete HTMLInputElement.prototype.capture;render(<ProductPhotos controller={controller()}/>);expect(screen.queryByText('Камера, якщо доступна')).toBeNull();expect(screen.getByLabelText('Додати фото')).toBeTruthy();
});
it.each([{busy:true},{loading:true},{ready:false},{delivery:{state:'uncertain'}},{delivery:{state:'pending'}}])('blocked picker cannot stage through button or a synthetic file event: %j',(lock)=>{
 const p=controller(lock);render(<ProductPhotos controller={p}/>);const button=screen.getByRole('button',{name:'Додати фото'});expect(button.disabled).toBe(true);fireEvent.click(button);fireEvent.change(screen.getByLabelText('Додати фото'),{target:{files:[file()]}});expect(p.addFiles).not.toHaveBeenCalled();
});
it('readonly media preserves gallery previews without selection or mutation controls',()=>{
 render(<ProductPhotos controller={controller({photos})} canEdit={false} existingProduct/>);expect(screen.getAllByRole('img')).toHaveLength(2);expect(screen.queryByRole('button')).toBeNull();expect(screen.queryByLabelText('Додати фото')).toBeNull();expect(screen.getByText('Головне')).toBeTruthy();
});
it('uses one accessible handle per photo and retains compact removal without a primary action',()=>{
 const p=controller({photos});render(<ProductPhotos controller={p}/>);
 expect(screen.getAllByRole('img').map(img=>img.alt)).toEqual(['photo-0.png','photo-1.png']);
 expect(screen.queryByRole('button',{name:'Зробити головним'})).toBeNull();
 expect(screen.getByRole('button',{name:'Перемістити photo-1.png'}).getAttribute('aria-describedby')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Прибрати photo-0.png'}));expect(p.removePhoto).toHaveBeenCalledExactlyOnceWith(ids[0]);
 expect(screen.queryByText('Фото перевірено в Magento')).toBeNull();
});
it('maximum gallery disables only new selection while existing removal stays available',()=>{
 const p=controller({photos:Array.from({length:8},(_,i)=>({id:String(i),name:'photo-'+i+'.png'}))});render(<ProductPhotos controller={p}/>);expect(screen.getByRole('button',{name:'Додати фото'}).disabled).toBe(true);expect(screen.getByText('Додано всі 8 фото. Приберіть одне, щоб додати інше.')).toBeTruthy();expect(screen.getAllByRole('button',{name:/^Прибрати /}).every(button=>!button.disabled)).toBe(true);
});
it('gallery selection with lost stage reply retains failed intent and retries original key/content only on explicit action',async()=>{
 mocks.post.mockRejectedValueOnce(new Error('lost synthetic stage')).mockResolvedValueOnce({data:photos[0]});function Gallery(){return <ProductPhotos controller={useProductPhotos()}/>;}render(<Gallery/>);await act(async()=>{await Promise.resolve();await Promise.resolve();});await act(async()=>{fireEvent.change(screen.getByLabelText('Додати фото'),{target:{files:[file()]}});});await screen.findByText(/Створити товар можна після повторного збереження/);expect(mocks.post).toHaveBeenCalledTimes(1);const original=mocks.post.mock.calls[0][1];expect(screen.queryByRole('img')).toBeNull();await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Повторити збереження цих фото'}));});await screen.findByRole('img',{name:'photo-0.png'});expect(mocks.post).toHaveBeenCalledTimes(2);expect(mocks.post.mock.calls[1][1]).toEqual(original);expect(screen.queryByText(/Створити товар можна після повторного збереження/)).toBeNull();
});
