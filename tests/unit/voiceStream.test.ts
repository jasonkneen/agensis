import { describe, expect, it } from 'vitest';
import {
  chooseEngines,
  floatToPcm16,
  flushRemainder,
  IDLE_TURN,
  isEchoSuppressed,
  pcm16ToFloat32,
  playbackEchoGuardUntil,
  PLAYBACK_ECHO_TAIL_MS,
  readFluxEvent,
  reduceTurn,
  sentenceChunks,
  SENTENCE_SOFT_LIMIT,
  type FluxEvent,
} from '@/lib/voiceStream';

describe('floatToPcm16', () => {
  it('maps the full range without wrapping', () => {
    const out = floatToPcm16(new Float32Array([0, 1, -1, 0.5, -0.5]));
    expect(Array.from(out)).toEqual([0, 32767, -32768, 16383, -16384]);
  });

  it('clamps out-of-range samples instead of letting them wrap', () => {
    // The bug this guards: 1.5 * 32767 overflows Int16 and comes out NEGATIVE,
    // turning a loud syllable into a burst of noise the model cannot read.
    const out = floatToPcm16(new Float32Array([1.5, -1.5, 12]));
    expect(Array.from(out)).toEqual([32767, -32768, 32767]);
  });

  it('produces one sample per input sample', () => {
    expect(floatToPcm16(new Float32Array(320)).length).toBe(320);
  });
});

describe('pcm16ToFloat32', () => {
  it('reads little-endian pairs back to the same values', () => {
    const source = new Float32Array([0, 0.5, -0.5, -1]);
    const bytes = new Uint8Array(floatToPcm16(source).buffer);
    const round = pcm16ToFloat32(bytes);
    expect(round.length).toBe(4);
    for (let i = 0; i < source.length; i += 1) {
      expect(round[i]).toBeCloseTo(source[i], 4);
    }
  });

  it('ignores a trailing odd byte rather than reading past the end', () => {
    expect(pcm16ToFloat32(new Uint8Array([0x00, 0x40, 0x11])).length).toBe(1);
  });

  it('is empty for empty input', () => {
    expect(pcm16ToFloat32(new Uint8Array(0)).length).toBe(0);
  });
});

describe('readFluxEvent', () => {
  it('recognises each turn event', () => {
    const kinds = ['StartOfTurn', 'Update', 'EagerEndOfTurn', 'TurnResumed', 'EndOfTurn'].map(
      event => readFluxEvent({ type: 'TurnInfo', event, transcript: 'hi' }).kind,
    );
    expect(kinds).toEqual(['start', 'update', 'eager', 'resumed', 'final']);
  });

  it('reads the connect frame and the error frame', () => {
    expect(readFluxEvent({ type: 'Connected', request_id: 'x' }).kind).toBe('connected');
    const error = readFluxEvent({ type: 'Error', code: 'INTERNAL_SERVER_ERROR', description: 'boom' });
    expect(error.kind).toBe('error');
    expect(error.message).toBe('boom');
  });

  it('trims the transcript and defaults the confidence', () => {
    const event = readFluxEvent({ type: 'TurnInfo', event: 'Update', transcript: '  hello there  ' });
    expect(event.transcript).toBe('hello there');
    expect(event.endOfTurnConfidence).toBe(0);
  });

  it('survives junk without throwing', () => {
    for (const junk of [null, undefined, 42, 'nope', {}, { type: 'Whatever' }]) {
      expect(readFluxEvent(junk).kind).toMatch(/other|connected/);
    }
  });
});

