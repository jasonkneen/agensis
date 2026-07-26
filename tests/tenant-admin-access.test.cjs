// ============================================================================
// tests/tenant-admin-access.test.cjs
// ----------------------------------------------------------------------------
// The Tenants surface lists every registered account. Hiding the button is not
// access control — the ROUTE is. These pin the gate itself: assertSystemOwner
// is what every tenant route on both backends calls, and it must refuse anyone
// who is not the configured owner, including when nothing is configured.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSystemOwner, isSystemOwnerUser } = require('../shared/tenant-admin.cjs');

const OWNER = 'jason@bouncingfish.com';
const OWNER_ID = 'owner-1';
const OTHER_ID = 'other-1';

// Emails come from the DATABASE, keyed by the authenticated user id — never
// from anything the caller sent.
const db = async (_sql, params) => {
  const id = params[0];
  if (id === OWNER_ID) return [{ email: OWNER }];
  if (id === OTHER_ID) return [{ email: 'someone@else.test' }];
  return [];
};
const env = { AGENSIS_SYSTEM_OWNER_EMAIL: OWNER };

async function refuses(fn, expectedStatus, label) {
  try {
    await fn();
    assert.fail(`${label}: expected a refusal, got through`);
  } catch (error) {
    assert.equal(error.status, expectedStatus, `${label}: wrong status`);
  }
}

test('the owner is allowed through', async () => {
  assert.equal(await assertSystemOwner({ userId: OWNER_ID, db, env }), OWNER_ID);
});

test('an ordinary authenticated user is refused 403', async () => {
  await refuses(() => assertSystemOwner({ userId: OTHER_ID, db, env }), 403, 'ordinary user');
});

test('an unauthenticated caller is refused 401', async () => {
  for (const id of ['', '   ', null, undefined]) {
    await refuses(() => assertSystemOwner({ userId: id, db, env }), 401, `userId=${String(id)}`);
  }
});

test('a user id that matches no account is refused', async () => {
  await refuses(() => assertSystemOwner({ userId: 'ghost', db, env }), 403, 'unknown id');
});

test('with NO owner configured, even the owner address is refused', async () => {
  // Fail closed. The tempting fallback — "the oldest account", as
  // ensureSystemWorkspace does — would hand admin over every tenant to
  // whoever signed up first.
  await refuses(() => assertSystemOwner({ userId: OWNER_ID, db, env: {} }), 403, 'unconfigured');
  assert.equal(await isSystemOwnerUser({ userId: OWNER_ID, db, env: {} }), false);
});

test('the refusal does not reveal who the owner is', async () => {
  // An admin surface must not be an oracle for the operator's address.
  try {
    await assertSystemOwner({ userId: OTHER_ID, db, env });
    assert.fail('expected a refusal');
  } catch (error) {
    assert.ok(!String(error.message).includes('@'), 'no address in the message');
    assert.ok(!String(error.message).toLowerCase().includes('jason'), 'no owner name');
  }
});
