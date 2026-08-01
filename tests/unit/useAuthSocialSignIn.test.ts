import { describe, expect, it, vi } from 'vitest';
import { startSocialSignIn } from '../../src/hooks/useAuth';

describe('startSocialSignIn', () => {
  it('does not start OAuth when the provider is unavailable', async () => {
    const startOAuth = vi.fn();

    const result = await startSocialSignIn(
      'github',
      async () => false,
      startOAuth,
    );

    expect(result).toEqual({
      error: 'GitHub sign-in is not configured for this site. On a self-hosted instance, use email and password instead.',
    });
    expect(startOAuth).not.toHaveBeenCalled();
  });

  it('starts OAuth when the provider is available', async () => {
    const startOAuth = vi.fn();

    const result = await startSocialSignIn(
      'google',
      async () => true,
      startOAuth,
    );

    expect(result).toEqual({ error: null });
    expect(startOAuth).toHaveBeenCalledOnce();
    expect(startOAuth).toHaveBeenCalledWith('google');
  });
});
