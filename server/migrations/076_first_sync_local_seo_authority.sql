-- Explicit, audited change of unfinished NM SEO authority only. No enrollment or writes.
-- 073/075 and all recorded terminal/remote-preservation evidence remain immutable.
CREATE FUNCTION first_sync_local_seo_choice_valid(
  field magento_first_sync_fields, previous JSONB, previous_revision BIGINT,
  progress magento_first_sync_progress, session magento_first_sync_sessions
) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 SELECT field.target IN ('meta_title','meta_description') AND field.scope IN ('all','en')
  AND field.state='pending_outward_confirmation' AND session.completed_at IS NULL
  AND field.evidence->'source'->>'decision'='keep_local'
  AND field.evidence->'source'->>'kind'='seo_snapshot'
  AND field.evidence->'source'->>'field'=field.target
  AND field.evidence->'source'->>'category'='NM'
  AND field.evidence->'source'->>'seoContract'='nm-first-sync-seo-v1'
  AND field.evidence->'source'->'seoAuthorityChange'->>'revision'=previous_revision::text
  AND field.evidence->'source'->'seoAuthorityChange'->'evidence'=previous
  AND field.evidence->>'mappingHash'=previous->>'mappingHash'
  AND field.evidence->'source'->>'bindingRevisionId'=previous->'source'->>'bindingRevisionId'
  AND field.evidence->'source'->>'definitionHash'=previous->'source'->>'definitionHash'
  AND field.evidence->'before'->'known'='true'::jsonb AND field.evidence->'before'->'present'='true'::jsonb
  AND field.evidence->'remote'->'known'='true'::jsonb
  AND ((field.evidence->'remote'->'present'='true'::jsonb
      AND jsonb_typeof(field.evidence->'remote'->'value')='string'
      AND length(field.evidence->'remote'->>'value') BETWEEN 1 AND 4096
      AND btrim(field.evidence->'remote'->>'value')<>'' AND field.evidence->'remote'->>'value' !~ '[[:cntrl:]]')
    OR (field.evidence->'remote'->'present'='false'::jsonb
      AND (NOT (field.evidence->'remote')?'value' OR field.evidence->'remote'->'value'='null'::jsonb
        OR jsonb_typeof(field.evidence->'remote'->'value')='string' AND btrim(field.evidence->'remote'->>'value')='')))
  AND field.evidence->'after'=field.evidence->'before'->'value'
  AND jsonb_typeof(field.evidence->'after')='string'
  AND length(field.evidence->>'after') BETWEEN 1 AND 4096 AND btrim(field.evidence->>'after')<>''
  AND field.evidence->>'after' !~ '[[:cntrl:]]'
  AND EXISTS(SELECT 1 FROM application_users u JOIN user_role_assignments a ON a.application_user_id=u.id
    JOIN roles r ON r.id=a.role_id WHERE u.id=progress.actor_user_id AND u.status='active'
      AND a.revoked_at IS NULL AND r.role_key='administrator' AND r.status='active')
  AND EXISTS(SELECT 1 FROM products p JOIN product_full_export_state l ON l.product_id=p.id
    JOIN magento_binding_revisions b ON b.id=field.evidence->'source'->>'bindingRevisionId'
    JOIN magento_binding_field_policies policy ON policy.revision_id=b.id
      AND policy.route_key=field.evidence->'source'->>'routeKey'
      AND policy.field_target=field.target AND policy.store_code=field.scope
    WHERE p.id::text=field.evidence->'source'->>'productId'
      AND p.public_product_identity_id=session.public_product_identity_id AND p.status='active'
      AND p.corrected_to_product_id IS NULL AND p.exclude_from_export=0
      AND l.route='normal' AND l.business_exclusion_state='none' AND NOT l.recount_compatibility_excluded
      AND COALESCE(l.evidence->>'independentExclusion','false')<>'true'
      AND b.state='published' AND b.origin_hash=session.origin_hash
      AND b.template_definition_hash=field.evidence->'source'->>'definitionHash'
      AND b.id=(SELECT id FROM magento_binding_revisions WHERE installation_key=b.installation_key
        AND state='published' ORDER BY version_number DESC LIMIT 1)
      AND policy.policy='authoritative_create_update' AND policy.review_state='approved')
  AND NOT EXISTS(SELECT 1 FROM magento_sync_jobs j WHERE j.origin_hash=session.origin_hash
    AND j.public_product_identity_id=session.public_product_identity_id
    AND (j.state NOT IN ('succeeded','superseded') OR EXISTS(SELECT 1 FROM magento_sync_steps s WHERE s.job_id=j.id)))
  AND NOT EXISTS(SELECT 1 FROM product_media_jobs j WHERE j.public_product_identity_id=session.public_product_identity_id
    AND j.state NOT IN ('succeeded','superseded'))
  AND NOT EXISTS(SELECT 1 FROM product_visibility_intents v WHERE v.public_product_identity_id=session.public_product_identity_id
    AND v.state NOT IN ('verified','superseded'))
$$;

