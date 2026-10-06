import {useContext,useEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {AuthContext} from '../../auth/auth-context.js';
import {api} from '../../lib/api.js';
import {getApiError} from '../../lib/http-error.js';
import {validateIntegrationResume} from '../../lib/integration-task-resume.js';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export default function CreationIntegrationResume({taskId,config,canCreate,onResume,busy=false,dirty=false}) {
  const {principalLifetime}=useContext(AuthContext) || {};
  const [task,setTask]=useState(null);const [error,setError]=useState('');const [loading,setLoading]=useState(false);
  const [applied,setApplied]=useState(false);const sequence=useRef(0);
  useEffect(()=>{
    let active=true;const ticket=++sequence.current;
    const current=()=>active && sequence.current===ticket && principalLifetime?.valid!==false;
    const load=async()=>{
      await Promise.resolve();if(!current())return;
      setApplied(false);setTask(null);setError('');
      if(!canCreate || !UUID.test(taskId || '')){setError('Некоректна або недоступна інтеграційна задача.');return;}
      setLoading(true);
      try {
        const {data}=await api.get('/integration-tasks/'+taskId);
        if(!current())return;
        validateIntegrationResume(data,taskId,config);setTask(data);
      } catch(failure){if(current())setError(failure.response?getApiError(failure):failure.message);}
      finally{if(current())setLoading(false);}
    };
    if(config)load();return()=>{active=false;};
  },[taskId,config,canCreate,principalLifetime]);
  if(!taskId)return null;
  return <section className="rounded border border-slate-200 bg-white p-4 mb-4" aria-label="Повернення до введення товару">
    <h2 className="font-semibold">Повернутися до введення товару</h2>
    {loading && <p role="status">Завантаження збережених даних задачі…</p>}
    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
    {task && !applied && <>
      <p className="text-sm mt-2">{task.categoryLabel}: збережено {Object.keys(task.creationContext.product.answers).length} характеристик і {task.creationContext.photoCount} фото. Дані не створюють товар; після відновлення потрібна нова перевірка.</p>
      {dirty && <p className="text-sm mt-2">Відновлення замінить поточні незбережені поля та фото даними цієї задачі.</p>}
      <button type="button" className="btn btn-primary mt-3" disabled={busy || !canCreate} onClick={()=>{
        try {
          const context=validateIntegrationResume(task,taskId,config);
          if(onResume?.(context,taskId)===true)setApplied(true);
          else setError('Завершіть поточну операцію перед відновленням.');
        } catch(failure){setError(failure.message);}
      }}>{dirty?'Замінити форму збереженими даними':'Відновити введені дані та фото'}</button>
    </>}
    {applied && <p role="status" className="text-sm mt-2">Дані та фото відновлено. Перевірте їх перед збереженням товару.</p>}
    {UUID.test(taskId) && <Link className="btn btn-ghost mt-2" to={'/attention?integrationTask='+taskId}>Відкрити інтеграційну задачу</Link>}
  </section>;
}
