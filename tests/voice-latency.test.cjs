'use strict';

// ============================================================================
// tests/voice-latency.test.cjs
// ----------------------------------------------------------------------------
// Time-to-first-spoken-word in a huddle. Not correctness of the voice pipeline
// (tests/voice.test.cjs owns that) — the specific decisions that determine how
// long a person waits between finishing a sentence and hearing an answer.
//
// The stages, measured against the live APIs on 2026-07-26 so these tests guard
// numbers rather than opinions:
//
//   speech ends -> Flux EndOfTurn            ~90ms   (nothing left to win)
//   utterance   -> row + dispatch            ~2 HTTP round trips
//   model       -> first complete sentence   the dominant stage, unmeasured
//   sentence    -> first audio, warm socket  107-120ms
//   sentence    -> first audio, COLD socket  395-626ms
//
// Two of those are addressed here: the write that carries a finished sentence
// must not be held behind a throttle window, and the huddle's first sentence
// must not pay for a cold TTS connect. The third — the model — is only reachable
// through the prompt, so the note's first-sentence contract is asserted too: the
// reader cannot speak an unterminated fragment, so "one short sentence ending in
// a full stop" is a latency requirement, not a style preference.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../server/index.cjs');
const { clampEotThreshold, deepgramListenUrl, DEEPGRAM_EOT_MIN, DEEPGRAM_EOT_MAX } = require('../shared/voice-core.cjs');

const { streamFlushDue, BUILTIN_FLUSH_INTERVAL_MS: INTERVAL, VOICE_HUDDLE_NOTE } = __test;

// ---------------------------------------------------------------------------
// The write that gets spoken jumps the throttle
// ---------------------------------------------------------------------------

test('a streamed write waits out the throttle window while mid-sentence', () => {
  // 40ms after the last write, and the new text is half a sentence. Nothing is
  // sayable yet, so there is no reason to spend a realtime broadcast on it.
  assert.equal(
    streamFlushDue({ text: 'The deploy went out about', written: 'The deploy', lastFlushAt: 1000, now: 1040 }),
    false,
  );
});

test('a write that COMPLETES a sentence goes immediately, mid-window', () => {
  // Same 40ms, but the full stop has landed. This is the write the huddle
  // speaks: holding it for the remaining 210ms is 210ms of silence in a live
  // call, which is the whole bug.
  assert.equal(
    streamFlushDue({ text: 'The deploy went out four minutes ago.', written: 'The deploy', lastFlushAt: 1000, now: 1040 }),
    true,
  );
});

test('every terminator the reader can speak on also triggers a write', () => {
  // Must be a superset of the client splitter's boundaries (src/lib/voiceStream.ts).
  // A boundary it speaks on but we do not write on is silence with no cause.
  for (const tail of ['done.', 'done!', 'done?', 'done…', 'two things: first', 'one; two']) {
    assert.equal(
      streamFlushDue({ text: `ok ${tail} more`, written: 'ok ', lastFlushAt: 1000, now: 1010 }),
      true,
      `"${tail}" must flush immediately`,
    );
  }
});

test('the throttle still governs sentence-free text', () => {
  const args = { text: 'a much longer fragment with no terminator at all', written: 'a', lastFlushAt: 1000 };
  assert.equal(streamFlushDue({ ...args, now: 1000 + INTERVAL - 1 }), false);
  assert.equal(streamFlushDue({ ...args, now: 1000 + INTERVAL }), true);
});

test('nothing new means no write, however long it has been', () => {
  // The stream can deliver an identical partial (a retried delta, a tool step
  // that changed no text). Writing it would broadcast to every subscriber of the
  // session for nothing.
  assert.equal(streamFlushDue({ text: 'same.', written: 'same.', lastFlushAt: 0, now: 999_999 }), false);
  assert.equal(streamFlushDue({ text: '', written: '', lastFlushAt: 0, now: 999_999 }), false);
});

test('a rewritten block is judged whole, not as a tail', () => {
  // `written` is not a prefix, so there is no new tail to inspect; the sentence
  // shortcut looks at the replacement text itself rather than a bogus slice.
  assert.equal(
    streamFlushDue({ text: 'Actually it failed.', written: 'The deploy went out.', lastFlushAt: 1000, now: 1010 }),
    true,
  );
  assert.equal(
    streamFlushDue({ text: 'Actually it', written: 'The deploy went out.', lastFlushAt: 1000, now: 1010 }),
    false,
  );
});

// ---------------------------------------------------------------------------
// The prompt half: the first sentence has to be sayable
// ---------------------------------------------------------------------------

test('the voice note bounds the first sentence and requires a full stop', () => {
  // src/lib/voiceStream.ts hands Cartesia a sentence only once its terminator
  // arrives (or 220 characters have piled up). An opening "sentence" that runs
  // on is therefore silence, no matter how fast the model produced it.
  assert.match(VOICE_HUDDLE_NOTE, /FIRST sentence must be at most a dozen words/i);
  assert.match(VOICE_HUDDLE_NOTE, /END IN A FULL STOP/i);
  assert.match(VOICE_HUDDLE_NOTE, /Do not reason at length before that first sentence/i);
});

test('the voice note cancels the markdown instruction it is fighting', () => {
  // buildSystemPrompt asks every agent to "prefer markdown for structure", and
  // the daemon's own prompt suffix asks again. A heading has no full stop and a
  // bullet has no verb, so unless this is cancelled the fast path is unreachable.
  assert.match(VOICE_HUDDLE_NOTE, /Ignore any instruction to prefer markdown/i);
});

test('the fast first sentence must not become a premature claim', () => {
  // The acknowledgement exists to fill the gap before the work is done, which is
  // exactly when it is tempting to describe the work as finished.
  assert.match(VOICE_HUDDLE_NOTE, /may say what you are ABOUT to do/i);
  assert.match(VOICE_HUDDLE_NOTE, /never say you have already done it/i);
});

// ---------------------------------------------------------------------------
// End-of-turn threshold: fast already, and a 400 away from a dead microphone
// ---------------------------------------------------------------------------

test('an out-of-range end-of-turn threshold is clamped, not sent', () => {
  // 0.4 is refused by the API with HTTP 400 (verified live), and the client shows
  // "the transcription service did not answer" — a dead mic with no clue why.
  assert.equal(clampEotThreshold(0.4), DEEPGRAM_EOT_MIN);
  assert.equal(clampEotThreshold(0), DEEPGRAM_EOT_MIN);
  assert.equal(clampEotThreshold(1.5), DEEPGRAM_EOT_MAX);
  assert.equal(clampEotThreshold(0.7), 0.7);
});

test('a non-numeric threshold falls back to the default', () => {
  assert.equal(clampEotThreshold(undefined), 0.7);
  assert.equal(clampEotThreshold('snappy'), 0.7);
});

test('the listen URL never carries a threshold the API rejects', () => {
  const url = new URL(deepgramListenUrl({ sampleRate: 16000, eotThreshold: 0.1 }));
  const sent = Number(url.searchParams.get('eot_threshold'));
  assert.ok(sent >= DEEPGRAM_EOT_MIN && sent <= DEEPGRAM_EOT_MAX, `eot_threshold ${sent} is out of range`);
});
