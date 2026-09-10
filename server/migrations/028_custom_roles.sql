ALTER TABLE roles
  ADD COLUMN version BIGINT NOT NULL DEFAULT 1
    CHECK (version > 0);

LOCK TABLE user_role_assignments IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  protected_role_count INTEGER;
BEGIN
  SELECT COUNT(*)::int
  INTO protected_role_count
  FROM roles
  WHERE is_system = TRUE
    AND role_key IN ('administrator', 'manager', 'storekeeper');

  IF protected_role_count <> 3 OR NOT EXISTS (
    SELECT 1 FROM roles
    WHERE role_key = 'administrator' AND is_system = TRUE AND status = 'active'
  ) THEN
    RAISE EXCEPTION
      'Migration 028 requires active Administrator plus Manager and Storekeeper system-role identities';
  END IF;
END;
$$;

DO $$
DECLARE
  conflicting_role_key TEXT;
  conflicting_permission_key TEXT;
BEGIN
  SELECT role.role_key, mapping.permission_key
  INTO conflicting_role_key, conflicting_permission_key
  FROM role_permissions mapping
  JOIN roles role ON role.id = mapping.role_id
  WHERE mapping.permission_key IN ('users.manage', 'roles.manage', 'audit.view')
    AND NOT (role.role_key = 'administrator' AND role.is_system = TRUE)
  ORDER BY role.role_key, mapping.permission_key
  LIMIT 1;

  IF conflicting_role_key IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 028 cannot preserve reserved permissions: role "%" has Administrator-only permission "%"',
      conflicting_role_key, conflicting_permission_key
      USING HINT = 'Review role_permissions and explicitly remove every users.manage, roles.manage, and audit.view mapping outside the built-in Administrator role before restarting the migration.';
  END IF;
END;
$$;

DO $$
DECLARE
  conflicting_user_id BIGINT;
BEGIN
  SELECT application_user_id
  INTO conflicting_user_id
  FROM user_role_assignments
  WHERE revoked_at IS NULL
  GROUP BY application_user_id
  HAVING COUNT(*) > 1
  ORDER BY application_user_id
  LIMIT 1;

  IF conflicting_user_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 028 cannot enforce one current role: application user % has multiple unrevoked role assignments',
      conflicting_user_id
      USING HINT = 'Review user_role_assignments and explicitly revoke all but the intended current assignment before restarting the migration. Migration 028 will not choose a role automatically.';
  END IF;
END;
$$;

CREATE UNIQUE INDEX user_role_assignments_one_current_role_per_user_idx
  ON user_role_assignments (application_user_id)
  WHERE revoked_at IS NULL;

DO $$
DECLARE
  conflicting_display_name TEXT;
BEGIN
  SELECT MIN(display_name)
  INTO conflicting_display_name
  FROM roles
  GROUP BY LOWER(BTRIM(display_name))
  HAVING COUNT(*) > 1
  ORDER BY LOWER(BTRIM(MIN(display_name)))
  LIMIT 1;

  IF conflicting_display_name IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 028 cannot enforce unique role display names: normalized name "%" is duplicated',
      conflicting_display_name
      USING HINT = 'Rename duplicate roles so their trimmed display names differ case-insensitively before restarting the migration.';
  END IF;
END;
$$;

CREATE UNIQUE INDEX roles_display_name_case_insensitive_idx
  ON roles (LOWER(BTRIM(display_name)));

INSERT INTO role_permissions (role_id, permission_key)
SELECT administrator.id, permission.permission_key
FROM roles administrator
CROSS JOIN permissions permission
WHERE administrator.role_key = 'administrator'
  AND administrator.is_system = TRUE
ON CONFLICT (role_id, permission_key) DO NOTHING;

CREATE OR REPLACE FUNCTION protect_role_identity_and_administrator()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'application roles are permanent; deactivate a role instead of deleting it';
  END IF;

  IF OLD.role_key = 'administrator' AND OLD.is_system = TRUE THEN
    RAISE EXCEPTION 'the built-in Administrator role is immutable';
  END IF;

  IF NEW.role_key IS DISTINCT FROM OLD.role_key
     OR NEW.is_system IS DISTINCT FROM OLD.is_system THEN
    RAISE EXCEPTION 'role_key and is_system are immutable role identity fields';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER roles_identity_and_administrator_protected
BEFORE UPDATE OR DELETE ON roles
FOR EACH ROW EXECUTE FUNCTION protect_role_identity_and_administrator();

CREATE OR REPLACE FUNCTION prevent_role_security_truncation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated because application roles and Administrator permissions are permanent',
    TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER roles_truncation_protected
BEFORE TRUNCATE ON roles
FOR EACH STATEMENT EXECUTE FUNCTION prevent_role_security_truncation();

CREATE TRIGGER role_permissions_truncation_protected
BEFORE TRUNCATE ON role_permissions
FOR EACH STATEMENT EXECUTE FUNCTION prevent_role_security_truncation();

CREATE OR REPLACE FUNCTION protect_reserved_role_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_role_key TEXT;
  target_is_system BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT role_key, is_system
    INTO target_role_key, target_is_system
    FROM roles
    WHERE id = OLD.role_id;

    IF target_role_key = 'administrator' AND target_is_system = TRUE THEN
      RAISE EXCEPTION 'Administrator permissions cannot be removed';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT role_key, is_system
    INTO target_role_key, target_is_system
    FROM roles
    WHERE id = OLD.role_id;
    IF target_role_key = 'administrator' AND target_is_system = TRUE THEN
      RAISE EXCEPTION 'Administrator permissions cannot be removed or replaced';
    END IF;
  END IF;

  SELECT role_key, is_system
  INTO target_role_key, target_is_system
  FROM roles
  WHERE id = NEW.role_id;

  IF NEW.permission_key IN ('users.manage', 'roles.manage', 'audit.view')
     AND NOT (target_role_key = 'administrator' AND target_is_system = TRUE) THEN
    RAISE EXCEPTION 'permission % is reserved for the built-in Administrator role', NEW.permission_key;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER role_permissions_reserved_and_administrator_protected
BEFORE INSERT OR UPDATE OR DELETE ON role_permissions
FOR EACH ROW EXECUTE FUNCTION protect_reserved_role_permissions();

CREATE OR REPLACE FUNCTION grant_new_permission_to_administrator()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO role_permissions (role_id, permission_key)
  SELECT id, NEW.permission_key
  FROM roles
  WHERE role_key = 'administrator' AND is_system = TRUE
  ON CONFLICT (role_id, permission_key) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER permissions_grant_administrator
AFTER INSERT ON permissions
FOR EACH ROW EXECUTE FUNCTION grant_new_permission_to_administrator();
