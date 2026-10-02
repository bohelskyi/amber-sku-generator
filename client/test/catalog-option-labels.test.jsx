import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {OptionForm} from '../src/components/admin/AdminCatalogForms.jsx';
afterEach(cleanup);
it('create/edit catalog forms expose independent Ukrainian and optional English labels without fallback',()=>{
  for(const isNew of [true,false]){
    const onChange=vi.fn(),option={label:'Скриньки',label_en:null,value_id:'8',sku_code:'91'};
    const form=(value)=><OptionForm isNew={isNew} config={{categories:{},questions:{}}} currentCatQuestions={[]} option={value} onChange={onChange} onSave={vi.fn()} onCancel={vi.fn()}/>;
    const {rerender}=render(form(option));
    expect(screen.getByLabelText('Назва українською').value).toBe('Скриньки');
    expect(screen.getByLabelText('Назва українською').maxLength).toBe(255);
    const en=screen.getByLabelText(/Назва англійською/);expect(en.value).toBe('');
    fireEvent.change(en,{target:{value:'Amber boxes'}});
    expect(onChange).toHaveBeenCalledWith({...option,label_en:'Amber boxes'});
    rerender(form({...option,label_en:'Amber boxes'}));
    fireEvent.change(en,{target:{value:''}});
    expect(onChange).toHaveBeenLastCalledWith({...option,label_en:''});
    cleanup();
  }
});
