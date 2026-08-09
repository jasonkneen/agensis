import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_SHARE_POLICY,
  channelState,
  describeChannelBlock,
  describeSharePolicy,
  policyAllowsChannel,
  sharePolicyFromCapabilities,
} from '../../src/lib/agentSharePolicy';

// src/lib/agentSharePolicy.ts is the READING half of shared/agentSharePolicy.cjs.
// The server parses the file and enforces it; the browser only has to answer
// "this channel is off — which side turned it off?" and answer it the same way
// the server would. A disagreement here shows up as a toggle that claims to work
// and does nothing, or worse, one that claims a machine is sharing when it is not.

const require = createRequire(import.meta.url);
const server = require('../../shared/agentSharePolicy.cjs');

describe('the twins agree about channel state', () => {
  const cases = [
    { agent: { sharing: {} }, policy: '' },
    { agent: { sharing: {} }, policy: 'withhold: documents' },
    { agent: { sharing: { documents: false } }, policy: '' },
    { agent: { sharing: { documents: false } }, policy: 'withhold: documents' },
    { agent: { sharing: { documents: false } }, policy: 'share: documents' },
    { agent: {}, policy: 'withhold: memory' },
  ];

  it('reports the same shared flag and the same reason', () => {
    for (const { agent, policy } of cases) {
      const parsed = server.parseSharePolicy(policy);
      // The browser never parses; it reads the normalized wire shape. Round-trip
      // through that so the comparison is the one that actually happens.
      const wire = sharePolicyFromCapabilities({ sharePolicy: parsed });
      for (const channel of ['memory', 'skills', 'tools', 'documents'] as const) {
        expect(channelState(agent, wire, channel))
          .toEqual(server.describeChannelState(agent, parsed, channel));
      }
    }
  });

  it('summarises a policy the same way', () => {
    for (const text of ['', 'share: documents', 'withhold: memory', 'disallow: a/**']) {
      const parsed = server.parseSharePolicy(text);
      expect(describeSharePolicy(sharePolicyFromCapabilities({ sharePolicy: parsed })))
        .toBe(server.describeSharePolicy(parsed));
    }
  });
});

describe('reading a policy off a connection', () => {
  it('treats every absence as no restriction', () => {
    // A daemon too old to send one, a connection that has not synced yet, and a
    // malformed blob must all mean "the workspace switches decide alone".
    for (const capabilities of [undefined, null, {}, { sharePolicy: null }, { sharePolicy: 'nope' }, { sharePolicy: [] }]) {
      const policy = sharePolicyFromCapabilities(capabilities);
      expect(policy.declared).toBe(false);
      expect(policyAllowsChannel(policy, 'documents')).toBe(true);
    }
  });

  it('keeps only well-formed rules', () => {
    const policy = sharePolicyFromCapabilities({
      sharePolicy: {
        declared: true,
        channels: { memory: false },
        rules: [{ allow: false, pattern: 'a/**' }, { allow: true }, null, 'nope'],
      },
    });
    expect(policy.channels.memory).toBe(false);
    expect(policy.rules).toEqual([{ allow: false, pattern: 'a/**' }]);
  });

  it('only an explicit withhold says no', () => {
    expect(policyAllowsChannel(EMPTY_SHARE_POLICY, 'memory')).toBe(true);
    const policy = sharePolicyFromCapabilities({ sharePolicy: { declared: true, channels: { memory: false, skills: true } } });
    expect(policyAllowsChannel(policy, 'memory')).toBe(false);
    expect(policyAllowsChannel(policy, 'skills')).toBe(true);
    // Never mentioned is not a grant and not a refusal — it defers.
    expect(policyAllowsChannel(policy, 'documents')).toBe(true);
  });
});

describe('what the UI tells the reader', () => {
  it('only explains a block the switch cannot fix', () => {
    // A channel the WORKSPACE turned off needs no explanation — the switch next
    // to the text is the fix, and a note saying so is noise.
    expect(describeChannelBlock({ shared: false, reason: 'workspace' })).toBe('');
    expect(describeChannelBlock({ shared: true, reason: 'shared' })).toBe('');
    expect(describeChannelBlock({ shared: false, reason: 'machine' })).toMatch(/policy file withholds it/);
    expect(describeChannelBlock({ shared: false, reason: 'both' })).toMatch(/policy file withholds it too/);
  });

  it('distinguishes no file from a file that restricts nothing', () => {
    expect(describeSharePolicy(EMPTY_SHARE_POLICY)).toMatch(/No policy file/);
    expect(describeSharePolicy({ declared: true, channels: {}, rules: [] })).toMatch(/no restrictions/);
  });
});
