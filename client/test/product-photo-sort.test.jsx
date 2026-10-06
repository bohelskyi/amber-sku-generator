import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProductPhotos } from '../src/components/app/ProductPhotos.jsx';
import { useProductPhotos } from '../src/hooks/useProductPhotos.js';
const mocks = vi.hoisted(() => ({get:vi.fn(),post:vi.fn(),defaults:{baseURL:'/api'}}));
vi.mock('../src/lib/api.js',()=>({api:mocks}));
const photos=[1,2,3].map(n=>({id:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,name:`photo-${n}.png`,mimeType:'image/png',available:true,expiresAt:'2099-01-01'}));
const controller=(extra={})=>({photos,failedUploads:[],contentUrl:()=>'/fixture.png',reorderPhotos:vi.fn(),removePhoto:vi.fn(),...extra});
const names=()=>screen.getAllByRole('img').map(img=>img.alt);
beforeEach(()=>{
 mocks.post.mockReset(); mocks.get.mockReset();
 class Pointer extends MouseEvent { constructor(type,props){super(type,props);Object.defineProperties(this,{pointerId:{value:props.pointerId},pointerType:{value:props.pointerType || 'mouse'},isPrimary:{value:true}});} }
 vi.stubGlobal('PointerEvent',Pointer);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('keyboard preview commits exact IDs once; first item becomes primary without duplicating IDs',()=>{
 const p=controller();render(<ProductPhotos controller={p}/>);const handle=screen.getByRole('button',{name:'Перемістити photo-3.png'});
 fireEvent.keyDown(handle,{key:' '});fireEvent.keyDown(handle,{key:'ArrowLeft'});fireEvent.keyDown(handle,{key:'ArrowUp'});
 expect(names()).toEqual(['photo-3.png','photo-1.png','photo-2.png']);expect(p.reorderPhotos).not.toHaveBeenCalled();
 expect(screen.getByText('Головне').closest('li').dataset.photoId).toBe(photos[2].id);
 fireEvent.keyDown(handle,{key:'Enter'});expect(p.reorderPhotos).toHaveBeenCalledExactlyOnceWith([photos[2].id,photos[0].id,photos[1].id]);
});
it('Escape and keyboard blur cancel without dirtying the authoritative order',()=>{
 const p=controller();render(<ProductPhotos controller={p}/>);const handle=screen.getByRole('button',{name:'Перемістити photo-2.png'});
 for(const end of ['escape','blur']){fireEvent.keyDown(handle,{key:' '});fireEvent.keyDown(handle,{key:'ArrowLeft'});if(end==='escape')fireEvent.keyDown(handle,{key:'Escape'});else fireEvent.blur(handle,{relatedTarget:document.body});expect(names()).toEqual(photos.map(p=>p.name));}
 expect(p.reorderPhotos).not.toHaveBeenCalled();
});
function boxes(){for(const [index,card] of [...document.querySelectorAll('li[data-photo-id]')].entries())vi.spyOn(card,'getBoundingClientRect').mockReturnValue({left:index*180,top:0,width:160,height:200});}
it.each(['mouse','touch'])('%s drag commits only on release; removal is locked during the gesture',pointerType=>{
 const p=controller();render(<ProductPhotos controller={p}/>);boxes();const handle=screen.getByRole('button',{name:'Перемістити photo-1.png'});
 fireEvent.pointerDown(handle,{pointerId:4,pointerType,button:0,clientX:40,clientY:100});
 fireEvent.pointerMove(handle,{pointerId:4,pointerType,clientX:420,clientY:100});
 expect(screen.getByRole('button',{name:'Прибрати photo-1.png'}).disabled).toBe(true);
 expect(p.reorderPhotos).not.toHaveBeenCalled();fireEvent.pointerUp(handle,{pointerId:4,pointerType});
 expect(p.reorderPhotos).toHaveBeenCalledExactlyOnceWith([photos[1].id,photos[2].id,photos[0].id]);expect(p.removePhoto).not.toHaveBeenCalled();
});
it.each(['pointerCancel','lostPointerCapture'])('canceled %s restores the original gallery and makes no write',event=>{
 const p=controller();render(<ProductPhotos controller={p}/>);boxes();const handle=screen.getByRole('button',{name:'Перемістити photo-1.png'});
 fireEvent.pointerDown(handle,{pointerId:1,button:0,clientX:40,clientY:100});fireEvent.pointerMove(handle,{pointerId:1,clientX:420,clientY:100});fireEvent[event](handle,{pointerId:1});
 expect(names()).toEqual(photos.map(p=>p.name));expect(p.reorderPhotos).not.toHaveBeenCalled();
});
it('a click below the drag threshold and a non-primary button do not reorder',()=>{
 const p=controller();render(<ProductPhotos controller={p}/>);const handle=screen.getByRole('button',{name:'Перемістити photo-1.png'});
 fireEvent.pointerDown(handle,{pointerId:1,button:0,clientX:40,clientY:100});fireEvent.pointerMove(handle,{pointerId:1,clientX:42,clientY:101});fireEvent.pointerUp(handle,{pointerId:1});
 fireEvent.pointerDown(handle,{pointerId:2,button:2});fireEvent.pointerUp(handle,{pointerId:2});expect(p.reorderPhotos).not.toHaveBeenCalled();
});
it('a permission lock or an upload replacing the set cancels a stale keyboard commit',()=>{
 const p=controller();const view=render(<ProductPhotos controller={p}/>);const handle=screen.getByRole('button',{name:'Перемістити photo-1.png'});
 fireEvent.keyDown(handle,{key:' '});fireEvent.keyDown(handle,{key:'ArrowRight'});view.rerender(<ProductPhotos controller={{...p,busy:true}}/>);fireEvent.keyDown(handle,{key:'Enter'});expect(p.reorderPhotos).not.toHaveBeenCalled();
 view.rerender(<ProductPhotos controller={{...p,photos:photos.slice(0,2)}}/>);fireEvent.keyDown(handle,{key:'Enter'});expect(p.reorderPhotos).not.toHaveBeenCalled();
});
it('valid reorder preserves failed upload intent and retry key; removing first promotes the next stable ID',async()=>{
 const {result}=renderHook(()=>useProductPhotos());await act(async()=>{await Promise.resolve();await Promise.resolve();});
 act(()=>result.current.restoreStaged(photos,false));mocks.post.mockRejectedValueOnce(new Error('lost reply'));
 await act(async()=>{await result.current.addFiles([new File([new Uint8Array(68)],'retry.png',{type:'image/png'})]);});
 const attempt=mocks.post.mock.calls[0][1];act(()=>result.current.reorderPhotos([photos[2].id,photos[0].id,photos[1].id]));expect(result.current.photoIds).toEqual([photos[2].id,photos[0].id,photos[1].id]);expect(result.current.failedUploads).toHaveLength(1);expect(result.current.dirty).toBe(true);
 act(()=>result.current.reorderPhotos([photos[0].id,photos[0].id,photos[2].id]));expect(new Set(result.current.photoIds).size).toBe(3);
 act(()=>result.current.removePhoto(photos[2].id));expect(result.current.creationPayload.photoIds[0]).toBe(photos[0].id);
 mocks.post.mockResolvedValueOnce({data:{id:'00000000-0000-4000-8000-000000000004',name:'retry.png',mimeType:'image/png'}});
 await act(async()=>{await result.current.retryUploads();});expect(mocks.post.mock.calls[1][1]).toEqual(attempt);expect(result.current.photoIds).toEqual([photos[0].id,photos[1].id,'00000000-0000-4000-8000-000000000004']);
});
