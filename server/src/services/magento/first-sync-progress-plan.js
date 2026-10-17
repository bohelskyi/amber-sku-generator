const { hash } = require('./binding-contract');
const TERMINAL = new Set(['imported','equal','optional_empty','outward_verified','name_received','seo_received','remote_retained']);
// Temporary legacy SV decision: Magento keeps a value Amber lacks and the template does not emit.
const RETAINABLE = new Set(['EMPTY_LOCAL_UNIQUE_REMOTE_OPTION','EMPTY_LOCAL_VALID_REMOTE']);
const CORRECTION_REASONS = new Set(['FIRST_SYNC_LEGACY_SKU_CORRECTION_REQUIRED',
  'FIRST_SYNC_LEGACY_MISSING_ONLY_REVIEW_REQUIRED', 'FIRST_SYNC_LEGACY_WEIGHT_IDENTITY_REVIEW_REQUIRED',
  'FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN', 'FIRST_SYNC_CANONICAL_CALIBRATION_REVIEW_REQUIRED']);
const fieldKey = field => field.scope + '/' + field.target;
const fail = code => { throw Object.assign(new Error(code), {code:'MAGENTO_FIRST_SYNC_' + code,statusCode:409}); };

// Receipts belong to the complete server-derived projection, never a UI subset.
function prepareProgress(projection, progress, decision = null) {
  const decisions=decision==null?[]:Array.isArray(decision)?decision:[decision];
  if(decisions.length>500 || Object.keys(decisions).length!==decisions.length
    || Array.from({length:decisions.length},(_,i)=>i).some(i=>!Object.hasOwn(decisions,i))
    || decisions.some(d=>!d || !['keep_local','accept_remote','retain_remote'].includes(d.choice))
    || new Set(decisions.map(fieldKey)).size!==decisions.length) fail('DECISION_INVALID');
  const selections=new Map(decisions.map(d=>[fieldKey(d),d]));
  const previous = new Map((progress?.fields || []).map(field => [fieldKey(field),field]));
  const inputs = new Map(projection.fields.map(field => [fieldKey(field),field]));
  const metadata = new Map(projection.projection.map(field => [fieldKey(field),field]));
  const manifest = projection.fields.map(({target,scope})=>({target,scope}));
  const manifestHash = hash(projection.projection.map(({target,scope,mappingHash})=>({target,scope,mappingHash})));
  const rows = projection.plan.fields.map(result => {
    const key=fieldKey(result), field=inputs.get(key), meta=metadata.get(key), prior=previous.get(key);
    let status=result.status, reason=result.evidenceReason || result.reason, after=field.local.value ?? null;
    if (prior && TERMINAL.has(prior.state)) {
      return { ...result, local:field.local,remote:field.remote,record:Object.fromEntries(['target','scope','state','before','remote','after','source','mappingHash'].map(name=>[name,prior[name]])),
        canAcceptRemote:false,canKeepLocal:false,canRetainRemote:false,terminal:true };
    }
    const supported=['name','information','price','weight','characteristic'].includes(meta.persistence) && !meta.importBlocker && !meta.reason;
    const reverseValues = field.kind==='option' ? [...new Set((field.reverseCandidates || [])
      .filter(candidate=>candidate.optionId===String(field.remote.value)).map(candidate=>String(candidate.value)))] : null;
    const seo=meta.persistence==='seo_snapshot' && field.kind==='seo';
    const canAcceptRemote=seo ? result.status==='conflict' && prior?.state!=='seo_pending_initial_readback'
      : result.status==='conflict' && supported && field.mapping.proven
      && (!reverseValues || reverseValues.length===1);
    const derivedLocal=require('./first-sync-local-authority').selectable(field,meta,result);
    const canKeepLocal=(result.status==='conflict' || derivedLocal
      || seo && prior?.state==='seo_pending_initial_readback') && field.mapping.proven
      && meta.outwardPolicy==='authoritative_create_update'
      && (!seo || require('./first-sync-local-authority').validSeoLocal(field));
    const canRetainRemote=!seo && meta.remoteRetention==='legacy-sv-empty-output-v1' && meta.persistence==='characteristic'
      && result.status==='imported' && RETAINABLE.has(result.reason) && !result.received && field.scope==='all'
      && field.mapping.proven && !meta.reason && !meta.readReason
      && field.local.known===true && field.local.present===false && field.remote.known===true && field.remote.present===true;
    const priorKeep=prior?.state==='pending_outward_confirmation'
      && prior.source?.decision==='keep_local' && prior.mappingHash===meta.mappingHash
      && hash(prior.before)===hash(field.local) && hash(prior.remote)===hash(field.remote)
      && !(field.comparison==='nm-exact-length-cm-v1' && result.status==='equal'
        && result.reason==='NM_EXACT_LENGTH_CM_EQUAL');
    const selected=selections.get(key);
    if (selected && selected.choice==='keep_local' && !canKeepLocal) fail('DECISION_NOT_AVAILABLE');
    if (selected && selected.choice==='accept_remote' && !canAcceptRemote) fail('DECISION_NOT_AVAILABLE');
    if (selected && selected.choice==='retain_remote' && !canRetainRemote) fail('DECISION_NOT_AVAILABLE');
    if (priorKeep || selected && selected.choice==='keep_local') {
      status='pending_outward_confirmation';reason='ADMINISTRATOR_KEPT_LOCAL_AWAITING_READBACK';
    } else if (selected && selected.choice==='accept_remote') {
      status=seo?'seo_pending_initial_readback':'imported';after=reverseValues ? reverseValues[0] : field.remote.value;
      reason=seo?'ADMINISTRATOR_ACCEPTED_REMOTE_SEO':'ADMINISTRATOR_ACCEPTED_REMOTE';
    } else if (selected && selected.choice==='retain_remote') {
      status='remote_retained';reason='ADMINISTRATOR_RETAINED_REMOTE';after=null;
    } else if (status==='imported') after=result.importValue;
    // Approved magento_managed SEO: Magento keeps its value. Automatic terminal
    // receipt; equal/empty fields keep their ordinary receipts.
    const managedSeo=meta.remoteRetention==='magento-managed-seo-v1' && !seo && field.kind==='derived'
      && field.remote.known===true && field.mapping.proven && !selected && !priorKeep
      && !['equal','optional_empty'].includes(status);
    if (managedSeo) { status='remote_retained';reason='MAGENTO_MANAGED_SEO_REMOTE_RETAINED';after=null; }
    if (status==='imported' && !supported) {
      status='review_required';reason=meta.importBlocker || 'CANONICAL_' + meta.persistence.toUpperCase() + '_SETTER_UNSUPPORTED';
      after=field.local.value ?? null;
    }
    if(status==='pending_outward_confirmation' && meta.outwardPolicy!=='authoritative_create_update') {
      status='review_required';reason='OUTWARD_POLICY_NOT_AUTHORITATIVE';
    }
    // Expose the correction route for populated historical inputs without
    // replacing read/remote validation failures or changing decision authority.
    if (['conflict','review_required'].includes(status) && !result.received
      && field.local.known && field.remote.known && field.mapping.proven
      && !meta.reason && !meta.readReason && !String(result.reason).startsWith('REMOTE_')
      && CORRECTION_REASONS.has(meta.importBlocker)) reason=meta.importBlocker;
    let state=status;
    if (status==='equal' && prior?.state==='pending_outward_confirmation') state='outward_verified';
    else if (field.kind==='name' && ['imported','equal'].includes(status)) state='name_received';
    const source={...meta.source,
      ...(!meta.source.key && !meta.source.field ? {field:field.target}:{}),manifestHash,
      ...(priorKeep || selected?.choice==='keep_local' ? {decision:'keep_local'}:{}),
      ...(selected?.choice==='accept_remote' ? {decision:'accept_remote'}:{}),
      ...(selected?.choice==='retain_remote' ? {decision:'retain_remote'}:{}),
      ...(managedSeo ? {decision:'retain_remote',retention:'magento_managed_seo'}:{}),
      ...(seo && prior?.state==='seo_pending_initial_readback' && selected?.choice==='keep_local'
        ? {seoAuthorityChange:{revision:prior.revision,evidence:Object.fromEntries(['target','scope','state','before','remote','after','source','mappingHash'].map(k=>[k,prior[k]]))}} : {})};
    const record={target:field.target,scope:field.scope,state,before:field.local,remote:field.remote,
      after,source,mappingHash:meta.mappingHash};
    if (seo && prior?.state==='seo_pending_initial_readback' && selected?.choice!=='keep_local') {
      Object.assign(record,Object.fromEntries(['target','scope','state','before','remote','after','source','mappingHash'].map(k=>[k,prior[k]])));
      if(!['unknown','review_required'].includes(status) && (prior.mappingHash!==meta.mappingHash || hash(prior.remote)!==hash(field.remote))) {
        status='review_required';reason='FIRST_SYNC_ACCEPTED_SEO_CHANGED';
      } else if(!['unknown','review_required'].includes(status)) {
        status='seo_pending_initial_readback';reason='EXPLICIT_REMOTE_SEO_PENDING_READBACK';
      }
    } else if (seo && status==='seo_pending_initial_readback') {
      record.after=result.importValue;
    }
    return {...result,status,reason,local:field.local,remote:field.remote,record,
      canAcceptRemote,canKeepLocal,canRetainRemote,terminal:TERMINAL.has(record.state)};
  });
  if (decisions.some(d=>!rows.some(row=>fieldKey(row)===fieldKey(d)))) fail('FIELD_NOT_MAPPED');
  const blockers=[...projection.blockers,
    ...rows.filter(row=>!row.ordinaryReconciliation && ['conflict','unknown','review_required'].includes(row.status))
      .map(row=>({code:'FIRST_SYNC_FIELD_' + row.status.toUpperCase(),target:row.target,scope:row.scope,reason:row.reason}))];
  for(const prior of previous.values()) {
    if(!inputs.has(fieldKey(prior)) && !TERMINAL.has(prior.state)) blockers.push({code:'FIRST_SYNC_UNSETTLED_PRIOR_FIELD',
      target:prior.target,scope:prior.scope,reason:prior.state});
  }
  return {rows,manifest,manifestHash,blockers,
    readyForOutbound:blockers.length===0,
    complete:rows.length>0 && blockers.length===0 && rows.every(row=>row.terminal)};
}
function blockImports(prepared, blocked) {
  const failures=new Map(blocked.map(field=>[fieldKey(field),field]));
  for (const row of prepared.rows) {
    const failure=failures.get(fieldKey(row));
    if (!failure || row.received) continue;
    row.status='review_required';row.reason=failure.reason || failure.code;
    row.record.state='review_required';row.record.after=row.local.value ?? null;
    row.terminal=false;row.canAcceptRemote=false;
    prepared.blockers.push({code:'FIRST_SYNC_FIELD_VALIDATION_REQUIRED',target:row.target,scope:row.scope,reason:row.reason});
  }
  if (blocked.length) {prepared.readyForOutbound=false;prepared.complete=false;}
  return prepared;
}

function deferAfterCanonicalImports(prepared,projection) {
  const persistence=new Map(projection.projection.map(field=>[fieldKey(field),field.persistence]));
  if(!prepared.rows.some(row=>!row.received && row.record.state==='imported'
    && ['information','price','weight','characteristic'].includes(persistence.get(fieldKey(row))))) return prepared;
  // A changed canonical input can feed multiple direct and derived targets.
  // Never receipt their pre-import equality/emptiness as the final observation.
  for(const row of prepared.rows) {
    if(row.received || row.kind==='name' || !['equal','optional_empty','outward_verified'].includes(row.record.state)) continue;
    row.status='review_required';row.reason='POST_IMPORT_CANONICAL_RECHECK_REQUIRED';
    row.record.state='review_required';row.terminal=false;
  }
  prepared.blockers.push({code:'FIRST_SYNC_POST_ADOPTION_RECHECK_REQUIRED'});
  prepared.readyForOutbound=false;prepared.complete=false;
  return prepared;
}
module.exports={prepareProgress,blockImports,deferAfterCanonicalImports,TERMINAL,fieldKey};
