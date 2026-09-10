CREATE TABLE application_users (
  id BIGSERIAL PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'disabled')),
  preferred_username TEXT,
  display_name TEXT,
  given_name TEXT,
  family_name TEXT,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_authenticated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_at TIMESTAMPTZ,
  deactivated_at TIMESTAMPTZ
);

CREATE INDEX application_users_status_idx
  ON application_users (status, id);

CREATE TABLE application_external_identities (
  id BIGSERIAL PRIMARY KEY,
  application_user_id BIGINT NOT NULL
    REFERENCES application_users(id) ON DELETE RESTRICT,
  issuer TEXT NOT NULL CHECK (BTRIM(issuer) <> ''),
  subject TEXT NOT NULL CHECK (BTRIM(subject) <> ''),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_authenticated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (issuer, subject),
  UNIQUE (application_user_id, issuer)
);

CREATE INDEX application_external_identities_user_idx
  ON application_external_identities (application_user_id);

CREATE OR REPLACE FUNCTION protect_application_external_identity_linkage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'application external identities cannot be deleted';
  END IF;
  IF NEW.application_user_id IS DISTINCT FROM OLD.application_user_id
     OR NEW.issuer IS DISTINCT FROM OLD.issuer
     OR NEW.subject IS DISTINCT FROM OLD.subject THEN
    RAISE EXCEPTION 'application external identity linkage is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER application_external_identity_linkage_immutable
BEFORE UPDATE OR DELETE ON application_external_identities
FOR EACH ROW EXECUTE FUNCTION protect_application_external_identity_linkage();

CREATE TABLE permissions (
  permission_key TEXT PRIMARY KEY
    CHECK (permission_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  description TEXT NOT NULL CHECK (BTRIM(description) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE roles (
  id BIGSERIAL PRIMARY KEY,
  role_key TEXT NOT NULL UNIQUE
    CHECK (role_key ~ '^[a-z][a-z0-9_]*$'),
  display_name TEXT NOT NULL CHECK (BTRIM(display_name) <> ''),
  description TEXT NOT NULL CHECK (BTRIM(description) <> ''),
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE role_permissions (
  role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  permission_key TEXT NOT NULL
    REFERENCES permissions(permission_key) ON UPDATE RESTRICT ON DELETE RESTRICT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (role_id, permission_key)
);

CREATE INDEX role_permissions_permission_idx
  ON role_permissions (permission_key, role_id);

CREATE TABLE user_role_assignments (
  id BIGSERIAL PRIMARY KEY,
  application_user_id BIGINT NOT NULL
    REFERENCES application_users(id) ON DELETE RESTRICT,
  role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  assigned_by_user_id BIGINT
    REFERENCES application_users(id) ON DELETE RESTRICT,
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id BIGINT
    REFERENCES application_users(id) ON DELETE RESTRICT,
  CHECK (revoked_by_user_id IS NULL OR revoked_at IS NOT NULL)
);

CREATE UNIQUE INDEX user_role_assignments_one_active_role_idx
  ON user_role_assignments (application_user_id, role_id)
  WHERE revoked_at IS NULL;

CREATE INDEX user_role_assignments_active_user_idx
  ON user_role_assignments (application_user_id, role_id)
  WHERE revoked_at IS NULL;

CREATE INDEX user_role_assignments_active_role_idx
  ON user_role_assignments (role_id, application_user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE security_bootstrap_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  completed_at TIMESTAMPTZ,
  administrator_user_id BIGINT
    REFERENCES application_users(id) ON DELETE RESTRICT,
  CHECK (
    (completed_at IS NULL AND administrator_user_id IS NULL)
    OR (completed_at IS NOT NULL AND administrator_user_id IS NOT NULL)
  )
);

INSERT INTO security_bootstrap_state (singleton)
VALUES (TRUE);

INSERT INTO permissions (permission_key, description) VALUES
  ('products.view', 'View the main product workspace and product data'),
  ('products.decode', 'Decode existing product SKUs'),
  ('products.create', 'Create and save new products and SKUs'),
  ('products.archive', 'Archive an existing product'),
  ('history.view', 'View product and correction history'),
  ('corrections.view', 'View correction requests'),
  ('corrections.create', 'Create correction requests'),
  ('corrections.claim', 'Claim and release correction requests'),
  ('corrections.complete', 'Refresh and complete owned correction requests'),
  ('corrections.reject', 'Reject and reopen correction requests'),
  ('corrections.force_release', 'Force-release another worker correction request'),
  ('repricing.view', 'View repricing scenarios, drafts, previews, and history'),
  ('repricing.prepare', 'Create, edit, synchronize, and discard repricing drafts'),
  ('repricing.apply', 'Apply repricing changes to live product prices'),
  ('repricing.rollback', 'Rollback applied repricing changes'),
  ('exports.create', 'Create and confirm final export snapshots'),
  ('catalog.view', 'View editable catalog configuration'),
  ('catalog.manage', 'Create and edit catalog configuration'),
  ('sku_schemas.publish', 'Publish immutable SKU schema versions'),
  ('pricing.view', 'View price matrices and pricing configuration'),
  ('pricing.manage', 'Edit price matrices and pricing configuration'),
  ('users.manage', 'Manage local application users and their access'),
  ('roles.manage', 'Manage application roles and permission mappings');

INSERT INTO roles (role_key, display_name, description, is_system) VALUES
  ('administrator', 'Administrator', 'Full application and access-administration permissions', TRUE),
  ('manager', 'Manager', 'Correction operations, read-only pricing, and repricing preparation', TRUE),
  ('storekeeper', 'Storekeeper', 'Operational product creation, corrections, and repricing preparation', TRUE);

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.permission_key
FROM roles r
CROSS JOIN permissions p
WHERE r.role_key = 'administrator';

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, mapping.permission_key
FROM roles r
JOIN (VALUES
  ('products.view'),
  ('products.decode'),
  ('history.view'),
  ('corrections.view'),
  ('corrections.create'),
  ('corrections.claim'),
  ('corrections.complete'),
  ('corrections.reject'),
  ('repricing.view'),
  ('repricing.prepare'),
  ('pricing.view')
) AS mapping(permission_key) ON TRUE
WHERE r.role_key = 'manager';

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, mapping.permission_key
FROM roles r
JOIN (VALUES
  ('products.view'),
  ('products.decode'),
  ('products.create'),
  ('history.view'),
  ('corrections.view'),
  ('corrections.create'),
  ('corrections.claim'),
  ('corrections.complete'),
  ('corrections.reject'),
  ('repricing.view'),
  ('repricing.prepare')
) AS mapping(permission_key) ON TRUE
WHERE r.role_key = 'storekeeper';
