ALTER TABLE products
  ADD COLUMN created_by_user_id BIGINT
    REFERENCES application_users(id) ON DELETE RESTRICT,
  ADD COLUMN archived_by_user_id BIGINT
    REFERENCES application_users(id) ON DELETE RESTRICT;

ALTER TABLE product_corrections
  ADD COLUMN performed_by_user_id BIGINT
    REFERENCES application_users(id) ON DELETE RESTRICT;
