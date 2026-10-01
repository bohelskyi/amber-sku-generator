const pool = require('../../db/pool');
const c = require('./binding-contract');
const { randomUUID } = require('node:crypto');
const { runAccessAdminMutation } = require('../access-admin-transaction');
const { writeAuditEvent } = require('../../audit/audit-events');
async function record(client, context, revision, kind, previewHash, evidence, items) {
  const id = randomUUID();
  await client.query(`INSERT INTO magento_binding_handoffs(id,binding_revision_id,kind,preview_hash,actor_user_id,evidence)
    VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[id,revision.id,kind,previewHash,context.actorUserId,JSON.stringify(c.safeData(evidence))]);
  if(items.length)await client.query(`INSERT INTO magento_binding_handoff_items(handoff_id,product_id,public_product_identity_id,reason)
    SELECT $1,v."productId",v."publicIdentityId",v.reason FROM jsonb_to_recordset($2::jsonb)
      AS v("productId" integer,"publicIdentityId" bigint,reason text)`,[id,JSON.stringify(items.map((v)=>({productId:v.productId,publicIdentityId:v.publicIdentityId,reason:v.reason})))]);
  return id;
}
async function processHandoffs(config, options = {}) {
  const db = options.databasePool || pool;
  if (!config.configured) return { settled: 0 };
  const gate = (await db.query('SELECT * FROM magento_auto_sync_activation WHERE singleton')).rows[0];
  if (!gate?.enabled || !gate.installation_key || !gate.actor_user_id) return { settled: 0 };
  if (!(await db.query(`SELECT 1 FROM magento_binding_handoff_items i JOIN magento_binding_handoffs h ON h.id=i.handoff_id
    JOIN magento_binding_revisions b ON b.id=h.binding_revision_id WHERE i.state='pending' AND b.installation_key=$1 AND b.origin_hash=$2 LIMIT 1`,
  [gate.installation_key,c.originHash(config.baseUrl)])).rowCount) return {settled:0};
  return runAccessAdminMutation({databasePool:db,actorUserId:Number(gate.actor_user_id),requiredPermission:'export_templates.publish',createError:c.error,
    operation:async(client)=>{
      const currentGate=(await client.query('SELECT * FROM magento_auto_sync_activation WHERE singleton FOR SHARE')).rows[0];
      if (!currentGate.enabled || currentGate.installation_key!==gate.installation_key || currentGate.actor_user_id!==gate.actor_user_id) return {settled:0};
      const pending=(await client.query(`SELECT i.*,h.binding_revision_id FROM magento_binding_handoff_items i
        JOIN magento_binding_handoffs h ON h.id=i.handoff_id JOIN magento_binding_revisions b ON b.id=h.binding_revision_id
        WHERE i.state='pending' AND b.installation_key=$1 AND b.origin_hash=$2
        ORDER BY h.created_at,i.product_id LIMIT 25 FOR UPDATE OF i`,[gate.installation_key,c.originHash(config.baseUrl)])).rows;
      let settled=0;
      for (const item of pending) {
        const product=(await client.query('SELECT * FROM products WHERE id=$1 FOR NO KEY UPDATE',[item.product_id])).rows[0];
        let state='retired',generation=null;
        if (product?.status==='active' && product.corrected_to_product_id===null
          && String(product.public_product_identity_id)===String(item.public_product_identity_id)
          && !(await client.query('SELECT 1 FROM magento_test_deletions WHERE public_product_identity_id=$1',[item.public_product_identity_id])).rowCount) {
          const protectedWork=(await client.query(`SELECT 1 FROM magento_product_sync_requests WHERE public_product_identity_id=$1 AND reason_code='reconciliation_required'
            UNION ALL SELECT 1 FROM magento_sync_jobs j WHERE j.public_product_identity_id=$1 AND j.origin_hash=$2
              AND j.state NOT IN ('succeeded','superseded') AND (j.automatic_generation IS NULL OR j.state='uncertain'
                OR EXISTS(SELECT 1 FROM magento_sync_steps s WHERE s.job_id=j.id)) LIMIT 1`,[item.public_product_identity_id,c.originHash(config.baseUrl)])).rowCount;
          if (protectedWork) state='protected';
          else {
            const request=(await client.query(`INSERT INTO magento_product_sync_requests(public_product_identity_id,product_id)
              VALUES($1,$2) ON CONFLICT(public_product_identity_id) DO UPDATE SET product_id=EXCLUDED.product_id,
              desired_generation=magento_product_sync_requests.desired_generation+1,
              state=CASE WHEN magento_product_sync_requests.reason_code='reconciliation_required' THEN 'needs_attention' ELSE 'pending' END,
              reason_code=CASE WHEN magento_product_sync_requests.reason_code='reconciliation_required' THEN 'reconciliation_required' ELSE NULL END,
              diagnostics=CASE WHEN magento_product_sync_requests.reason_code='reconciliation_required' THEN magento_product_sync_requests.diagnostics ELSE '[]'::jsonb END,
              attempts=0,next_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP RETURNING desired_generation`,
            [item.public_product_identity_id,item.product_id])).rows[0];
            generation=request.desired_generation;state='enrolled';
          }
        }
        await client.query('UPDATE magento_binding_handoff_items SET state=$3,generation=$4 WHERE handoff_id=$1 AND product_id=$2',
          [item.handoff_id,item.product_id,state,generation]);settled++;
      }
      if (settled) await writeAuditEvent(client,{mutationContext:{actorUserId:Number(gate.actor_user_id),requestId:`binding-handoff-${randomUUID()}`},
        eventKey:'magento_binding.handoff_enrolled',subjectType:'magento_binding_handoff',subjectId:pending[0].handoff_id,details:{settled}});
      return {settled};
    }});
}
async function status(config, bindingId, options = {}) {
  c.identity(bindingId);
  const db=options.databasePool || pool;
  const binding=(await db.query('SELECT origin_hash FROM magento_binding_revisions WHERE id=$1',[bindingId])).rows[0];
  if (!config.configured || binding?.origin_hash!==c.originHash(config.baseUrl)) throw c.error(422,'MAGENTO_BINDING_INSTALLATION_OR_SCOPE_MISMATCH','Installation differs');
  return (await db.query(`SELECT h.id,h.kind,h.created_at,count(i.product_id)::int total,
    count(*) FILTER(WHERE i.state='pending')::int pending_handoff,
    count(*) FILTER(WHERE i.state='protected')::int protected,
    count(*) FILTER(WHERE i.state='retired')::int retired,
    count(*) FILTER(WHERE i.state='enrolled' AND r.synced_generation>=i.generation)::int synced,
    count(*) FILTER(WHERE i.state='enrolled' AND r.synced_generation<i.generation AND r.state='needs_attention')::int needs_attention,
    count(*) FILTER(WHERE i.state='enrolled' AND r.synced_generation<i.generation AND r.state<>'needs_attention')::int waiting
    FROM magento_binding_handoffs h LEFT JOIN magento_binding_handoff_items i ON i.handoff_id=h.id
    LEFT JOIN magento_product_sync_requests r ON r.public_product_identity_id=i.public_product_identity_id
    WHERE h.binding_revision_id=$1 GROUP BY h.id ORDER BY h.created_at DESC LIMIT 20`,[bindingId])).rows;
}
module.exports={record,processHandoffs,status};
