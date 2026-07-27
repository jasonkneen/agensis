import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CartesiaSpeaker, resetPrewarmCooldown } from '../../src/lib/cartesiaSpeaker';

// Time-to-first-spoken-word, the connect half.
//
// The socket used to be opened by the first sentence of the call, so the first
// thing an agent said in a huddle paid for a token mint AND a websocket
// handshake before Cartesia had even been asked to synthesise anything. Measured
// against the live API on 2026-07-26: 395-626ms cold (mint 132-336 + socket
// 153-182 + first chunk 107-112) against 107-120ms warm. In the app it is worse
// than that, because the mint goes through our own backend rather than straight
// to Cartesia.
//
// These tests hold the two things that fix costs: the connect happens with
// NOTHING queued, and an idle close does not quietly put the call back on the
// cold path for its next reply.

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
  }

  /** Complete the handshake, as the real socket does a moment after construction. */
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  /** What Cartesia does to a socket nobody has spoken on for a while. */
  serverClose() {
    this.readyState = 3;
    this.onclose?.();
  }

  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
}

const events = () => ({
  onSpeakingChange: vi.fn(),
  onPlaybackEnd: vi.fn(),
  onError: vi.fn(),
});

let tokenRequests = 0;

beforeEach(() => {
  tokenRequests = 0;
  FakeSocket.instances = [];
  // The cooldown is module-wide by design, so it survives between tests here.
  resetPrewarmCooldown();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('AudioContext', class {
    state = 'running';
    currentTime = 0;
    resume = vi.fn();
    close = vi.fn(async () => { });
    createBuffer = vi.fn();
    createBufferSource = vi.fn();
    destination = {};
  });
  vi.stubGlobal('fetch', vi.fn(async () => {
    tokenRequests += 1;
    return {
      ok: true,
      json: async () => ({
        data: { token: 'tok', expiresInSeconds: 120, model: 'sonic-3.5', version: '2026-03-01', defaultVoiceId: 'v1' },
      }),
    };
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * Let the token fetch settle under fake timers.
 *
 * `prewarm` awaits a fetch before it constructs a socket, and with the clock
 * faked nothing on the microtask queue runs until the timers are advanced — so
 * without this the socket does not exist yet and the assertions read zero.
 */
async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Let the speaker's promise chain run, then finish the handshake it started. */
async function settleConnect(): Promise<FakeSocket> {
  await vi.waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  socket.open();
  await Promise.resolve();
  return socket;
}

describe('CartesiaSpeaker.prewarm', () => {
  it('mints a token and opens the socket with nothing queued', async () => {
    const speaker = new CartesiaSpeaker('ws-1', events());
    void speaker.prewarm();
    const socket = await settleConnect();

    expect(tokenRequests).toBe(1);
    expect(socket.url).toContain('access_token=tok');
    // The whole point: no transcript was sent, because nothing has been said yet.
    expect(socket.sent).toEqual([]);
    await speaker.close();
  });

  it('leaves the first real sentence with no connect to pay for', async () => {
    const speaker = new CartesiaSpeaker('ws-1', events());
    void speaker.prewarm();
    const socket = await settleConnect();

    speaker.speak('On it, checking now.', 'Coder', 'v1');
    await vi.waitFor(() => expect(socket.sent.length).toBe(1));

    // One socket, one token: the sentence went straight down the warm one.
    expect(FakeSocket.instances).toHaveLength(1);
    expect(tokenRequests).toBe(1);
    expect(JSON.parse(socket.sent[0]).transcript).toBe('On it, checking now.');
    await speaker.close();
  });

  it('does not report a pre-warm failure — nobody asked for anything yet', async () => {
    const handlers = events();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ error: { message: 'nope' } }) })));
    const speaker = new CartesiaSpeaker('ws-1', handlers);
    await speaker.prewarm();
    expect(handlers.onError).not.toHaveBeenCalled();
    await speaker.close();
  });

  it('does not spend a token mint per mount when output mute is toggled', async () => {
    // Muting output destroys the speaker and unmuting builds a new one. The
    // backend allows 20 token mints a minute per user per workspace, so a jittery
    // toggle used to be free and must not become a way to exhaust that budget and
    // have the next real reply refused a token.
    vi.useFakeTimers();
    for (let toggle = 0; toggle < 12; toggle += 1) {
      const speaker = new CartesiaSpeaker('ws-1', events());
      void speaker.prewarm();
      await flushMicrotasks();
      await speaker.close();
    }
    // The first mount warms the socket; the eleven that follow are inside the
    // cooldown and never reach the mint at all.
    expect(tokenRequests).toBe(1);
  });

  it('re-opens after an idle close, so the next reply is still warm', async () => {
    vi.useFakeTimers();
    const speaker = new CartesiaSpeaker('ws-1', events());
    void speaker.prewarm();
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    FakeSocket.instances[0].open();
    await Promise.resolve();

    FakeSocket.instances[0].serverClose();
    await vi.advanceTimersByTimeAsync(1200);
    // A second socket exists without anyone having spoken: the call is warm again.
    expect(FakeSocket.instances.length).toBe(2);
    await speaker.close();
  });

  it('stops re-opening once closed, and never after the huddle ends', async () => {
    vi.useFakeTimers();
    const speaker = new CartesiaSpeaker('ws-1', events());
    void speaker.prewarm();
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    FakeSocket.instances[0].open();
    await Promise.resolve();

    await speaker.close();
    FakeSocket.instances[0].serverClose();
    await vi.advanceTimersByTimeAsync(5000);
    // Leaving the call must not leave a reconnect loop behind it.
    expect(FakeSocket.instances.length).toBe(1);
  });

  it('gives up on a service that closes us the moment it opens us', async () => {
    vi.useFakeTimers();
    const speaker = new CartesiaSpeaker('ws-1', events());
    void speaker.prewarm();
    await flushMicrotasks();

    // The shape of a refusal: the handshake completes and the socket is gone
    // again immediately. Naively counting a successful OPEN as health refunds the
    // budget every cycle, and the ceiling below is never reached — which is a
    // reconnect running once a second for the length of the call.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
      if (socket.readyState === 3) break; // it stopped re-warming; nothing new to close
      socket.open();
      await Promise.resolve();
      socket.serverClose();
      await vi.advanceTimersByTimeAsync(1200);
    }
    // The initial pre-warm plus MAX_CONSECUTIVE_REWARMS, and then it stops. The
    // next speak() still reconnects on demand and reports the failure out loud.
    expect(FakeSocket.instances.length).toBe(4);
    await speaker.close();
  });

  it('keeps re-warming a long call, where each close really is an idle timeout', async () => {
    vi.useFakeTimers();
    const speaker = new CartesiaSpeaker('ws-1', events());
    void speaker.prewarm();
    await flushMicrotasks();

    // Five idle cycles, each socket held open well past the healthy threshold
    // before Cartesia times it out. A 40-minute call must not fall back to the
    // cold path after three quiet stretches.
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
      expect(socket).toBeDefined();
      socket.open();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60_000);
      socket.serverClose();
      await vi.advanceTimersByTimeAsync(1200);
    }
    expect(FakeSocket.instances.length).toBe(6);
    await speaker.close();
  });
});
