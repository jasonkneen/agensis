import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// ---------------------------------------------------------------------------
// THE DOCK MUST ACTUALLY START THE CALL.
//
// This file exists because of a bug that every other gate was blind to. The
// huddle moved out of the channel and into an app-level dock; the chrome moved
// with it, the LiveKit mount did not. The dock read the join token and used it
// as a BOOLEAN — `connected: !!connection` — so it rendered a whole panel
// around a WebRTC session that was never established. Nobody connected,
// including the local user, and `participant_joined` was never written because
// nothing ever confirmed a connection: production huddles from that build have
// zero join events where older ones have one each.
//
// A mount test cannot see this. The dock rendered perfectly. So these assert
// the two things whose ABSENCE was the bug:
//
//   1. given a token, the dock mounts a LiveKit room with it;
//   2. when that room reports connected, confirmJoin fires — once per
//      connection epoch, which is what writes the roster.
//
// Everything below the room (the voice hooks, the caption, the panel) is real:
// only LiveKit itself, the huddle hook and the realtime transport are stubbed,
// because those are a media server, a database and a websocket.
// ---------------------------------------------------------------------------

const stub = vi.hoisted(() => ({
  /** Props the last-rendered LiveKitRoom was given. */
  room: { token: '', serverUrl: '', connect: false, audio: false, mounts: 0 },
  /** The stubbed room reports a live session as soon as it mounts. */
  autoConnect: true,
  /** …or reports that it could not be established. */
  failWith: '',
  micEnabled: true,
  session: null as unknown,
  /** What useHuddle returns with no session id — a record view. */
  inert: null as unknown,
  /** What useHuddleRecord answers with for a huddle fetched by id. */
  record: null as unknown,
}));

vi.mock('@livekit/components-react', async () => {
  const react = await import('react');
  return {
    LiveKitRoom: (props: {
      token: string;
      serverUrl: string;
      connect?: boolean;
      audio?: boolean;
      className?: string;
      onConnected?: () => void;
      onError?: (error: Error) => void;
      children?: ReactNode;
    }) => {
      stub.room.token = props.token;
      stub.room.serverUrl = props.serverUrl;
      stub.room.connect = !!props.connect;
      stub.room.audio = !!props.audio;
      const { onConnected, onError } = props;
      react.useEffect(() => {
        stub.room.mounts += 1;
        if (stub.failWith) onError?.(new Error(stub.failWith));
        else if (stub.autoConnect) onConnected?.();
        // Keyed on the token: a new grant is a new session, exactly as the real
        // component treats it.
      }, [props.token, onConnected, onError]);
      return react.createElement(
        'div',
        { 'data-livekit-room': '', 'data-token': props.token, 'data-server-url': props.serverUrl },
        props.children,
      );
    },
    RoomAudioRenderer: () => react.createElement('div', { 'data-room-audio': '' }),
    useLocalParticipant: () => ({
      localParticipant: { setMicrophoneEnabled: async () => {} },
      isMicrophoneEnabled: stub.micEnabled,
    }),
    useParticipants: () => [],
  };
});

vi.mock('@/hooks/useHuddle', () => ({
  // Faithful to the real hook in the one way this file depends on: with no
  // session id there is no base path, so it can neither fetch nor hold a
  // connection. That is what makes reading an ended huddle inert.
  useHuddle: (_workspaceId: string | null, sessionId: string | null) => (
    sessionId ? stub.session : stub.inert
  ),
  useHuddleHeartbeat: () => {},
  useHuddleRecord: () => ({ state: stub.record, loading: false }),
  DEFAULT_HUDDLE_HEARTBEAT_MS: 30_000,
}));

// No websockets in a unit test. Everything that reads them stays mounted.
vi.mock('@/hooks/useTableSubscription', () => ({
  useTableSubscription: () => {},
  useRealtimeDeduper: () => ({ shouldProcess: () => true }),
}));

const { HuddleDock } = await import('../../src/components/huddle/HuddleDock');
const { HuddleDockProvider, useHuddleDock } = await import('../../src/components/huddle/HuddleDockContext');
const { __resetSpeakerClaims } = await import('../../src/lib/speakerClaim');
import type { HuddleAgentOption } from '../../src/lib/huddleAgents';
import type { HuddleState } from '../../src/types';

