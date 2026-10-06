const positiveId = value => /^(?:[1-9][0-9]*)$/.test(String(value)) && Number.isSafeInteger(Number(value));
const unavailable = reason => ({target:null,reason});
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

// IDs come only from the current server projection and approved exact binding
// entries. Local semantic IDs and labels never substitute for database/remote IDs.
export function resolveCatalogDeletionTarget({categoryCode,questions,revision,field,optionEntry}) {
  if (!UUID.test(revision?.id || '') || !positiveId(revision?.revision)
    || field?.revision?.id !== revision.id || String(field.revision.revision) !== String(revision.revision)) return unavailable('Точний контекст відповідності змінився або ще не прочитаний.');
  const attribute=field.attribute;
  if (!attribute || !/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(attribute.code || '') || attribute.service) return unavailable('Поле Magento не визначено точно або є службовим.');
  const attributes=(field.entries || []).filter(entry=>entry.kind==='attribute' && entry.target===attribute.target && entry.group===categoryCode);
  if(attributes.length!==1 || attributes[0].reviewState!=='approved' || attributes[0].label!==attribute.code || !positiveId(attributes[0].identity)) return unavailable('Потрібна одна підтверджена відповідність із точним Magento attribute ID.');
  const mapped=attributes[0];
  if(attribute.attributeId != null && String(attribute.attributeId)!==String(mapped.identity)) return unavailable('Збережені Magento attribute IDs не збігаються.');
  let questionKey; let semanticValue;
  if(optionEntry) {
    const source=optionEntry.source?.match(/^([A-Z][A-Z0-9_]*)\.([a-zA-Z0-9][a-zA-Z0-9_]{0,99})=value_id:(0|-?[1-9][0-9]*)$/);
    if(optionEntry.kind!=='option' || optionEntry.reviewState!=='approved' || !source || source[1]!==categoryCode
      || optionEntry.target!==attribute.target || optionEntry.routeKey!==mapped.routeKey || optionEntry.row!==mapped.row
      || !positiveId(optionEntry.identity) || !(field.options || []).some(option=>option.value===String(optionEntry.identity) && !option.isEmpty)) return unavailable('Варіант не має підтвердженої точної відповідності Magento у цьому полі.');
    questionKey=source[2]; semanticValue=source[3];
  } else {
    const sources=(attribute.sources || []).filter(source=>['semantic','information'].includes(source.kind));
    if(!sources.length || sources.some(source=>source.category!==categoryCode || typeof source.key!=='string')
      || new Set(sources.map(source=>source.key)).size!==1) return unavailable('Поле не пов’язано однозначно з однією характеристикою Manager.');
    questionKey=sources[0].key;
  }
  const matches=(questions || []).filter(question=>question.id===questionKey && (!question.cat || question.cat===categoryCode));
  if(matches.length!==1 || !positiveId(matches[0].q_db_id)) return unavailable('Точний Manager question ID недоступний. Ключ або підпис не замінює ID.');
  const question=matches[0]; let option=null;
  if(optionEntry) {
    const selected=(question.options || []).filter(item=>String(item.id)===semanticValue);
    if(selected.length!==1 || !positiveId(selected[0].db_id)) return unavailable('Точний Manager option row ID недоступний. value_id не замінює ID рядка.');
    option=selected[0];
  }
  return {reason:'',question,option,target:{bindingRevisionId:revision.id,expectedRevision:String(revision.revision),type:optionEntry?'option':'question',
    questionId:String(question.q_db_id),optionId:option ? String(option.db_id) : null,attributeCode:attribute.code,attributeId:Number(mapped.identity),remoteOptionId:optionEntry ? String(optionEntry.identity) : null}};
}
