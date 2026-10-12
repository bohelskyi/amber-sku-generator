-- NM first-sync SEO snapshots only. No template, binding, product or job enrollment changes.
ALTER TABLE magento_first_sync_fields DROP CONSTRAINT magento_first_sync_fields_state_check;
ALTER TABLE magento_first_sync_fields ADD CONSTRAINT magento_first_sync_fields_state_check
 CHECK (state IN ('imported','equal','optional_empty','outward_verified','name_received','seo_received',
 'conflict','unknown','pending_outward_confirmation','review_required','seo_pending_initial_readback'));
ALTER TABLE magento_first_sync_fields ADD CONSTRAINT first_sync_seo_receipt_shape CHECK (
 state NOT IN ('seo_pending_initial_readback','seo_received') OR COALESCE(
 target IN ('meta_title','meta_description') AND scope IN ('all','en')
 AND evidence->'source'->>'kind'='seo_snapshot' AND evidence->'source'->>'category'='NM'
 AND evidence->'source'->>'seoContract'='nm-first-sync-seo-v1' AND evidence->'source'->>'field'=target
 AND evidence->'remote'->>'known'='true' AND evidence->'remote'->>'present'='true'
 AND jsonb_typeof(evidence->'after')='string' AND length(evidence->>'after') BETWEEN 1 AND 4096
 AND btrim(evidence->>'after')<>'' AND evidence->>'after' !~ '[[:cntrl:]]'
 AND evidence->'after'=evidence->'remote'->'value',false));

CREATE OR REPLACE FUNCTION guard_first_sync_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session magento_first_sync_sessions; progress magento_first_sync_progress; previous_seo JSONB; delivery magento_sync_jobs;
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
    SELECT evidence INTO previous_seo FROM magento_first_sync_fields
      WHERE session_id=NEW.session_id AND target=NEW.target AND scope=NEW.scope AND revision<NEW.revision
      ORDER BY revision DESC LIMIT 1;
    IF previous_seo->>'state'='seo_pending_initial_readback' THEN
      IF NEW.state NOT IN ('seo_pending_initial_readback','seo_received')
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
CREATE OR REPLACE FUNCTION require_first_sync_progress() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session magento_first_sync_sessions; event audit_events;
BEGIN
  SELECT * INTO session FROM magento_first_sync_sessions WHERE id=NEW.session_id;
  SELECT * INTO event FROM audit_events WHERE id=NEW.audit_event_id;
  IF session.revision<NEW.revision OR NEW.transaction_id<>txid_current()
    OR event.actor_user_id IS DISTINCT FROM NEW.actor_user_id
    OR event.event_key IS DISTINCT FROM 'magento.first_sync_progress_recorded'
    OR event.subject_type IS DISTINCT FROM 'magento_first_sync'
    OR event.subject_id IS DISTINCT FROM NEW.session_id::text
    OR event.details->>'revision' IS DISTINCT FROM NEW.revision::text
    OR event.details->>'previewHash' IS DISTINCT FROM NEW.preview_hash
    OR event.details->>'commandHash' IS DISTINCT FROM NEW.command_hash
    OR event.details->'result' IS DISTINCT FROM NEW.result
    OR NEW.result->>'revision' IS DISTINCT FROM NEW.revision::text
    OR NEW.result->>'sessionId' IS DISTINCT FROM NEW.session_id::text
    OR (NEW.result->>'completed')::boolean IS DISTINCT FROM NEW.completed
    OR (NEW.command->>'complete')::boolean IS DISTINCT FROM NEW.completed
    OR jsonb_array_length(NEW.command->'fields')>500
    OR jsonb_array_length(NEW.result->'changedFields') IS DISTINCT FROM
      (SELECT count(*)::integer FROM magento_first_sync_fields WHERE session_id=NEW.session_id AND revision=NEW.revision)
    OR (SELECT count(*) FROM (SELECT DISTINCT target,scope FROM magento_first_sync_fields WHERE session_id=NEW.session_id) fields)>500 THEN
    RAISE EXCEPTION 'FIRST_SYNC_PROGRESS_INCOMPLETE';
  END IF;
  IF NEW.completed THEN
    IF session.completed_at IS DISTINCT FROM NEW.recorded_at OR session.revision<>NEW.revision
      OR jsonb_array_length(NEW.command->'requiredScopes') IS NULL OR jsonb_array_length(NEW.command->'requiredScopes')=0
      OR EXISTS(SELECT 1 FROM (
        SELECT DISTINCT ON(target,scope) state FROM magento_first_sync_fields
        WHERE session_id=NEW.session_id AND revision<=NEW.revision ORDER BY target,scope,revision DESC
      ) fields WHERE state NOT IN ('imported','equal','optional_empty','outward_verified','name_received','seo_received'))
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.command->'requiredScopes') needed WHERE NOT EXISTS(
        SELECT 1 FROM magento_first_sync_fields f WHERE f.session_id=NEW.session_id AND f.revision<=NEW.revision
          AND f.target=needed->>'target' AND f.scope=needed->>'scope'
          AND f.state IN ('imported','equal','optional_empty','outward_verified','name_received','seo_received'))) THEN
      RAISE EXCEPTION 'FIRST_SYNC_COMPLETION_UNPROVEN';
    END IF;
  ELSIF session.revision=NEW.revision AND session.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'FIRST_SYNC_COMPLETION_UNPROVEN';
  END IF;
  RETURN NULL;
END $$;
