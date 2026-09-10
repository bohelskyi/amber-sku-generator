const { sendHttpError } = require('../../http/errors');
const { ApplicationUserAdminError } = require('../../services/application-user-admin.service');
const { RoleAdminError } = require('../../services/role-admin.service');

function sendApplicationUserAdminError(res, error) {
  const expected = error instanceof ApplicationUserAdminError || error instanceof RoleAdminError;
  if (!expected) console.error('Application user administration failed:', error);

  return sendHttpError(res, error, {
    defaultMessage: 'Application user administration failed',
    includeCode: true,
    isExpected: (candidate) => (
      candidate instanceof ApplicationUserAdminError || candidate instanceof RoleAdminError
    ),
  });
}

module.exports = {
  sendApplicationUserAdminError,
};
