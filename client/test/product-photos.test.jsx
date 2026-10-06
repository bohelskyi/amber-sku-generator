import { Buffer } from 'node:buffer';
import { act,cleanup,fireEvent,render,renderHook,screen } from '@testing-library/react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { useProductPhotos } from '../src/hooks/useProductPhotos.js';
import { ProductPhotos } from '../src/components/app/ProductPhotos.jsx';

const mocks=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),defaults:{baseURL:'/api'}}));
vi.mock('../src/lib/api.js',()=>({api:mocks}));
const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];
const originalPhotos=ids.map((id,index)=>({id,name:`photo-${index}.png`,mimeType:'image/png'}));
const data=(state='succeeded')=>({productId:1,version:'4',photos:originalPhotos,enableWhenVerified:true,delivery:{jobId:'job',state}});
const file=()=>new File([new Uint8Array(68)],'camera.png',{type:'image/png'});
const flush=async()=>{await act(async()=>{await Promise.resolve();await Promise.resolve();});};
beforeEach(()=>{mocks.get.mockReset();mocks.post.mockReset();});
afterEach(()=>{cleanup();vi.useRealTimers();});
describe('product photo controller',()=>{
  it.each([1048575,1048576])('stages the original photo at the one-MiB boundary: %i bytes',async(size)=>{
    mocks.post.mockResolvedValue({data:originalPhotos[0]});
    const bytes=new Uint8Array(size);bytes[0]=137;bytes[size-1]=73;
    const {result}=renderHook(()=>useProductPhotos());await flush();
    await act(async()=>{await result.current.addFiles([new File([bytes],'boundary.png',{type:'image/png'})]);});
    expect(mocks.post).toHaveBeenCalledOnce();expect(result.current.photos).toHaveLength(1);
    const original=Buffer.from(mocks.post.mock.calls[0][1].base64,'base64');
    expect(original.length).toBe(size);expect(original[0]).toBe(137);expect(original[size-1]).toBe(73);
    expect(result.current.error).toBe('');
  });
  it('rejects one byte above one MiB before HTTP, retaining the failed selection for explicit removal',async()=>{
    const {result}=renderHook(()=>useProductPhotos());await flush();
    await act(async()=>{await result.current.addFiles([new File([new Uint8Array(1048577)],'oversized.png',{type:'image/png'})]);});
    expect(mocks.post).not.toHaveBeenCalled();expect(result.current.photos).toHaveLength(0);
    expect(result.current.error).toContain('oversized.png');expect(result.current.error).toContain('1 МіБ (1 048 576 байтів)');
    expect(result.current.failedUploads).toHaveLength(1);expect(result.current.hasPendingUploads).toBe(true);
  });
  it('uploads eight one-MiB originals as separate requests, preserving the gallery limit and every byte length',async()=>{
    let next=0;mocks.post.mockImplementation(async()=>({data:{id:`00000000-0000-4000-8000-${String(++next).padStart(12,'0')}`,name:`photo-${next}.png`,mimeType:'image/png'}}));
    const {result}=renderHook(()=>useProductPhotos());await flush();
    const files=Array.from({length:8},(_,i)=>new File([new Uint8Array(1048576)],`photo-${i}.png`,{type:'image/png'}));
    await act(async()=>{await result.current.addFiles(files);});
    expect(mocks.post).toHaveBeenCalledTimes(8);expect(result.current.photos).toHaveLength(8);
    expect(new Set(result.current.photoIds).size).toBe(8);
    for(const [,body] of mocks.post.mock.calls)expect(Buffer.from(body.base64,'base64').length).toBe(1048576);
    await act(async()=>{await result.current.addFiles([file()]);});
    expect(mocks.post).toHaveBeenCalledTimes(8);expect(result.current.photos).toHaveLength(8);
    expect(result.current.error).toContain('не більше 8 фото');
  });
  it('keeps a valid photo and blocks only the oversized selection in a multiple-photo request',async()=>{
    mocks.post.mockResolvedValue({data:originalPhotos[0]});
    const {result}=renderHook(()=>useProductPhotos());await flush();
    await act(async()=>{await result.current.addFiles([file(),new File([new Uint8Array(1048577)],'too-large.png',{type:'image/png'})]);});
    expect(mocks.post).toHaveBeenCalledOnce();expect(result.current.photos).toHaveLength(1);
    expect(result.current.failedUploads).toHaveLength(1);expect(result.current.failedUploads[0].name).toBe('too-large.png');
    expect(result.current.hasPendingUploads).toBe(true);
  });
  it('explicit task resume adopts exact staged photo order without uploading or silently dropping expired originals',async()=>{
    const {result}=renderHook(()=>useProductPhotos());await flush();
    const photos=originalPhotos.map(photo=>({...photo,available:true,expiresAt:'2099-01-01T00:00:00.000Z'}));
    let accepted;act(()=>{accepted=result.current.restoreStaged(photos,true);});expect(accepted).toBe(true);
    expect(result.current.photoIds).toEqual(ids);expect(result.current.enableWhenVerified).toBe(true);expect(mocks.post).not.toHaveBeenCalled();
    act(()=>{accepted=result.current.restoreStaged([{...photos[0],expiresAt:'2000-01-01'}],false);});
    expect(accepted).toBe(false);expect(result.current.photoIds).toEqual(ids);expect(result.current.enableWhenVerified).toBe(true);
  });
  it('failed upload intent or revoked access prevents task resume from replacing the photo form',async()=>{
    mocks.post.mockRejectedValue(new Error('lost response'));const principalLifetime={valid:true};
    const wrapper=({children})=><AuthContext.Provider value={{principalLifetime}}>{children}</AuthContext.Provider>;
    const {result}=renderHook(()=>useProductPhotos(),{wrapper});await flush();
    await act(async()=>{await result.current.addFiles([file()]);});expect(result.current.failedUploads).toHaveLength(1);
    let accepted;act(()=>{accepted=result.current.restoreStaged([],false);});expect(accepted).toBe(false);
    expect(result.current.failedUploads).toHaveLength(1);principalLifetime.valid=false;
    act(()=>{accepted=result.current.restoreStaged([],false);});expect(accepted).toBe(false);
  });
  it('retries a lost stage response with the original key/content and never retries automatically',async()=>{
    mocks.post.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce({data:originalPhotos[0]});
    const {result}=renderHook(()=>useProductPhotos());await flush();
    await act(async()=>{await result.current.addFiles([file()]);});
    expect(mocks.post).toHaveBeenCalledTimes(1);expect(result.current.failedUploads).toHaveLength(1);
    expect(result.current.hasPendingUploads).toBe(true);expect(result.current.photos).toHaveLength(0);
    const first=mocks.post.mock.calls[0][1];
    await act(async()=>{await result.current.retryUploads();});
    expect(mocks.post).toHaveBeenCalledTimes(2);expect(mocks.post.mock.calls[1][1]).toEqual(first);
    expect(result.current.photos).toHaveLength(1);expect(result.current.failedUploads).toHaveLength(0);
  });
  it('drops late upload tokens when the application principal changes',async()=>{
    let resolve;const oldPrincipal={valid:true};let principal=oldPrincipal;
    const wrapper=({children})=><AuthContext.Provider value={{principalLifetime:principal}}>{children}</AuthContext.Provider>;
    mocks.post.mockImplementation(()=>new Promise((done)=>{resolve=done;}));
    const {result,rerender}=renderHook(()=>useProductPhotos(),{wrapper});await flush();
    let upload;act(()=>{upload=result.current.addFiles([file()]);});
    await vi.waitFor(()=>expect(mocks.post).toHaveBeenCalledTimes(1));
    oldPrincipal.valid=false;principal={valid:true};rerender();await flush();
    await act(async()=>{resolve({data:originalPhotos[0]});await upload;});
    expect(result.current.photos).toHaveLength(0);expect(result.current.failedUploads).toHaveLength(0);expect(result.current.busy).toBe(false);
  });
  it('polls without overlapping and displays stale status while preserving local edits',async()=>{
    vi.useFakeTimers();let reject;
    mocks.get.mockResolvedValueOnce({data:data('pending')}).mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));
    const {result}=renderHook(()=>useProductPhotos({productId:1}));await flush();
    act(()=>result.current.setEnableWhenVerified(false));
    await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
    expect(mocks.get).toHaveBeenCalledTimes(2);
    await act(async()=>{await vi.advanceTimersByTimeAsync(20000);});
    expect(mocks.get).toHaveBeenCalledTimes(2);
    await act(async()=>{reject(new Error('Read failed'));await Promise.resolve();});
    expect(result.current.error).toContain('останній відомий стан');
    mocks.get.mockResolvedValue({data:data('pending')});
    await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
    expect(result.current.enableWhenVerified).toBe(false);expect(result.current.dirty).toBe(true);expect(result.current.error).toBe('');
  });
  it('discard restores the loaded existing set synchronously without a reload',async()=>{
    mocks.get.mockResolvedValue({data:data()});
    const {result}=renderHook(()=>useProductPhotos({productId:1}));await flush();
    act(()=>result.current.removePhoto(ids[0]));expect(result.current.photos).toHaveLength(1);
    act(()=>result.current.reset());expect(result.current.photos).toEqual(originalPhotos);expect(result.current.version).toBe('4');
    expect(result.current.enableWhenVerified).toBe(true);expect(result.current.dirty).toBe(false);expect(mocks.get).toHaveBeenCalledTimes(1);
  });
  it('failed initial read leaves mutation controls unavailable',async()=>{
    mocks.get.mockRejectedValue(new Error('Read failed'));
    const {result}=renderHook(()=>useProductPhotos({productId:1}));await flush();
    expect(result.current.ready).toBe(false);expect(result.current.error).toContain('Read failed');
    await act(async()=>{await result.current.addFiles([file()]);await result.current.save();});
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it.each([{...data(),photos:undefined},{...data(),productId:2},{...data(),version:'invalid'}])('rejects malformed or different-product photo state',async(invalid)=>{
    mocks.get.mockResolvedValue({data:invalid});
    const {result}=renderHook(()=>useProductPhotos({productId:1}));await flush();
    expect(result.current.ready).toBe(false);expect(result.current.photos).toEqual([]);expect(result.current.error).toContain('некоректний стан');
    await act(async()=>{await result.current.addFiles([file()]);});expect(mocks.post).not.toHaveBeenCalled();
  });
  it('keeps failed selections blocked when permission is revoked and shows the creation reason',async()=>{
    mocks.post.mockRejectedValue(new Error('Connection lost'));
    const {result,rerender}=renderHook(({canEdit})=>useProductPhotos({canEdit}),{initialProps:{canEdit:true}});await flush();
    await act(async()=>{await result.current.addFiles([file()]);});
    const failed=result.current.failedUploads[0];rerender({canEdit:false});
    act(()=>result.current.discardFailed(failed.key));
    await act(async()=>{await result.current.retryUploads();});
    expect(result.current.failedUploads).toHaveLength(1);expect(result.current.hasPendingUploads).toBe(true);expect(mocks.post).toHaveBeenCalledTimes(1);
    render(<ProductPhotos controller={result.current} canEdit={false}/>);
    expect(screen.getByText(/Створити товар можна після повторного збереження/)).toBeTruthy();
    expect(screen.getByRole('button',{name:'Повторити збереження цих фото'}).disabled).toBe(true);
    expect(screen.getByRole('button',{name:'Прибрати зі спроби'}).disabled).toBe(true);
  });
  it.each([{busy:true},{loading:true},{ready:false}])('locks retry and discard while controls are unavailable',async(lock)=>{
    const retryUploads=vi.fn();const discardFailed=vi.fn();
    const controller={photos:[],failedUploads:[{key:'failed',name:'camera.png'}],retryUploads,discardFailed,...lock};
    render(<ProductPhotos controller={controller}/>);
    fireEvent.click(screen.getByRole('button',{name:'Повторити збереження цих фото'}));
    fireEvent.click(screen.getByRole('button',{name:'Прибрати зі спроби'}));
    expect(retryUploads).not.toHaveBeenCalled();expect(discardFailed).not.toHaveBeenCalled();
  });
  it('offers a full checkbox-label target and consistently sized action controls',()=>{
    const controller={photos:[originalPhotos[0]],contentUrl:()=>'/api/photo',failedUploads:[],enableWhenVerified:true,setEnableWhenVerified:vi.fn()};
    render(<ProductPhotos controller={controller}/>);
    const checkbox=screen.getByRole('checkbox',{name:'Увімкнути товар у Magento після перевірки всіх фото'});
    expect(checkbox.closest('label').style.minHeight).toBe('34px');
    for(const button of screen.getAllByRole('button')){expect(button.style.minHeight).toBe('34px');expect(button.className).toContain('btn btn-outline');}
  });
});
