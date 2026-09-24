import { useEffect, useState } from 'react';
import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DefinitionEditor } from '../src/components/export-templates/DefinitionEditor';
import { PreviewTable } from '../src/components/export-templates/PreviewTable';
const require = createRequire(import.meta.url);
const { materializeMagentoV1 } = require('../../server/src/services/export-templates/magento-v1-definition');
const { upgradeColumns } = require('../../server/src/services/export-templates/column-contract');
const { compileDefinition } = require('../../server/src/services/export-templates/definition');
const { evaluateBatch } = require('../../server/src/services/export-templates/evaluate');
const { catalog, product } = require('../../server/test/fixtures/magento-v1/contract');
afterEach(cleanup);
let current;
function Editor() {
  const [d, set] = useState(() => upgradeColumns(materializeMagentoV1(catalog())));
  useEffect(() => { current = d; }, [d]);
  return <DefinitionEditor definition={d} registry={{ productFields: ['weight'] }} onChange={set} />;
}
const click = (name) => fireEvent.click(screen.getByRole('button', { name, exact: true }));
const change = (name, value) => fireEvent.change(screen.getByLabelText(name, { exact: true }), { target: { value } });
it('rendered grid task adds an approved-source target, keeps EN blank, duplicates, renames, moves and deletes', () => {
  render(<Editor />);
  expect(screen.getByRole('table')).toBeTruthy();
  expect(screen.getByText('Основний · макет')).toBeTruthy();
  expect(screen.queryByText(product('BR').full_sku)).toBeNull();
  click('+ Колонка');
  change('Код колонки CSV', 'synthetic_target');
  change('Чим заповнювати', 'source'); change('Характеристика', 'weight'); change('Як записувати', 'raw'); click('Додати колонку');
  expect(evaluateBatch(compileDefinition(current), [product('BR')]).status).toBe('ready');
  expect(current.groups[0].rows[1].cells.synthetic_target).toEqual({ op: 'literal', value: '' });
  fireEvent.click(screen.getByText('Код, порядок та інші дії'));
  change('Код нової колонки', 'synthetic_copy'); click('Дублювати');
  fireEvent.click(screen.getByText('Код, порядок та інші дії'));
  change('Код колонки CSV', 'synthetic_renamed'); click('Змінити код колонки');
  fireEvent.click(screen.getByText('Код, порядок та інші дії'));
  change('Перемістити на позицію', '0');
  expect(current.groups[0].columns[0]).toBe('synthetic_renamed');
  click('Видалити колонку');
  expect(current.groups[0].columns).not.toContain('synthetic_renamed');
  expect(current.groups[0].rows[0].cells.synthetic_renamed).toBeUndefined();
  click('Налаштувати колонку sku');
  fireEvent.click(screen.getByText('Код, порядок та інші дії'));
  expect(screen.getByRole('button', { name: 'Видалити колонку' }).disabled).toBe(true);
});
it('header is keyboard reachable, drawer focus is explicit and Escape restores header focus', () => {
  render(<Editor />);
  const header = screen.getByRole('button', { name: 'Налаштувати колонку name' });
  header.focus(); fireEvent.click(header);
  const panel = screen.getByRole('complementary', { name: 'Налаштування колонки' });
  expect(document.activeElement).toBe(panel);
  fireEvent.keyDown(panel, { key: 'Escape' });
  expect(document.activeElement).toBe(header);
});
it('preview paginates the same CSV and reveals long quoted/formula-neutralized values without changing order', () => {
  const rows = Array.from({ length: 104 }, (_, i) => 'BR' + i + ',en,"\\u0027=formula, ""quoted""\\nlong"');
  const csvContent = 'sku,store_view_code,name\\n' + rows.join('\\n');
  render(<PreviewTable artifact={{ groupCode: 'BR', rowCount: 104, csvContent: csvContent.replaceAll('\\n', '\n').replaceAll('\\u0027', "'") }} />);
  expect(screen.getAllByRole('row')).toHaveLength(51);
  click('Наступні рядки'); expect(screen.getByText(/51–100/)).toBeTruthy();
  click('Значення name, рядок 51');
  expect(screen.getByRole('region', { name: 'Повне значення' }).textContent).toContain("'=formula, \"quoted\"\nlong");
  click('Наступні рядки'); expect(screen.getAllByRole('row')).toHaveLength(5);
});

it('cell details follow the current authoritative artifact instead of retaining prior values', () => {
  const artifact = { groupCode: 'BR', rowCount: 1, csvContent: 'sku,store_view_code,name\r\nS,,Before\r\n' };
  const view = render(<PreviewTable artifact={artifact} />);
  click('Значення name, рядок 1');
  expect(screen.getByRole('region', { name: 'Повне значення' }).textContent).toContain('Before');
  view.rerender(<PreviewTable artifact={{ ...artifact, csvContent: artifact.csvContent.replace('Before', 'After') }} />);
  expect(screen.getByRole('region', { name: 'Повне значення' }).textContent).toContain('After');
  expect(screen.queryByText('Before')).toBeNull();
});