CREATE OR REPLACE FUNCTION guard_first_sync_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session magento_first_sync_sessions; progress magento_first_sync_progress; previous_seo JSONB; previous_revision BIGINT; delivery magento_sync_jobs;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'FIRST_SYNC_EVIDENCE_IMMUTABLE'; END IF;
  SELECT * INTO session FROM magento_first_sync_sessions WHERE id=NEW.session_id FOR UPDATE;
  IF session.id IS NULL OR session.completed_at IS NOT NULL OR NEW.revision<>session.revision+1 THEN
    RAISE EXCEPTION 'FIRST_SYNC_REVISION_CONFLICT';
  END IF;
  IF TG_TABLE_NAME='magento_first_sync_progress' THEN
    IF NEW.transaction_id<>txid_current() THEN RAISE EXCEPTION 'FIRST_SYNC_TRANSACTION_REQUIRED'; END IF;
  ELSE
    SELECT * INTO progress FROM magento_first_sync_progress WHERE session_id=NEW.session_id AND revision=NEW.revision;
    IF progress.transaction_id IS DISTINCT FROM txid_current()
      OR NEW.evidence->>'target' IS DISTINCT FROM NEW.target OR NEW.evidence->>'scope' IS DISTINCT FROM NEW.scope
      OR NEW.evidence->>'state' IS DISTINCT FROM NEW.state
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(progress.command->'fields') field WHERE field=NEW.evidence) THEN
      RAISE EXCEPTION 'FIRST_SYNC_FIELD_EVIDENCE_INVALID';
    END IF;
    SELECT evidence,revision INTO previous_seo,previous_revision FROM magento_first_sync_fields
      WHERE session_id=NEW.session_id AND target=NEW.target AND scope=NEW.scope AND revision<NEW.revision
      ORDER BY revision DESC LIMIT 1;
    IF previous_seo->>'state'='seo_pending_initial_readback' THEN
      IF NEW.state='pending_outward_confirmation' THEN
        IF NOT COALESCE(first_sync_local_seo_choice_valid(NEW,previous_seo,previous_revision,progress,session),FALSE) THEN
          RAISE EXCEPTION 'FIRST_SYNC_LOCAL_SEO_AUTHORITY_UNPROVEN';
        END IF;
      ELSIF NEW.state NOT IN ('seo_pending_initial_readback','seo_received')
        OR NEW.state='seo_pending_initial_readback' AND NEW.evidence IS DISTINCT FROM previous_seo THEN
        RAISE EXCEPTION 'FIRST_SYNC_SEO_RECEIPT_PERMANENT';
      END IF;
    END IF;
    IF NEW.state='seo_received' THEN
      IF previous_seo->>'state' IS DISTINCT FROM 'seo_pending_initial_readback'
        OR ((NEW.evidence #- '{source,seoDelivery}')-'state') IS DISTINCT FROM (previous_seo-'state') THEN
        RAISE EXCEPTION 'FIRST_SYNC_SEO_RECEIPT_CHANGED';
      END IF;
      SELECT * INTO delivery FROM magento_sync_jobs WHERE id=NEW.evidence->'source'->'seoDelivery'->>'jobId';
      IF delivery.id IS NULL OR delivery.state IS DISTINCT FROM 'succeeded' OR delivery.acknowledged_at IS NULL
        OR delivery.intent->>'mode' IS DISTINCT FROM 'update'
        OR delivery.origin_hash IS DISTINCT FROM session.origin_hash
        OR delivery.public_product_identity_id IS DISTINCT FROM session.public_product_identity_id
        OR delivery.remote_product_id IS DISTINCT FROM session.remote_product_id
        OR delivery.sku IS DISTINCT FROM session.public_sku
        OR delivery.binding_revision_id IS DISTINCT FROM NEW.evidence->'source'->>'bindingRevisionId'
        OR delivery.plan_hash IS DISTINCT FROM NEW.evidence->'source'->'seoDelivery'->>'planHash'
        OR delivery.baseline->'firstSyncSeo'->>'sessionId' IS DISTINCT FROM session.id::text
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(delivery.baseline->'firstSyncSeo'->'fields') f
          WHERE f->>'target'=NEW.target AND f->>'scope'=NEW.scope AND f->>'mappingHash'=NEW.evidence->>'mappingHash')
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(delivery.intent->'operations') op,
          jsonb_array_elements(COALESCE(op->'payload'->'product'->'custom_attributes','[]'::jsonb)) a
          WHERE op->>'domain'=CASE WHEN NEW.scope='all' THEN 'coreProduct' ELSE 'storeViews' END
            AND a->>'attribute_code'=NEW.target)
        OR NEW.scope='en' AND COALESCE(delivery.intent->'englishValues','{}'::jsonb)?NEW.target THEN
        RAISE EXCEPTION 'FIRST_SYNC_SEO_DELIVERY_UNPROVEN';
      END IF;
    END IF;
    IF EXISTS(SELECT 1 FROM magento_first_sync_fields f WHERE f.session_id=NEW.session_id
      AND f.target=NEW.target AND f.scope=NEW.scope
      AND f.state IN ('imported','equal','optional_empty','outward_verified','name_received','seo_received')) THEN
      RAISE EXCEPTION 'FIRST_SYNC_TERMINAL_PERMANENT';
    END IF;
  END IF;
  RETURN NEW;
END $$;
