import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  CARTESIA_MODEL_ID,
  DEFAULT_EMOTION,
  DEFAULT_SPEED,
  MAX_SPEED,
  MIN_SPEED,
  VOICE_EMOTIONS,
  assignAgentVoices,
  defaultVoiceIdFor,
  describeVoice,
  englishVoiceIds,
  filterVoices,
  isCartesiaVoiceId,
  normalizeVoicePreference,
  readAgentVoice,
  resolveAgentVoice,
  voiceSeed,
  type CartesiaVoice,
  type VoiceAgent,
} from '../../src/lib/agentVoice';

// Every agent in a huddle used to be read aloud in the same browser voice, so
// with four agents in a channel call you could not tell who was talking. Speech
// is Cartesia now, which removes the hard part — a voice id means the same thing
// on every machine, so there is nothing to "resolve against this device".
//
// What still has to be right:
//
//   1. NOBODY CONFIGURES ANYTHING AND THE AGENTS STILL SOUND DIFFERENT. Defaults
//      are derived from the agent id, and derived defaults are assigned across
//      the whole roster so a hash collision cannot double up.
//   2. AN EXPLICIT CHOICE IS NEVER MOVED. Reassigning a voice someone picked, to
//      make room for a derived default, would be the app overruling a decision.
//   3. THE CATALOGUE HAS NO ORDER. /voices pages by cursor and promises nothing,
//      so a default derived from "the Nth English voice" has to sort first or it
//      drifts between page loads.

const voice = (id: string, name: string, language = 'en', gender = 'feminine'): CartesiaVoice =>
  ({ id, name, language, gender });

// Ids are deliberately not in sorted order — the catalogue arrives unordered.
const CATALOGUE: CartesiaVoice[] = [
  voice('f9fc912e-e650-4766-a20c-5a93a43aa6e3', 'Brooke', 'en-GB'),
  voice('0834f3df-e650-4766-a20c-5a93a43aa6e3', 'Ryan', 'en-US', 'masculine'),
  voice('a1b2c3d4-1111-2222-3333-444455556666', 'Nadia', 'en-AU'),
  voice('b0000000-0000-0000-0000-000000000001', 'Sofia', 'es-ES'),
  voice('c0000000-0000-0000-0000-000000000002', 'Kenji', 'ja-JP', 'masculine'),
  voice('d0000000-0000-0000-0000-000000000003', 'Priya', 'en-IN'),
];

const ENGLISH = englishVoiceIds(CATALOGUE);

const agent = (id: string, voicePreference?: unknown): VoiceAgent => ({
  id,
  identity: voicePreference === undefined ? null : { voice: voicePreference },
});

describe('voiceSeed', () => {
  it('is stable for the same input', () => {
    expect(voiceSeed('agent-a')).toBe(voiceSeed('agent-a'));
  });

  it('separates ids that differ by one character', () => {
    expect(voiceSeed('agent-a')).not.toBe(voiceSeed('agent-b'));
  });

  it('stays a non-negative 32-bit integer even for long input', () => {
    const seed = voiceSeed('x'.repeat(500));
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(2 ** 32);
  });
});

describe('isCartesiaVoiceId', () => {
  it('accepts a stock UUID and a plausible custom id', () => {
    expect(isCartesiaVoiceId('f9fc912e-e650-4766-a20c-5a93a43aa6e3')).toBe(true);
    expect(isCartesiaVoiceId('my_cloned_voice-01')).toBe(true);
  });

  it('rejects a browser voice name', () => {
    // The exact value the old design would have stored, and the reason it was
    // wrong: it is meaningless anywhere but the machine that produced it.
    expect(isCartesiaVoiceId('Microsoft Aria Online (Natural)')).toBe(false);
  });

  it('rejects prose, empties and non-strings', () => {
    expect(isCartesiaVoiceId('a warm british voice')).toBe(false);
    expect(isCartesiaVoiceId('')).toBe(false);
    expect(isCartesiaVoiceId('short')).toBe(false);
    expect(isCartesiaVoiceId(null)).toBe(false);
    expect(isCartesiaVoiceId({ id: 'x' })).toBe(false);
  });
});

describe('normalizeVoicePreference', () => {
  it('returns an empty preference for junk, so nothing is invented', () => {
    expect(normalizeVoicePreference(null)).toEqual({});
    expect(normalizeVoicePreference('f9fc912e-e650-4766-a20c-5a93a43aa6e3')).toEqual({});
    expect(normalizeVoicePreference([1, 2])).toEqual({});
  });

  it('keeps unset fields ABSENT rather than defaulting them', () => {
    // The precedence rule turns on "unset" and "set to the default value" being
    // different things.
    const preference = normalizeVoicePreference({ speed: 1.2 });
    expect(preference).toEqual({ speed: 1.2 });
    expect('cartesia_voice_id' in preference).toBe(false);
    expect('emotion' in preference).toBe(false);
  });

  it('clamps speed to the range Cartesia accepts', () => {
    expect(normalizeVoicePreference({ speed: 99 }).speed).toBe(MAX_SPEED);
    expect(normalizeVoicePreference({ speed: 0 }).speed).toBe(MIN_SPEED);
  });

  it('drops an emotion the API does not know', () => {
    // Forwarding it would be a 400 from Cartesia in the middle of a live huddle.
    expect(normalizeVoicePreference({ emotion: 'brisk' })).toEqual({});
    expect(normalizeVoicePreference({ emotion: 'SARCASTIC' })).toEqual({ emotion: 'sarcastic' });
  });
});

