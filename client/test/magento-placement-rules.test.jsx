import { createRequire } from 'node:module';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MagentoPlacementRuleEditor from '../src/components/export-templates/MagentoPlacementRuleEditor.jsx';
import { appendPlacement, placementRules, removePlacement, updatePlacement } from '../src/lib/magento-placement-rule.js';
import { api } from '../src/lib/api.js';
import MagentoCharacteristics from '../src/components/workspace/MagentoCharacteristics.jsx';
import { MemoryRouter } from 'react-router-dom';
const require = createRequire(import.meta.url);
const { materializeMagentoV1 } = require('../../server/src/services/export-templates/magento-v1-definition');
const { upgradeColumns } = require('../../server/src/services/export-templates/column-contract');
const { compileDefinition } = require('../../server/src/services/export-templates/definition');
const { evaluateProduct } = require('../../server/src/services/export-templates/evaluate');
const { catalog, product } = require('../../server/test/fixtures/magento-v1/contract');
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
afterEach(cleanup); beforeEach(() => vi.resetAllMocks());
it('appends one conditional placement without changing existing paths, other products, English, references or the original definition', () => {
  const definition = upgradeColumns(materializeMagentoV1(catalog()));
  const before = structuredClone(definition); const index = definition.groups.findIndex((group) => group.route === 'AR');
  const path = ['groups', index, 'rows', 0, 'cells', 'categories'];
  const next = appendPlacement(definition, path, 'Default/Картини/Новий розділ', 'AR.type', '1');
  const oldExpression = definition.groups[index].rows[0].cells.categories;
  expect(next.groups[index].rows[0].cells.categories.items[0]).toEqual(oldExpression);
  expect(next.groups[index].rows[1]).toEqual(definition.groups[index].rows[1]);
  expect(next.bindings).toEqual(definition.bindings);
  expect(definition).toEqual(before);
  for (const type of [1, 2]) {
    const old = evaluateProduct(compileDefinition(definition), product('AR', { type })).base.categories;
    const changed = evaluateProduct(compileDefinition(next), product('AR', { type })).base.categories;
    expect(changed).toBe(type === 1 ? `${old},Default/Картини/Новий розділ` : old);
  }
});
it('preserves an opaque existing expression when adding an explicit all-products placement and rejects cross-category conditions', () => {
  const existing = { op: 'ref', id: 'opaque' };
  const definition = { sources: { wrong: { kind: 'semantic', category: 'SV', key: 'kind' } }, groups: [{ route: 'BR', rows: [{ cells: { categories: existing } }] }], bindings: [{ id: 'opaque', value: { op: 'literal', value: 'Default/Old' } }] };
  const path = ['groups', 0, 'rows', 0, 'cells', 'categories'];
  const next = appendPlacement(definition, path, 'Default/New');
  expect(next.groups[0].rows[0].cells.categories.items).toEqual([existing, { op: 'literal', value: 'Default/New' }]);
  expect(next.bindings).toEqual(definition.bindings);
  expect(() => appendPlacement(definition, path, 'Default/New', 'wrong', '1')).toThrow();
});
it('authors an existing category subcategory using observed parent, explicit product scope, and local draft-only application', async () => {
  const definition = { sources: { color: { kind: 'semantic', category: 'BR', key: 'color' } }, bindings: [], groups: [{ route: 'BR', rows: [{ cells: { categories: { op: 'literal', value: 'Default/Прикраси' } } }] }] };
  const registry = { references: { questions: [{ category_code: 'BR', key: 'color', include_in_sku: 1, label: 'Колір' }], schemas: [{ category_code: 'BR', questions: [{ key: 'color' }] }] } };
  const loadSource = vi.fn().mockResolvedValue({ data: { current: [{ options: [{ value_id: '1', label: 'Світлий' }] }] } });
  const onChange = vi.fn();
  api.post.mockResolvedValueOnce({ data: { categories: [{ categoryId: '10', normalizedPath: 'Default/Прикраси', comparable: true }] } }).mockResolvedValueOnce({ data: { categoryCode: 'BR', parentId: 10, path: 'Default/Прикраси/Світлі браслети', status: 'would_create', magentoWriteAttempted: false, impact: { activeProductUpperBound: 17 } } });
  render(<MagentoPlacementRuleEditor definition={definition} cellPath={['groups', 0, 'rows', 0, 'cells', 'categories']} registry={registry} loadSource={loadSource} onChange={onChange} onEditing={vi.fn()} />);
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Прочитати розділи магазину' }));
  await screen.findByRole('button', { name: 'Default › Прикраси' });
  fireEvent.change(screen.getByLabelText('Розділ'), { target: { value: 'new' } });
  fireEvent.click(screen.getByRole('button', { name: 'Default › Прикраси' }));
  fireEvent.change(screen.getByLabelText('Назва підкатегорії'), { target: { value: 'Світлі браслети' } });
  expect(screen.getByRole('button', { name: 'Додати розміщення до правила' }).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Які товари тут розміщувати?'), { target: { value: 'condition' } });
  fireEvent.change(screen.getByLabelText('Характеристика'), { target: { value: 'color' } });
  await screen.findByRole('option', { name: 'Світлий' });
  fireEvent.change(screen.getByLabelText('Значення характеристики'), { target: { value: '1' } });
  expect(screen.getByRole('button', { name: 'Додати розміщення до правила' }).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити шлях і вплив' }));
  await screen.findByText('План створення перевірено');
  fireEvent.click(screen.getByRole('button', { name: 'Додати розміщення до правила' }));
  expect(onChange).toHaveBeenCalledOnce();
  const node = onChange.mock.calls[0][0].groups[0].rows[0].cells.categories.items[1];
  expect(node.then.value).toBe('Default/Прикраси/Світлі браслети');
  expect(node.if.right.value).toBe('1');
  expect(api.post.mock.calls.map(call => call.slice(0, 2))).toEqual([['/admin/magento-integration/discovery', {}], ['/admin/magento-integration/categories/plan', { categoryCode: 'BR', parentId: 10, name: 'Світлі браслети' }]]);
});
it('shows text characteristics with no options and never invents an attribute association', () => {
  render(<MemoryRouter><MagentoCharacteristics questions={[{ id: 'engraving', label: 'Гравіювання', input_type: 'text', options: [] }, { id: 'description', label: 'Опис', input_type: 'text', options: [] }]} values={[]} targets={{ engraving: ['engraving_text'] }} definition={{}} revision={{ schema: { attributes: [{ attribute_code: 'engraving_text', default_frontend_label: 'Текст гравіювання' }] } }} actionFor={(question) => `/admin/magento/prepare?intent=attribute&question=${question.id}`} /></MemoryRouter>);
  expect(screen.getByText('Гравіювання')).toBeTruthy();
  expect(screen.getByText('Текст гравіювання')).toBeTruthy();
  expect(screen.getByText('Не передається за чинними правилами')).toBeTruthy();
  expect(screen.getAllByRole('link', { name: 'Налаштувати передачу' })).toHaveLength(2);
});

const literal = (value) => ({ op: 'literal', value });
const join = (items) => ({ op: 'join', items, delimiter: ',', omitEmpty: true });
const condition = (value, path) => ({ op: 'when', if: { op: 'eq', left: { op: 'semanticKey', input: { op: 'source', id: 'color' } }, right: literal(value) }, then: literal(path), else: literal('') });
const cellPath = ['groups', 0, 'rows', 0, 'cells', 'categories'];
const categoriesOf = (definition) => definition.groups[0].rows[0].cells.categories;
function placementFixture() {
  return { sources: { color: { kind: 'semantic', category: 'BR', key: 'color' } },
    bindings: [{ id: 'shared', value: literal('Default/Shared') }],
    groups: [{ route: 'BR', rows: [{ cells: { name: literal('Keep UA'), categories: join([
      { op: 'ref', id: 'shared' }, condition('0', 'Default/Zero'),
      join([literal('Default/Existing'), { op: 'when', if: literal(true), then: literal('Default/Complex'), else: literal('Default/Else') }]),
    ]) } }, { cells: { name: literal('Keep EN'), categories: { op: 'ref', id: 'shared' } } }] },
    { route: 'OTHER', rows: [{ cells: { categories: literal('Default/Other category') } }] }] };
}

it('edits and removes exact supported branches while retaining complex rules, references, languages and other categories', () => {
  const definition = placementFixture(); const before = structuredClone(definition);
  const rows = placementRules(definition, cellPath);
  expect(rows.map((row) => row.supported)).toEqual([false, true, true, false]);
  expect(rows[1].valueId).toBe('0');
  const next = updatePlacement(definition, cellPath, rows[1], 'Default/Updated', 'color', '1');
  expect(categoriesOf(next).items[1]).toEqual(condition('1', 'Default/Updated'));
  expect(categoriesOf(next).items[0]).toEqual(categoriesOf(before).items[0]);
  expect(categoriesOf(next).items[2]).toEqual(categoriesOf(before).items[2]);
  expect(next.bindings).toEqual(before.bindings);
  expect(next.groups[0].rows[1]).toEqual(before.groups[0].rows[1]);
  expect(next.groups[0].rows[0].cells.name).toEqual(before.groups[0].rows[0].cells.name);
  expect(next.groups[1]).toEqual(before.groups[1]);
  const removed = removePlacement(next, cellPath, placementRules(next, cellPath).find((row) => row.path === 'Default/Existing'));
  expect(categoriesOf(removed).items[2].items).toEqual([categoriesOf(before).items[2].items[1]]);
  expect(categoriesOf(removed).items.slice(0, 2)).toEqual(categoriesOf(next).items.slice(0, 2));
  expect(removed.groups[0].rows[1]).toEqual(before.groups[0].rows[1]);
  expect(removed.bindings).toEqual(before.bindings);
  expect(definition).toEqual(before);
  expect(() => updatePlacement(next, cellPath, rows[1], 'Default/Stale', 'color', '0')).toThrow(/змінилося/);
  expect(() => removePlacement(definition, cellPath, rows[0])).toThrow();
  expect(() => removePlacement(definition, cellPath, rows[3])).toThrow();
});

it('keeps unsupported joins, typed comparisons, guarded paths and shared refs opaque instead of guessing a simple rule', () => {
  const definition = placementFixture();
  definition.groups[0].rows[0].cells.categories = join([
    { ...join([literal('Default/Keep')]), omitEmpty: false },
    { ...join([literal('Default/Keep')]), delimiter: ';' },
    condition(0, 'Default/Numeric'),
    { op: 'require', if: literal(true), value: literal('Default/Guarded') },
    { ...literal('Default/Keep'), unknown: true },
    literal('Default/One,Default/Two'),
    { op: 'ref', id: 'shared' },
  ]);
  const before = structuredClone(definition);
  expect(placementRules(definition, cellPath).every((row) => !row.supported)).toBe(true);
  const next = appendPlacement(definition, cellPath, 'Default/New', 'color', '0');
  expect(categoriesOf(next).items[0]).toEqual(categoriesOf(before));
  expect(placementRules(next, cellPath).at(-1).valueId).toBe('0');
  expect(definition).toEqual(before);
});

it('removes only the selected duplicate and guards stale positions after another row is removed', () => {
  const definition = placementFixture();
  definition.groups[0].rows[0].cells.categories = join([literal('Default/Same'), literal('Default/Same')]);
  const rows = placementRules(definition, cellPath);
  const next = removePlacement(definition, cellPath, rows[1]);
  expect(categoriesOf(next).items).toEqual([literal('Default/Same')]);
  expect(() => removePlacement(next, cellPath, rows[0])).toThrow(/змінилося/);
  const root = { ...definition, groups: [{ route: 'BR', rows: [{ cells: { categories: literal('Default/Only') } }] }] };
  const empty = removePlacement(root, cellPath, placementRules(root, cellPath)[0]);
  expect(categoriesOf(empty)).toEqual(literal(''));
  expect(placementRules(empty, cellPath)).toEqual([]);
});

it('server evaluation changes only the selected semantic-zero placement and removal restores the original output', () => {
  const definition = upgradeColumns(materializeMagentoV1(catalog()));
  const index = definition.groups.findIndex((group) => group.route === 'CH');
  const path = ['groups', index, 'rows', 0, 'cells', 'categories'];
  const added = appendPlacement(definition, path, 'Default/Zero', 'CH.count', '0');
  const changed = updatePlacement(added, path, placementRules(added, path).at(-1), 'Default/Thirty three', 'CH.count', '1');
  const removed = removePlacement(changed, path, placementRules(changed, path).at(-1));
  for (const count of [0, 1]) {
    const evaluate = (value) => evaluateProduct(compileDefinition(value), product('CH', { count })).base.categories;
    const original = evaluate(definition);
    expect(evaluate(added)).toBe(count === 0 ? `${original},Default/Zero` : original);
    expect(evaluate(changed)).toBe(count === 1 ? `${original},Default/Thirty three` : original);
    expect(evaluate(removed)).toBe(original);
  }
});

it('shows readable existing rules and edits or removes a row locally without dispatching shop changes', async () => {
  const initial = placementFixture(); const changes = vi.fn();
  const registry = { references: { questions: [{ category_code: 'BR', key: 'color', include_in_sku: 1, label: 'Колір' }], schemas: [{ category_code: 'BR', questions: [{ key: 'color' }] }] } };
  const loadSource = vi.fn().mockResolvedValue({ data: { current: [{ options: [{ value_id: 0, label: 'Нульовий' }, { value_id: 1, label: 'Світлий' }] }] } });
  api.post.mockResolvedValue({ data: { categories: [{ categoryId: '10', normalizedPath: 'Default/Zero', comparable: true }, { categoryId: '11', normalizedPath: 'Default/Updated', comparable: true }] } });
  function Editor() {
    const [definition, setDefinition] = useState(initial);
    return <MagentoPlacementRuleEditor definition={definition} cellPath={cellPath} registry={registry} loadSource={loadSource}
      onChange={(next) => { changes(next); setDefinition(next); }} />;
  }
  render(<Editor />);
  await screen.findByText('Колір = Нульовий');
  expect(screen.getByRole('columnheader', { name: 'Для яких товарів' })).toBeTruthy();
  expect(screen.getAllByText('Складне або спільне правило')).toHaveLength(2);
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Редагувати розміщення Default/Zero' }));
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Прочитати розділи магазину' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Default › Updated' }));
  expect(screen.getByLabelText('Значення характеристики').value).toBe('0');
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти розміщення в правилі' }));
  expect(categoriesOf(changes.mock.calls[0][0]).items[1]).toEqual(condition('0', 'Default/Updated'));
  fireEvent.click(screen.getByRole('button', { name: 'Вилучити розміщення Default/Updated' }));
  expect(placementRules(changes.mock.calls[1][0], cellPath).filter((row) => row.supported).map((row) => row.path)).toEqual(['Default/Existing']);
  expect(changes.mock.calls[1][0].bindings).toEqual(initial.bindings);
  expect(api.post.mock.calls).toEqual([['/admin/magento-integration/discovery', {}]]);
});

it('does not offer draft edits or store discovery in the read-only rule table', () => {
  render(<MagentoPlacementRuleEditor definition={placementFixture()} cellPath={cellPath} registry={{}} readOnly onChange={vi.fn()} />);
  expect(screen.getAllByText('Лише перегляд')).toHaveLength(2);
  expect(screen.queryByRole('button', { name: /розміщення|розділи магазину/ })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});
