import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import CreationDeliveryNotice from '../src/components/app/CreationDeliveryNotice.jsx';
afterEach(cleanup);
const readiness = { scope: 'native_characteristic_source_support', status: 'configuration_required',
  code: 'NATIVE_CHARACTERISTICS_UPGRADE_REQUIRED', categoryCode: 'NM', questionKey: 'extra',
  bindingRevisionId: 'binding-checked', targetContract: 'public-product-characteristics-v1' };
it('offers only permitted exact review in a new tab and leaves the local save statement truthful', () => {
  render(<CreationDeliveryNotice readiness={readiness} categoryCode="NM" permissions={['export_templates.view', 'export_templates.manage']} questionLabel="Додаткова ознака" />);
  const link = screen.getByRole('link', { name: 'Підготувати підключення у новій вкладці' });
  expect(link.target).toBe('_blank'); expect(link.rel).toBe('noopener noreferrer');
  expect(link.href).toContain('binding=binding-checked');
  expect(screen.getByText(/Можна зберегти лише в менеджері./)).toBeTruthy();
  expect(screen.getByText(/Для доставки в Magento вирішіть конфлікт/)).toBeTruthy();
});
it('requires integration rights without inventing an Administrator-only upgrade gate', () => {
  const view = render(<CreationDeliveryNotice readiness={readiness} categoryCode="NM" permissions={[]} />);
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.getByText(/із правом керування інтеграцією/)).toBeTruthy();
  view.rerender(<CreationDeliveryNotice readiness={readiness} categoryCode="NM" permissions={['export_templates.view']} />);
  expect(screen.getByRole('link', { name: 'Переглянути потрібну зміну у новій вкладці' })).toBeTruthy();
});
it('describes deferred size as separate value review even under evaluator5', () => {
  render(<CreationDeliveryNotice readiness={{ ...readiness, categoryCode: 'AR', questionKey: 'size', code: 'SOURCE_SUPPORT_DEFERRED_VALUE',
    valueId: '30', evaluatorVersion: 'magento-declarative-5', targetContract: undefined }} categoryCode="AR"
    permissions={['export_templates.view']} valueLabel="Тридцятий розмір" saved />);
  expect(screen.getByRole('link', { name: 'Перевірити значення та відповідність у новій вкладці' }).href).toContain('value=30');
  expect(screen.getByText(/значення «Тридцятий розмір» відкладено в правилах/)).toBeTruthy();
  expect(screen.queryByText(/Підготувати підключення/)).toBeNull();
});
it('rechecks only after an explicit click and disables that action while an operation is pending', () => {
  const onRecheck = vi.fn();
  const view = render(<CreationDeliveryNotice readiness={readiness} categoryCode="NM" onRecheck={onRecheck} busy />);
  const button = screen.getByRole('button', { name: 'Оновити перевірку' });
  fireEvent.click(button); expect(onRecheck).not.toHaveBeenCalled();
  view.rerender(<CreationDeliveryNotice readiness={readiness} categoryCode="NM" onRecheck={onRecheck} />);
  fireEvent.click(button); expect(onRecheck).toHaveBeenCalledOnce();
});
it('never presents a narrow successful source check as a confirmed Magento delivery', () => {
  render(<CreationDeliveryNotice readiness={{ ...readiness, status: 'no_native_upgrade_blocker', code: null }} categoryCode="NM" saved />);
  expect(screen.getByText(/передавання товару в Magento перевіряється окремо/)).toBeTruthy();
  expect(screen.getByText(/Для цієї характеристики не виявлено потреби оновлювати підтримку нових товарів/)).toBeTruthy();
  expect(screen.queryByText(/Сумісність цієї характеристики перевірено/)).toBeNull();
  expect(screen.getByText('Перевірка на момент збереження:')).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
});

