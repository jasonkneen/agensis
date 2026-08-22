import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// ONE CALL, ONE SPEAKER — enforced structurally, because the failure is heard
// rather than seen and no rendering test can catch it.
//
// agensis is a single page holding many in-page windows, so the same channel
// can genuinely be on screen twice: two windows on one desktop, a window plus a
// snapped tile, the same DM reopened beside itself. Two mounts of the call
// machinery means two microphones published into one room and every agent reply
// read aloud twice, a beat apart — heard as two voices talking over each other.
// src/lib/speakerClaim.ts exists because of exactly that, and it is the runtime
// guard (see speakerClaim.test.ts).
//
// This is the compile-time half: the call is mounted in ONE place. When the
// huddle moved into the app-level dock, the fix was to move the connection —
// not to copy it — and a second copy reappearing anywhere in src/ is the thing
// these assertions are here to stop.
// ---------------------------------------------------------------------------

// cwd, not import.meta.url: vitest runs from the repo root, and under jsdom
// import.meta.url resolves against the document rather than the file.
const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

function filesContaining(needle: string): string[] {
  return sourceFiles(SRC)
    .filter(path => readFileSync(path, 'utf8').includes(needle))
    .map(path => path.slice(SRC.length + 1))
    .sort();
}

describe('the LiveKit connection has exactly one home', () => {
  it('is mounted in HuddleRoom and nowhere else', () => {
    // A second <LiveKitRoom> anywhere in the app is a second microphone in the
    // same room. If a new surface needs the call, it renders inside the dock's
    // room — it does not open its own.
    expect(filesContaining('<LiveKitRoom')).toEqual(['components/huddle/HuddleRoom.tsx']);
  });

  it('is the only file importing the LiveKit client at all', () => {
    expect(filesContaining("from '@livekit/components-react'")).toEqual([
      'components/huddle/HuddleRoom.tsx',
    ]);
  });

  it('is rendered by the dock, which is what survives navigation', () => {
    // The dock is mounted at App level, above every window and every view. That
    // is the entire reason it exists: a call mounted inside a channel view is
    // dropped the moment you look at anything else.
    // The newline keeps <HuddleRoomState, the room's own child, out of this.
    expect(filesContaining('<HuddleRoom\n')).toEqual(['components/huddle/HuddleDock.tsx']);
  });
});

describe('the browser runs no voice pipeline of its own', () => {
  // This used to assert the browser pipeline had exactly ONE home, because two
  // components calling it read every reply aloud twice. The pipeline is gone:
  // agents are LiveKit participants (voice-worker/), so STT, TTS and VAD all
  // happen in the room. The guard inverts — the browser must own NONE of it.
  //
  // It matters that this stays a test rather than a deletion. Re-adding a
  // browser-side recogniser or speaker would silently recreate the split that
  // made barge-in impossible: LiveKit cannot cancel echo from audio it does not
  // own, so capture would have to be muted during playback all over again.
  it('opens exactly one microphone — the one LiveKit publishes', () => {
    expect(filesContaining('getUserMedia(')).toEqual([]);
  });

  it('never schedules speech audio outside the room', () => {
    // Cartesia playback used to connect an AudioContext straight to the local
    // speakers, which is why other people on the call could not hear the agent.
    expect(filesContaining('new AudioContext(')).toEqual([]);
    expect(filesContaining('useSpeechOutput(')).toEqual([]);
    expect(filesContaining('useSpeechInput(')).toEqual([]);
  });

  it('confirms its own join from one component only', () => {
    // Two confirms for one browser would write two participant_joined events
    // for the same person and the roster would double-count them.
    expect(filesContaining('confirmJoin(')).toEqual(['components/huddle/HuddleDock.tsx']);
  });
});

describe('the dock REPLACED the old surfaces — it does not sit beside them', () => {
  it('has no in-channel huddle strip left to render', () => {
    // The strip stayed on screen after the dock shipped, showing its own
    // "waiting for the first person to connect" next to a Join button and
    // opening its own side panel. Two surfaces for one call is how they end up
    // disagreeing about whether you are connected — and a second live strip is
    // a second LiveKitRoom and a second voice.
    expect(existsSync(join(SRC, 'components/huddle/HuddleCard.tsx'))).toBe(false);
    expect(filesContaining('HuddleCard')).toEqual([]);
  });

  it('has no huddle side panel left to open', () => {
    expect(filesContaining("sidePanel === 'huddle'")).toEqual([]);
    expect(filesContaining("'huddle'")).not.toContain('components/windows/ChatWindowContent.tsx');
  });

  it('renders the huddle conversation from the dock and nowhere else', () => {
    // One panel, one answer to "where is the huddle" — live or long ended.
    expect(filesContaining('<HuddlePanel')).toEqual(['components/huddle/HuddleDock.tsx']);
  });
});
