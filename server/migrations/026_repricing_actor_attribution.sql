ALTER TABLE repricing_drafts
  ADD COLUMN created_by_user_id BIGINT
    REFERENCES application_users(id) ON DELETE RESTRICT,
  ADD COLUMN last_modified_by_user_id BIGINT
    REFERENCES application_users(id) ON DELETE RESTRICT,
  ADD COLUMN discarded_by_user_id BIGINT
    REFERENCES application_users(id) ON DELETE RESTRICT;

ALTER TABLE repricing_batches
  ADD COLUMN applied_by_user_id BIGINT
    REFERENCES application_users(id) ON DELETE RESTRICT,
  ADD COLUMN rolled_back_by_user_id BIGINT
    REFERENCES application_users(id) ON DELETE RESTRICT;