describe('reduceTurn', () => {
  const event = (over: Partial<FluxEvent>): FluxEvent => ({
    kind: 'update', transcript: '', endOfTurnConfidence: 0, message: '', ...over,
  });

  it('shows interim text while the turn is running', () => {
    let state = reduceTurn(IDLE_TURN, event({ kind: 'start', transcript: 'what' }));
    state = reduceTurn(state, event({ kind: 'update', transcript: 'what is the' }));
    expect(state.interim).toBe('what is the');
    expect(state.utterance).toBe('');
  });

  it('commits exactly once, on EndOfTurn', () => {
    let state = reduceTurn(IDLE_TURN, event({ kind: 'update', transcript: 'ship it' }));
    state = reduceTurn(state, event({ kind: 'final', transcript: 'ship it now' }));
    expect(state.utterance).toBe('ship it now');
    expect(state.interim).toBe('');
    // The next unrelated frame must NOT re-emit it — that would post the same
    // sentence twice and dispatch the agent twice.
    state = reduceTurn(state, event({ kind: 'other' }));
    expect(state.utterance).toBe('');
  });

  it('does NOT commit on EagerEndOfTurn', () => {
    // Eager is a guess Flux may retract with TurnResumed. Posting a chat message
    // dispatches an agent and cannot be un-posted, so a guess is not enough.
    const state = reduceTurn(IDLE_TURN, event({ kind: 'eager', transcript: 'maybe done', endOfTurnConfidence: 0.6 }));
    expect(state.utterance).toBe('');
    expect(state.interim).toBe('maybe done');
  });

  it('keeps the caption when a resumed frame carries no transcript', () => {
    let state = reduceTurn(IDLE_TURN, event({ kind: 'update', transcript: 'still talking' }));
    state = reduceTurn(state, event({ kind: 'resumed', transcript: '' }));
    expect(state.interim).toBe('still talking');
  });

  it('falls back to the interim when EndOfTurn carries no transcript', () => {
    let state = reduceTurn(IDLE_TURN, event({ kind: 'update', transcript: 'the last thing' }));
    state = reduceTurn(state, event({ kind: 'final', transcript: '' }));
    expect(state.utterance).toBe('the last thing');
  });

  it('surfaces an error and clears the turn', () => {
    let state = reduceTurn(IDLE_TURN, event({ kind: 'update', transcript: 'half a' }));
    state = reduceTurn(state, event({ kind: 'error', message: 'stream died' }));
    expect(state).toEqual({ interim: '', utterance: '', error: 'stream died' });
  });

  it('starts a new turn clean', () => {
    let state = reduceTurn(IDLE_TURN, event({ kind: 'final', transcript: 'first' }));
    state = reduceTurn(state, event({ kind: 'start', transcript: '' }));
    expect(state).toEqual({ interim: '', utterance: '', error: '' });
  });
});

describe('sentenceChunks', () => {
  it('speaks the first sentence before the second has been written', () => {
    const first = sentenceChunks('The build passed. Now the', '');
    expect(first.speak).toEqual(['The build passed.']);
    // The unfinished fragment is held, not spoken.
    expect(first.spoken).toBe('The build passed.');

    const second = sentenceChunks('The build passed. Now the tests. And', first.spoken);
    expect(second.speak).toEqual(['Now the tests.']);
  });

  it('emits several sentences that arrive in one update', () => {
    const split = sentenceChunks('One. Two! Three? Four', '');
    expect(split.speak).toEqual(['One.', 'Two!', 'Three?']);
  });

  it('does not break a decimal or an initial into a sentence', () => {
    expect(sentenceChunks('We use sonic 3.5 today. Yes', '').speak).toEqual(['We use sonic 3.5 today.']);
    expect(sentenceChunks('Ask J. Kneen about it. Right', '').speak).toEqual(['Ask J. Kneen about it.']);
  });

  it('breaks on a colon or semicolon, which are real pauses in speech', () => {
    expect(sentenceChunks('Results: two failures; one fixed. ', '').speak)
      .toEqual(['Results:', 'two failures;', 'one fixed.']);
  });

  it('says nothing new when nothing was added', () => {
    const split = sentenceChunks('All done.', 'All done.');
    expect(split.speak).toEqual([]);
    expect(split.spoken).toBe('All done.');
  });

  it('drops the tail of a REWRITE rather than repeating a paragraph', () => {
    const split = sentenceChunks('Actually, something else entirely.', 'The build passed.');
    expect(split.speak).toEqual([]);
    expect(split.spoken).toBe('The build passed.');
  });

  it('breaks a run-on at a clause boundary rather than starving the voice', () => {
    const runOn = `${'and then '.repeat(30)}, and finally something`;
    expect(runOn.length).toBeGreaterThan(SENTENCE_SOFT_LIMIT);
    const split = sentenceChunks(runOn, '');
    expect(split.speak.length).toBe(1);
    expect(split.speak[0].length).toBeLessThanOrEqual(SENTENCE_SOFT_LIMIT);
    expect(runOn.startsWith(split.spoken)).toBe(true);
  });

  it('holds a short unterminated fragment instead of speaking half a word', () => {
    expect(sentenceChunks('I think we sho', '').speak).toEqual([]);
  });

  it('handles empty and whitespace input', () => {
    expect(sentenceChunks('', '').speak).toEqual([]);
    expect(sentenceChunks('   ', '').speak).toEqual([]);
  });
});

