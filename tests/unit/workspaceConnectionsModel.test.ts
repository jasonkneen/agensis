import { describe, expect, it } from 'vitest';
import {
  canManageWorkspace,
  joinLinkAudienceLabel,
  joinLinkLifecycleState,
  joinLinkRedeemedAsLabel,
  type WorkspaceJoinLink,
  type WorkspaceMember,
} from '../../src/features/workspace-connections';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');

function member(userId: string, role: WorkspaceMember['role']): WorkspaceMember {
  return {
    id: role === 'owner' ? null : `${userId}-membership`,
    user_id: userId,
    email: `${userId}@example.test`,
    role,
    invited_by: null,
    created_at: '2026-07-30T00:00:00.000Z',
  };
}

function link(overrides: Partial<WorkspaceJoinLink> = {}): WorkspaceJoinLink {
  return {
    id: 'join-1',
    workspace_id: 'ws-1',
    label: '',
    role: 'editor',
    audience: 'both',
    status: 'pending',
    redeemed_as: null,
    redeemed_by: null,
    redeemed_agent_id: null,
    redeemed_at: null,
    expires_at: '2026-07-31T12:10:00.000Z',
    created_by: 'owner',
    created_by_email: 'owner@example.test',
    created_at: '2026-07-31T11:55:00.000Z',
    ...overrides,
  };
}

describe('workspace connection model', () => {
  it('derives manage authority only from the current owner/admin membership', () => {
    const members = [
      member('owner', 'owner'),
      member('admin', 'admin'),
      member('editor', 'editor'),
      member('viewer', 'viewer'),
    ];

    expect(canManageWorkspace(members, 'owner')).toBe(true);
    expect(canManageWorkspace(members, 'admin')).toBe(true);
    expect(canManageWorkspace(members, 'editor')).toBe(false);
    expect(canManageWorkspace(members, 'viewer')).toBe(false);
    expect(canManageWorkspace(members, 'missing')).toBe(false);
    expect(canManageWorkspace(members)).toBe(false);
  });

  it('derives pending, expired, redeemed, and revoked without trusting raw pending forever', () => {
    expect(joinLinkLifecycleState(link(), NOW)).toBe('pending');
    expect(joinLinkLifecycleState(link({ expires_at: '2026-07-31T11:59:59.000Z' }), NOW)).toBe('expired');
    expect(joinLinkLifecycleState(link({ status: 'redeemed' }), NOW)).toBe('redeemed');
    expect(joinLinkLifecycleState(link({ status: 'revoked' }), NOW)).toBe('revoked');
  });

  it('uses explicit audience and redemption labels', () => {
    expect(joinLinkAudienceLabel('both')).toBe('person or agent');
    expect(joinLinkAudienceLabel('human')).toBe('person only');
    expect(joinLinkAudienceLabel('agent')).toBe('agent only');
    expect(joinLinkRedeemedAsLabel(link({ status: 'redeemed', redeemed_as: 'human' })))
      .toBe('redeemed as person');
    expect(joinLinkRedeemedAsLabel(link({ status: 'redeemed', redeemed_as: 'agent' })))
      .toBe('redeemed as agent');
  });
});
