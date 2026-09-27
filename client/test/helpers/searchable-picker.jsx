import { fireEvent, within } from '@testing-library/react';

const names = { 'BR.color': 'Браслети → Колір', 'KL.color': 'Кулони → Колір', 'AR.type': 'Картини → Тип картини', weight: 'Товар → Збережена вага', 'BR.note': 'Браслети → Примітка', 'BR.test_zero': 'Браслети → Тестовий нуль', '"1"': 'Ікона', '"2"': 'Пейзаж', '"3"': 'Панно' };
export function changeControl(element, value) {
  if (element.tagName === 'INPUT' && element.getAttribute('role') === 'combobox') {
    fireEvent.focus(element);
    fireEvent.change(element, { target: { value: names[value] || value } });
    fireEvent.click(within(element.closest('.et-combobox')).getByRole('option', { name: names[value] || value, exact: true }));
  } else fireEvent.change(element, { target: { value } });
}
