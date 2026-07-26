import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { isSystemOwnerEmail } = require_('../../shared/tenant-admin.cjs');

// The Tenants surface exposes EVERY user's data across the whole deployment.
// This predicate is the only thing standing between an ordinary account and
// all of it, so the negative cases matter far more than the positive one.
describe('isSystemOwnerEmail', () => {
  const OWNER = 'jason@bouncingfish.com';

  it('accepts the configured owner', () => {
    expect(isSystemOwnerEmail(OWNER, OWNER)).toBe(true);
  });

  it('ignores case and surrounding whitespace on both sides', () => {
    // A stored email and a configured secret will not always agree on either.
    expect(isSystemOwnerEmail('  Jason@BouncingFish.com ', OWNER)).toBe(true);
    expect(isSystemOwnerEmail(OWNER, '  JASON@BOUNCINGFISH.COM  ')).toBe(true);
  });

  it('refuses every near miss', () => {
    for (const near of [
      'jason@bouncingfish.com.evil.test',  // suffix
      'evil.test/jason@bouncingfish.com',  // prefix
      'jason+admin@bouncingfish.com',      // plus-addressing is a DIFFERENT account
      'jason@bouncingfish.co',             // truncated TLD
      'ason@bouncingfish.com',             // dropped char
      'jason@bouncingfish.com ',           // trailing space is fine, but...
    ]) {
      const expected = near.trim().toLowerCase() === OWNER;
      expect(isSystemOwnerEmail(near, OWNER), near).toBe(expected);
    }
  });

  it('an UNCONFIGURED deployment has no owner, not an owner of everyone', () => {
    // The dangerous failure mode: falling back to "the oldest account" the way
    // ensureSystemWorkspace does. Fine for creating a workspace, catastrophic
    // for granting admin over every tenant.
    for (const unset of ['', '   ', null, undefined]) {
      expect(isSystemOwnerEmail(OWNER, unset as unknown as string)).toBe(false);
    }
  });

  it('refuses a caller with no email at all', () => {
    for (const empty of ['', '   ', null, undefined]) {
      expect(isSystemOwnerEmail(empty as unknown as string, OWNER)).toBe(false);
    }
  });

  it('refuses when both sides are empty — two blanks are not a match', () => {
    expect(isSystemOwnerEmail('', '')).toBe(false);
  });
});
