import assert from 'node:assert/strict';
import test from 'node:test';
import { isActualAdministrator } from '../src/auth/auth-model.js';

test('actual Administrator presentation uses immutable role identity, not names or delegated capabilities', () => {
  assert.equal(isActualAdministrator({roles:[{key:'administrator',displayName:'Адміністратор'}]}),true);
  assert.equal(isActualAdministrator({roles:[{key:'custom',displayName:'Administrator'}],permissions:['export_templates.publish','users.manage']}),false);
  assert.equal(isActualAdministrator({roles:[{key:'Administrator'}]}),false);
});

test('missing or malformed role evidence never grants Administrator presentation', () => {
  for(const auth of [undefined,null,{}, {roles:null}, {roles:{}}, {roles:[null,{}]}, {permissions:['users.manage']}]) {
    assert.equal(isActualAdministrator(auth),false);
  }
});
