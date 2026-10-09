// Actual local read-only catalog/publication copies. Never connect to that source.
const data=require('./legacy-sv-schema6.json');
function schema() {
  return {...structuredClone(data.schema),questions:data.questions.map(q=>({
    id:q.question_key,key:q.question_key,label:q.label,sku_index:Number(q.sku_index),display_order:Number(q.display_order),
    required:q.required,sku_separator:q.sku_separator,visible_if_json:q.visible_if_json,
    options:data.options.filter(o=>o.schema_question_id===q.id).map(o=>({
      value_id:o.value_id,sku_code:o.sku_code,label:o.label,visible_if_json:o.visible_if_json,hidden_if_json:o.hidden_if_json,archived:o.archived,
    })),
  }))};
}
function current() {
  return {...structuredClone(data.category),category_code:'SV',questions:data.currentQuestions.map(q=>({...structuredClone(q),
    options:structuredClone(data.currentOptions.filter(o=>o.question_id===q.id))}))};
}
function product(id) {return structuredClone(data.products.find(p=>p.id===id));}
function publication() {
  const {definition,tables:t}=require('./legacy-sv-publication.json');
  const schema={storeCode:'all',attributeSets:t.schema_sets.map(s=>({attribute_set_id:Number(s.set_id),attribute_set_name:s.name,
    attributeCodes:t.schema_members.filter(m=>m.set_id===s.set_id).map(m=>m.attribute_code).sort()})),
  attributes:t.schema_attributes.map(a=>({...a.metadata,options:t.schema_options.filter(o=>o.attribute_code===a.code).map(o=>({value:o.option_id,label:o.label,isEmpty:o.option_id===''}))})),
  storeTopology:Object.fromEntries(['websites','storeGroups','storeViews'].map(kind=>[kind,t.schema_stores.filter(s=>s.kind===kind).map(s=>s.metadata)]))};
  const bindings={routes:t.routes.map(r=>({routeKey:r.route_key,evaluatorSetName:r.evaluator_set_name,enabled:r.enabled,setId:Number(r.set_id),reviewState:r.review_state})),
    attributes:t.attributes.map(a=>({routeKey:a.route_key,rowId:a.row_id,target:a.target,strategy:a.strategy,attributeCode:a.attribute_code,transportTarget:a.transport_target,unknownOutputPolicy:a.unknown_output_policy,reviewState:a.review_state})),
    options:t.options.map(o=>({bindingKey:o.binding_key,sourceKind:o.source_kind,evaluatedOutput:o.evaluated_output,optionId:o.option_id,reviewState:o.review_state,
      ...(o.source_kind==='semantic'?{amberGroup:o.amber_group,questionKey:o.question_key,valueId:String(o.value_id),...(o.sku_code_evidence===null?{}:{skuCodeEvidence:o.sku_code_evidence})}:{domainKey:o.domain_key,outputKey:o.output_key})})),
    policies:t.field_policies.map(p=>({bindingKey:p.binding_key,storeCode:p.store_code,policy:p.policy,reviewState:p.review_state}))};
  return structuredClone({definition,schema,bindings});
}
module.exports={data,schema,current,product,publication};
