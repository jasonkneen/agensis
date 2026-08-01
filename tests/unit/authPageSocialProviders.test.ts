import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthPage } from '../../src/components/auth/AuthPage';
import type { SocialAuthProvider } from '../../src/lib/socialAuth';

const authResult = async () => ({ error: null });

function renderAuthPage(socialAuthProviders: SocialAuthProvider[]) {
  return renderToStaticMarkup(createElement(AuthPage, {
    onSignIn: authResult,
    onSignUp: authResult,
    onOAuthSignIn: authResult,
    socialAuthProviders,
  }));
}

describe('AuthPage social providers', () => {
  it('omits social sign-in and its divider when no provider is configured', () => {
    const html = renderAuthPage([]);
    expect(html).not.toContain('>Google<');
    expect(html).not.toContain('>GitHub<');
    expect(html).not.toContain('>or<');
  });

  it('renders only the providers reported as available', () => {
    const html = renderAuthPage(['github']);
    expect(html).not.toContain('>Google<');
    expect(html).toContain('>GitHub<');
    expect(html).toContain('>or<');
  });
});
