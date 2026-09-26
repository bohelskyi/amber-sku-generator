import { useEffect, useState } from 'react';
import { createRequire } from 'node:module';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DefinitionEditor } from '../src/components/export-templates/DefinitionEditor';
import { SampleProducts } from '../src/components/export-templates/SampleProducts';
import { PreviewTable } from '../src/components/export-templates/PreviewTable';
const require = createRequire(import.meta.url);
const { materializeMagentoV1 } = require('../../server/src/services/export-templates/magento-v1-definition');
const { officeCatalog, officeEvidence } = require('../../server/test/fixtures/magento-v1/office');
const { validateSourceReferences } = require('../../server/src/services/export-templates/source-references');
const { hashJsonData } = require('../../server/src/services/export-templates/definition');
afterEach(cleanup);
let current;
const details = { current: [{ label: 'Додатково', include_in_sku: 1, options: [{ value_id: '1', label: 'Назва з каталогу', sku_code: '99' }] }], historical: [], truncated: false };
function Editor({ loadSource = vi.fn().mockResolvedValue({ data: details }), initial }) {
  const [definition, setDefinition] = useState(() => initial || materializeMagentoV1(officeCatalog()));
  useEffect(() => { current = definition; }, [definition]);
  return <DefinitionEditor definition={definition} onChange={setDefinition} loadSource={loadSource} diagnostics={validateSourceReferences(definition, officeEvidence())} />;
}
const field = (code) => fireEvent.click(screen.getByRole('button', { name: 'Налаштувати колонку ' + code, exact: true }));
it('normal NM controls expose exact zero/empty mappings with verified labels, local changes and frozen diagnostics', async () => {
  render(<Editor />); const hash = hashJsonData(current);
  fireEvent.click(screen.getByRole('tab', { name: 'Намиста' })); field('dodatkovo_namysta');
  const panel = screen.getByRole('region', { name: 'Редактор поля' });
  expect(within(panel).getByLabelText('Значення у CSV: Значення №0 — назву не підтверджено').value).toBe('');
  expect(within(panel).getByText('Порожня клітинка')).toBeTruthy();
  await screen.findByText('Назва з каталогу');
  expect(within(panel).getByText('Значення №0 — назву не підтверджено')).toBeTruthy();
  expect(screen.queryByText('Непідтверджені value_id: 0')).toBeNull();
  expect(screen.getByText('Джерело потрібно перевірити перед публікацією.')).toBeTruthy();
  expect(hashJsonData(current)).toBe(hash);
  const frozen = structuredClone(current.questionContracts); const original = structuredClone(current);
  fireEvent.change(screen.getByLabelText('Значення у CSV: Назва з каталогу'), { target: { value: 'Локальний текст' } }); fireEvent.click(screen.getByRole('button', { name: 'Застосувати до чернетки' })); field('dodatkovo_namysta');
  expect(current.questionContracts).toEqual(frozen); expect(current.groups.slice(2)).toEqual(original.groups.slice(2));
  expect(current.tables.nmExtra['0']).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Технічні подробиці', exact: true }));
  expect(await screen.findByText('Поточний каталог')).toBeTruthy(); expect(screen.getByText('Історичні SKU-схеми')).toBeTruthy();
  expect(screen.queryByLabelText('Спільне правило')).toBeNull();
});
it('normal AR size shows mappings, absent 29/30/31 and source failures without the advanced tree', async () => {
  const read = vi.fn().mockRejectedValue({ response: { status: 403, data: { error: 'Немає дозволу' } } }); render(<Editor loadSource={read} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Картини' })); field('rozmir_kartyny');
  expect(screen.getByLabelText('Значення у CSV: Значення №1 — назву не підтверджено').value).toBe('10×15');
  expect(screen.queryByText('Непідтверджені value_id: 29, 30, 31')).toBeNull();
  expect(screen.getByText('Джерело потрібно перевірити перед публікацією.')).toBeTruthy();
  expect(screen.getAllByText('Відповідності немає')).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: 'Технічні подробиці', exact: true })); await screen.findByText(/Не вдалося прочитати джерело/);
  expect(screen.getByText('Непідтверджені value_id: 29, 30, 31')).toBeTruthy();
  expect(screen.queryByLabelText('Спільне правило')).toBeNull();
});
it('SKU selection deduplicates, supports pages and rejects late/cancelled search responses', async () => {
  let resolve; const late = new Promise((r) => { resolve = r; });
  const search = vi.fn().mockReturnValueOnce(late).mockResolvedValue({ data: { products: [{ id: 21, full_sku: 'BR2/EXACT-001', category: 'BR', status: 'active' }], nextOffset: 20 } });
  function Picker() { const [selected, setSelected] = useState([]); return <SampleProducts search={search} selected={selected} onChange={setSelected} />; }
  render(<Picker />);
  fireEvent.change(screen.getByLabelText('Пошук за SKU'), { target: { value: 'OLD' } }); await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText('Пошук за SKU'), { target: { value: 'BR2/EXACT-001' } });
  expect(search.mock.calls[0][1].aborted).toBe(true);
  await screen.findByRole('button', { name: 'Обрати BR2/EXACT-001' });
  resolve({ data: { products: [{ id: 99, full_sku: 'OLD', category: 'AR' }], nextOffset: null } });
  fireEvent.click(screen.getByRole('button', { name: 'Обрати BR2/EXACT-001' }));
  expect(screen.getByRole('button', { name: 'Обрати BR2/EXACT-001' }).disabled).toBe(true);
  expect(screen.getByText('Вибрано: 1 / 100')).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Обрати OLD' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Наступні товари' })); await waitFor(() => expect(search).toHaveBeenLastCalledWith({ q: 'BR2/EXACT-001', offset: 20 }, expect.any(AbortSignal)));
});
it('SKU selection keeps limit and permission errors; table preserves quoted comma/newline values', async () => {
  const search = vi.fn().mockResolvedValueOnce({ data: { products: [{ id: 101, full_sku: 'BR-LIMIT', category: 'BR', status: 'active' }], nextOffset: null } })
    .mockRejectedValue({ response: { status: 403, data: { error: 'Немає дозволу' } } });
  const view = render(<SampleProducts search={search} selected={Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }))} onChange={vi.fn()} />);
  expect(screen.getByText('Вибрано: 100 / 100')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Пошук за SKU'), { target: { value: 'BR' } });
  expect((await screen.findByRole('button', { name: 'Обрати BR-LIMIT' })).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Пошук за SKU'), { target: { value: 'NM' } }); await screen.findByRole('alert'); view.unmount();
  render(<PreviewTable artifact={{ groupCode: 'BR', groupName: 'Браслети', rowCount: 2, csvContent: 'sku,store_view_code,name,color\r\nBR1,,"Назва, з ""лапками""\nдалі",Світлий\r\nBR1,en,English,\r\n' }} />);
  expect(screen.getAllByText(/Назва, з "лапками"/)[0].textContent).toBe('Назва, з "лапками"\nдалі');
  expect(screen.getAllByText('English').length).toBeGreaterThan(0);
});
it('null and invalid mappings remain distinct and untouched; sparse EN and identity cells remain protected', () => {
  const d = materializeMagentoV1(officeCatalog()); d.tables.nmExtra['2'] = null; d.tables.nmExtra['4'] = 42; delete d.tables.nmExtra['1'];
  const hash = hashJsonData(d); render(<Editor initial={d} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Намиста' })); field('dodatkovo_namysta');
  expect(screen.getByText('null — не порожній текст')).toBeTruthy(); expect(screen.getByText('Відповідності немає')).toBeTruthy();
  expect(screen.getAllByText(/Некоректний тип відповідності/)).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'NM / dodatkovo_namysta / EN' }));
  expect(screen.getAllByText('Порожня клітинка').length).toBeGreaterThan(0);
  field('sku'); expect(screen.getByText('Захищене ідентифікаційне поле: sku.')).toBeTruthy();
  expect(hashJsonData(current)).toBe(hash);
});
