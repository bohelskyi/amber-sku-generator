ALTER TABLE products
  ADD COLUMN magento_name_subject_ua TEXT,
  ADD COLUMN magento_name_subject_en TEXT;

ALTER TABLE products
  ADD CONSTRAINT products_magento_manual_name_pair CHECK (
    (magento_name_subject_ua IS NULL AND magento_name_subject_en IS NULL)
    OR (
      magento_name_subject_ua IS NOT NULL AND magento_name_subject_en IS NOT NULL
      AND length(btrim(magento_name_subject_ua)) BETWEEN 1 AND 200
      AND length(btrim(magento_name_subject_en)) BETWEEN 1 AND 200
    )
  );
