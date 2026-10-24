-- Reviewed retirement of an uncertain sync job (sync-job-recovery.supersede).
-- Allowed only inside the reviewing transaction that names this exact job and only once
-- every dispatch marker has been resolved by an exact fresh Magento observation. The
-- migration 068 standard-reactivation cancellation and every other migration 044
-- protection are unchanged. No job, step, request or product row is written here.
CREATE OR REPLACE FUNCTION guard_magento_sync_supersession() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state='superseded' OR (NEW.state='superseded' AND
    (OLD.automatic_generation IS NULL OR OLD.state IN ('uncertain','succeeded') OR
      EXISTS(SELECT 1 FROM magento_sync_steps WHERE job_id=OLD.id))) THEN
    IF OLD.state IN ('queued','running','retryable','blocked') AND NEW.state='superseded'
      AND OLD.automatic_generation IS NULL AND NOT EXISTS(SELECT 1 FROM magento_sync_steps WHERE job_id=OLD.id)
      AND EXISTS(SELECT 1 FROM historical_standard_intents h WHERE h.native_job_id=OLD.id AND h.state='cancelled'
        AND current_setting('amber.historical_standard_cancel',true)=h.id)
    THEN RETURN NEW; END IF;
    IF OLD.state='uncertain' AND NEW.state='superseded'
      AND NOT EXISTS(SELECT 1 FROM magento_sync_steps WHERE job_id=OLD.id AND state='dispatched')
      AND current_setting('amber.reviewed_job_supersede',true)=OLD.id
    THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Magento dispatch evidence requires reconciliation';
  END IF;
  RETURN NEW;
END $$;
