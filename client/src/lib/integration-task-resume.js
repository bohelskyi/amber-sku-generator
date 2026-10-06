const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function validateIntegrationResume(task,taskId,config) {
  const fail=message=>{throw new Error(message || 'Контекст задачі не підтверджено.');};
  if(!task || task.id!==taskId || !UUID.test(taskId) || task.resumeHref!=='/products/create?integrationTask='+taskId
    || task.deliveryAccepted!==false || !['open','resolved','cancelled'].includes(task.state))fail();
  const context=task.creationContext;const product=context?.product;
  if(product?.isTestProduct!==undefined && typeof product.isTestProduct!=='boolean')fail('Ознака TEST у збереженій задачі не підтверджена.');
  if(product?.isTestProduct===true && product.enableWhenPhotosVerified===true)fail('TEST товар не може бути ввімкнений фотографіями.');
  if(!product || product.categoryCode!==task.categoryCode || !Object.hasOwn(config?.categories || {},product.categoryCode)
    || !product.answers || typeof product.answers!=='object' || Array.isArray(product.answers))fail();
  if(Object.keys(product.answers).length>100 || typeof product.weight!=='number' || !Number.isFinite(product.weight) || product.weight<0
    || product.pricingDecision && !['system_auto','manual_uah','usd_per_gram'].includes(product.pricingDecision.mode))fail();
  const questions=config.questions?.[product.categoryCode] || [];
  for(const [key,value] of Object.entries(product.answers)) {
    const question=questions.find(question=>question.id===key);
    if(!question || question.archived===true || question.archived===1)fail('Збережена характеристика змінилася або архівована. Поверніться до задачі та перевірте введення.');
    if(question.input_type!=='text' && value!==null && !question.options?.some(option=>String(option.id)===String(value) && option.archived!==true && option.archived!==1))
      fail('Збережене значення більше недоступне. Перевірте його в задачі.');
  }
  const ids=product.photoIds || [];
  if(!Array.isArray(ids) || ids.length>8 || new Set(ids).size!==ids.length || !Array.isArray(context.photos)
    || ids.some((id,index)=>!UUID.test(id) || context.photos[index]?.id!==id))fail();
  if(context.canResume!==true || !Array.isArray(context.unavailablePhotoIds) || context.unavailablePhotoIds.length
    || context.photos.some(photo=>photo.available!==true || !Number.isFinite(Date.parse(photo.expiresAt)) || Date.parse(photo.expiresAt)<=Date.now()))
    fail('Строк збереження фото минув або вони вже прикріплені до товару. Цю форму не можна відновити з усіма фото; поточні введені дані залишилися без змін.');
  return {product,photos:context.photos};
}
