import { describe, expect, it } from 'vitest';
import {
  HUDDLE_MARKER_KIND,
  HUDDLE_SESSION_FOLDER,
  canComposeInHuddle,
  hasOwnTranscript,
  huddleComposerPlaceholder,
  huddleMarkerTarget,
  huddleSummaryLine,
  huddleTranscriptTarget,
  isHuddleMarkerMessage,
  isHuddleSession,
  shouldOpenHuddlePanel,
} from '../../src/lib/huddleTranscript';
import { foldHuddleState } from '../../src/lib/huddleState';
import type { Huddle, HuddleState, Message } from '../../src/types';

// A huddle is ad-hoc; the channel is the record.
//
// Transcribed speech used to be posted into the host channel as ordinary
// messages, which made every voice call part of the channel's permanent
// history. It now goes into the huddle's own session. The routing decision that
// implements that is one function, and it has exactly one way to be wrong in
// each direction:
//
//   - returning the CHANNEL for a huddle that has its own session puts the
//     whole conversation back where it was, invisibly. Nothing errors; the
//     feature just is not there.
//   - returning NOTHING for an old huddle that has no transcript session drops
//     every utterance on the floor instead of falling back to the behaviour
//     those huddles actually had.

const CHANNEL = 'session-channel';
const TRANSCRIPT = 'session-transcript';

function state(overrides: Partial<HuddleState> = {}): HuddleState {
  return {
    id: 'h1',
    workspaceId: 'ws1',
    sessionId: CHANNEL,
    transcriptSessionId: TRANSCRIPT,
    roomName: 'agensis-h1',
    startedBy: 'user-a',
    startedAt: '2026-07-26T10:00:00.000Z',
    endedAt: null,
    active: true,
    participants: [],
    participantCount: 0,
    peakParticipants: 0,
    everJoinedCount: 0,
    ...overrides,
  };
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    session_id: CHANNEL,
    role: 'assistant',
    content: 'You were in a huddle · 12:04 · Ada, Sam',
    created_at: '2026-07-26T10:12:04.000Z',
    ...overrides,
  };
}

describe('huddleTranscriptTarget', () => {
  it('sends the words to the huddle, not to the channel it was called from', () => {
    expect(huddleTranscriptTarget(state(), CHANNEL)).toBe(TRANSCRIPT);
  });

  it('falls back to the channel for a huddle that predates transcript sessions', () => {
    // Not a leak of the new behaviour — the ONLY behaviour those huddles ever
    // had. The channel really was their transcript.
    expect(huddleTranscriptTarget(state({ transcriptSessionId: null }), CHANNEL)).toBe(CHANNEL);
  });

  it('returns nothing when there is nowhere to post, rather than guessing', () => {
    expect(huddleTranscriptTarget(null, null)).toBe('');
    expect(huddleTranscriptTarget(state({ transcriptSessionId: null }), null)).toBe('');
    expect(huddleTranscriptTarget(undefined, undefined)).toBe('');
  });

  it('treats a blank transcript id as absent, not as a session called ""', () => {
    expect(huddleTranscriptTarget(state({ transcriptSessionId: '  ' }), CHANNEL)).toBe(CHANNEL);
  });
});

describe('hasOwnTranscript', () => {
  it('distinguishes a modern huddle from a legacy one', () => {
    expect(hasOwnTranscript(state())).toBe(true);
    expect(hasOwnTranscript(state({ transcriptSessionId: null }))).toBe(false);
    expect(hasOwnTranscript(null)).toBe(false);
  });
});

describe('canComposeInHuddle', () => {
  it('offers the composer in Chat mode, on a live huddle with its own transcript', () => {
    expect(canComposeInHuddle('chat', state())).toBe(true);
  });

  it('never offers it in Transcript mode — that view is read-only, minutes-style', () => {
    expect(canComposeInHuddle('transcript', state())).toBe(false);
  });

  it('withholds it in Chat mode once the huddle has ended', () => {
    expect(canComposeInHuddle('chat', state({ active: false }))).toBe(false);
  });

  it('keeps legacy huddles writable through their host channel', () => {
    expect(canComposeInHuddle('chat', state({ transcriptSessionId: null }))).toBe(true);
  });

  it('withholds it when there is no huddle at all', () => {
    expect(canComposeInHuddle('chat', null)).toBe(false);
    expect(canComposeInHuddle('transcript', null)).toBe(false);
  });
});

describe('the fold carries the transcript link through', () => {
  it('reads transcript_session_id off the row, and nulls a missing one', () => {
    // The blank-column trap, client side: if the fold drops this field every
    // huddle silently looks legacy and speech goes back into the channel.
    const row: Huddle = {
      id: 'h1',
      workspace_id: 'ws1',
      session_id: CHANNEL,
      transcript_session_id: TRANSCRIPT,
      room_name: 'agensis-h1',
      started_by: 'user-a',
      started_at: '2026-07-26T10:00:00.000Z',
      ended_at: null,
      notes: '',
    };
    expect(foldHuddleState(row, [])?.transcriptSessionId).toBe(TRANSCRIPT);
    expect(foldHuddleState({ ...row, transcript_session_id: null }, [])?.transcriptSessionId).toBeNull();
    // A row from a server that has not deployed the column yet.
    const legacy = { ...row } as Partial<Huddle>;
    delete legacy.transcript_session_id;
    expect(foldHuddleState(legacy as Huddle, [])?.transcriptSessionId).toBeNull();
  });
});

