const applicationUserService = require('./application-users');

const ACCESS_ERROR_BY_STATUS = Object.freeze({
  pending: {
    code: 'APP_ACCESS_PENDING',
    error: 'Application access is pending approval',
  },
  disabled: {
    code: 'APP_ACCESS_DISABLED',
    error: 'Application access is disabled',
  },
});

const PERMISSION_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const INSUFFICIENT_PERMISSION_ERROR = 'Insufficient permission';

function createRequireActiveApplicationUser({
  getOrCreateApplicationAccess = applicationUserService.getOrCreateApplicationAccess,
} = {}) {
  return async function requireActiveApplicationUser(req, res, next) {
    try {
      const access = await getOrCreateApplicationAccess(req.user);
      req.applicationAccess = access;
      req.applicationUser = access.applicationUser;
      req.roles = access.roles;
      req.permissions = access.permissions;

      if (access.applicationUser.status !== 'active') {
        const response = ACCESS_ERROR_BY_STATUS[access.applicationUser.status]
          || ACCESS_ERROR_BY_STATUS.disabled;
        res.set('Cache-Control', 'no-store');
        return res.status(403).json(response);
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

const requireActiveApplicationUser = createRequireActiveApplicationUser();

function requirePermission(permissionKey) {
  if (!PERMISSION_KEY_PATTERN.test(permissionKey)) {
    throw new Error(`Invalid permission key: ${permissionKey}`);
  }

  function requirePermissionMiddleware(req, res, next) {
    if (Array.isArray(req.permissions) && req.permissions.includes(permissionKey)) {
      return next();
    }

    res.set('Cache-Control', 'no-store');
    return res.status(403).json({
      code: 'INSUFFICIENT_PERMISSION',
      error: INSUFFICIENT_PERMISSION_ERROR,
      requiredPermission: permissionKey,
    });
  }

  Object.defineProperty(requirePermissionMiddleware, 'permissionKey', {
    value: permissionKey,
  });
  return requirePermissionMiddleware;
}

module.exports = {
  ACCESS_ERROR_BY_STATUS,
  INSUFFICIENT_PERMISSION_ERROR,
  createRequireActiveApplicationUser,
  requireActiveApplicationUser,
  requirePermission,
};
