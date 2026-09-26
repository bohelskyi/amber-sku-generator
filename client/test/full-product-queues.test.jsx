import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FullProductQueues } from '../src/components/exports/FullProductQueues';
import { exportsApi } from '../src/api/exports-api';
vi.mock('../src/api/exports-api',()=>({exportsApi:{getQueue:vi.fn()}}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
const lifecycle={phase:'active',counts:{firstDelivery:44,fullUpdate:1,replacementReady:1,held:1037}};
it('updates use one SKU; replacement keeps reviewed identity/version; holds offer no export action',async()=>{
  exportsApi.getQueue.mockImplementation(({queue})=>Promise.resolve({data:{items:[{id:7,full_sku:'SV7',delivery_version:'8',hold_reason:'prior_exposure'}],next:null,queue}}));
  const onPreview=vi.fn();render(<FullProductQueues lifecycle={lifecycle} onPreview={onPreview} />);
  fireEvent.click(await screen.findByRole('button',{name:'Перевірити товар'}));
  expect(onPreview).toHaveBeenLastCalledWith({fromSku:'SV7',toSku:'SV7'});
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'replacement'}});
  fireEvent.click(await screen.findByRole('button',{name:'Перевірити товар'}));
  expect(onPreview).toHaveBeenLastCalledWith({mode:'replacement',productId:7,deliveryVersion:'8'});
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'hold'}});
  await screen.findByText('Потрібна звірка попередніх файлів і SKU');
  expect(screen.queryByRole('button',{name:'Перевірити товар'})).toBeNull();
});
it('switching queues drops stale responses and pending creates disable export actions',async()=>{
  let resolve;exportsApi.getQueue.mockReturnValueOnce(new Promise(r=>{resolve=r;}))
    .mockResolvedValue({data:{items:[{id:9,full_sku:'SV9',delivery_version:'2'}],next:null}});
  render(<FullProductQueues lifecycle={lifecycle} disabled onPreview={vi.fn()} />);
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'replacement'}});
  expect((await screen.findByRole('button',{name:'Перевірити товар'})).disabled).toBe(true);
  resolve({data:{items:[{id:1,full_sku:'STALE'}],next:null}});
  await waitFor(()=>expect(screen.queryByText('STALE')).toBeNull());
});