const AGENTS: HuddleAgentOption[] = [
  { id: 'a1', name: 'boris', handle: 'boris', avatar: '', accent: '#888888', voiceId: '' },
  { id: 'a2', name: 'Coder', handle: 'coder', avatar: '', accent: '#888888', voiceId: '' },
];

function huddleState(overrides: Partial<HuddleState> = {}): HuddleState {
  return {
    id: 'huddle-1',
    workspaceId: 'ws-1',
    sessionId: 'session-1',
    transcriptSessionId: 'transcript-1',
    roomName: 'room-1',
    startedBy: 'user-1',
    startedAt: '2026-07-27T10:00:00.000Z',
    endedAt: null,
    active: true,
    participants: [],
    participantCount: 0,
    peakParticipants: 0,
    everJoinedCount: 0,
    ...overrides,
  };
}

interface FakeSession {
  state: HuddleState | null;
  connection: {
    token: string;
    url: string;
    identity: string;
    roomName: string;
    huddleId: string;
    joinedAtMs: number;
    heartbeatIntervalMs: number;
  } | null;
  configured: boolean;
  busy: boolean;
  error: string;
  confirmJoin: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  startOrJoin: ReturnType<typeof vi.fn>;
}

function fakeSession(connected: boolean, joinedAtMs = 1_000): FakeSession {
  return {
    state: huddleState(),
    connection: connected
      ? {
        token: 'jwt-for-this-browser',
        url: 'wss://livekit.example/room',
        identity: 'user-1',
        roomName: 'room-1',
        huddleId: 'huddle-1',
        joinedAtMs,
        heartbeatIntervalMs: 30_000,
      }
      : null,
    configured: true,
    busy: false,
    error: '',
    confirmJoin: vi.fn(async () => {}),
    leave: vi.fn(),
    end: vi.fn(async () => {}),
    startOrJoin: vi.fn(async () => null),
  };
}

/** Opens the dock on a conversation, the way the channel toolbar does. */
function OpenHuddle({ agents = AGENTS }: { agents?: HuddleAgentOption[] }) {
  const dock = useHuddleDock();
  const open = dock?.openHuddle;
  useEffect(() => {
    open?.({ workspaceId: 'ws-1', sessionId: 'session-1', title: 'design', agents });
  }, [open, agents]);
  return null;
}

/** What a "You were in a huddle" marker row in the transcript does. */
function OpenRecord({ huddleId }: { huddleId: string }) {
  const dock = useHuddleDock();
  const open = dock?.openHuddleRecord;
  useEffect(() => {
    open?.({ workspaceId: 'ws-1', huddleId, title: 'design' });
  }, [open, huddleId]);
  return null;
}

/** What the channel toolbar does for as long as the channel is on screen. */
function PushRoster({ agents }: { agents: HuddleAgentOption[] }) {
  const dock = useHuddleDock();
  const push = dock?.setTargetAgents;
  useEffect(() => {
    push?.('session-1', agents);
  }, [push, agents]);
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  __resetSpeakerClaims();
  stub.room = { token: '', serverUrl: '', connect: false, audio: false, mounts: 0 };
  stub.autoConnect = true;
  stub.failWith = '';
  stub.micEnabled = true;
  stub.record = huddleState({ active: false, endedAt: '2026-07-27T10:30:00.000Z' });
  stub.inert = { ...fakeSession(false), state: null };
  // The voice-capabilities probe is the only network call this tree makes.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(session: FakeSession, agents: HuddleAgentOption[] = AGENTS) {
  stub.session = session;
  act(() => {
    root.render(createElement(
      HuddleDockProvider,
      null,
      createElement(OpenHuddle, { agents }),
      createElement(HuddleDock),
    ));
  });
}

