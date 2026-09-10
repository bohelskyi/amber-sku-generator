const express = require('express');
const { getRequestMutationContext } = require('../../audit/mutation-context');
const { approveApplicationUser, changeApplicationUserRole, disableApplicationUser, enableApplicationUser, listApplicationUsers, listAssignableRoles } = require('../../services/application-user-admin.service');
const { requirePermission } = require('../../auth/authorization');
const { sendApplicationUserAdminError } = require('./admin-error-response');

const router = express.Router();

router.get('/admin/users', requirePermission('users.manage'), async (_req, res) => {
  try {
    res.json({ users: await listApplicationUsers() });
  } catch (error) {
    sendApplicationUserAdminError(res, error);
  }
});

router.get('/admin/users/roles', requirePermission('users.manage'), async (_req, res) => {
  try {
    res.json({ roles: await listAssignableRoles() });
  } catch (error) {
    sendApplicationUserAdminError(res, error);
  }
});

router.post('/admin/users/:userId/approve', requirePermission('users.manage'), async (req, res) => {
  try {
    res.json({
      user: await approveApplicationUser(req.params.userId, req.body?.roleId, {
        mutationContext: getRequestMutationContext(req),
      }),
    });
  } catch (error) {
    sendApplicationUserAdminError(res, error);
  }
});

router.put('/admin/users/:userId/role', requirePermission('users.manage'), async (req, res) => {
  try {
    res.json({
      user: await changeApplicationUserRole(req.params.userId, req.body?.roleId, {
        expectedAssignmentId: req.body?.expectedAssignmentId,
        mutationContext: getRequestMutationContext(req),
      }),
    });
  } catch (error) {
    sendApplicationUserAdminError(res, error);
  }
});

router.post('/admin/users/:userId/disable', requirePermission('users.manage'), async (req, res) => {
  try {
    res.json({
      user: await disableApplicationUser(req.params.userId, {
        mutationContext: getRequestMutationContext(req),
      }),
    });
  } catch (error) {
    sendApplicationUserAdminError(res, error);
  }
});

router.post('/admin/users/:userId/enable', requirePermission('users.manage'), async (req, res) => {
  try {
    res.json({
      user: await enableApplicationUser(req.params.userId, req.body?.roleId, {
        expectedAssignmentId: req.body?.expectedAssignmentId,
        mutationContext: getRequestMutationContext(req),
      }),
    });
  } catch (error) {
    sendApplicationUserAdminError(res, error);
  }
});

module.exports = router;
