import { useState } from 'react';
import { act, cleanup, render, renderHook, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ProductBuilder } from '../src/components/app/ProductBuilder';
import { useSkuManager } from '../src/hooks/useSkuManager';
import { api } from '../src/lib/api';
const config={categories:{SV:{name:'Сувеніри'}},questions:{SV:[{id:'size',label:'Розмір',required:0,input_type:'text'},{id:'weight',label:'Вага',required:0,input_type:'text'}]},
  productCreateRequirements:{SV:{requiredAnswers:['size','weight'],automaticName:{question:'souvenir',values:['6']}}}};
function Form({souvenir,preview}){
  const [answers,setAnswers]=useState({souvenir,weight:'12.5'}),[names,setNames]=useState({});
  return <ProductBuilder config={config} selectedCat="SV" answers={answers} nameSubjects={names} onNameSubject={(k,v)=>setNames(p=>({...p,[k]:v}))}
    isQuestionVisible={()=>true} isTextQuestion={()=>true} getVisibleOptionsForQuestion={()=>[]} onTextAnswer={(k,v)=>setAnswers(p=>({...p,[k]:v}))}
    onPreview={preview} onCancel={()=>{}} requiredCount={4} answeredRequiredCount={1}/>;
}
beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it.each([1,5])('new SV route %s exposes required paired subjects and size before preview', async souvenir=>{
  const preview=vi.fn();render(<Form souvenir={souvenir} preview={preview}/>);
  const ua=screen.getByLabelText(/Назва предмета українською/),en=screen.getByLabelText(/Назва предмета англійською/);
  expect(ua.required).toBe(true);expect(en.required).toBe(true);expect(screen.getByLabelText(/Розмір/).required).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Перевірити дані'}));expect(preview).not.toHaveBeenCalled();
  fireEvent.change(ua,{target:{value:'Сувенір'}});fireEvent.change(en,{target:{value:'souvenir'}});fireEvent.change(screen.getByLabelText(/Розмір/),{target:{value:'3/2'}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити дані'}));expect(preview).toHaveBeenCalledTimes(1);
});
it('keychain uses the automatic name but cannot preview without size',()=>{
  const preview=vi.fn();render(<Form souvenir={6} preview={preview}/>);
  expect(screen.queryByLabelText(/Назва предмета українською/)).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Перевірити дані'}));expect(preview).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText(/Розмір/),{target:{value:'3/2'}});
  fireEvent.click(screen.getByRole('button',{name:'Перевірити дані'}));expect(preview).toHaveBeenCalledTimes(1);
});

it('creation controller sends the subject pair through preview/save and invalidates edits without carrying subjects to another route', async () => {
  const posts = [];
  vi.spyOn(api, 'get').mockImplementation(async url => ({ data: url === '/config' ? { ...config, extraConfig: {} } : [] }));
  vi.spyOn(api, 'post').mockImplementation(async (url, body) => {
    posts.push({ url, body });
    return { data: { fullProposedSku: 'SV-NEW', skuSchemaVersionId: 6, previewToken: 'bound-subjects', totalPriceUah: 1000, weightVal: 0 } };
  });
  const { result } = renderHook(() => useSkuManager());
  await waitFor(() => expect(result.current.config).not.toBeNull());
  act(() => result.current.resetProductFlow('SV'));
  act(() => {
    result.current.handleAnswer('souvenir', '1');
    result.current.handleTextAnswer('size', '3/2');
    result.current.handleTextAnswer('weight', '12.5');
    result.current.handleNameSubject('magento_name_subject_ua', 'Сокіл');
    result.current.handleNameSubject('magento_name_subject_en', 'falcon');
  });
  await act(() => result.current.handlePreview());
  const names = { magento_name_subject_ua: 'Сокіл', magento_name_subject_en: 'falcon' };
  expect(posts.find(p => p.url === '/preview').body).toMatchObject(names);
  act(() => result.current.handleNameSubject('magento_name_subject_en', 'new falcon'));
  expect(result.current.previewData).toBeNull();
  await act(() => result.current.handlePreview());
  act(() => result.current.handleSave());
  await waitFor(() => expect(result.current.selectedCat).toBeNull());
  expect(posts.find(p => p.url === '/save').body).toMatchObject({ ...names, magento_name_subject_en: 'new falcon', previewToken: 'bound-subjects', answers: { size: '3/2', weight: '12.5' } });
  expect(result.current.nameSubjects.magento_name_subject_ua).toBe('');
  act(() => result.current.resetProductFlow('SV'));
  act(() => result.current.handleNameSubject('magento_name_subject_ua', 'Previous subject'));
  act(() => result.current.handleAnswer('souvenir', '6'));
  expect(result.current.nameSubjects.magento_name_subject_ua).toBe('');
});

