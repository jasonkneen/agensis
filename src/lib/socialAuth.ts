import { getSettings } from '@netlify/identity';

export type SocialAuthProvider = 'google' | 'github';

type IdentitySettingsLoader = () => Promise<{
  providers?: Partial<Record<SocialAuthProvider, unknown>>;
}>;

const SOCIAL_AUTH_PROVIDERS: SocialAuthProvider[] = ['google', 'github'];

/**
 * Netlify's browser helper derives an Identity URL on any origin, including a
 * self-hosted server that has no Identity service. Ask the helper for the
 * site's settings before redirecting so a missing provider becomes an inline
 * explanation rather than a round trip back to the SPA.
 */
export async function getSocialAuthProviders(
  loadSettings: IdentitySettingsLoader = getSettings,
): Promise<SocialAuthProvider[]> {
  try {
    const settings = await loadSettings();
    return SOCIAL_AUTH_PROVIDERS.filter(provider => settings.providers?.[provider] === true);
  } catch {
    return [];
  }
}

export async function hasSocialAuthProvider(
  provider: SocialAuthProvider,
  loadSettings: IdentitySettingsLoader = getSettings,
): Promise<boolean> {
  return (await getSocialAuthProviders(loadSettings)).includes(provider);
}