describe('HuddleDock mounts the call', () => {
  it('renders a LiveKit room carrying the join token', () => {
    // THE REGRESSION. The dock had the token and used it only to decide
    // whether to be visible, so no WebRTC session was ever established.
    render(fakeSession(true));
    const room = container.querySelector('[data-livekit-room]');
    expect(room).not.toBeNull();
    expect(room?.getAttribute('data-token')).toBe('jwt-for-this-browser');
    expect(room?.getAttribute('data-server-url')).toBe('wss://livekit.example/room');
    // `connect` and `audio` are what make it a call rather than an idle room.
    expect(stub.room.connect).toBe(true);
    expect(stub.room.audio).toBe(true);
  });

  it('renders the audio sink, without which the call is silent', () => {
    render(fakeSession(true));
    expect(container.querySelector('[data-room-audio]')).not.toBeNull();
  });

  it('mounts no room at all when there is no token', () => {
    // A visible dock is not a call. Without a grant there is nothing to connect
    // to, and a room with an empty token would fail forever in the background.
    render(fakeSession(false));
    expect(container.querySelector('[data-huddle-dock]')).not.toBeNull();
    expect(container.querySelector('[data-livekit-room]')).toBeNull();
  });

  it('keeps the panel visible while the room is still connecting', () => {
    stub.autoConnect = false;
    render(fakeSession(true));
    expect(container.querySelector('[data-huddle-dock]')).not.toBeNull();
    expect(container.textContent).toContain('Connecting');
  });

  it('says so when the room cannot be established, rather than sitting on "connecting"', () => {
    // A failure that goes nowhere is indistinguishable from the bug this file
    // exists to catch: in both cases the panel is up and no call is happening.
    stub.failWith = 'WebRTC is not supported here';
    render(fakeSession(true));
    const failure = container.querySelector('[data-testid="huddle-dock-error"]');
    expect(failure?.textContent).toContain('WebRTC is not supported here');
  });

  it('does not confirm a join for a room that failed', () => {
    stub.failWith = 'WebRTC is not supported here';
    const session = fakeSession(true);
    render(session);
    expect(session.confirmJoin).not.toHaveBeenCalled();
  });
});

describe('confirming our own join', () => {
  it('confirms once when the room reports connected', () => {
    // This is what writes participant_joined. Without it the roster is empty
    // even while the call is running — LiveKit's webhook requires a dashboard
    // step that has never delivered a single event in this deployment.
    const session = fakeSession(true);
    render(session);
    expect(session.confirmJoin).toHaveBeenCalledTimes(1);
    expect(session.confirmJoin.mock.calls[0][0]).toMatchObject({ huddleId: 'huddle-1', joinedAtMs: 1_000 });
  });

  it('does NOT confirm again on a re-render of the same connection', () => {
    // A retry is the same event. Keyed on the connection epoch, not on the
    // connection object, which the hook rebuilds freely.
    const session = fakeSession(true);
    render(session);
    act(() => { root.render(createElement(
      HuddleDockProvider,
      null,
      createElement(OpenHuddle, {}),
      createElement(HuddleDock),
    )); });
    expect(session.confirmJoin).toHaveBeenCalledTimes(1);
  });

  it('confirms again for a NEW connection epoch — a rejoin is a new event', () => {
    const session = fakeSession(true);
    render(session);
    expect(session.confirmJoin).toHaveBeenCalledTimes(1);

    act(() => {
      session.connection = { ...session.connection!, joinedAtMs: 2_000, token: 'second-grant' };
      root.render(createElement(
        HuddleDockProvider,
        null,
        createElement(OpenHuddle, {}),
        createElement(HuddleDock),
      ));
    });
    expect(session.confirmJoin).toHaveBeenCalledTimes(2);
    expect(session.confirmJoin.mock.calls[1][0]).toMatchObject({ joinedAtMs: 2_000 });
  });

  it('never confirms a connection the room has not brought up', () => {
    // Confirming on the grant alone is how the roster fills with people who are
    // not in the call: the grant is a request for a token, not a session.
    stub.autoConnect = false;
    const session = fakeSession(true);
    render(session);
    expect(session.confirmJoin).not.toHaveBeenCalled();
  });
});

