import {useContext,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {AuthContext} from '../auth/auth-context.js';
import {api} from '../lib/api.js';
import {getApiError} from '../lib/http-error.js';

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const DEFINITE=new Set(['VALIDATION_ERROR','ADMIN_PERMISSION_REVOKED','INTEGRATION_TASK_PREVIEW_STALE',
  'INTEGRATION_TASK_NOT_REQUIRED','INTEGRATION_TASK_PHOTOS_UNAVAILABLE','INTEGRATION_TASK_OPEN_LIMIT']);
export function validateIntegrationTaskReceipt(data) {
  if(!data || !UUID.test(data.id) || !['open','resolved','cancelled'].includes(data.state)
    || !/^[1-9][0-9]{0,17}$/.test(data.revision) || data.deliveryAccepted!==false)throw new Error('Результат створення задачі ще не підтверджено.');
  return {taskId:data.id,state:data.state,href:'/attention?integrationTask='+data.id,
    message:data.state==='open'?'Інтеграційну задачу збережено для адміністратора.':'Знайдено збережену інтеграційну задачу.'};
}
export function useCreationIntegrationTask({available,canCreate,busy,product,previewData}={}) {
  const {principalLifetime}=useContext(AuthContext) || {};
  const attempt=useRef(null);const flight=useRef(false);const lifetime=useRef({valid:true});const currentContext=useRef('');
  const [creatingRequest,setCreating]=useState(false);const [receipt,setReceipt]=useState(null);const [error,setError]=useState('');
  const context=JSON.stringify(product || null);
  useLayoutEffect(()=>{currentContext.current=context;},[context]);
  useEffect(()=>{
    const ticket={valid:true};lifetime.current=ticket;attempt.current=null;flight.current=false;
    let active=true;
    Promise.resolve().then(()=>{if(active){setReceipt(null);setError('');setCreating(false);}});
    return ()=>{active=false;ticket.valid=false;};
  },[principalLifetime]);
  const request=async()=>{
    if(!available || !canCreate || busy || flight.current || principalLifetime?.valid===false)return;
    if(!attempt.current && (!previewData?.previewToken || previewData.creationDeliveryReadiness?.status!=='configuration_required'))return;
    const ticket=lifetime.current;flight.current=true;setCreating(true);setError('');
    const valid=()=>ticket.valid && principalLifetime?.valid!==false;
    try {
      let response;
      if(attempt.current) {
        // Unknown writes are recovered by GET only. A missing receipt is not proof of nonacceptance.
        response=await api.get('/integration-tasks/attempts/'+attempt.current.command.clientRequestId);
      } else {
        attempt.current={context,command:JSON.parse(JSON.stringify({clientRequestId:crypto.randomUUID(),
          expectedPreviewToken:previewData.integrationTaskPreviewToken || previewData.previewToken,product}))};
        response=await api.post('/integration-tasks',attempt.current.command);
      }
      const confirmed=validateIntegrationTaskReceipt(response.data);
      if(!valid())return;
      const acceptedContext=attempt.current.context;
      setReceipt({...confirmed,context:acceptedContext});attempt.current=null;
      if(acceptedContext!==currentContext.current)setError('Задачу попередніх введених даних збережено. Поточні дані товару залишилися у формі.');
    } catch(failure) {
      if(!valid())return;
      if(DEFINITE.has(failure.response?.data?.code) && failure.response.status<500)attempt.current=null;
      setError(attempt.current?'Результат задачі ще не підтверджено. Наступне натискання перевірить ту саму спробу без повторного надсилання.':getApiError(failure));
    } finally {if(valid()){flight.current=false;setCreating(false);}}
  };
  return {onRequestIntegration:available && canCreate?request:undefined,creatingRequest,
    requestReceipt:receipt?.context===context?receipt:null,integrationTaskError:error};
}
