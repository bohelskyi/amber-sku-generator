import { useCallback,useContext,useEffect,useRef,useState } from 'react';
import { AuthContext } from '../auth/auth-context.js';
import { api } from '../lib/api.js';
import { getApiError } from '../lib/http-error.js';

// One MiB per original photo; upload encoding overhead is handled by the server.
const MAX_BYTES=1024*1024;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function validateRead(data,productId) {
  if (!data || Number(data.productId)!==Number(productId) || !/^\d{1,18}$/.test(String(data.version))
    || !Array.isArray(data.photos) || data.photos.length>8 || new Set(data.photos.map((p)=>p?.id)).size!==data.photos.length
    || data.photos.some((p)=>!p || !UUID.test(p.id) || typeof p.name!=='string' || !['image/jpeg','image/png'].includes(p.mimeType))
    || typeof data.enableWhenVerified!=='boolean' || (data.delivery!==null && (!data.delivery || !['pending','running','uncertain','blocked','succeeded','superseded'].includes(data.delivery.state)))) {
    throw new Error('Сервер повернув некоректний стан фотографій. Оновіть товар.');
  }
  return data;
}
function encodeFile(file) {
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error('Не вдалося прочитати фото.'));
    reader.onload=()=>resolve(String(reader.result).slice(String(reader.result).indexOf(',')+1));
    reader.readAsDataURL(file);
  });
}
export function useProductPhotos({productId=null,canEdit=true,onSaved,allowProductActivation=true}={}) {
  const {principalLifetime}=useContext(AuthContext) || {};
  const generation=useRef(0); const alive=useRef(false); const inFlight=useRef(false);
  const baseline=useRef(null);const loaded=useRef(!productId);
  const saveAttempt=useRef(null); const pendingFiles=useRef([]);
  const [photos,setPhotos]=useState([]); const [enableWhenVerified,setEnable]=useState(false);
  const [version,setVersion]=useState('0'); const [delivery,setDelivery]=useState(null);
  const [loading,setLoading]=useState(Boolean(productId)); const [busy,setBusy]=useState(false);
  const [error,setError]=useState(''); const [failedUploads,setFailedUploads]=useState([]);
  const [pollError,setPollError]=useState('');
  const [dirty,setDirty]=useState(false);
  const [ready,setReady]=useState(!productId);
  const current=useCallback((value)=>alive.current && value===generation.current && principalLifetime?.valid!==false,[principalLifetime]);
  const reload=useCallback(async({adopt=true}={})=>{
    if (!productId) return;
    const value=generation.current;
    const response=await api.get(`/products/${productId}/photos`);const data=validateRead(response.data,productId);
    if (!current(value)) return;
    setDelivery(data.delivery);
    setPollError('');
    if (adopt) {
      baseline.current={photos:data.photos,enableWhenVerified:data.enableWhenVerified,version:data.version};loaded.current=true;
      setReady(true);
      setPhotos(data.photos);setEnable(data.enableWhenVerified);setVersion(data.version);setDirty(false);saveAttempt.current=null;
    }
  },[productId,current]);
  useEffect(()=>{
    alive.current=true; generation.current++;
    inFlight.current=false;saveAttempt.current=null;pendingFiles.current=[];baseline.current=null;loaded.current=!productId;
    const value=generation.current;
    const initialize=async()=>{
      await Promise.resolve();
      if(!current(value))return;
      setPhotos([]);setEnable(false);setVersion('0');setDelivery(null);setError('');setPollError('');setFailedUploads([]);setDirty(false);setBusy(false);
      setLoading(Boolean(productId));setReady(!productId);
      if(productId)try {await reload();}
      catch(failure){if(current(value))setError(getApiError(failure));}
      finally{if(current(value))setLoading(false);}
    };
    initialize();
    return ()=>{alive.current=false;};
  },[productId,principalLifetime,reload,current]);
  useEffect(()=>{
    if (!productId || !['pending','running'].includes(delivery?.state)) return;
    let stopped=false;let timer;const value=generation.current;
    const poll=async()=>{
      try {await reload({adopt:false});}
      catch {if(current(value))setPollError('Не вдалося оновити стан передавання фото. Показано останній відомий стан.');}
      finally {if(!stopped && current(value))timer=setTimeout(poll,5000);}
    };
    timer=setTimeout(poll,5000);
    return ()=>{stopped=true;clearTimeout(timer);};
  },[productId,delivery?.state,reload,current]);
  const edit=(operation)=>{
    if(!canEdit || inFlight.current || !loaded.current)return;
    saveAttempt.current=null;setError('');setDirty(true);operation();
  };
  const upload=async(entries)=>{
    if(!canEdit || inFlight.current || !loaded.current)return;
    const value=generation.current;inFlight.current=true;setBusy(true);setError('');
    const failed=[];
    for(const entry of entries) {
      try {
        if(!entry.file || !['image/png','image/jpeg'].includes(entry.file.type) || entry.file.size<32) throw new Error('Виберіть коректне фото JPEG або PNG.');
        if(entry.file.size>MAX_BYTES) throw new Error(`Фото «${entry.file.name}» завелике. Оберіть фото до 1 МіБ (1 048 576 байтів).`);
        entry.base64 ||= await encodeFile(entry.file);
        if(!current(value))return;
        const {data}=await api.post('/product-photos/stage',{idempotencyKey:entry.key,name:entry.file.name,mimeType:entry.file.type,base64:entry.base64});
        if(!current(value))return;
        setPhotos((existing)=>[...existing,data]);setEnable(true);setDirty(true);saveAttempt.current=null;
      } catch(failure) {
        if(!current(value))return;
        failed.push(entry);setError(failure.response ? getApiError(failure) : failure.message || 'Не вдалося додати фото.');
      }
    }
    if(current(value)){pendingFiles.current=failed;setFailedUploads(failed.map((entry)=>({key:entry.key,name:entry.file.name})));inFlight.current=false;setBusy(false);}
  };
  const addFiles=(files)=>{
    if(photos.length+pendingFiles.current.length+files.length>8){setError('До товару можна додати не більше 8 фото.');return;}
    return upload([...pendingFiles.current,...Array.from(files,(file)=>({file,key:crypto.randomUUID()}))]);
  };
  const perform=async(action)=>{
    if(!productId || !canEdit || inFlight.current || !loaded.current || pendingFiles.current.length)return;
    const value=generation.current;inFlight.current=true;setBusy(true);setError('');
    try {
      if(action==='save') {
        saveAttempt.current ||= {idempotencyKey:crypto.randomUUID(),expectedVersion:version,photoIds:photos.map((p)=>p.id),enableWhenVerified:allowProductActivation && photos.length>0 && enableWhenVerified};
        await api.post(`/products/${productId}/photos`,saveAttempt.current);
      } else await api.post(`/products/${productId}/photos/reconcile`,{});
      if(!current(value))return;
      await reload(); if(current(value))onSaved?.();
    } catch(failure) {if(current(value))setError(getApiError(failure));}
    finally {if(current(value)){inFlight.current=false;setBusy(false);}}
  };
  const movePhoto=(id,offset)=>edit(()=>setPhotos((existing)=>{
    const index=existing.findIndex((p)=>p.id===id);const target=index+offset;
    if(index<0 || target<0 || target>=existing.length)return existing;
    const next=[...existing];[next[index],next[target]]=[next[target],next[index]];return next;
  }));
  return {photos,photoIds:photos.map((p)=>p.id),enableWhenVerified:allowProductActivation && enableWhenVerified,setEnableWhenVerified:(value)=>edit(()=>setEnable(allowProductActivation && value)),
    restoreStaged:(nextPhotos,enable)=>{
      if(productId || !canEdit || principalLifetime?.valid===false || inFlight.current || pendingFiles.current.length || !loaded.current
        || !Array.isArray(nextPhotos) || nextPhotos.length>8 || new Set(nextPhotos.map(photo=>photo.id)).size!==nextPhotos.length
        || nextPhotos.some(photo=>!UUID.test(photo.id) || typeof photo.name!=='string' || !['image/jpeg','image/png'].includes(photo.mimeType)
          || photo.available!==true || !Number.isFinite(Date.parse(photo.expiresAt)) || Date.parse(photo.expiresAt)<=Date.now()))return false;
      generation.current++;pendingFiles.current=[];saveAttempt.current=null;
      setPhotos(nextPhotos);setEnable(nextPhotos.length>0 && enable===true);setVersion('0');setDelivery(null);setDirty(true);
      setError('');setPollError('');setFailedUploads([]);setBusy(false);return true;
    },
    version,delivery,loading,busy,ready,canEdit,error:error || pollError,dirty,failedUploads,hasPendingUploads:busy || failedUploads.length>0,
    addFiles,retryUploads:()=>upload(pendingFiles.current),discardFailed:(key)=>{
      if(!canEdit || inFlight.current)return;
      pendingFiles.current=pendingFiles.current.filter((entry)=>entry.key!==key);setFailedUploads((existing)=>existing.filter((entry)=>entry.key!==key));
    },
    removePhoto:(id)=>edit(()=>setPhotos((existing)=>existing.filter((p)=>p.id!==id))),
    reorderPhotos:(ids)=>{
      if(delivery && delivery.state!=='succeeded')return;
      if(!Array.isArray(ids) || ids.length!==photos.length || new Set(ids).size!==ids.length
        || ids.some(id=>!photos.some(photo=>photo.id===id)) || ids.every((id,index)=>id===photos[index].id))return;
      edit(()=>setPhotos((existing)=>{
        if(existing.length!==ids.length || existing.some(photo=>!ids.includes(photo.id)))return existing;
        return ids.map(id=>existing.find(photo=>photo.id===id));
      }));
    },
    makePrimary:(id)=>edit(()=>setPhotos((existing)=>[...existing.filter((p)=>p.id===id),...existing.filter((p)=>p.id!==id)])),movePhoto,
    save:()=>perform('save'),reconcile:()=>perform('reconcile'),reload,
    reset:()=>{
      generation.current++;inFlight.current=false;pendingFiles.current=[];saveAttempt.current=null;
      setPhotos(baseline.current?.photos || []);setEnable(baseline.current?.enableWhenVerified || false);setVersion(baseline.current?.version || '0');
      setError('');setPollError('');setFailedUploads([]);setDirty(false);setBusy(false);
    },
    creationPayload:{photoIds:photos.map((p)=>p.id),enableWhenPhotosVerified:allowProductActivation && photos.length>0 && enableWhenVerified},
    contentUrl:(id)=>`${api.defaults.baseURL.replace(/\/$/,'')}/product-photos/${encodeURIComponent(id)}/content`,
  };
}
