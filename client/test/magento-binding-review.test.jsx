import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
it('v4 uses the normal grid and new category authoring remains a local reviewed template draft', async () => {
  const d = definition(); const change = vi.fn();
  api.get.mockResolvedValue({ data: { categories: [{ code: 'ZZ', name: 'Нова категорія' }] } });
  api.post.mockResolvedValue({ data: { categories: [{ categoryId: '12', normalizedPath: 'Default/Нова', comparable: true }], schema: { attributeSets: [{ attribute_set_id: 151, attribute_set_name: 'Fixture set' }] } } });
  render(<DefinitionEditor definition={d} registry={{ productFields: [] }} onChange={change} />);
  expect(screen.getByRole('table')).toBeTruthy();
  expect(screen.queryByText('Цей формат ще не підтримується формами.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Додати категорію до правил' }));
  await screen.findByRole('option', { name: 'Нова категорія' });
  const fields = { 'Категорія товару': 'ZZ', 'Основна назва товару українською': 'Свідома назва', 'Основна назва товару англійською': 'Reviewed English name' };
  for (const [label, value] of Object.entries(fields)) fireEvent.change(screen.getByLabelText(label), { target: { value } });
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Прочитати структуру магазину' }));
  await screen.findByRole('button', { name: 'Default › Нова' });
  fireEvent.change(screen.getByLabelText('Набір характеристик'), { target: { value: 'Fixture set' } });
  fireEvent.click(screen.getByRole('button', { name: 'Default › Нова' }));
  fireEvent.click(screen.getByRole('button', { name: 'Додати категорію до чернетки' }));
  const next = change.mock.calls[0][0]; expect(next.groups.at(-1).route).toBe('ZZ');
  expect(compileDefinition(next).definition.evaluatorVersion).toBe('magento-declarative-4');
  expect(d.groups).toHaveLength(1); expect(api.post.mock.calls).toEqual([['/admin/magento-integration/discovery', {}]]);
  expect(() => addIntegrationCategory(d, { code: 'YY' })).toThrow();
});
it('keeps pending category fields while the editor is hidden by a navigation guard and restores them on Stay', async () => {
  const d = definition(); const change = vi.fn(); const pending = vi.fn();
  api.get.mockResolvedValue({ data: { categories: [{ code: 'ZZ', name: 'Нова категорія' }] } });
  const props = { definition: d, registry: { productFields: [] }, onChange: change, onPendingChange: pending, initialCategory: 'ZZ' };
  const view = render(<DefinitionEditor {...props} />);
  await screen.findByRole('option', { name: 'Нова категорія' });
  fireEvent.change(screen.getByLabelText('Основна назва товару українською'), { target: { value: 'Збережене заповнення' } });
  expect(pending).toHaveBeenLastCalledWith(true);
  view.rerender(<DefinitionEditor {...props} visible={false} />);
  view.rerender(<DefinitionEditor {...props} visible />);
  expect(screen.getByLabelText('Основна назва товару українською').value).toBe('Збережене заповнення');
  expect(pending).toHaveBeenLastCalledWith(true);
  expect(api.get).toHaveBeenCalledOnce();
  expect(api.post).not.toHaveBeenCalled();
});
it('review candidate selection is separate from approval and exact clone is a separate command', async () => {
  const revision = { id: 'draft', state: 'draft', revision: '1', templateId: 'family', templateVersionId: 'version',
    bindings: { attributes: [] }, schema: { attributeSets: [{ attribute_set_id: 151, attribute_set_name: 'Сувеніри' }], attributes: [] } };
  api.get.mockResolvedValue({ data: { revision, validation: { valid: false, diagnostics: [{}] },
    entries: [{ id: 'route:SV:all', kind: 'route', group: 'SV', target: 'attribute_set_code', reviewState: 'review_required', identity: 151, label: 'Сувеніри', exact: false }] } });
  api.post.mockResolvedValue({ data: { ...revision, revision: '2' } }); const changed = vi.fn();
  render(<AuthContext.Provider value={{ permissions: ['export_templates.manage'] }}><MemoryRouter><MagentoBindingReview revision={revision} onChanged={changed} /></MemoryRouter></AuthContext.Provider>);
  await screen.findByText('Невирішених структурних питань: 1');
  fireEvent.click(screen.getByText('Рішення за маршрутами та полями').closest('summary'));
  fireEvent.change(screen.getByLabelText('Кандидат'), { target: { value: '151' } });
  fireEvent.click(screen.getByRole('button', { name: 'Вибрати кандидата' }));
  await vi.waitFor(() => expect(changed).toHaveBeenCalled());
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-integration/bindings/draft/select', { expectedRevision: '1', binding: 'route:SV:all', identity: 151 });
  expect(screen.queryByRole('button', { name: /Опублікувати/ })).toBeNull();
});

