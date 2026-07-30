import { describe, expect, it } from 'vitest';
import { nextChunkStart } from '../../src/lib/cartesiaSpeaker';

// THE double voice, finally. Sentence chunks were synthesized and then played in
// PARALLEL: the speaker zeroed the playback head at the start of every utterance,
// so sentence two scheduled at "now" while sentence one's audio was still queued
// ahead of it. Two sentences at once, from one agent, in one voice — heard as two
// voices talking over each other.
//
// Cartesia's `done` is the trap: it means generation finished, not playback. The
// head must therefore carry ACROSS sentences, and only stop() may reset it.
describe('nextChunkStart', () => {
  it('schedules AFTER the audio already queued — the head wins', () => {
    // Sentence one runs until t=8; sentence two must wait, not start at 2.05.
    expect(nextChunkStart(8, 2)).toBe(8);
  });

  it('never schedules in the past when the head has fallen behind', () => {
    // A gap in generation leaves the head behind the clock; a start time in the
    // past is dropped by the audio thread, losing the chunk entirely.
    expect(nextChunkStart(1, 5)).toBeCloseTo(5.05);
  });

  it('keeps a lead on a fresh timeline so the opening syllable survives', () => {
    // Scheduling at exactly currentTime races the audio thread and clips it.
    expect(nextChunkStart(0, 3)).toBeCloseTo(3.05);
    expect(nextChunkStart(0, 3)).toBeGreaterThan(3);
  });

  it('chains consecutive chunks end to end, with no overlap and no gap', () => {
    let head = 0;
    const durations = [0.4, 0.6, 0.5];
    const starts: number[] = [];
    for (const duration of durations) {
      const start = nextChunkStart(head, 0); // clock at 0: the head governs
      starts.push(start);
      head = start + duration;
    }
    expect(starts[0]).toBeCloseTo(0.05);
    expect(starts[1]).toBeCloseTo(0.45); // 0.05 + 0.4 — exactly where one ended
    expect(starts[2]).toBeCloseTo(1.05); // 0.45 + 0.6
  });

  it('two sentences whose heads carry over do NOT overlap', () => {
    // The regression itself: with the head reset to 0 the second sentence would
    // have started at currentTime + lead, on top of the first.
    const firstEnds = 4;
    const secondStart = nextChunkStart(firstEnds, 1.5);
    expect(secondStart).toBeGreaterThanOrEqual(firstEnds);
  });
});