describe('the channel marker', () => {
  it('recognises the marker row and nothing else', () => {
    expect(isHuddleMarkerMessage(message({ message_kind: HUDDLE_MARKER_KIND }))).toBe(true);
    expect(isHuddleMarkerMessage(message({ message_kind: 'tool_step' }))).toBe(false);
    expect(isHuddleMarkerMessage(message())).toBe(false);
    expect(isHuddleMarkerMessage(null)).toBe(false);
  });

  it('links back to its huddle', () => {
    expect(huddleMarkerTarget(message({ message_kind: HUDDLE_MARKER_KIND, huddle_id: 'h9' }))).toBe('h9');
  });

  it('drops the link, not the row, when the huddle is gone', () => {
    // A marker whose huddle was pruned keeps its sentence — which is complete
    // on its own — and simply stops offering a button that would do nothing.
    expect(huddleMarkerTarget(message({ message_kind: HUDDLE_MARKER_KIND, huddle_id: null }))).toBe('');
    expect(huddleMarkerTarget(message({ message_kind: HUDDLE_MARKER_KIND }))).toBe('');
  });

  it('never links from a message that is not a marker', () => {
    // Otherwise any row that happened to carry a huddle_id would grow an
    // "Open transcript" button in the middle of the conversation.
    expect(huddleMarkerTarget(message({ huddle_id: 'h9' }))).toBe('');
  });
});

describe('huddleSummaryLine', () => {
  it('says who is here while it is live', () => {
    expect(huddleSummaryLine(state({ participantCount: 3 }))).toBe('3 in the huddle');
    expect(huddleSummaryLine(state())).toBe('Waiting for the first person to connect');
  });

  it('counts who WAS here once it has ended, not who is here now', () => {
    // An ended huddle has zero live participants by definition. Reading
    // participantCount here is how a call four people attended ends up
    // reporting that nobody came.
    const ended = state({ active: false, participantCount: 0, everJoinedCount: 4 });
    expect(huddleSummaryLine(ended)).toBe('Huddle ended — 4 people joined');
    expect(huddleSummaryLine({ ...ended, everJoinedCount: 1 })).toBe('Huddle ended — 1 person joined');
    expect(huddleSummaryLine({ ...ended, everJoinedCount: 0 })).toBe('Huddle ended — nobody joined');
  });

  it('says nothing about a huddle that is not there', () => {
    expect(huddleSummaryLine(null)).toBe('');
  });
});

describe('shouldOpenHuddlePanel', () => {
  it('opens once when you join a huddle', () => {
    expect(shouldOpenHuddlePanel('h1', '')).toBe(true);
  });

  it('does not reopen a panel the user closed mid-call', () => {
    // A fight the user cannot win: they close it, the effect reopens it.
    expect(shouldOpenHuddlePanel('h1', 'h1')).toBe(false);
  });

  it('opens again for a DIFFERENT huddle', () => {
    expect(shouldOpenHuddlePanel('h2', 'h1')).toBe(true);
  });

  it('stays shut when you are not in a call', () => {
    // A huddle someone else is holding must not seize a panel out from under
    // whatever you were reading.
    expect(shouldOpenHuddlePanel(null, '')).toBe(false);
    expect(shouldOpenHuddlePanel('', 'h1')).toBe(false);
  });
});

describe('huddleComposerPlaceholder', () => {
  it('names the addressee, because a channel huddle dispatches on mention', () => {
    expect(huddleComposerPlaceholder('coder')).toBe('Message @coder in this huddle');
    expect(huddleComposerPlaceholder('@coder')).toBe('Message @coder in this huddle');
  });

  it('says something true in a DM, where there is nobody to pick', () => {
    expect(huddleComposerPlaceholder('')).toBe('Message in this huddle');
  });
});

describe('isHuddleSession', () => {
  it('tells a huddle transcript apart from a channel', () => {
    expect(isHuddleSession({ folder: 'huddle' })).toBe(true);
    expect(isHuddleSession({ folder: 'Huddle' })).toBe(true);
    expect(isHuddleSession({ folder: 'General' })).toBe(false);
    expect(isHuddleSession({ folder: 'sub-thread' })).toBe(false);
    expect(isHuddleSession({ folder: null })).toBe(false);
    expect(isHuddleSession(null)).toBe(false);
  });

  it('is the only thing separating a huddle from a channel in a session list', () => {
    // Every OTHER "is this a channel" test in the app says yes to a huddle
    // transcript: it has no parent_message_id (so it is not a sub-thread) and
    // its participants are copied from the host (so it is not a DM either).
    const huddle = { id: 'h', folder: 'huddle', parent_message_id: null, deleted_at: null };
    const channel = { id: 'c', folder: 'General', parent_message_id: null, deleted_at: null };
    const subThread = { id: 's', folder: 'sub-thread', parent_message_id: 'm1', deleted_at: null };

    // The filter useChat and the sidebar both apply. Ordered by updated_at, the
    // huddle would otherwise be the session the app opens into.
    const channels = [huddle, channel, subThread]
      .filter(s => !s.parent_message_id && !s.deleted_at && !isHuddleSession(s));
    expect(channels.map(s => s.id)).toEqual(['c']);
  });
});

describe('constants', () => {
  it('agree with the server', () => {
    // Two literals, two files, one meaning each. server/huddles.cjs writes
    // message_kind='huddle' and folder='huddle'; if these drift, the marker
    // renders as a chat bubble and every huddle session appears in the sidebar.
    expect(HUDDLE_MARKER_KIND).toBe('huddle');
    expect(HUDDLE_SESSION_FOLDER).toBe('huddle');
  });
});
