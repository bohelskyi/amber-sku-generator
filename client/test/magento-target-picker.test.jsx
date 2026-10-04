import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../src/lib/api.js';
import MagentoTargetPicker from '../src/components/export-templates/MagentoTargetPicker.jsx';
import MagentoStructureResult from '../src/components/workspace/MagentoStructureResult.jsx';
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('offers actual category-set attributes by name without a remote request or duplicate output', async () => {
  api.get.mockResolvedValue({ data: { revision: { bindings: { routes: [{ routeKey: 'BR:all', setId: 7 }] }, schema: {
    attributeSets: [{ attribute_set_id: 7, attribute_set_name: 'Браслети', attributeCodes: ['color', 'weight'] }],
    attributes: [{ attribute_code: 'color', default_frontend_label: 'Колір', frontend_input: 'select' },
      { attribute_code: 'weight', default_frontend_label: 'Вага' }, { attribute_code: 'unrelated', default_frontend_label: 'Інший набір' }],
  } } } });
  const onSelect = vi.fn();
  render(<MagentoTargetPicker group={{ route: 'BR', columns: ['weight'] }} selected="" onSelect={onSelect} />);
  await screen.findByRole('option', { name: 'Колір · список' });
  expect(screen.queryByRole('option', { name: /Вага|Інший набір/ })).toBeNull();
  fireEvent.change(screen.getByLabelText('Наявний атрибут Magento'), { target: { value: 'color' } });
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ attribute_code: 'color' }));
  expect(api.post).not.toHaveBeenCalled();
});

it('structure success identifies its scope and a different publication invalidates that evidence', () => {
  const comparison = { state: 'checked', bindingRevisionId: 'old', routesChecked: 2, attributesChecked: 8, findings: [] };
  const view = render(<MemoryRouter><MagentoStructureResult comparison={comparison} activeId="old" /></MemoryRouter>);
  expect(screen.getByText(/Доставку товарів ця перевірка не підтверджує/)).toBeTruthy();
  view.rerender(<MemoryRouter><MagentoStructureResult comparison={comparison} activeId="new" /></MemoryRouter>);
  expect(screen.queryByText(/розбіжностей не знайдено/)).toBeNull();
  expect(screen.getByText(/Підключення змінилося/)).toBeTruthy();
});
