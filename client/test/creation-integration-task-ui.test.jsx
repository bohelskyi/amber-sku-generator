import React from 'react';
import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {AuthContext} from '../src/auth/auth-context.js';
import {useCreationIntegrationTask} from '../src/hooks/useCreationIntegrationTask.js';
const calls=vi.hoisted(()=>({post:vi.fn(),get:vi.fn()}));
vi.mock('../src/lib/api.js',()=>({api:calls}));
const id='11111111-1111-4111-8111-111111111111';
const dto={id,state:'open',revision:'1',deliveryAccepted:false};
const product={categoryCode:'NM',answers:{extra:1},weight:1,photoIds:['22222222-2222-4222-8222-222222222222']};
const base={available:true,canCreate:true,busy:false,product,previewData:{previewToken:'a'.repeat(64),creationDeliveryReadiness:{status:'configuration_required'}}};
beforeEach(()=>{calls.post.mockReset();calls.get.mockReset();});afterEach(cleanup);
describe('durable integration task creation',()=>{
  it('captures current fields/photos and accepts only the actual durable task receipt',async()=>{
    calls.post.mockResolvedValue({data:dto});
    const {result}=renderHook(()=>useCreationIntegrationTask(base));
    await act(async()=>{await result.current.onRequestIntegration();});
    const command=calls.post.mock.calls[0][1];
    expect(command.product).toEqual(product);expect(command.clientRequestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(command).not.toHaveProperty('readiness');
    expect(result.current.requestReceipt).toMatchObject({taskId:id,state:'open',href:'/attention?integrationTask='+id});
    expect(product.photoIds).toHaveLength(1);expect(product.answers.extra).toBe(1);
  });
  it('unknown acceptance and GET404 remain sticky and never resubmit POST',async()=>{
    calls.post.mockRejectedValue(new Error('connection lost'));
    calls.get.mockRejectedValueOnce({response:{status:404,data:{code:'INTEGRATION_TASK_ATTEMPT_NOT_FOUND',error:'not found'}}}).mockResolvedValueOnce({data:dto});
    const {result}=renderHook(()=>useCreationIntegrationTask(base));
    await act(async()=>{await result.current.onRequestIntegration();});
    const command=calls.post.mock.calls[0][1];
    await act(async()=>{await result.current.onRequestIntegration();});
    expect(result.current.requestReceipt).toBeNull();expect(result.current.integrationTaskError).toMatch(/не підтверджено/);
    await act(async()=>{await result.current.onRequestIntegration();});
    expect(calls.post).toHaveBeenCalledTimes(1);expect(calls.get).toHaveBeenCalledTimes(2);
    expect(calls.get.mock.calls[0][0]).toBe('/integration-tasks/attempts/'+command.clientRequestId);
    expect(result.current.requestReceipt.taskId).toBe(id);
  });
  it('malformed success is recovered using GET only rather than a fake success toast',async()=>{
    calls.post.mockResolvedValue({data:{...dto,deliveryAccepted:true}});calls.get.mockResolvedValue({data:dto});
    const {result}=renderHook(()=>useCreationIntegrationTask(base));
    await act(async()=>{await result.current.onRequestIntegration();});expect(result.current.requestReceipt).toBeNull();
    await act(async()=>{await result.current.onRequestIntegration();});expect(calls.post).toHaveBeenCalledTimes(1);
    expect(result.current.requestReceipt.taskId).toBe(id);
  });
  it('pending photos and revoked creation permission cannot send a partial task',async()=>{
    const {result,rerender}=renderHook(props=>useCreationIntegrationTask(props),{initialProps:{...base,busy:true}});
    await act(async()=>{await result.current.onRequestIntegration();});expect(calls.post).not.toHaveBeenCalled();
    rerender({...base,canCreate:false});expect(result.current.onRequestIntegration).toBeUndefined();
  });
  it('confirmed preacceptance errors permit an explicit fresh command',async()=>{
    calls.post.mockRejectedValueOnce({response:{status:409,data:{code:'INTEGRATION_TASK_PREVIEW_STALE',error:'Refresh'}}}).mockResolvedValueOnce({data:dto});
    const {result}=renderHook(()=>useCreationIntegrationTask(base));
    await act(async()=>{await result.current.onRequestIntegration();});
    await act(async()=>{await result.current.onRequestIntegration();});
    expect(calls.post).toHaveBeenCalledTimes(2);expect(calls.get).not.toHaveBeenCalled();
    expect(calls.post.mock.calls[1][1].clientRequestId).not.toBe(calls.post.mock.calls[0][1].clientRequestId);
  });
  it('changed inputs while recovering retain the frozen attempt and current photo form',async()=>{
    calls.post.mockRejectedValue(new Error('lost'));calls.get.mockResolvedValue({data:dto});
    const {result,rerender}=renderHook(props=>useCreationIntegrationTask(props),{initialProps:base});
    await act(async()=>{await result.current.onRequestIntegration();});
    const changed={...base,product:{...product,answers:{extra:2}}};rerender(changed);
    await act(async()=>{await result.current.onRequestIntegration();});
    expect(calls.post).toHaveBeenCalledTimes(1);expect(result.current.requestReceipt).toBeNull();
    expect(result.current.integrationTaskError).toMatch(/поточні дані|Поточні дані/);expect(changed.product.photoIds).toEqual(product.photoIds);
  });
  it('late replies cannot cross principal revocation or unmount',async()=>{
    let release;calls.post.mockReturnValue(new Promise(resolve=>{release=resolve;}));const principalLifetime={valid:true};
    const wrapper=({children})=><AuthContext.Provider value={{principalLifetime}}>{children}</AuthContext.Provider>;
    const {result}=renderHook(()=>useCreationIntegrationTask(base),{wrapper});
    let pending;act(()=>{pending=result.current.onRequestIntegration();});await waitFor(()=>expect(calls.post).toHaveBeenCalledOnce());
    principalLifetime.valid=false;await act(async()=>{release({data:dto});await pending;});
    expect(result.current.requestReceipt).toBeNull();
  });
});
