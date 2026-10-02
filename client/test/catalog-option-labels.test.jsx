import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {OptionForm} from '../src/components/admin/AdminCatalogForms.jsx';
afterEach(cleanup);
it('create/edit catalog forms expose independent Ukrainian and optional English labels without fallback',()=>{
  for(const isNew of [true,false]){
    const onChange=vi.fn(),option={label:'Скриньки',label_en:null,value_id:'8',sku_code:'91'};
    render(<OptionForm isNew={isNew} config={{categories:{},questions:{}}} currentCatQuestions={[]} option={option} onChange={onChange} onSave={vi.fn()} onCancel={vi.fn()}/>);
    expect(screen.getByLabelText('Назва українською').value).toBe('Скриньки');
    const en=screen.getByLabelText(/Назва англійською/);expect(en.value).toBe('');
    fireEvent.change(en,{target:{value:'Amber boxes'}});
    expect(onChange).toHaveBeenCalledWith({...option,label_en:'Amber boxes'});
    cleanup();
  }
});
