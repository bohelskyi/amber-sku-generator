import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { TestProductDeletion } from '../src/components/app/TestProductDeletion.jsx';
import { HistoryTable } from '../src/components/app/HistoryTable.jsx';
import { productsApi } from '../src/api/products-api.js';
import AppPage from '../src/pages/AppPage.jsx';
import { useSkuManager } from '../src/hooks/useSkuManager.js';
vi.mock('../src/hooks/useSkuManager.js',()=>({useSkuManager:vi.fn()}));
let authState;
vi.mock('../src/auth/auth-context.js', async (importOriginal) => ({
  ...await importOriginal(), useAuth: () => authState,
}));
vi.mock('../src/components/app/HomeDashboard.jsx',()=>({HomeDashboard:({canDeleteTestProduct,onDeleteTest})=>(
  canDeleteTestProduct ? <button type="button" onClick={onDeleteTest}>Open test deletion</button> : null
)}));
vi.mock('../src/api/products-api.js',()=>({productsApi:{previewTestDeletion:vi.fn(),applyTestDeletion:vi.fn()}}));
const product={id:12,public_sku:'AG-000123',full_sku:'ZZ-INTERNAL',status:'active',category:'ZZ'};
const preview={productId:12,publicSku:product.public_sku,previewHash:'reviewed',state:'preview'};
beforeEach(()=>{
  vi.resetAllMocks();
  authState={permissions:['products.view','history.view','products.delete_test'],roles:[{key:'administrator'}]};
  productsApi.previewTestDeletion.mockResolvedValue({data:preview});
});
afterEach(cleanup);
it('requires eligibility and exact public SKU confirmation then refreshes after verified completion',async()=>{
  const done=vi.fn();const close=vi.fn();productsApi.applyTestDeletion.mockResolvedValue({data:{state:'finalized'}});
  render(<TestProductDeletion product={product} onDeleted={done} onClose={close}/>);
  expect(screen.getByText(/технічний запис і журнал аудиту/)).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByText('Перевірити можливість видалення'));
  const input=await screen.findByRole('textbox');const apply=screen.getByText('Назавжди видалити з Magento');
  fireEvent.change(input,{target:{value:product.full_sku}});expect(apply.disabled).toBe(true);
  fireEvent.change(input,{target:{value:product.public_sku}});fireEvent.click(apply);
  await waitFor(()=>expect(done).toHaveBeenCalledTimes(1));expect(close).toHaveBeenCalledTimes(1);
  expect(productsApi.applyTestDeletion).toHaveBeenCalledWith({productId:12,previewHash:'reviewed',confirmation:product.public_sku});
});
it('uncertainty keeps the product visible and reuses the sealed intent for read-only recovery',async()=>{
  const done=vi.fn();productsApi.applyTestDeletion.mockResolvedValue({data:{state:'dispatched',reconciliationRequired:true}});
  render(<TestProductDeletion product={product} onDeleted={done} onClose={vi.fn()}/>);
  fireEvent.click(screen.getByText('Перевірити можливість видалення'));
  fireEvent.change(await screen.findByRole('textbox'),{target:{value:product.public_sku}});
  fireEvent.click(screen.getByText('Назавжди видалити з Magento'));
  expect(await screen.findByRole('status')).toBeTruthy();expect(done).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Перевірити результат видалення'));
  await waitFor(()=>expect(productsApi.applyTestDeletion).toHaveBeenCalledTimes(2));
  expect(productsApi.applyTestDeletion.mock.calls[0]).toEqual(productsApi.applyTestDeletion.mock.calls[1]);
});
it('ordinary archive remains separate and no delete-test action is shown without permission callback',()=>{
  const archive=vi.fn();const props={history:[product],config:{categories:{}},onDelete:archive};
  const view=render(<MemoryRouter><HistoryTable {...props}/></MemoryRouter>);
  expect(screen.queryByText('Видалити тестовий товар')).toBeNull();fireEvent.click(screen.getByText('Архівувати'));
  expect(archive).toHaveBeenCalledWith(product.full_sku);
  view.rerender(<MemoryRouter><HistoryTable {...props} onDeleteTest={vi.fn()}/></MemoryRouter>);
  expect(screen.getByText('Видалити тестовий товар')).toBeTruthy();
});
it('shows test deletion only to an actual Administrator and retains the authoritative final receipt',async()=>{
  const clearDecode=vi.fn();
  useSkuManager.mockReturnValue({
    answers:{},config:{categories:{}},decodeData:{existsInDb:true,publicSku:product.public_sku,sku:product.full_sku,
      internalSku:product.full_sku,product},handleCancelRecount:vi.fn(),handleDecodeInputChange:clearDecode,
    isDecodeLoading:false,nameSubjects:{},resetProductFlow:vi.fn(),savedProduct:{publicSku:product.public_sku},
    selectedCat:null,
  });
  productsApi.applyTestDeletion.mockResolvedValue({data:{state:'finalized',publicSku:product.public_sku,internalSku:product.full_sku}});
  const router=createMemoryRouter([{path:'*',element:<AppPage/>}],{initialEntries:['/products/open?article='+product.public_sku]});
  const view=render(<RouterProvider router={router}/>);
  expect(screen.getByText(/Товар збережено/)).toBeTruthy();
  fireEvent.click(screen.getByText('Open test deletion'));
  fireEvent.click(screen.getByText('Перевірити можливість видалення'));
  fireEvent.change(await screen.findByRole('textbox'),{target:{value:product.public_sku}});
  fireEvent.click(screen.getByText('Назавжди видалити з Magento'));
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.queryByText(/Товар збережено/)).toBeNull();
  expect(screen.getByText(/Видалення тестового товару підтверджено/)).toBeTruthy();
  expect(screen.getByText(/Видалення з Magento перевірено/)).toBeTruthy();
  expect(screen.queryByText('Стан операції: finalized')).toBeNull();
  fireEvent.click(screen.getByText('Технічні деталі'));
  expect(screen.getByText('Стан операції: finalized')).toBeTruthy();
  expect(clearDecode).toHaveBeenCalledWith('');

  view.unmount();
  authState={...authState,roles:[{key:'manager'}]};
  const deniedRouter=createMemoryRouter([{path:'*',element:<AppPage/>}],{initialEntries:['/products']});
  const denied=render(<RouterProvider router={deniedRouter}/>);
  expect(screen.queryByText('Open test deletion')).toBeNull();
  denied.unmount();
});

it('archived TEST review promises retained archive and reads nothing until explicit preview',()=>{
  render(<TestProductDeletion product={{...product,public_sku:'TEST-000001',status:'archived'}} onDeleted={vi.fn()} onClose={vi.fn()}/>);
  expect(screen.getByText('Архівований TEST запис, фотографії та історія перевірок залишаться в Manager.')).toBeTruthy();
  expect(productsApi.previewTestDeletion).not.toHaveBeenCalled();expect(productsApi.applyTestDeletion).not.toHaveBeenCalled();
});