const taskId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
it('short warning preserves exact human category/question/value and task callback remains inert until explicit click',()=>{
 const onRequestIntegration=vi.fn();render(<CreationDeliveryNotice readiness={{...readiness,categoryCode:'AR',questionKey:'size',code:'SOURCE_SUPPORT_DEFERRED_VALUE',valueId:'29',targetContract:undefined}} categoryCode="AR" categoryLabel="Каблучки" questionLabel="Розмір" valueLabel="29 мм" onRequestIntegration={onRequestIntegration}/>);expect(screen.getByText(/«Розмір»: значення «29 мм» відкладено в правилах/)).toBeTruthy();expect(onRequestIntegration).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Сформувати задачу Адміністратору'}));expect(onRequestIntegration).toHaveBeenCalledExactlyOnceWith({categoryCode:'AR',questionKey:'size',valueId:'29'});expect(screen.getByText(/Можна зберегти лише в менеджері./)).toBeTruthy();
});
it('pending request disables task creation and recheck without inventing a receipt or posting by itself',()=>{
 const onRequestIntegration=vi.fn(),onRecheck=vi.fn();render(<CreationDeliveryNotice readiness={readiness} categoryCode="NM" onRequestIntegration={onRequestIntegration} creatingRequest onRecheck={onRecheck}/>);fireEvent.click(screen.getByRole('button',{name:'Створюємо задачу…'}));expect(screen.queryByRole('button',{name:'Оновити перевірку'})).toBeNull();expect(onRequestIntegration).not.toHaveBeenCalled();expect(onRecheck).not.toHaveBeenCalled();expect(screen.queryByText('Задачу Адміністратору створено')).toBeNull();
});
it('durable task receipt links only the same internal task and preserves local-save next step',()=>{
 const onRequestIntegration=vi.fn();render(<CreationDeliveryNotice readiness={readiness} categoryCode="NM" onRequestIntegration={onRequestIntegration} requestReceipt={{taskId,state:'open',href:'/attention?integrationTask='+taskId,message:'Адміністратор перевірить додаткову ознаку.'}}/>);expect(screen.getByRole('link',{name:'Відкрити задачу'}).getAttribute('href')).toBe('/attention?integrationTask='+taskId);expect(screen.getByText('Задачу Адміністратору створено')).toBeTruthy();expect(screen.queryByRole('button',{name:'Сформувати задачу Адміністратору'})).toBeNull();expect(screen.getByText(/Створення задачі не підтверджує доставку/)).toBeTruthy();expect(onRequestIntegration).not.toHaveBeenCalled();
});
it('resolved task is a local receipt requiring product recheck, never a confirmed delivery claim',()=>{
 render(<CreationDeliveryNotice readiness={readiness} categoryCode="NM" saved requestReceipt={{taskId,state:'resolved',href:'/attention?integrationTask='+taskId,message:'Налаштування перевірено.'}}/>);expect(screen.getByText('Перевірка на момент збереження')).toBeTruthy();expect(screen.getByText('Рішення за задачею позначено виконаним')).toBeTruthy();expect(screen.getByText(/Оновіть перевірку цього товару/)).toBeTruthy();expect(screen.queryByText(/Товар синхронізовано/)).toBeNull();
});
it('malformed or external task receipt holds result unconfirmed and cannot trigger another creation attempt',()=>{
 const onRequestIntegration=vi.fn();render(<CreationDeliveryNotice readiness={readiness} categoryCode="NM" onRequestIntegration={onRequestIntegration} requestReceipt={{taskId,state:'open',href:'https://external.invalid/task'}}/>);expect(screen.getByText(/Результат створення задачі ще не підтверджено/)).toBeTruthy();expect(screen.getByRole('button',{name:'Сформувати задачу Адміністратору'}).disabled).toBe(true);expect(screen.queryByRole('link')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Сформувати задачу Адміністратору'}));expect(onRequestIntegration).not.toHaveBeenCalled();
});

it.each([
 {code:'MAGENTO_CATEGORY_NOT_LINKED',questionKey:null,valueId:null,categoryCode:'ZZ',kind:'category',text:'Категорія «Нова категорія» не підключена в правилах',hint:{categoryCode:'ZZ',questionKey:null,valueId:null}},
 {code:'MAGENTO_SOURCE_VALUE_NOT_LINKED',questionKey:'shade',valueId:'0',categoryCode:'ZZ',kind:'source_value',text:'«Колір»: значення «Білий» не має прив’язки в правилах',hint:{categoryCode:'ZZ',questionKey:'shade',valueId:'0'}},
])('authoritative $kind warning requests exact category/value review without inventing a native upgrade',({code,questionKey,valueId,categoryCode,text,hint})=>{
 const request=vi.fn();render(<CreationDeliveryNotice readiness={{...readiness,code,questionKey,valueId,categoryCode}} categoryCode={categoryCode} categoryLabel="Нова категорія" questionLabel="Колір" valueLabel="Білий" onRequestIntegration={request}/>);expect(screen.getByText(new RegExp(text))).toBeTruthy();expect(screen.queryByText(/підтримку характеристик нових товарів ще не налаштовано/)).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Сформувати задачу Адміністратору'}));expect(request).toHaveBeenCalledExactlyOnceWith(hint);
});

it('short warning keeps an exact rule blocker and one task action without redundant support paragraphs', () => {
  const request = vi.fn();
  render(<CreationDeliveryNotice readiness={{ ...readiness, code: 'MAGENTO_SOURCE_VALUE_NOT_LINKED', categoryCode: 'ZZ', questionKey: 'shade', valueId: '0' }}
    categoryCode="ZZ" questionLabel="Колір" valueLabel="Білий" onRequestIntegration={request} />);
  const notice = screen.getByRole('alert', { name: 'Передавання нового товару в Magento' });
  expect(screen.getByText('Можна зберегти лише в менеджері.')).toBeTruthy();
  expect(screen.getByText('«Колір»: значення «Білий» не має прив’язки в правилах')).toBeTruthy();
  expect(notice.querySelectorAll('button')).toHaveLength(1);
  expect(notice.querySelector('details')).toBeNull();
  expect(request).not.toHaveBeenCalled();
});
it('an unsupported evaluator truthfully requests rule update rather than claiming a missing mapping', () => {
  render(<CreationDeliveryNotice readiness={readiness} categoryCode="NM" questionLabel="Додаткова ознака" onRequestIntegration={vi.fn()} />);
  expect(screen.getByText('Потрібне оновлення правил для «Додаткова ознака»')).toBeTruthy();
  expect(screen.queryByText(/не має прив’язки/)).toBeNull();
});

it('keeps an uncertain request locked while the explanation is opened, without another request', () => {
  const request = vi.fn();
  render(<CreationDeliveryNotice readiness={readiness} categoryCode="NM" onRequestIntegration={request}
    requestReceipt={{ taskId, state: 'open', href: '/attention?integrationTask=another-task' }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Сформувати задачу Адміністратору' }));
  expect(screen.getByText(/Результат створення задачі ще не підтверджено/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Сформувати задачу Адміністратору' }).disabled).toBe(true);
  expect(request).not.toHaveBeenCalled();
});
