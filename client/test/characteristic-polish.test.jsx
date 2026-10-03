import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DecodeWorkspace } from '../src/components/app/HomeDashboard.jsx';
import { RecountConfirmDialog } from '../src/components/app/RecountConfirmDialog.jsx';
import { polishConfig, polishDecoded, polishPreview, polishTargetAnswers } from './fixtures/characteristic-polish.js';

vi.mock('../src/components/app/ProductMagentoState.jsx', () => ({ ProductMagentoState: () => null }));
vi.mock('../src/components/app/RecountNameFields.jsx', () => ({ RecountNameFields: () => null }));
afterEach(cleanup);

function renderWorkspace(overrides = {}) {
  return render(<MemoryRouter><DecodeWorkspace config={polishConfig} decodeData={polishDecoded}
    recountAnswers={polishTargetAnswers} recountReason="" recountWeight="0" {...overrides} /></MemoryRouter>);
}

it('omits absent optional/dependent rows while retaining selected, zero and historical characteristics', () => {
  const { container } = renderWorkspace();
  const rows = [...container.querySelectorAll('.decode-field-row')].map((row) => row.textContent);
  expect(rows).toHaveLength(9);
  expect(rows.join('\n')).toContain('Тип сувеніраПисьмовий набір');
  expect(rows.join('\n')).not.toContain('Не обрано');
  expect(rows.join('\n')).not.toContain('Відсутнє');
  expect(rows.join('\n')).toContain('Семантичний нульСправжній нуль');
  expect(rows.join('\n')).toContain('Числове поле0');
  expect(rows.join('\n')).toContain('КалібруванняНекалібрований');
  expect(rows.join('\n')).toContain('Історичний нуль0');
  expect(rows.join('\n')).toContain('Історично невідомеНевідомо (збережено: 90)');
  expect(rows.join('\n')).toContain('Архівний вибірІсторичний архівний варіант');
  expect(screen.getByText('AG-000020')).toBeTruthy();
});

it('retains placeholder rows in the existing non-stored SKU decoding view', () => {
  const { container } = renderWorkspace({ decodeData: { ...polishDecoded, existsInDb: false, product: null } });
  expect(container.querySelectorAll('.decode-field-row')).toHaveLength(polishDecoded.decodedAnswers.length);
  expect(screen.getByRole('heading', { name: 'Розшифрований код' })).toBeTruthy();
});

it.each([false, true])('keeps only the parent business change in comparison (accepted preview: %s)', (current) => {
  const { container } = renderWorkspace({ isRecountOpen: true, hasRecountChanges: true,
    isRecountPreviewCurrent: current, recountPreview: polishPreview });
  const rows = container.querySelectorAll('.recount-change-row');
  expect(rows).toHaveLength(1);
  expect(rows[0].textContent).toBe('Тип сувеніраПисьмовий набір → Годинник');
  expect(container.querySelectorAll('.recount-inline-change')).toHaveLength(1);
  expect(screen.getByRole('textbox', { name: 'Числове поле' }).value).toBe('0');
  expect(container.textContent).toContain('AG-000020');
});

it('keeps visible clears and genuine historical unknown/zero removal in comparison', () => {
  const changes = ['visible_clear', 'numeric_zero', 'zero_option', 'historic_zero', 'historic_unknown', 'historic_archived']
    .map((key) => ({ key, from: polishDecoded.product.details.answers[key], to: null }));
  const clearedAnswers = { ...polishTargetAnswers, ...Object.fromEntries(changes.map((change) => [change.key, null])) };
  const { container } = renderWorkspace({ isRecountOpen: true, hasRecountChanges: true,
    recountAnswers: clearedAnswers, isRecountPreviewCurrent: true,
    recountPreview: { ...polishPreview, changes, corrected: { ...polishPreview.corrected, answers: clearedAnswers } } });
  const rows = [...container.querySelectorAll('.recount-change-row')];
  expect(rows).toHaveLength(6);
  expect(rows[0].textContent).toContain('Збережений вибір → Не обрано');
  expect(rows[1].textContent).toContain('0 → Не обрано');
  expect(rows[2].textContent).toContain('Справжній нуль → Не обрано');
  expect(rows[3].textContent).toContain('0 → Не обрано');
  expect(rows[4].textContent).toContain('Невідомо (збережено: 90) → Не обрано');
  expect(rows[5].textContent).toContain('Історичний архівний варіант → Не обрано');
});

it('suppresses two absent sides and visible placeholder cleanup without suppressing calibration changes', () => {
  const changes = [{ key: 'visible_clear', from: null, to: '' },
    { key: 'statue', from: 0, to: null }, { key: 'is_calibrated', from: 0, to: 2 }];
  const { container } = renderWorkspace({ isRecountOpen: true, hasRecountChanges: true,
    isRecountPreviewCurrent: true, recountAnswers: { ...polishTargetAnswers, souvenir: 3 },
    recountPreview: { ...polishPreview, changes,
      corrected: { ...polishPreview.corrected, answers: { ...polishTargetAnswers, souvenir: 3 } } } });
  const rows = container.querySelectorAll('.recount-change-row');
  expect(rows).toHaveLength(1);
  expect(rows[0].textContent).toContain('Некалібрований → Напівкалібрований');
});

it('uses the same meaningful changes and public article in direct recount confirmation', () => {
  render(<RecountConfirmDialog config={polishConfig} preview={polishPreview} isOpen onCancel={vi.fn()} onConfirm={vi.fn()} />);
  const dialog = screen.getByRole('dialog');
  expect(dialog.textContent).toContain('Тип сувеніра: Письмовий набір → Годинник');
  expect(dialog.textContent).not.toContain('Деталь набору:');
  expect(dialog.textContent).not.toContain('Відсутнє');
  expect(screen.getByRole('button', { name: 'Скопіювати поточний артикул' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Застосувати переоблік' }).disabled).toBe(false);
});
