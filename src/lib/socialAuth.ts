import { getSettings } from '@netlify/identity';

export type SocialAuthProvider = 'google' | 'github';

type IdentitySettingsLoader = () => Promise<{
  providers?: Partial<Record<SocialAuthProvider, unknown>>;
}>;

const SOCIAL_AUTH_PROVIDERS: SocialAuthProvider[] = ['google', 'github'];

/**
 * Netlify Identity derives its API URL from the page origin, and gotrue-js
 * refuses to be used over plain HTTP — it logs
 * "DO NOT USE HTTP IN PRODUCTION FOR GOTRUE EVER!" from its constructor before
 * doing anything else. On the Vite dev server (http://localhost) that warning
 * fires on every boot, and the request behind it can never succeed, because a
 * dev origin has no Identity service to answer it.
 *
 * So don't construct the client at all off an insecure origin: there is no
 * provider list to be had there, and `[]` is exactly what the failed request
 * would have produced.
 */
function identityIsReachable(): boolean {
  if (typeof window === 'undefined') return false;
  // https: only. http://localhost is the dev server; file:// is packaged
  // Electron. Neither has a Netlify Identity service behind it.
  return window.location.protocol === 'https:';
}

const loadIdentitySettings: IdentitySettingsLoader = async () => {
  if (!identityIsReachable()) return {};
  return getSettings();
};

/**
 * Netlify's browser helper derives an Identity URL on any origin, including a
 * self-hosted server that has no Identity service. Ask the helper for the
 * site's settings before redirecting so a missing provider becomes an inline
 * explanation rather than a round trip back to the SPA.
 */
export async function getSocialAuthProviders(
  loadSettings: IdentitySettingsLoader = loadIdentitySettings,
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
