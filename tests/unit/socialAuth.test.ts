import { describe, expect, it } from 'vitest';
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
