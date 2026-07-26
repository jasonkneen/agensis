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
const { assertSystemOwner, isSystemOwnerUser, isSystemOwnerEmail, isReservedSignupEmail } = require('../shared/tenant-admin.cjs');

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

test('case folding is ASCII-only: U+212A (Kelvin sign) does not become the owner', () => {
  // toLowerCase() folds the Kelvin sign to `k`, which would make a
  // visually-distinct address equal an ASCII owner address. The comparison
  // must only ever make ONE address equal to the owner's.
  const kelvinSign = '\u212A'; // KELVIN SIGN
  assert.equal(isSystemOwnerEmail(`${kelvinSign}ate@example.com`, 'kate@example.com'), false);
  assert.equal(isSystemOwnerEmail('KATE@example.com', 'kate@example.com'), true);
  // A configured owner address containing non-ASCII letters matches nothing:
  // signup stores addresses ASCII-lowercased, so this fails closed.
  assert.equal(isSystemOwnerEmail('kate@example.com', `${kelvinSign}ate@example.com`), false);
});

test('isReservedSignupEmail reserves exactly the configured owner address', () => {
  // The squat: signup never verifies mailbox ownership, so the owner address
  // must be refused from account creation. Same normalization as the gate.
  assert.equal(isReservedSignupEmail(OWNER, env), true);
  assert.equal(isReservedSignupEmail('  Jason@Bouncingfish.COM ', env), true);
  // Near misses are NOT reserved — the reservation must not over-block.
  assert.equal(isReservedSignupEmail('jason+admin@bouncingfish.com', env), false);
  assert.equal(isReservedSignupEmail('jason@bouncingfish.com.evil.test', env), false);
  assert.equal(isReservedSignupEmail('someone@else.test', env), false);
});

test('with NO owner configured, isReservedSignupEmail reserves nothing (fail-safe)', () => {
  assert.equal(isReservedSignupEmail(OWNER, {}), false);
  assert.equal(isReservedSignupEmail(OWNER, { AGENSIS_SYSTEM_OWNER_EMAIL: '' }), false);
  assert.equal(isReservedSignupEmail(OWNER, { AGENSIS_SYSTEM_OWNER_EMAIL: '   ' }), false);
});