describe('leaving', () => {
  it('posts the leave rather than waiting for the reaper', () => {
    // session.leave() is what POSTs /leave for this epoch. Closing the dock
    // without it leaves presence to expire on the server's 150s clock, so the
    // roster keeps showing someone who has gone.
    const session = fakeSession(true);
    render(session);
    const leave = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Leave');
    expect(leave).toBeDefined();
    act(() => { leave?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(session.leave).toHaveBeenCalledTimes(1);
  });
});

describe('who is in the call', () => {
  it('shows agents as participants even though they hold no LiveKit connection', () => {
    // An agent hears the transcript and speaks through it, but never joins the
    // room. Building the chips from presence alone makes a three-agent call
    // look empty.
    render(fakeSession(true));
    const chips = Array.from(container.querySelectorAll('[title="boris"], [title="Coder"]'));
    expect(chips.map(c => c.textContent)).toEqual(['BO', 'CO']);
  });

  it('offers the agent switcher in a channel, where a plain sentence wakes nobody', () => {
    render(fakeSession(true));
    expect(container.querySelector('[aria-label="Who your voice goes to"]')).not.toBeNull();
  });

  it('hides the switcher in a DM, where the one agent answers a plain message', () => {
    render(fakeSession(true), []);
    expect(container.querySelector('[aria-label="Who your voice goes to"]')).toBeNull();
  });

  it('reads an ENDED huddle without starting a call in the channel it happened in', () => {
    // The huddle marker used to open a side panel inside the channel. That
    // panel is gone — the dock is the only place a huddle is shown — so this
    // mode has to exist here or the marker is a link to nothing. It must also
    // stay inert: "open the huddle from March" turning into "start a huddle
    // now" is the obvious way to get this wrong.
    stub.session = fakeSession(false);
    act(() => {
      root.render(createElement(
        HuddleDockProvider,
        null,
        createElement(OpenRecord, { huddleId: 'huddle-from-march' }),
        createElement(HuddleDock),
      ));
    });
    expect(container.querySelector('[data-huddle-dock]')).not.toBeNull();
    expect(container.querySelector('[data-livekit-room]')).toBeNull();
    expect((stub.session as FakeSession).startOrJoin).not.toHaveBeenCalled();
  });

  it('offers nothing to leave or end in a call that is over', () => {
    stub.session = fakeSession(false);
    act(() => {
      root.render(createElement(
        HuddleDockProvider,
        null,
        createElement(OpenRecord, { huddleId: 'huddle-from-march' }),
        createElement(HuddleDock),
      ));
    });
    const labels = Array.from(container.querySelectorAll('button')).map(b => b.textContent);
    expect(labels).not.toContain('Leave');
    expect(labels).not.toContain('End');
    expect(container.querySelector('[aria-label="Mute microphone"]')).toBeNull();
    expect(container.querySelector('[aria-label="Unmute microphone"]')).toBeNull();
  });

  it('hangs up properly when a record takes the dock from a live call', () => {
    // One panel, one slot. Re-keying the huddle hook drops the connection
    // silently, which leaves the roster claiming someone is still in a call
    // they walked out of until the server's staleness reaper catches up.
    const session = fakeSession(true);
    render(session);
    expect(session.leave).not.toHaveBeenCalled();

    act(() => {
      root.render(createElement(
        HuddleDockProvider,
        null,
        createElement(OpenRecord, { huddleId: 'huddle-from-march' }),
        createElement(HuddleDock),
      ));
    });
    expect(session.leave).toHaveBeenCalledTimes(1);
  });

  it('picks up a roster that only finishes loading after the call started', () => {
    // The channel's participants are still loading when the Huddle button
    // becomes clickable. A roster snapshotted at that moment is empty, and an
    // empty roster in a CHANNEL means every spoken sentence is posted with no
    // @mention — which wakes nobody, so the call is silent and looks broken.
    stub.session = fakeSession(true);
    act(() => {
      root.render(createElement(
        HuddleDockProvider,
        null,
        createElement(OpenHuddle, { agents: [] }),
        createElement(HuddleDock),
      ));
    });
    expect(container.querySelector('[title="boris"]')).toBeNull();

    act(() => {
      root.render(createElement(
        HuddleDockProvider,
        null,
        createElement(OpenHuddle, { agents: [] }),
        createElement(PushRoster, { agents: AGENTS }),
        createElement(HuddleDock),
      ));
    });
    expect(container.querySelector('[title="boris"]')).not.toBeNull();
  });
});
