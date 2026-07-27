import { describe, expect, it } from 'vitest';
import * as tenantAdmin from '../../shared/tenant-admin.cjs';

// ---------------------------------------------------------------------------
// The system-owner check, as pure data.
//
// This is the single most dangerous predicate in the codebase: it is the only
// thing standing between a signed-in account and every other account's data.
// So the tests are written the way the gate has to fail — NEGATIVE first, and
// with the near misses spelled out one at a time, because "returns true for the
// owner" is the assertion that would still pass if the function were
// `() => true`.
//
// Everything here is pure: (callerEmail, configuredOwnerEmail) -> boolean. No
// DB, no request, no env. The DB-backed wrappers are exercised in
// tests/tenants-admin.test.cjs against the real route handlers.
// ---------------------------------------------------------------------------

const {
  isSystemOwnerEmail,
  normalizeOwnerEmail,
  configuredSystemOwnerEmail,
  SYSTEM_OWNER_EMAIL_ENV,
} = tenantAdmin as {
  isSystemOwnerEmail: (caller: unknown, configured: unknown) => boolean;
  normalizeOwnerEmail: (value: unknown) => string;
  configuredSystemOwnerEmail: (env?: Record<string, string | undefined>) => string;
  SYSTEM_OWNER_EMAIL_ENV: string;
};

const OWNER = 'jason@bouncingfish.com';

describe('isSystemOwnerEmail — refusals', () => {
  it('refuses an ordinary account', () => {
    expect(isSystemOwnerEmail('someone@example.com', OWNER)).toBe(false);
  });

  it('refuses EVERY caller when no owner is configured — never falls back to a default', () => {
    // ensureSystemWorkspace (shared/backend-core.cjs) falls back to the oldest
    // account when this is unset. That is fine for choosing who owns an
    // auto-created workspace and catastrophic for granting admin, so the fallback
    // must not exist here.
    for (const configured of [undefined, null, '', '   ', 0, false]) {
      expect(isSystemOwnerEmail(OWNER, configured)).toBe(false);
      expect(isSystemOwnerEmail('someone@example.com', configured)).toBe(false);
    }
  });

  it('refuses a blank/absent caller email even against a configured owner', () => {
    for (const caller of [undefined, null, '', '   ']) {
      expect(isSystemOwnerEmail(caller, OWNER)).toBe(false);
    }
  });

  it('refuses addresses that merely RESEMBLE the owner', () => {
    const nearMisses = [
      'jason@bouncingfish.com.evil.test',   // owner as a subdomain prefix
      'evil.test@jason@bouncingfish.com',   // owner as a suffix
      'xjason@bouncingfish.com',            // one extra leading char
      'ason@bouncingfish.com',              // one missing leading char
      'jason@bouncingfish.co',              // truncated TLD
      'jason@bouncingfish.como',            // extended TLD
      'jason@bouncing-fish.com',            // different domain
      'jason+admin@bouncingfish.com',       // plus-address: a DIFFERENT account
      'ja.son@bouncingfish.com',            // dotted local part: a different account
    ];
    for (const caller of nearMisses) {
      expect(isSystemOwnerEmail(caller, OWNER), `${caller} must not be the owner`).toBe(false);
    }
  });

  it('refuses a substring of the owner and refuses the owner being a substring of it', () => {
    // Guards against ever "improving" this into an includes()/startsWith() check.
    expect(isSystemOwnerEmail('jason@bouncing', OWNER)).toBe(false);
    expect(isSystemOwnerEmail(`${OWNER}x`, OWNER)).toBe(false);
    expect(isSystemOwnerEmail(OWNER, 'jason@bouncing')).toBe(false);
  });

  it('refuses a non-string caller — an array or object from a JSON body must not coerce', () => {
    // String(['jason@bouncingfish.com']) === 'jason@bouncingfish.com', so a
    // String()-based normalizer would hand admin to anyone who could put an
    // array where a string was expected.
    expect(isSystemOwnerEmail([OWNER], OWNER)).toBe(false);
    expect(isSystemOwnerEmail({ toString: () => OWNER }, OWNER)).toBe(false);
    expect(isSystemOwnerEmail(new String(OWNER), OWNER)).toBe(false);
  });

  it('refuses a regex-shaped or wildcard "email"', () => {
    for (const caller of ['.*', '*@bouncingfish.com', '%@bouncingfish.com', 'jason@%']) {
      expect(isSystemOwnerEmail(caller, OWNER)).toBe(false);
    }
  });
});

describe('isSystemOwnerEmail — the owner', () => {
  it('accepts the exact configured address', () => {
    expect(isSystemOwnerEmail(OWNER, OWNER)).toBe(true);
  });

  it('accepts across case differences on either side', () => {
    expect(isSystemOwnerEmail('Jason@BouncingFish.com', OWNER)).toBe(true);
    expect(isSystemOwnerEmail(OWNER, 'JASON@BOUNCINGFISH.COM')).toBe(true);
    expect(isSystemOwnerEmail('JASON@BOUNCINGFISH.COM', 'jason@BouncingFish.COM')).toBe(true);
  });

  it('accepts across surrounding whitespace on either side', () => {
    // A Fly secret set with a trailing newline is a real and silent way to lock
    // the owner out of their own admin surface.
    expect(isSystemOwnerEmail(`  ${OWNER}  `, OWNER)).toBe(true);
    expect(isSystemOwnerEmail(OWNER, `${OWNER}\n`)).toBe(true);
    expect(isSystemOwnerEmail(` ${OWNER}\t`, `\n ${OWNER} `)).toBe(true);
  });
});

describe('normalizeOwnerEmail', () => {
  it('trims and lowercases a string', () => {
    expect(normalizeOwnerEmail('  Jason@Bouncingfish.COM ')).toBe(OWNER);
  });

  it('returns empty for anything that is not a string', () => {
    for (const value of [undefined, null, 0, 1, false, true, [OWNER], { email: OWNER }]) {
      expect(normalizeOwnerEmail(value)).toBe('');
    }
  });

  it('does NOT strip internal whitespace or fold plus-addresses', () => {
    // Both would make more addresses equal to the owner's than there should be.
    expect(normalizeOwnerEmail('ja son@x.com')).toBe('ja son@x.com');
    expect(normalizeOwnerEmail('jason+a@x.com')).toBe('jason+a@x.com');
  });
});

describe('configuredSystemOwnerEmail', () => {
  it('reads the documented env var and normalizes it', () => {
    expect(SYSTEM_OWNER_EMAIL_ENV).toBe('AGENSIS_SYSTEM_OWNER_EMAIL');
    expect(configuredSystemOwnerEmail({ [SYSTEM_OWNER_EMAIL_ENV]: `  ${OWNER.toUpperCase()} ` }))
      .toBe(OWNER);
  });

  it('returns empty when unset, blank, or the env object is missing', () => {
    expect(configuredSystemOwnerEmail({})).toBe('');
    expect(configuredSystemOwnerEmail({ [SYSTEM_OWNER_EMAIL_ENV]: '   ' })).toBe('');
    // `null` rather than `undefined`: the parameter defaults to process.env, so
    // only an explicit null exercises the "no env object at all" branch.
    expect(configuredSystemOwnerEmail(null as unknown as Record<string, string>)).toBe('');
  });
});
