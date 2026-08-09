import { describe, expect, it } from 'vitest';
import { MAX_TARGET_REVISION, decodeVoiceTarget, decodeVoiceTargetRequest, makeVoiceTarget, makeVoiceTargetRequest } from '../../src/lib/voiceTarget';

describe('voice target wire packets', () => {
  it('accepts matching requests and carries a worker revision floor', () => {
    const request = makeVoiceTargetRequest('h1');
    const bytes = new TextEncoder().encode(JSON.stringify(request));
    expect(decodeVoiceTargetRequest(bytes, 'h1')).toEqual(request);
    expect(decodeVoiceTargetRequest(bytes, 'other')).toBeNull();
    const replay = makeVoiceTargetRequest('h1', 7);
    expect(decodeVoiceTargetRequest(new TextEncoder().encode(JSON.stringify(replay)), 'h1')).toEqual(replay);
    expect(decodeVoiceTargetRequest(new TextEncoder().encode(JSON.stringify({ ...request, extra: true })), 'h1')).toBeNull();
    expect(decodeVoiceTargetRequest(new TextEncoder().encode(JSON.stringify({ ...replay, currentRevision: -1 })), 'h1')).toBeNull();
  });

  it('refuses invalid constructor revisions and huddle ids', () => {
    expect(() => makeVoiceTarget({ huddleId: 'h1', targetAgentId: null, revision: -1 })).toThrow();
    expect(() => makeVoiceTarget({ huddleId: 'h1', targetAgentId: null, revision: 1.5 })).toThrow();
    expect(() => makeVoiceTarget({ huddleId: 'h1', targetAgentId: null, revision: MAX_TARGET_REVISION + 1 })).toThrow();
    expect(makeVoiceTarget({ huddleId: 'h1', targetAgentId: null, revision: MAX_TARGET_REVISION }).revision).toBe(MAX_TARGET_REVISION);
    expect(() => makeVoiceTargetRequest('')).toThrow();
  });

  it('validates target packets against the huddle roster', () => {
    const packet = makeVoiceTarget({ huddleId: 'h1', targetAgentId: 'a2', revision: 3 });
    const bytes = new TextEncoder().encode(JSON.stringify(packet));
    expect(decodeVoiceTarget(bytes, 'h1', ['a1', 'a2'])).toEqual(packet);
    expect(decodeVoiceTarget(bytes, 'h1', ['a1'])).toBeNull();
    expect(decodeVoiceTarget(new TextEncoder().encode(JSON.stringify({ ...packet, revision: 0x80000000 })), 'h1', ['a1', 'a2'])).toBeNull();
  });
});
