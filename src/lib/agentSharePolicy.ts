import type { AgentSharingChannel } from './agentSharing';
import { agentSharesChannel } from './agentSharing';

// ---------------------------------------------------------------------------
// The MACHINE's half of sharing, frontend side.
//
// The twin of shared/agentSharePolicy.cjs — but only its READING half. The
// browser never parses a `.agensis-share` file: the daemon reads it on its own
// machine and reports the parsed shape, and the server re-validates that before
// storing it. What is left for the UI is to answer one question honestly:
//
//     this channel is off — which side turned it off?
//
// That distinction is the whole reason this file exists. "We turned it off
// here" is a toggle away; "that machine declines" needs a file change on
// somebody else's computer. A surface that rendered one blank list for both
// would send people to the wrong place, and then to us.
//
// tests/unit/agentSharePolicy.test.ts pins this against the server's twin.
// ---------------------------------------------------------------------------

export interface SharePolicyRule {
  allow: boolean;
  pattern: string;
}

/**
 * A policy as it arrives on `agent_connections.capabilities.sharePolicy`.
 *
 * `channels` holds only what the file MENTIONED. An absent channel is "no
 * opinion" — it defers to the workspace switch — which is emphatically not the
 * same as a grant.
 */
export interface AgentSharePolicy {
  declared: boolean;
  channels: Partial<Record<AgentSharingChannel, boolean>>;
  rules: SharePolicyRule[];
}

export const EMPTY_SHARE_POLICY: AgentSharePolicy = { declared: false, channels: {}, rules: [] };

/** Read a policy off a connection's capabilities, tolerating every absence. */
export function sharePolicyFromCapabilities(capabilities: unknown): AgentSharePolicy {
  const block = capabilities as { sharePolicy?: unknown } | null | undefined;
  const raw = block?.sharePolicy;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_SHARE_POLICY;
  const value = raw as { declared?: unknown; channels?: unknown; rules?: unknown };
  const channels: Partial<Record<AgentSharingChannel, boolean>> = {};
  if (value.channels && typeof value.channels === 'object' && !Array.isArray(value.channels)) {
    for (const [key, entry] of Object.entries(value.channels as Record<string, unknown>)) {
      channels[key as AgentSharingChannel] = entry !== false;
    }
  }
  const rules = Array.isArray(value.rules)
    ? (value.rules as unknown[])
      .filter((rule): rule is SharePolicyRule =>
        Boolean(rule) && typeof rule === 'object' && typeof (rule as SharePolicyRule).pattern === 'string')
      .map(rule => ({ allow: rule.allow === true, pattern: rule.pattern }))
    : [];
  return { declared: value.declared === true, channels, rules };
}

/** Only an explicit withhold says no. Mirrors channelAllowed on the server. */
export function policyAllowsChannel(policy: AgentSharePolicy, channel: AgentSharingChannel): boolean {
  return policy.channels[channel] !== false;
}

/** Which side is withholding, if either. */
export type ChannelBlockedBy = 'shared' | 'workspace' | 'machine' | 'both';

export interface ChannelState {
  shared: boolean;
  reason: ChannelBlockedBy;
}

/**
 * The effective state of one channel, and who decided it.
 *
 * The two halves AND together. Neither can widen the other — a workspace cannot
 * switch on what the machine withholds, and a machine cannot force in what the
 * workspace turned off.
 */
export function channelState(
  agent: unknown,
  policy: AgentSharePolicy,
  channel: AgentSharingChannel,
): ChannelState {
  const workspaceOn = agentSharesChannel(agent, channel);
  const machineOn = policyAllowsChannel(policy, channel);
  if (workspaceOn && machineOn) return { shared: true, reason: 'shared' };
  if (!workspaceOn && !machineOn) return { shared: false, reason: 'both' };
  return { shared: false, reason: workspaceOn ? 'machine' : 'workspace' };
}

/** What to say under a toggle that the machine has overruled. */
export function describeChannelBlock(state: ChannelState): string {
  if (state.reason === 'machine') return 'This machine’s policy file withholds it, so the switch has no effect.';
  if (state.reason === 'both') return 'Off here, and this machine’s policy file withholds it too.';
  return '';
}

/** A one-line summary of the whole policy. */
export function describeSharePolicy(policy: AgentSharePolicy): string {
  if (!policy.declared) return 'No policy file on this machine';
  const withheld = (Object.keys(policy.channels) as AgentSharingChannel[])
    .filter(channel => policy.channels[channel] === false);
  const parts: string[] = [];
  if (withheld.length > 0) parts.push(`withholds ${withheld.join(', ')}`);
  if (policy.rules.length > 0) parts.push(`${policy.rules.length} path rule${policy.rules.length === 1 ? '' : 's'}`);
  return parts.length > 0 ? `Machine policy: ${parts.join(' · ')}` : 'Machine policy: no restrictions';
}
