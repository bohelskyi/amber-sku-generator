import { changeControl } from './helpers/searchable-picker';
import { useEffect, useState } from 'react';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it } from 'vitest';
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
beforeEach(() => { window.innerWidth = 1600; });
let current;
function Editor() {
  const [d, set] = useState(() => upgradeColumns(materializeMagentoV1(catalog())));
  useEffect(() => { current = d; }, [d]);
  return <DefinitionEditor definition={d} registry={{ productFields: ['weight'] }} onChange={set} />;
}
const click = (name) => fireEvent.click(screen.getByRole('button', { name, exact: true }));
const change = (name, value) => changeControl(screen.getByLabelText(name, { exact: true }), value);
it('rendered grid task adds an approved-source target, keeps EN blank, duplicates, renames, moves and deletes', () => {
  render(<Editor />);
  expect(screen.getByRole('table')).toBeTruthy();
  expect(screen.getByRole('rowheader', { name: 'Основний' })).toBeTruthy();
  expect(screen.queryByText(product('BR').full_sku)).toBeNull();
  click('+ Колонка');
  change('Код у CSV', 'synthetic_target');
  change('Звідки брати значення', 'source'); change('Характеристика', 'weight'); change('Як записувати значення', 'raw'); click('Додати колонку');
  expect(evaluateBatch(compileDefinition(current), [product('BR')]).status).toBe('ready');
  expect(current.groups[0].rows[1].cells.synthetic_target).toEqual({ op: 'literal', value: '' });
  const menu = (code, action) => { click('Дії колонки ' + code); fireEvent.click(screen.getByRole('menuitem', { name: action, exact: true })); };
  menu('synthetic_target', 'Дублювати'); change('Код у CSV', 'synthetic_copy'); click('Застосувати до чернетки');
  menu('synthetic_copy', 'Перейменувати…'); change('Код у CSV', 'synthetic_renamed'); click('Застосувати до чернетки');
  menu('synthetic_renamed', 'Перемістити…'); change('Перемістити на позицію', '0'); click('Застосувати до чернетки');
  expect(current.groups[0].columns[0]).toBe('synthetic_renamed');
  menu('synthetic_renamed', 'Видалити…'); click('Видалити колонку');
  expect(current.groups[0].columns).not.toContain('synthetic_renamed');
  expect(current.groups[0].rows[0].cells.synthetic_renamed).toBeUndefined();
  click('Дії колонки sku');
  expect(screen.getByRole('menuitem', { name: 'Видалити…' }).disabled).toBe(true);
});
it('headers open the appropriate task surface, with contained focus and Escape restoring header focus', () => {
  render(<Editor />);
  for (const [column, role] of [['meta_title', 'complementary'], ['name', 'dialog']]) {
    const header = screen.getByRole('button', { name: 'Налаштувати колонку ' + column });
    header.focus(); fireEvent.click(header);
    const panel = screen.getByRole(role, { name: 'Налаштування колонки' });
    expect(panel.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(document.activeElement).toBe(header);
  }
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
