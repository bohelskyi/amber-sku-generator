const express = require('express');
const { getRequestMutationContext } = require('../../audit/mutation-context');
const { createRole, deactivateRole, listPermissions, listRoles, reactivateRole, replaceRolePermissions, updateRole } = require('../../services/role-admin.service');
const { requirePermission } = require('../../auth/authorization');
const { sendApplicationUserAdminError } = require('./admin-error-response');

const router = express.Router();

router.get('/admin/roles', requirePermission('roles.manage'), async (_req, res) => {
  try {
    res.json({ roles: await listRoles() });
  } catch (error) {
    sendApplicationUserAdminError(res, error);
  }
});

router.get('/admin/roles/permissions', requirePermission('roles.manage'), async (_req, res) => {
  try {
    res.json({ permissions: await listPermissions() });
  } catch (error) {
    sendApplicationUserAdminError(res, error);
  }
});

router.post('/admin/roles', requirePermission('roles.manage'), async (req, res) => {
  try {
    res.status(201).json({
      role: await createRole(req.body || {}, {
        mutationContext: getRequestMutationContext(req),
      }),
    });
  } catch (error) {
    sendApplicationUserAdminError(res, error);
  }
});

router.patch('/admin/roles/:roleId', requirePermission('roles.manage'), async (req, res) => {
  try {
    res.json({
      role: await updateRole(req.params.roleId, req.body || {}, {
        mutationContext: getRequestMutationContext(req),
      }),
    });
  } catch (error) {
    sendApplicationUserAdminError(res, error);
  }
});

router.put('/admin/roles/:roleId/permissions', requirePermission('roles.manage'), async (req, res) => {
  try {
    res.json({
      role: await replaceRolePermissions(req.params.roleId, req.body || {}, {
        mutationContext: getRequestMutationContext(req),
      }),
    });
  } catch (error) {
    sendApplicationUserAdminError(res, error);
  }
});

router.post('/admin/roles/:roleId/deactivate', requirePermission('roles.manage'), async (req, res) => {
  try {
    res.json({
      role: await deactivateRole(req.params.roleId, req.body?.expectedVersion, {
        mutationContext: getRequestMutationContext(req),
      }),
    });
  } catch (error) {
    sendApplicationUserAdminError(res, error);
  }
});

router.post('/admin/roles/:roleId/reactivate', requirePermission('roles.manage'), async (req, res) => {
  try {
    res.json({
      role: await reactivateRole(req.params.roleId, req.body?.expectedVersion, {
        mutationContext: getRequestMutationContext(req),
      }),
    });
  } catch (error) {
    sendApplicationUserAdminError(res, error);
  }
});

module.exports = router;
