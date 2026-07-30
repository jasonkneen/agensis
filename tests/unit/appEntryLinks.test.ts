import { describe, expect, it } from 'vitest';
import { farmSignInUrl } from '../../src/components/integrations/FarmIntegrationApproval';
import { inviteUrl } from '../../src/hooks/useWorkspaceUsers';

describe('app entry links', () => {
  it('sends workspace invites to the app instead of the public homepage', () => {
    expect(inviteUrl('https://agensis.io/', 'token /?')).toBe(
      'https://agensis.io/app?invite=token%20%2F%3F',
    );
  });

  it('sends Farm sign-in through the app and preserves its return path', () => {
    expect(farmSignInUrl('FARM CODE')).toBe(
      '/app?intent=login&redirect=%2Fintegrations%2Ffarm%3Fcode%3DFARM%2520CODE',
    );
  });
});
