import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ArtifactTables, PreviewTable } from '../src/components/export-templates/PreviewTable.jsx';

afterEach(cleanup);

const artifact = (groupCode, sku, extra = {}) => ({ groupCode, rowCount: 1,
  csvContent: `sku,store_view_code,name\r\n${sku},,Назва ${sku}\r\n`, ...extra });

it('renders nothing for an absent or empty artifact list', () => {
  const view = render(<ArtifactTables />);
  expect(view.container.textContent).toBe('');
  view.rerender(<ArtifactTables artifacts={[]} stored />);
  expect(screen.queryByRole('table')).toBeNull();
  expect(view.container.textContent).toBe('');
});

it('changes only the selected table and falls back safely when that artifact disappears', () => {
  const br = artifact('BR', 'AG-000041', { groupName: 'Браслети' });
  const sv = artifact('SV', 'AG-000042');
  const view = render(<ArtifactTables artifacts={[br, sv]} />);
  expect(screen.getByRole('region', { name: 'Майбутні таблиці' })).toBeTruthy();
  expect(screen.getByText(/Авторитетний попередній перегляд/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Браслети' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'SV' }));
  expect(screen.getByRole('button', { name: 'SV' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('region', { name: 'Таблиця результату BR' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Значення sku, рядок 1' }).textContent).toBe('AG-000042');
  view.rerender(<ArtifactTables artifacts={[br]} stored />);
  expect(screen.getByRole('region', { name: 'Збережені таблиці' })).toBeTruthy();
  expect(screen.getByText(/Незмінний збережений результат/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Браслети' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: 'Значення sku, рядок 1' }).textContent).toBe('AG-000041');
  expect(screen.queryByRole('button', { name: 'SV' })).toBeNull();
});

it('removes old table cells when the selected artifact no longer includes CSV', () => {
  const br = artifact('BR', 'AG-000041');
  const view = render(<ArtifactTables artifacts={[br]} />);
  expect(screen.getByRole('table')).toBeTruthy();
  view.rerender(<ArtifactTables artifacts={[{ ...br, csvContent: undefined }]} />);
  expect(screen.getByText('Для таблиці повторіть перевірку або відкрийте збережений знімок.')).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.queryByText('AG-000041')).toBeNull();
});

it.each([
  [undefined, 'Відсутній CSV сервера.'],
  ['sku,name\nAG-1,"unfinished', 'Незакриті лапки CSV.'],
  ['sku,name\nAG-1,"closed"extra', 'Некоректні лапки CSV. Використайте технічний перегляд.'],
  ['sku,name\nAG-1', 'Неповний рядок CSV.'],
])('reports malformed or missing CSV instead of showing fabricated rows (%s)', (csvContent, message) => {
  render(<PreviewTable artifact={artifact('BR', 'unused', { csvContent })} />);
  expect(screen.getByRole('alert').textContent).toBe(message);
  expect(screen.queryByRole('table')).toBeNull();
});

it('preserves BOM, quoted commas, escaped quotes and multiline cells through the real CSV parser', () => {
  const csvContent = '\ufeffsku,store_view_code,name\r\nAG-000041,,"Назва, з комою"\r\nAG-000041,en,"Line ""quoted""\nsecond"\r\n';
  render(<PreviewTable artifact={artifact('BR', 'unused', { csvContent, rowCount: 2 })} integration />);
  expect(screen.getByRole('region', { name: 'BR · 2 рядків · перевірені значення полів' })).toBeTruthy();
  expect(screen.getByRole('rowheader', { name: 'Основний · AG-000041' })).toBeTruthy();
  expect(screen.getByRole('rowheader', { name: 'EN · AG-000041' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Значення name, рядок 1' }).textContent).toBe('Назва, з комою');
  fireEvent.click(screen.getByRole('button', { name: 'Значення name, рядок 2' }));
  expect(within(screen.getByRole('region', { name: 'Повне значення' })).getByText('Line "quoted" second').textContent).toBe('Line "quoted"\nsecond');
  fireEvent.click(screen.getByRole('button', { name: 'Закрити значення' }));
  expect(screen.queryByRole('region', { name: 'Повне значення' })).toBeNull();
});

it('reparses changed bytes in the same group and clears the table when all artifacts disappear', () => {
  const br = artifact('BR', 'AG-000041');
  const view = render(<ArtifactTables artifacts={[br]} />);
  view.rerender(<ArtifactTables artifacts={[artifact('BR', 'AG-000043')]} />);
  expect(screen.getByRole('button', { name: 'Значення sku, рядок 1' }).textContent).toBe('AG-000043');
  expect(screen.queryByText('AG-000041')).toBeNull();
  view.rerender(<ArtifactTables artifacts={[]} />);
  expect(screen.queryByRole('table')).toBeNull();
});
