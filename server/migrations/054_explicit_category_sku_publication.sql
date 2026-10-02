-- Existing catalog rows keep their historical upgrade/bootstrap behavior.
-- Future categories created by Amber commands require an explicit first publication.
ALTER TABLE categories ADD COLUMN sku_publication_mode TEXT NOT NULL DEFAULT 'legacy_bootstrap'
  CHECK (sku_publication_mode IN ('legacy_bootstrap', 'explicit'));
