import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const appSource = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf8');
const onboardingSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/components/onboarding/OnboardingTour.tsx'),
  'utf8',
);
const agentsSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/components/windows/AgentsWindowContent.tsx'),
  'utf8',
);

describe('unified workspace join entry points', () => {
  it('mints the secure human-or-agent join link from quick invite', () => {
    const quickInvite = appSource.slice(
      appSource.indexOf('const handleCopyInviteLink'),
      appSource.indexOf('// Accept-invite-on-load'),
    );
    expect(quickInvite).toContain('/join-links');
    expect(quickInvite).toContain("audience: 'both'");
    expect(quickInvite).toContain('payload.data.url');
    expect(quickInvite).not.toContain('/invites');
    expect(quickInvite).not.toContain('inviteUrl(');
  });

  it('sets explicit human redemption intent in the signed-in app flow', () => {
    const joinEffect = appSource.slice(
      appSource.indexOf('// The human half of a JOIN LINK'),
      appSource.indexOf('// A channel edited its own row'),
    );
    expect(joinEffect).toContain("JSON.stringify({ as: 'human' })");
  });

  it('describes one shared link during onboarding', () => {
    expect(onboardingSource).toContain("title: 'Invite a person or agent.'");
    expect(onboardingSource).toContain('from that same URL');
  });

  it('routes individual agent invitations to join links and labels workspace control separately', () => {
    expect(agentsSource).toContain('onClick={onInviteAgent}');
    expect(agentsSource).toContain('Invite an Agent');
    expect(agentsSource).toContain('Workspace control');
    expect(agentsSource).toContain('may register agents and create shared resources');
  });
});
