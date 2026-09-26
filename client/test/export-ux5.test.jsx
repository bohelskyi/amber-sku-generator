import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SearchablePicker } from '../src/components/export-templates/SearchablePicker';
import { ExportDataGrid } from '../src/components/exports/ExportDataGrid';
import { PriceExportWorkspace } from '../src/components/exports/PriceExportWorkspace';
import { StoredSnapshot } from '../src/components/exports/StoredSnapshot';
import { WorkspaceNav } from '../src/components/app/WorkspaceNav';
import { WorkspaceDialog } from '../src/components/workspace/WorkspaceDialog';
import ExportHistoryPage from '../src/pages/ExportHistoryPage';
import { AuthContext } from '../src/auth/auth-context';
import { useProductExportController } from '../src/hooks/product/useProductExportController';
import { notifyExportReviewChanged } from '../src/lib/export-review-events';
import { exportsApi } from '../src/api/exports-api';
import { dateText } from '../src/lib/export-review-presentation';
vi.mock('../src/api/exports-api', () => ({ exportsApi: Object.fromEntries(['getStatus','getPriceStatus','preview','createSnapshot','getSnapshot','getHistory'].map((name) => [name, vi.fn()])) }));
const response = (data) => ({ data });
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const preview = { mode:'new', tableFingerprint:'first', representedCount:1, readyCount:1, errors:[], range:{fromSku:'SV1',toSku:'SV1'}, previewExpectation:'first' };
beforeEach(() => {
  Object.values(exportsApi).forEach((fn) => fn.mockReset());
  exportsApi.getStatus.mockResolvedValue(response({countSinceLastExport:1})); exportsApi.getPriceStatus.mockResolvedValue(response({pendingCount:0}));
  exportsApi.preview.mockResolvedValue(response(preview));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('one searchable control browses, filters, selects with keyboard, and Escape keeps the stored value', () => {
  const change = vi.fn(); const close = vi.fn(); render(<WorkspaceDialog title="Правило" onClose={close}><SearchablePicker label="Характеристика" value="color" onChange={change} options={[{value:'color',label:'Колір'},{value:'type',label:'Тип картини'}]} /></WorkspaceDialog>);
  const field=screen.getByRole('combobox'); fireEvent.focus(field);
  expect(screen.getAllByRole('option')).toHaveLength(2); fireEvent.change(field,{target:{value:'карти'}});
  expect(screen.getAllByRole('option')).toHaveLength(1); expect(change).not.toHaveBeenCalled(); fireEvent.keyDown(field,{key:'Enter'});
  expect(change).toHaveBeenCalledWith('type'); fireEvent.focus(field); fireEvent.change(field,{target:{value:'missing'}}); fireEvent.keyDown(field,{key:'Escape'});
  expect(screen.queryByRole('listbox')).toBeNull(); expect(field.value).toBe('Колір');
  expect(close).not.toHaveBeenCalled(); fireEvent.keyDown(field,{key:'Escape'}); expect(close).toHaveBeenCalledTimes(1);
});

const issue = {code:'manual_name_required',field:'name',target:{column:'name'}};
const problemRow = {ordinal:1,productId:9,sku:'SV1',language:'main',readiness:'attention',issues:[issue],cells:[{state:'not-evaluated',value:null}]};
it('category attention counts share loaded rows, distinct empty state leads to issues, and corrective action precedes symptom', () => {
  const handoff=vi.fn(); const edit=vi.fn(); render(<MemoryRouter><ExportDataGrid canDecode onHandoff={handoff} onEditName={edit} files={[
    {groupCode:'AR',headers:['name'],rows:[]},{groupCode:'SV',headers:['name'],rows:[problemRow,{...problemRow,ordinal:2,language:'en'}]},
  ]} /></MemoryRouter>);
  expect(screen.getByRole('tab',{name:'Сувеніри'}).textContent).toBe('Сувеніри1');
  fireEvent.change(screen.getByLabelText('Готовність'),{target:{value:'attention'}});
  expect(screen.getByText(/У категорії «Картини» зараз немає/)).toBeTruthy(); expect(screen.queryByRole('table')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Переглянути: Сувеніри · 1'}));
  fireEvent.click(screen.getByRole('button',{name:'Значення name, рядок 1, потребує уваги'}));
  const dialog=screen.getByRole('dialog'); const primary=within(dialog).getByRole('button',{name:'Заповнити назву'});
  expect(primary.className).toContain('btn-primary'); expect(dialog.textContent.indexOf('Потрібно вказати назву')).toBeLessThan(dialog.textContent.indexOf('Значення ще не обчислено'));
  fireEvent.click(within(dialog).getByRole('link',{name:'Відкрити товар'})); expect(handoff).toHaveBeenCalledWith({sku:'SV1',reason:'Потрібно вказати назву'});
  expect(exportsApi.preview).not.toHaveBeenCalled();
});

it('read-only handoff does not stale; a successful mutation requests a new authoritative read and failed read keeps stale evidence', async () => {
  const life={valid:true}; const {result}=renderHook(()=>useProductExportController({principalLifetime:life}));
  await act(async()=>result.current.handlePreviewExport());
  act(()=>result.current.beginExportHandoff({sku:'SV1',returnTo:'/exports'}));
  expect(result.current.exportReviewStale).toBe(false); expect(exportsApi.preview).toHaveBeenCalledTimes(1);
  const read=deferred(); exportsApi.preview.mockReturnValueOnce(read.promise);
  act(()=>notifyExportReviewChanged({kind:'product'})); expect(result.current.exportRefreshing).toBe(true); expect(result.current.exportReviewStale).toBe(true);
  await act(async()=>read.reject(new Error('offline')));
  expect(result.current.exportPreview.tableFingerprint).toBe('first'); expect(result.current.exportReviewStale).toBe(true); expect(result.current.exportError).toBe('offline');
  exportsApi.preview.mockResolvedValueOnce(response({...preview,tableFingerprint:'second'}));
  await act(async()=>result.current.refreshAfterProductChange());
  expect(result.current.exportPreview.tableFingerprint).toBe('second'); expect(result.current.exportReviewStale).toBe(false);
  expect(exportsApi.preview.mock.calls).toEqual([[{mode:'new'}],[{mode:'new'}],[{mode:'new'}]]); expect(exportsApi.createSnapshot).not.toHaveBeenCalled();
});

it('new read after mutation never changes an uncertain original creation payload or retry key', async()=>{
  const {result}=renderHook(()=>useProductExportController()); await act(async()=>result.current.handlePreviewExport());
  exportsApi.createSnapshot.mockRejectedValue(new Error('unknown')); await act(async()=>result.current.handleCreateSnapshot());
  const original=exportsApi.createSnapshot.mock.calls[0];
  exportsApi.preview.mockResolvedValue(response({...preview,tableFingerprint:'new',previewExpectation:'new'}));
  await act(async()=>result.current.refreshAfterProductChange()); await act(async()=>result.current.handleCreateSnapshot());
  expect(exportsApi.createSnapshot.mock.calls[1]).toEqual(original); expect(result.current.pendingCreate.evidence.tableFingerprint).toBe('first');
});

it('late automatic preview cannot cross a principal lifetime', async()=>{
  const life={valid:true}; const {result}=renderHook(()=>useProductExportController({principalLifetime:life})); await act(async()=>result.current.handlePreviewExport());
  const pending=deferred(); exportsApi.preview.mockReturnValueOnce(pending.promise); let recheck;
  act(()=>{ recheck=result.current.refreshAfterProductChange(); }); life.valid=false;
  await act(async()=>{pending.resolve(response({...preview,tableFingerprint:'foreign'}));await recheck;});
  expect(result.current.exportPreview.tableFingerprint).toBe('first'); expect(result.current.exportReviewStale).toBe(true);
});

it('empty price queue has no grid, filters or pagination; absent stored artifacts make no CSV claim',()=>{
  const view=render(<PriceExportWorkspace canCreate workflow={{review:{checkedAt:'2026-09-26T09:00:00Z',rowCount:0,csvContent:'sku,price'},check:vi.fn()}} />);
  expect(screen.queryByLabelText('Пошук SKU')).toBeNull();expect(screen.queryByRole('table')).toBeNull();expect(screen.queryByText(/0–0/)).toBeNull();
  view.unmount();render(<StoredSnapshot snapshot={{id:'old',artifacts:[],status:'confirmed'}}/>);
  expect(screen.getByText(/Файли CSV для цього запису недоступні/)).toBeTruthy(); expect(screen.queryByText(/Таблиця читається зі створеного файлу/)).toBeNull();
});

it('navigation overflow keeps permission filtering, keyboard access and Escape restores its trigger',()=>{
  render(<AuthContext.Provider value={{permissions:['exports.view','audit.view'],identity:{},logout:vi.fn()}}><MemoryRouter><WorkspaceNav/></MemoryRouter></AuthContext.Provider>);
  const trigger=screen.getByRole('button',{name:/Розділи/}); fireEvent.click(trigger);
  const audit=screen.getByRole('link',{name:'Аудит'});audit.focus();expect(screen.queryByRole('link',{name:'Користувачі'})).toBeNull();
  fireEvent.keyDown(audit,{key:'Escape'});expect(screen.queryByRole('link',{name:'Аудит'})).toBeNull();expect(document.activeElement).toBe(trigger);
});

it('history shows only authoritative names and accessible session context, with local dates and unknown historical authors',async()=>{
  const item={id:'new',stream:'product',status:'generated',generatedAt:'2026-09-26T09:00:00Z',createdByUserId:4,createdByName:'Олена',sessionId:'private',sessionTitle:'Вересень',artifacts:[],productCount:1};
  exportsApi.getHistory.mockResolvedValue(response({items:[item,{...item,id:'old',createdByUserId:null,createdByName:null,sessionId:undefined,sessionTitle:undefined}],next:null}));
  render(<AuthContext.Provider value={{applicationUser:{id:4},permissions:['exports.view']}}><MemoryRouter><ExportHistoryPage/></MemoryRouter></AuthContext.Provider>);
  await screen.findByText('Автор: Олена');expect(screen.getByText('Автор невідомий')).toBeTruthy();
  expect(screen.getByRole('link',{name:'Вересень'}).getAttribute('href')).toBe('/exports/sessions/private');
  expect(screen.getAllByText('Створено: '+dateText(item.generatedAt))).toHaveLength(2); await waitFor(()=>expect(exportsApi.getHistory).toHaveBeenCalledTimes(1));
});
