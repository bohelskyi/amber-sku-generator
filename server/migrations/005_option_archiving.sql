ALTER TABLE options
  ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_options_question_archived
  ON options (question_id, archived, value_id);
