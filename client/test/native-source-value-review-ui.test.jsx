import { useState } from 'react';
import { createRequire } from 'node:module';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import NativeSourceValueReview from '../src/components/export-templates/NativeSourceValueReview.jsx';
import { DefinitionEditor } from '../src/components/export-templates/DefinitionEditor.jsx';
import MagentoFieldTargetReview from '../src/components/export-templates/MagentoFieldTargetReview.jsx';
import { api } from '../src/lib/api.js';
import { sourceOf } from '../src/lib/export-template-presentation.js';
const require = createRequire(import.meta.url);
const { materializeMagentoV1 } = require('../../server/src/services/export-templates/magento-v1-definition');
const { upgradeColumns } = require('../../server/src/services/export-templates/column-contract');
const { upgradeSourceSupport } = require('../../server/src/services/export-templates/source-support');
const { compileDefinition } = require('../../server/src/services/export-templates/definition');
const { officeCatalog, officeEvidence } = require('../../server/test/fixtures/magento-v1/office');
const definition = () => ({ ...upgradeSourceSupport(upgradeColumns(materializeMagentoV1(officeCatalog(), { publicSku: true })), officeEvidence()), evaluatorVersion: 'magento-declarative-5', sourceContractVersion: 'public-product-characteristics-v1' });
const evidence = { current: [{ archived: false, input_type: 'options', options: [29, 30, 31].map((value_id) => ({ value_id, archived: false, label: `Розмір ${value_id}` })) }], truncated: false };
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('deferred AR review needs the selected semantic value, all output texts and both acknowledgements; never publishes', async () => {
  const change = vi.fn(); const loadSource = vi.fn().mockResolvedValue({ data: evidence });
  render(<NativeSourceValueReview definition={definition()} sourceId="AR.size" loadSource={loadSource} onChange={change} />);
  await screen.findByRole('option', { name: 'Розмір 29' });
  fireEvent.change(screen.getByLabelText('Розмір для окремого перегляду'), { target: { value: '29' } });
  const confirm = screen.getByRole('button', { name: 'Додати підтримку цього розміру до чернетки' });
  expect(confirm.disabled).toBe(true);
  for (const input of screen.getAllByLabelText(/Текст відповідності/)) fireEvent.change(input, { target: { value: 'Reviewed exact output' } });
  fireEvent.click(screen.getByLabelText('Підтверджую точний розмір у чинній характеристиці.'));
  expect(confirm.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('Переглянув усі використання й тексти цього значення.'));
  fireEvent.click(confirm); expect(change).toHaveBeenCalledTimes(1);
  const next = change.mock.calls[0][0]; compileDefinition(next);
  expect(next.sourceSupport.sources['AR.size'].deferredValues).toEqual(['30', '31']);
  expect(api.post).not.toHaveBeenCalled();
});
it('v5 rules editor opens the native source inspector instead of the unsupported format fallback', async () => {
  api.get.mockResolvedValue({ data: { categories: [], revision: null } });
  const d = definition();
  render(<DefinitionEditor definition={d} integration registry={{ references: { questions: [], schemas: [] } }} initialCategory="AR" readOnly
    loadSource={vi.fn().mockResolvedValue({ data: evidence })} onChange={vi.fn()} />);
  expect(screen.queryByText(/Цей формат ще не підтримується формами/)).toBeNull();
  expect(screen.getByRole('tabpanel')).toBeTruthy();
});
it('field remap changes both language rules only after exact observed target and acknowledgement; publication remains separate', async () => {
  const d = definition(); const groupIndex = d.groups.findIndex((g) => g.route === 'AR'); const group = d.groups[groupIndex];
  api.get.mockResolvedValue({ data: { revision: { schema: { attributeSets: [{ attribute_set_id: 2, attribute_set_name: 'Exact set', attributeCodes: ['new_size'] }], attributes: [{ attribute_code: 'new_size', frontend_input: 'select', default_frontend_label: 'Новий розмір' }] }, bindings: { routes: [{ routeKey: 'AR:base', setId: 2 }] } } } });
  const change = vi.fn();
  render(<MagentoFieldTargetReview definition={d} groupIndex={groupIndex} column="rozmir_kartyny" onApply={change} onEditing={vi.fn()} />);
  await screen.findByRole('option', { name: 'Новий розмір · список' });
  fireEvent.change(screen.getByLabelText('Наявний атрибут Magento'), { target: { value: 'new_size' } });
  const apply = screen.getByRole('button', { name: 'Зберегти нове призначення в чернетці' }); expect(apply.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('Переглянув обидві мови та обрав точний атрибут призначення.'));
  fireEvent.click(apply); const next = change.mock.calls[0][0]; compileDefinition(next);
  expect(sourceOf(next, next.groups[groupIndex].rows[0].cells.new_size)).toBe(sourceOf(d, group.rows[0].cells.rozmir_kartyny));
  expect(next.groups[groupIndex].rows[1].cells.new_size).toEqual(group.rows[1].cells.rozmir_kartyny);
  expect(next.bindings.slice(0, d.bindings.length)).toEqual(d.bindings);
  expect(group.columns).toContain('rozmir_kartyny'); expect(next.groups[groupIndex].columns).not.toContain('rozmir_kartyny');
  expect(api.post).not.toHaveBeenCalled();
});
it('permission loss disables deferred promotion and field remap even after selections were made', async () => {
  function View() { const [disabled, setDisabled] = useState(false); return <><button onClick={() => setDisabled(true)}>Revoke</button><NativeSourceValueReview definition={definition()} sourceId="AR.size" disabled={disabled} loadSource={vi.fn().mockResolvedValue({ data: evidence })} onChange={vi.fn()} /></>; }
  render(<View />); await screen.findByRole('option', { name: 'Розмір 29' });
  fireEvent.change(screen.getByLabelText('Розмір для окремого перегляду'), { target: { value: '29' } });
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  expect(screen.getByRole('button', { name: 'Додати підтримку цього розміру до чернетки' }).disabled).toBe(true);
});
