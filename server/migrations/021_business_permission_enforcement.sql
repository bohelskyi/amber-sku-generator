INSERT INTO permissions (permission_key, description)
VALUES
  ('products.recount', 'Directly apply a product recount and create its corrected product'),
  ('exports.view', 'View export status and download existing export snapshots');

INSERT INTO role_permissions (role_id, permission_key)
SELECT id, 'products.recount'
FROM roles
WHERE role_key IN ('administrator', 'storekeeper');

INSERT INTO role_permissions (role_id, permission_key)
SELECT id, 'products.archive'
FROM roles
WHERE role_key = 'storekeeper';

INSERT INTO role_permissions (role_id, permission_key)
SELECT id, 'exports.view'
FROM roles
WHERE role_key IN ('administrator', 'manager', 'storekeeper');