const draft = {id:'draft',state:'draft',revision:'3',templateId:'family',templateVersionId:'version',bindings:{attributes:[]},schema:{attributes:[],attributeSets:[]}};
const reviewData=(entries,revision=draft)=>({revision,entries,validation:{valid:false,diagnostics:[{}]}});
function shell(props={},permissions=['export_templates.manage']) {
  return render(<AuthContext.Provider value={{permissions}}><MemoryRouter><MagentoBindingReview revision={draft} mode="review" onChanged={vi.fn()} {...props}/></MemoryRouter></AuthContext.Provider>);
}
it('mounts only unresolved entries from the selected category in bounded pages until all mappings are requested',async()=>{
  const entry=(index,reviewState,group='SV')=>({id:`attribute:${reviewState}-${index}`,kind:'attribute',group,target:'fixture',label:`${reviewState}-${index}`,reviewState,identity:1471,exact:false,evidence:{secret:'unmounted-evidence'}});
  const entries=[...Array.from({length:60},(_,i)=>entry(i,'review_required')),
    ...Array.from({length:200},(_,i)=>entry(i,'approved')),entry(1,'blocked'),entry(1,'not_applicable'),entry(999,'review_required','BR')];
  api.get.mockResolvedValue({data:reviewData(entries)});shell({categoryCode:'SV'});
  await screen.findByText('Потребують перевірки: 60. Усього відповідностей: 262.');
  expect(screen.getAllByRole('article')).toHaveLength(50);
  expect(screen.queryByRole('article',{name:'Атрибут: approved-0'})).toBeNull();
  expect(screen.queryByRole('article',{name:'Атрибут: blocked-1'})).toBeNull();
  expect(screen.queryByRole('article',{name:'Атрибут: not_applicable-1'})).toBeNull();
  expect(screen.queryByText(/unmounted-evidence/)).toBeNull();
  fireEvent.click(within(screen.getByRole('navigation',{name:'Сторінки відповідностей'})).getByRole('button',{name:'Далі'}));
  expect(screen.getAllByRole('article')).toHaveLength(10);
  expect(screen.queryByRole('article',{name:'Атрибут: review_required-999'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Показати всі відповідності'}));
  fireEvent.click(within(screen.getByRole('navigation',{name:'Сторінки відповідностей'})).getByRole('button',{name:'Далі'}));
  expect(screen.getByRole('article',{name:'Атрибут: approved-0'})).toBeTruthy();
  expect(screen.getAllByRole('article')).toHaveLength(50);
  expect(api.get).toHaveBeenCalledTimes(1);expect(api.post).not.toHaveBeenCalled();
});
it.each(['magento_managed','initialize_create_only','blocked'])('uses the actual %s policy and never defaults to broader field ownership',async identity=>{
  const entry={id:'policy:field:all',kind:'policy',group:'SV',row:'base',target:'product_online',label:'all',reviewState:'review_required',identity,exact:false,evidence:{}};
  api.get.mockResolvedValue({data:reviewData([entry])});api.post.mockResolvedValue({data:{...draft,revision:'4'}});
  shell();const select=await screen.findByLabelText('Доставка поля');
  expect(select.value).toBe(identity==='blocked'?'':identity);
  fireEvent.change(screen.getByLabelText('Пояснення перевірки'),{target:{value:'Перевірене правило'}});
  const approve=screen.getByRole('button',{name:'Підтвердити зв’язок'});
  if(identity==='blocked'){
    expect(approve.disabled).toBe(true);
    fireEvent.change(select,{target:{value:'magento_managed'}});
  }
  fireEvent.click(approve);
  expect(api.post).toHaveBeenCalledWith('/admin/magento-integration/bindings/draft/decision',expect.objectContaining({expectedRevision:'3',binding:'policy:field:all',action:'approve',policy:identity==='blocked'?'magento_managed':identity}));
  if(identity==='initialize_create_only')expect(api.post.mock.calls[0][1].createValue).toBe('2');
});
it('successor mode requires the current publication and keeps fresh observation separate from an exact clone',async()=>{
  const publication={...draft,id:'active',state:'published'};
  const view=shell({revision:publication,currentPublishedId:'newer',mode:'successor'});
  expect(screen.queryByRole('button',{name:/Перевірити наступну/})).toBeNull();expect(api.get).not.toHaveBeenCalled();
  view.unmount();const changed=vi.fn();shell({revision:publication,currentPublishedId:'active',mode:'successor',onChanged:changed,
    templateVersions:[{id:'template-v2',display_name:'Шаблон',version_number:2}]});
  expect(screen.getByText(/неопубліковані рішення автоматично не переносяться/)).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Створити точну чернетку'})).toBeNull();
  fireEvent.change(screen.getByLabelText('Опублікований шаблон наступної версії'),{target:{value:'template-v2'}});
  api.post.mockResolvedValueOnce({data:{previewToken:'fresh-proof',carried:{approvalsCarried:7},productIds:[],blockers:[]}})
    .mockResolvedValueOnce({data:{...draft,id:'new-draft'}});
  fireEvent.click(screen.getByRole('button',{name:/Перевірити наступну/}));
  fireEvent.click(await screen.findByRole('button',{name:'Підготувати наступну чернетку'}));
  await vi.waitFor(()=>expect(changed).toHaveBeenCalledWith({...draft,id:'new-draft'}));
  expect(api.post.mock.calls[1]).toEqual(['/admin/magento-integration/successor/apply',{sourceId:'active',expectedSourceRevision:'3',templateVersionId:'template-v2',previewToken:'fresh-proof'}]);
  expect(api.get).not.toHaveBeenCalled();
});
it('late mapping reads cannot populate a different draft review',async()=>{
  let resolveOld;api.get.mockReturnValueOnce(new Promise(resolve=>{resolveOld=resolve;}))
    .mockResolvedValueOnce({data:reviewData([{id:'attribute:new',kind:'attribute',group:'SV',target:'new',label:'New draft row',reviewState:'approved',identity:1}],{...draft,id:'new-draft'})});
  const view=shell();view.rerender(<AuthContext.Provider value={{permissions:[]}}><MemoryRouter><MagentoBindingReview revision={{...draft,id:'new-draft'}} mode="review"/></MemoryRouter></AuthContext.Provider>);
  await screen.findByText('Потребують перевірки: 0. Усього відповідностей: 1.');
  await act(async()=>resolveOld({data:reviewData([{id:'old',group:'SV',kind:'attribute',label:'Old response',reviewState:'review_required',identity:1}])}));
  expect(screen.queryByText(/Old response/)).toBeNull();
});
it('exact clone remains explicit and a late mutation cannot change a departed preparation context',async()=>{
  let resolveClone;api.post.mockReturnValueOnce(new Promise(resolve=>{resolveClone=resolve;}));
  const changed=vi.fn();const publication={...draft,id:'active',state:'published'};
  const view=shell({revision:publication,currentPublishedId:'active',mode:'successor',onChanged:changed});
  fireEvent.click(screen.getByText('Точна копія без нового спостереження').closest('summary'));
  fireEvent.click(screen.getByRole('button',{name:'Створити точну чернетку'}));
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-integration/bindings/active/clone',{expectedRevision:'3'});
  view.unmount();await act(async()=>resolveClone({data:{...draft,id:'copied'}}));
  expect(changed).not.toHaveBeenCalled();
});
