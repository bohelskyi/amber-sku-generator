DELETE FROM role_permissions rp
USING roles r
WHERE rp.role_id = r.id
  AND r.role_key = 'manager'
  AND rp.permission_key IN ('corrections.claim', 'corrections.complete');
