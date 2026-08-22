import { describe, expect, it, vi } from 'vitest';
import { getSocialAuthProviders, hasSocialAuthProvider } from '../../src/lib/socialAuth';

function stubSettings(providers: Record<string, unknown>) {
  return async () => ({ providers });
}

describe('hasSocialAuthProvider', () => {
  it('accepts only a provider enabled by Netlify Identity settings', async () => {
    const loadSettings = stubSettings({ github: true, google: false });
    expect(await getSocialAuthProviders(loadSettings)).toEqual(['github']);
    expect(await hasSocialAuthProvider('github', loadSettings)).toBe(true);
    expect(await hasSocialAuthProvider('google', loadSettings)).toBe(false);
  });

  it('rejects malformed provider settings', async () => {
    expect(await hasSocialAuthProvider('github', stubSettings({ github: 'yes' }))).toBe(false);
  });

  it('rejects missing and unreachable settings', async () => {
    expect(await hasSocialAuthProvider('github', async () => ({}))).toBe(false);
    const unavailableSettings = async () => {
      throw new Error('Identity is unavailable');
    };
    expect(await hasSocialAuthProvider('github', unavailableSettings)).toBe(false);
  });
});

describe('Netlify Identity is not constructed off an insecure origin', () => {
  // gotrue-js warns "DO NOT USE HTTP IN PRODUCTION FOR GOTRUE EVER!" from its
  // constructor. The default loader must not reach it on http:// / file://,
  // where there is no Identity service to answer anyway.
  it('returns no providers on http without calling getSettings', async () => {
    const getSettings = vi.fn(async () => ({ providers: { github: true } }));
    vi.resetModules();
    vi.doMock('@netlify/identity', () => ({ getSettings }));
    const { getSocialAuthProviders: fresh } = await import('../../src/lib/socialAuth');

    expect(window.location.protocol).toBe('http:'); // jsdom default
    expect(await fresh()).toEqual([]);
    expect(getSettings).not.toHaveBeenCalled();

    vi.doUnmock('@netlify/identity');
    vi.resetModules();
  });

  it('still consults an explicitly injected loader', async () => {
    // An injected loader is the caller saying "use this" — the origin guard
    // belongs to the default loader only, or every test would be short-circuited.
    expect(await getSocialAuthProviders(stubSettings({ github: true }))).toEqual(['github']);
  });
});
