import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { ProductRegister } from '../src/components/app/ProductRegister.jsx';
import { productsApi } from '../src/api/products-api.js';

vi.mock('../src/api/products-api.js', () => ({ productsApi: { listRegister: vi.fn() } }));

const response = (items, pageInfo = { hasMore: false, nextCursor: null }) => ({
  data: {
    items,
    pageInfo,
    filterOptions: { categories: [{ code: 'BR', name: 'Браслети' }] },
  },
});
const product = (id, overrides = {}) => ({
  id,
  publicSku: `AG-${String(id).padStart(6, '0')}`,
  internalSku: `BR-INTERNAL-${id}`,
  categoryCode: 'BR',
  categoryName: 'Браслети',
  status: 'active',
  weight: '3.2',
  priceUah: '1200',
  ...overrides,
});

function mount(path = '/products') {
  const router = createMemoryRouter([{ path: '*', element: <ProductRegister /> }], { initialEntries: [path] });
  return { router, ...render(<RouterProvider router={router} />) };
}

beforeEach(() => {
  productsApi.listRegister.mockReset().mockResolvedValue(response([]));
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps one bounded page in the DOM while moving through keyset results', async () => {
  const firstPage = Array.from({ length: 50 }, (_, index) => product(100 - index));
  productsApi.listRegister
    .mockResolvedValueOnce(response(firstPage, { hasMore: true, nextCursor: 'next-50' }))
    .mockResolvedValueOnce(response([product(50)]));
  mount();

  await screen.findByText('AG-000100');
  expect(screen.getAllByRole('row')).toHaveLength(51);
  fireEvent.click(screen.getByRole('button', { name: 'Далі' }));
  await screen.findByText('AG-000050');
  await waitFor(() => expect(screen.queryByText('AG-000100')).toBeNull());
  expect(screen.getAllByRole('row')).toHaveLength(2);
  expect(productsApi.listRegister).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'next-50', limit: 50 }));
});

it('shows public identity, preserves missing price, and opens historical evidence by exact internal SKU', async () => {
  const historical = product(21, { publicSku: 'AG-000021', internalSku: 'BR/CORRECTED-21', status: 'corrected', priceUah: null });
  productsApi.listRegister.mockResolvedValue(response([historical]));
  mount('/products?lifecycle=corrected');

  const article = await screen.findByText('AG-000021');
  const row = article.closest('tr');
  expect(within(row).getByText('—')).toBeTruthy();
  expect(row.textContent).not.toContain('BR/CORRECTED-21');
  expect(screen.getByRole('link', { name: 'Відкрити історію товару AG-000021' }).getAttribute('href'))
    .toBe('/products/history?sku=BR%2FCORRECTED-21');
  expect(productsApi.listRegister).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: 'corrected' }));
});

it('keeps search and filters in the address so browser Back restores the register', async () => {
  const { router } = mount();
  await waitFor(() => expect(productsApi.listRegister).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByPlaceholderText('Артикул або внутрішній SKU'), { target: { value: 'AG-000021' } });
  fireEvent.click(screen.getByRole('button', { name: 'Знайти' }));
  await waitFor(() => expect(router.state.location.search).toBe('?search=AG-000021'));
  await waitFor(() => expect(productsApi.listRegister).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'AG-000021' })));

  await router.navigate(-1);
  await waitFor(() => expect(screen.getByPlaceholderText('Артикул або внутрішній SKU').value).toBe(''));
  expect(router.state.location.search).toBe('');
});

it('returns from an opened product to the reviewed filter and cursor page', async () => {
  productsApi.listRegister
    .mockResolvedValueOnce(response([product(22)], { hasMore: true, nextCursor: 'filtered-next' }))
    .mockResolvedValueOnce(response([product(21)]))
    .mockResolvedValueOnce(response([product(21)]));
  const router = createMemoryRouter([
    { path: '/products', element: <ProductRegister /> },
    { path: '/products/open', element: <h1>Відкритий товар</h1> },
  ], { initialEntries: ['/products?search=AG-'] });
  render(<RouterProvider router={router} />);

  await screen.findByText('AG-000022');
  fireEvent.click(screen.getByRole('button', { name: 'Далі' }));
  await screen.findByText('AG-000021');
  expect(router.state.location.search).toContain('search=AG-');
  expect(router.state.location.search).toContain('cursor=filtered-next');
  expect(router.state.location.search).toContain('page=2');
  fireEvent.click(screen.getByRole('link', { name: 'Відкрити товар AG-000021' }));
  await screen.findByRole('heading', { name: 'Відкритий товар' });

  await router.navigate(-1);
  await screen.findByText('AG-000021');
  expect(screen.getByText('Сторінка 2')).toBeTruthy();
  expect(productsApi.listRegister).toHaveBeenLastCalledWith(expect.objectContaining({
    cursor: 'filtered-next', search: 'AG-', limit: 50,
  }));
});

it('archived TEST cleanup opens exact review only when an authorized callback is supplied, retaining the native history link',async()=>{
  const selected=product(5012,{publicSku:'TEST-000001',internalSku:null,status:'archived',isTestProduct:true});
  productsApi.listRegister.mockResolvedValue(response([selected]));const onDeleteArchivedTest=vi.fn();
  const router=createMemoryRouter([{path:'*',element:<ProductRegister onDeleteArchivedTest={onDeleteArchivedTest}/>}],{initialEntries:['/products?lifecycle=archived']});
  render(<RouterProvider router={router}/>);
  const action=await screen.findByRole('button',{name:'Перевірити видалення TEST TEST-000001 з Magento'});
  expect(onDeleteArchivedTest).not.toHaveBeenCalled();
  expect(screen.getByRole('link',{name:'Відкрити історію товару TEST-000001'}).getAttribute('href')).toBe('/products/history?sku=TEST-000001');
  fireEvent.click(action);expect(onDeleteArchivedTest).toHaveBeenCalledExactlyOnceWith(selected);
});

it('archived ordinary products and unproved TEST-looking identities cannot expose remote cleanup',async()=>{
  productsApi.listRegister.mockResolvedValue(response([product(1,{status:'archived'}),product(2,{publicSku:'TEST-000002',status:'archived',isTestProduct:false})]));
  const router=createMemoryRouter([{path:'*',element:<ProductRegister onDeleteArchivedTest={vi.fn()}/>}],{initialEntries:['/products?lifecycle=archived']});
  render(<RouterProvider router={router}/>);await screen.findByText('TEST-000002');
  expect(screen.queryByRole('button',{name:/Перевірити видалення TEST/})).toBeNull();
  cleanup();productsApi.listRegister.mockResolvedValue(response([product(3,{publicSku:'TEST-000003',status:'archived',isTestProduct:true})]));
  mount('/products?lifecycle=archived');await screen.findByText('TEST-000003');
  expect(screen.queryByRole('button',{name:/Перевірити видалення TEST/})).toBeNull();
});