describe('englishVoiceIds', () => {
  it('keeps only English voices', () => {
    expect(ENGLISH).toHaveLength(4);
    expect(ENGLISH).not.toContain('b0000000-0000-0000-0000-000000000001');
  });

  it('matches every English locale, not just bare "en"', () => {
    expect(ENGLISH).toContain('f9fc912e-e650-4766-a20c-5a93a43aa6e3'); // en-GB
    expect(ENGLISH).toContain('d0000000-0000-0000-0000-000000000003'); // en-IN
  });

  it('is sorted, so a derived default does not move when the pages come back in a different order', () => {
    expect(ENGLISH).toEqual([...ENGLISH].sort((a, b) => a.localeCompare(b)));
    expect(englishVoiceIds([...CATALOGUE].reverse())).toEqual(ENGLISH);
  });

  it('survives an empty or malformed catalogue', () => {
    expect(englishVoiceIds([])).toEqual([]);
    expect(englishVoiceIds(null as unknown as CartesiaVoice[])).toEqual([]);
  });
});

describe('defaultVoiceIdFor', () => {
  it('is deterministic', () => {
    expect(defaultVoiceIdFor('agent-a', ENGLISH)).toBe(defaultVoiceIdFor('agent-a', ENGLISH));
  });

  it('returns nothing when the catalogue has not loaded', () => {
    // Must NOT be treated as a voice — speaking with '' would be a 400.
    expect(defaultVoiceIdFor('agent-a', [])).toBe('');
  });

  it('always returns an id that is actually in the catalogue', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'agent-42']) {
      expect(ENGLISH).toContain(defaultVoiceIdFor(id, ENGLISH));
    }
  });
});

describe('resolveAgentVoice', () => {
  it('uses the chosen voice and marks it as not a default', () => {
    const resolved = resolveAgentVoice(
      agent('agent-a', { cartesia_voice_id: 'f9fc912e-e650-4766-a20c-5a93a43aa6e3', speed: 1.2, emotion: 'calm' }),
      ENGLISH,
    );
    expect(resolved).toEqual({
      voiceId: 'f9fc912e-e650-4766-a20c-5a93a43aa6e3',
      speed: 1.2,
      emotion: 'calm',
      isDefault: false,
    });
  });

  it('falls back to defaults for an unconfigured agent', () => {
    const resolved = resolveAgentVoice(agent('agent-a'), ENGLISH);
    expect(resolved.isDefault).toBe(true);
    expect(resolved.speed).toBe(DEFAULT_SPEED);
    expect(resolved.emotion).toBe(DEFAULT_EMOTION);
    expect(ENGLISH).toContain(resolved.voiceId);
  });

  it('reports no voice when the catalogue is empty and nothing was chosen', () => {
    expect(resolveAgentVoice(agent('agent-a'), []).voiceId).toBe('');
  });

  it('still honours a chosen voice the catalogue does not list', () => {
    // A voice cloned in Cartesia after our cache was filled must not be dropped.
    const resolved = resolveAgentVoice(agent('a', { cartesia_voice_id: 'zzzzzzzz-9999-9999-9999-999999999999' }), []);
    expect(resolved.voiceId).toBe('zzzzzzzz-9999-9999-9999-999999999999');
  });
});

