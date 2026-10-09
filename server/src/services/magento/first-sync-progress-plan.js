const { hash } = require('./binding-contract');
const TERMINAL = new Set(['imported','equal','optional_empty','outward_verified','name_received']);
const fieldKey = field => field.scope + '/' + field.target;
const fail = code => { throw Object.assign(new Error(code), {code:'MAGENTO_FIRST_SYNC_' + code,statusCode:409}); };

// Receipts belong to the complete server-derived projection, never a UI subset.
function prepareProgress(projection, progress, decision = null) {
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
        canAcceptRemote:false,canKeepLocal:false,terminal:true };
    }
    const supported=['name','information','price','weight','characteristic'].includes(meta.persistence) && !meta.importBlocker && !meta.reason;
    const reverseValues = field.kind==='option' ? [...new Set((field.reverseCandidates || [])
      .filter(candidate=>candidate.optionId===String(field.remote.value)).map(candidate=>String(candidate.value)))] : null;
    const canAcceptRemote=result.status==='conflict' && supported && field.mapping.proven
      && (!reverseValues || reverseValues.length===1);
    const canKeepLocal=result.status==='conflict' && field.mapping.proven
      && meta.outwardPolicy==='authoritative_create_update';
    const priorKeep=prior?.state==='pending_outward_confirmation'
      && prior.source?.decision==='keep_local' && prior.mappingHash===meta.mappingHash
      && hash(prior.before)===hash(field.local) && hash(prior.remote)===hash(field.remote);
    const selected=decision && fieldKey(decision)===key;
    if (selected && !['keep_local','accept_remote'].includes(decision.choice)) fail('DECISION_INVALID');
    if (selected && decision.choice==='keep_local' && !canKeepLocal) fail('DECISION_NOT_AVAILABLE');
    if (selected && decision.choice==='accept_remote' && !canAcceptRemote) fail('DECISION_NOT_AVAILABLE');
    if (priorKeep || selected && decision.choice==='keep_local') {
      status='pending_outward_confirmation';reason='ADMINISTRATOR_KEPT_LOCAL_AWAITING_READBACK';
    } else if (selected && decision.choice==='accept_remote') {
      status='imported';after=reverseValues ? reverseValues[0] : field.remote.value;reason='ADMINISTRATOR_ACCEPTED_REMOTE';
    } else if (status==='imported') after=result.importValue;
    if (status==='imported' && !supported) {
      status='review_required';reason=meta.importBlocker || 'CANONICAL_' + meta.persistence.toUpperCase() + '_SETTER_UNSUPPORTED';
      after=field.local.value ?? null;
    }
    if(status==='pending_outward_confirmation' && meta.outwardPolicy!=='authoritative_create_update') {
      status='review_required';reason='OUTWARD_POLICY_NOT_AUTHORITATIVE';
    }
    let state=status;
    if (status==='equal' && prior?.state==='pending_outward_confirmation') state='outward_verified';
    else if (field.kind==='name' && ['imported','equal'].includes(status)) state='name_received';
    const source={...meta.source,
      ...(!meta.source.key && !meta.source.field ? {field:field.target}:{}),manifestHash,
      ...(priorKeep || selected && decision.choice==='keep_local' ? {decision:'keep_local'}:{}),
      ...(selected && decision.choice==='accept_remote' ? {decision:'accept_remote'}:{})};
    const record={target:field.target,scope:field.scope,state,before:field.local,remote:field.remote,
      after,source,mappingHash:meta.mappingHash};
    return {...result,status,reason,local:field.local,remote:field.remote,record,
      canAcceptRemote,canKeepLocal,terminal:TERMINAL.has(state)};
  });
  if (decision && !rows.some(row=>fieldKey(row)===fieldKey(decision))) fail('FIELD_NOT_MAPPED');
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
