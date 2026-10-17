-- First-sync receipt for derived SEO whose approved binding policy is
-- magento_managed: Magento keeps its value (state remote_retained, after null).
-- Ordinary delivery never writes such a field, so the receipt only settles the
-- first-sync field ledger, including earlier non-terminal records. The legacy-SV
-- semantic shape from 080 is unchanged. 080 history and checksums are unchanged.
ALTER TABLE magento_first_sync_fields DROP CONSTRAINT first_sync_remote_retained_shape;
ALTER TABLE magento_first_sync_fields ADD CONSTRAINT first_sync_remote_retained_shape CHECK (
 (state='remote_retained') = COALESCE(evidence->'source'->>'decision'='retain_remote',false)
 AND (state<>'remote_retained' OR COALESCE(
 (scope='all' AND evidence->'source'->>'kind'='semantic'
  AND evidence->'source'->>'retention' IS NULL
  AND evidence->'before'->'known'='true'::jsonb AND evidence->'before'->'present'='false'::jsonb
  AND evidence->'remote'->'known'='true'::jsonb AND evidence->'remote'->'present'='true'::jsonb
  AND evidence->'after'='null'::jsonb)
 OR (scope IN ('all','en') AND target IN ('meta_title','meta_description')
  AND evidence->'source'->>'kind'='derived' AND evidence->'source'->>'retention'='magento_managed_seo'
  AND evidence->'source'->>'field'=target
  AND evidence->'remote'->'known'='true'::jsonb AND evidence->'after'='null'::jsonb),false)));

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
    IF NEW.state='remote_retained' AND NEW.evidence->'source'->>'retention' IS DISTINCT FROM 'magento_managed_seo'
      AND NOT EXISTS(SELECT 1 FROM products p
      WHERE p.id::text=NEW.evidence->'source'->>'productId'
        AND p.public_product_identity_id=session.public_product_identity_id
        AND p.category='SV' AND p.status='active' AND p.corrected_to_product_id IS NULL
        AND p.full_sku IS NOT NULL AND p.sku_schema_version_id IS NOT NULL AND p.characteristic_version_id IS NULL) THEN
      RAISE EXCEPTION 'FIRST_SYNC_REMOTE_RETENTION_UNPROVEN';
    END IF;
    IF EXISTS(SELECT 1 FROM magento_first_sync_fields f WHERE f.session_id=NEW.session_id
      AND f.target=NEW.target AND f.scope=NEW.scope
      AND f.state IN ('imported','equal','optional_empty','outward_verified','name_received','seo_received','remote_retained')) THEN
      RAISE EXCEPTION 'FIRST_SYNC_TERMINAL_PERMANENT';
    END IF;
  END IF;
  RETURN NEW;
END $$;