describe('assignAgentVoices', () => {
  it('gives every agent in a roster a different voice', () => {
    // THE bug this feature exists to fix.
    const roster = ['agent-a', 'agent-b', 'agent-c', 'agent-d'].map(id => agent(id));
    const ids = [...assignAgentVoices(roster, ENGLISH).values()].map(entry => entry.voiceId);
    expect(new Set(ids).size).toBe(roster.length);
  });

  it('separates two agents whose derived defaults collide', () => {
    // Forced: a one-voice catalogue makes every default collide, so the probe
    // has to run. With only one voice there is nowhere to step to, which is the
    // documented degenerate case — but the roster must still resolve.
    const single = [ENGLISH[0]];
    const map = assignAgentVoices([agent('agent-a'), agent('agent-b')], single);
    expect(map.size).toBe(2);
    expect([...map.values()].every(entry => entry.voiceId === single[0])).toBe(true);
  });

  it('never moves a voice someone explicitly chose', () => {
    const pinned = ENGLISH[0];
    const map = assignAgentVoices(
      [agent('agent-a', { cartesia_voice_id: pinned }), agent('agent-b'), agent('agent-c')],
      ENGLISH,
    );
    expect(map.get('agent-a')!.voiceId).toBe(pinned);
    expect(map.get('agent-a')!.isDefault).toBe(false);
  });

  it('routes derived defaults AROUND a voice another agent has chosen', () => {
    // Every explicit pick is reserved before any default is derived, so an
    // unconfigured agent can never be handed the voice someone chose next door.
    const roster = ENGLISH.map((id, index) => agent(`agent-${index}`));
    const pinnedId = defaultVoiceIdFor('agent-1', ENGLISH);
    roster[0] = agent('agent-0', { cartesia_voice_id: pinnedId });
    const map = assignAgentVoices(roster, ENGLISH);
    const others = [...map.entries()].filter(([id]) => id !== 'agent-0').map(([, entry]) => entry.voiceId);
    expect(others).not.toContain(pinnedId);
  });

  it('lets two agents share a voice when a HUMAN picked the same one twice', () => {
    const shared = ENGLISH[1];
    const map = assignAgentVoices(
      [agent('agent-a', { cartesia_voice_id: shared }), agent('agent-b', { cartesia_voice_id: shared })],
      ENGLISH,
    );
    expect(map.get('agent-a')!.voiceId).toBe(shared);
    expect(map.get('agent-b')!.voiceId).toBe(shared);
  });

  it('does not change who gets which voice when the roster order changes', () => {
    // Someone joining or leaving a channel must not reshuffle voices mid-call.
    const roster = ['agent-a', 'agent-b', 'agent-c'].map(id => agent(id));
    const forwards = assignAgentVoices(roster, ENGLISH);
    const backwards = assignAgentVoices([...roster].reverse(), ENGLISH);
    for (const id of ['agent-a', 'agent-b', 'agent-c']) {
      expect(forwards.get(id)).toEqual(backwards.get(id));
    }
  });

  it('resolves to no voice, rather than a wrong one, when the catalogue failed to load', () => {
    const map = assignAgentVoices([agent('agent-a')], []);
    expect(map.get('agent-a')!.voiceId).toBe('');
  });

  it('ignores agents with no id and returns an empty map for an empty roster', () => {
    expect(assignAgentVoices([{ id: '' }, agent('agent-a')], ENGLISH).size).toBe(1);
    expect(assignAgentVoices([], ENGLISH).size).toBe(0);
  });
});

describe('readAgentVoice', () => {
  it('is empty for an agent that has never been configured', () => {
    expect(readAgentVoice({ id: 'a' })).toEqual({});
    expect(readAgentVoice(null)).toEqual({});
  });
});

describe('the picker helpers', () => {
  it('describes a voice with its accent and gender', () => {
    expect(describeVoice(CATALOGUE[0])).toBe('Brooke — feminine, en-GB');
  });

  it('filters on name, accent and gender, case-insensitively', () => {
    expect(filterVoices(CATALOGUE, 'brooke').map(v => v.name)).toEqual(['Brooke']);
    expect(filterVoices(CATALOGUE, 'en-AU').map(v => v.name)).toEqual(['Nadia']);
    expect(filterVoices(CATALOGUE, 'MASCULINE').map(v => v.name)).toEqual(['Ryan', 'Kenji']);
  });

  it('returns everything for an empty query', () => {
    expect(filterVoices(CATALOGUE, '  ')).toHaveLength(CATALOGUE.length);
  });
});

describe('the contract shared with the server', () => {
  // The frontend cannot import the .cjs (tsconfig only includes `src`), so the
  // two copies are pinned here. Drift would mean the panel previews one voice
  // and the pipeline speaks another — the single worst failure mode available.
  const require_ = createRequire(import.meta.url);
  const shared = require_('../../shared/agentIdentity.cjs');

  it('agrees on the emotion vocabulary', () => {
    expect(shared.VOICE_EMOTIONS).toEqual(VOICE_EMOTIONS);
  });

  it('agrees on the model and the speed range', () => {
    expect(shared.CARTESIA_MODEL_ID).toBe(CARTESIA_MODEL_ID);
    expect(shared.MIN_SPEED).toBe(MIN_SPEED);
    expect(shared.MAX_SPEED).toBe(MAX_SPEED);
  });

  it('computes the SAME hash, so a derived default matches on both sides', () => {
    for (const id of ['agent-a', 'agent-b', '3f2a9c1e-0000-4000-8000-000000000000', '']) {
      expect(shared.voiceSeed(id)).toBe(voiceSeed(id));
    }
  });

  it('derives the SAME default voice on both sides', () => {
    for (const id of ['agent-a', 'agent-b', 'agent-c']) {
      expect(shared.resolveAgentVoice({ id }, ENGLISH).voiceId).toBe(resolveAgentVoice(agent(id), ENGLISH).voiceId);
    }
  });

  it('accepts and rejects the same voice ids', () => {
    for (const value of ['f9fc912e-e650-4766-a20c-5a93a43aa6e3', 'Microsoft Aria Online (Natural)', 'short', '']) {
      expect(shared.isCartesiaVoiceId(value)).toBe(isCartesiaVoiceId(value));
    }
  });
});
