import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  SHARING_CHANNELS,
  SHARING_CHANNEL_DESCRIPTIONS,
  SHARING_CHANNEL_LABELS,
  agentSharesChannel,
  describeAgentSharing,
  normalizeAgentSharing,
  withheldSharingChannels,
} from '../../src/lib/agentSharing';

// src/lib/agentSharing.ts is a TWIN of shared/agentSharing.cjs. The server gates
// every daemon push on the .cjs; the Agents window renders toggles from the .ts.
// A disagreement between them is invisible until somebody's memory stops syncing
// or an agent that was switched off keeps publishing — so the twins are pinned
// against each other here, which is the whole reason this file exists.

const require = createRequire(import.meta.url);
const server = require('../../shared/agentSharing.cjs');

describe('the twins agree', () => {
  it('lists the same channels in the same order', () => {
    expect([...SHARING_CHANNELS]).toEqual([...server.SHARING_CHANNELS]);
  });

  it('uses the same labels and descriptions', () => {
    expect(SHARING_CHANNEL_LABELS).toEqual(server.SHARING_CHANNEL_LABELS);
    expect(SHARING_CHANNEL_DESCRIPTIONS).toEqual(server.SHARING_CHANNEL_DESCRIPTIONS);
  });

  it('normalizes the same inputs to the same answers', () => {
    const inputs: unknown[] = [
      undefined,
      null,
      {},
      { sharing: {} },
      { sharing: { memory: false } },
      { sharing: { memory: false, skills: false, tools: false, documents: false } },
      { memory: false, documents: true },
      { sharing: '{"documents":false}' },
      { sharing: 'not json' },
      { sharing: [] },
      { sharing: { memory: 'yes' } },
    ];
    for (const input of inputs) {
      expect(normalizeAgentSharing(input)).toEqual(server.normalizeAgentSharing(input));
    }
  });
});

describe('fail open', () => {
  it('reads an absent column as sharing everything', () => {
    // MUTATION: `Boolean(raw.memory)`. Every agent row written before the
    // column existed then stops contributing — invisibly, with nothing to
    // error, which is exactly why this is asserted rather than left to the
    // column default.
    expect(normalizeAgentSharing(undefined)).toEqual({
      memory: true, skills: true, tools: true, documents: true,
    });
    expect(normalizeAgentSharing({ id: 'a-1' })).toEqual({
      memory: true, skills: true, tools: true, documents: true,
    });
    expect(normalizeAgentSharing({ sharing: null })).toEqual({
      memory: true, skills: true, tools: true, documents: true,
    });
  });

  it('withholds only on an explicit false', () => {
    expect(agentSharesChannel({ sharing: { documents: false } }, 'documents')).toBe(false);
    expect(agentSharesChannel({ sharing: { documents: true } }, 'documents')).toBe(true);
    // Anything that is not literally `false` is not a decision to withhold.
    expect(agentSharesChannel({ sharing: { documents: 0 } }, 'documents')).toBe(true);
    expect(agentSharesChannel({ sharing: { documents: null } }, 'documents')).toBe(true);
  });

  it('accepts a row, an agent, or the raw value', () => {
    const expected = { memory: false, skills: true, tools: true, documents: true };
    expect(normalizeAgentSharing({ sharing: { memory: false } })).toEqual(expected);
    expect(normalizeAgentSharing({ memory: false })).toEqual(expected);
    expect(normalizeAgentSharing('{"memory":false}')).toEqual(expected);
  });
});

describe('sanitizeAgentSharingPatch', () => {
  it('drops keys nothing understands', () => {
    // The column is jsonb, so without this the generic write path lets anyone
    // with 'write' park arbitrary data on an agent row.
    expect(server.sanitizeAgentSharingPatch({ documents: false, nonsense: { deep: [1, 2, 3] } }))
      .toEqual({ documents: false });
  });

  it('keeps a patch partial rather than filling in defaults', () => {
    // A patch says "these are the switches I touched". Filling the rest in
    // would turn a one-key write into a decision about all four.
    expect(server.sanitizeAgentSharingPatch({ memory: false })).toEqual({ memory: false });
    expect(server.sanitizeAgentSharingPatch({})).toEqual({});
  });
});

describe('sharingGate', () => {
  it('prunes exactly when it refuses', () => {
    // The prune is the load-bearing half: refusing a push without removing what
    // the agent already mirrored freezes a stale snapshot in the workspace, and
    // every browse surface keeps rendering files nobody is sharing any more.
    expect(server.sharingGate({ sharing: { memory: false } }, 'memory')).toEqual({ allowed: false, prune: true });
    expect(server.sharingGate({ sharing: {} }, 'memory')).toEqual({ allowed: true, prune: false });
  });
});

describe('applyToolSharing', () => {
  it('empties the tool advert without changing its shape', () => {
    const capabilities = { skills: ['a'], clis: ['claude'], mcpServers: [{ name: 'x' }], sharedModels: ['m'], commands: ['/go'] };
    const redacted = server.applyToolSharing(capabilities, { sharing: { tools: false } });
    // Shape-preserving: a reader that expects an array still gets one. A reader
    // that had to learn "these keys may be absent" will one day forget.
    for (const key of server.TOOL_CAPABILITY_KEYS) expect(redacted[key]).toEqual([]);
    // Skill NAMES survive — they are governed by the `skills` switch, not this.
    expect(redacted.skills).toEqual(['a']);
  });

  it('passes the block through untouched when tools are shared', () => {
    const capabilities = { skills: ['a'], clis: ['claude'] };
    expect(server.applyToolSharing(capabilities, { sharing: {} })).toBe(capabilities);
  });
});

describe('summaries', () => {
  it('names the withheld channels', () => {
    expect(withheldSharingChannels({ sharing: { memory: false, tools: false } })).toEqual(['memory', 'tools']);
    expect(withheldSharingChannels({})).toEqual([]);
  });

  it('says something different for all-on, all-off, and partial', () => {
    expect(describeAgentSharing({})).toBe('Sharing memory, skills, tools and documents');
    expect(describeAgentSharing({ sharing: { memory: false, skills: false, tools: false, documents: false } }))
      .toBe('Sharing nothing with the workspace');
    expect(describeAgentSharing({ sharing: { memory: false, tools: false } }))
      .toBe('Sharing skill documents, documents');
  });
});
