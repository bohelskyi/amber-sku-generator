import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import MagentoBindingReview from '../src/components/workspace/MagentoBindingReview.jsx';
import { DefinitionEditor } from '../src/components/export-templates/DefinitionEditor.jsx';
import { addIntegrationCategory } from '../src/lib/integration-template.js';
const require = createRequire(import.meta.url);
const { definition } = require('../../server/test/fixtures/magento-v4');
const { compileDefinition } = require('../../server/src/services/export-templates/definition');
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('v4 uses the normal grid and new category authoring remains a local reviewed template draft', () => {
  const d = definition(); const change = vi.fn();
  render(<DefinitionEditor definition={d} registry={{ productFields: [] }} onChange={change} />);
  expect(screen.getByRole('table')).toBeTruthy();
  expect(screen.queryByText('Цей формат ще не підтримується формами.')).toBeNull();
  fireEvent.click(screen.getByText('Категорії інтеграційного шаблону'));
  const fields = { 'Код категорії Amber': 'ZZ', 'Назва категорії Amber': 'Нова категорія',
    'Основна назва товару українською': 'Свідома назва', 'Основна назва товару англійською': 'Reviewed English name',
    'Точна назва набору атрибутів Magento': 'Fixture set', 'Повний шлях категорії Magento': 'Default/Нова' };
  for (const [label, value] of Object.entries(fields)) fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Додати категорію до чернетки' }));
  const next = change.mock.calls[0][0]; expect(next.groups.at(-1).route).toBe('ZZ');
  expect(compileDefinition(next).definition.evaluatorVersion).toBe('magento-declarative-4');
  expect(d.groups).toHaveLength(1); expect(api.post).not.toHaveBeenCalled();
  expect(() => addIntegrationCategory(d, { code: 'YY' })).toThrow();
});
it('review candidate selection is separate from approval and exact clone is a separate command', async () => {
  const revision = { id: 'draft', state: 'draft', revision: '1', templateId: 'family', templateVersionId: 'version',
    bindings: { attributes: [] }, schema: { attributeSets: [{ attribute_set_id: 151, attribute_set_name: 'Сувеніри' }], attributes: [] } };
  api.get.mockResolvedValue({ data: { revision, validation: { valid: false, diagnostics: [{}] },
    entries: [{ id: 'route:SV:all', kind: 'route', group: 'SV', target: 'attribute_set_code', reviewState: 'review_required', identity: 151, label: 'Сувеніри', exact: false }] } });
  api.post.mockResolvedValue({ data: { ...revision, revision: '2' } }); const changed = vi.fn();
  render(<AuthContext.Provider value={{ permissions: ['export_templates.manage'] }}><MemoryRouter><MagentoBindingReview revision={revision} onChanged={changed} /></MemoryRouter></AuthContext.Provider>);
  await screen.findByText('Невирішених структурних питань: 1'); fireEvent.click(screen.getByText('Рішення за маршрутами та полями'));
  fireEvent.change(screen.getByLabelText('Кандидат'), { target: { value: '151' } });
  fireEvent.click(screen.getByRole('button', { name: 'Вибрати кандидата' }));
  await vi.waitFor(() => expect(changed).toHaveBeenCalled());
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-integration/bindings/draft/select', { expectedRevision: '1', binding: 'route:SV:all', identity: 151 });
  expect(screen.queryByRole('button', { name: /Опублікувати/ })).toBeNull();
});