describe('flushRemainder', () => {
  it('says the held fragment once the message is known to be finished', () => {
    const split = flushRemainder('The build passed. Now the tests', 'The build passed.');
    expect(split.speak).toEqual(['Now the tests']);
    expect(split.spoken).toBe('The build passed. Now the tests');
  });

  it('says nothing when everything was already spoken', () => {
    expect(flushRemainder('All done.', 'All done.').speak).toEqual([]);
  });

  it('refuses to re-read a rewritten message', () => {
    expect(flushRemainder('Something else.', 'The build passed.').speak).toEqual([]);
  });
});

describe('playbackEchoGuardUntil', () => {
  it('guards past the end of the scheduled audio', () => {
    expect(playbackEchoGuardUntil(10_000)).toBe(10_000 + PLAYBACK_ECHO_TAIL_MS);
  });

  it('is open when nothing has been queued', () => {
    expect(playbackEchoGuardUntil(0)).toBe(0);
    expect(isEchoSuppressed(playbackEchoGuardUntil(0), 1)).toBe(false);
  });

  it('suppresses during playback and for the tail, then stops', () => {
    const guard = playbackEchoGuardUntil(5_000, 400);
    expect(isEchoSuppressed(guard, 4_999)).toBe(true);
    expect(isEchoSuppressed(guard, 5_399)).toBe(true);
    expect(isEchoSuppressed(guard, 5_400)).toBe(false);
  });
});

describe('chooseEngines', () => {
  const browser = { sttAvailable: true, ttsAvailable: true };
  const both = {
    stt: { provider: 'deepgram', model: 'flux-general-en', encoding: 'linear16' },
    tts: { provider: 'cartesia', model: 'sonic-3.5', version: '2026-03-01', defaultVoiceId: 'x' },
  };

  it('uses the hosted engines and says nothing when both are configured', () => {
    expect(chooseEngines(both, browser)).toEqual({ stt: 'deepgram', tts: 'cartesia', notice: '' });
  });

  it('falls back to the browser, out loud, when a key is missing', () => {
    const choice = chooseEngines({ ...both, stt: null }, browser);
    expect(choice.stt).toBe('browser');
    expect(choice.tts).toBe('cartesia');
    expect(choice.notice).toContain('Deepgram is unavailable');
  });

  it('reports both downgrades when nothing is configured', () => {
    const choice = chooseEngines({ stt: null, tts: null }, browser);
    expect(choice).toMatchObject({ stt: 'browser', tts: 'browser' });
    expect(choice.notice).toContain('Deepgram is unavailable');
    expect(choice.notice).toContain('Cartesia is unavailable');
  });

  it('says so plainly when there is no engine at all', () => {
    // A LOADED empty answer with no browser support — genuinely no engine.
    const choice = chooseEngines({ stt: null, tts: null }, { sttAvailable: false, ttsAvailable: false });
    expect(choice.stt).toBe('none');
    expect(choice.tts).toBe('none');
    expect(choice.notice).toContain('cannot transcribe speech');
    expect(choice.notice).toContain('cannot read replies aloud');
  });

  it('a FAILED capabilities fetch produces the loaded-empty shape, never null', () => {
    // useVoiceCapabilities' catch sets {stt:null, tts:null}. Null is reserved
    // for "the fetch has not answered yet", where nothing may speak — the old
    // version of this test pinned null -> browser, which was the two-voices bug.
    expect(chooseEngines({ stt: null, tts: null }, browser)).toMatchObject({ stt: 'browser', tts: 'browser' });
  });
});

// The two-voices bug, pinned. NULL capabilities means the fetch has not
// ANSWERED — it is not "Cartesia is unavailable". Treating loading as absence
// enabled the browser engine for the first beat of every call: a reply landing
// in that window played in the device default voice, then Cartesia mounted
// (anchored at joinedAtMs) and read the SAME reply again. One agent, two
// voices, the first one wrong. Reported twice before it was found.
describe('chooseEngines while capabilities are still loading', () => {
  const fullBrowser = { sttAvailable: true, ttsAvailable: true };

  it('enables NOTHING until the server has answered', () => {
    const choice = chooseEngines(null, fullBrowser);
    expect(choice.tts).toBe('none');
    expect(choice.stt).toBe('none');
  });

  it('a LOADED answer with no hosted providers still falls back to the browser', () => {
    // The fallback is for "the server said no", and only for that.
    const choice = chooseEngines({ stt: null, tts: null }, fullBrowser);
    expect(choice.tts).toBe('browser');
    expect(choice.stt).toBe('browser');
  });

  it('a loaded answer with hosted providers uses them', () => {
    const choice = chooseEngines(
      { stt: { provider: 'deepgram' }, tts: { provider: 'cartesia' } } as never,
      fullBrowser,
    );
    expect(choice.tts).toBe('cartesia');
    expect(choice.stt).toBe('deepgram');
  });
});
