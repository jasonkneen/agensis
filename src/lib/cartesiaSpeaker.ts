import { pcm16ToFloat32 } from './voiceStream';
import { apiAuthHeaders, apiUrl } from './backendClient';

// Text-to-speech playback through Cartesia sonic-3.5.
//
// The browser talks to Cartesia DIRECTLY, which it can do safely because
// Cartesia will exchange our secret key for a JWT that expires in two minutes
// and carries the `tts` grant and nothing else. Our backend mints it (see
// shared/voice-core.cjs); CARTESIA_API_KEY never leaves the server, and the
// audio never crosses our machine, which is worth roughly a round trip on
// every sentence.
//
// Audio is scheduled on an AudioContext rather than played through an <audio>
// element. That buys two things this feature needs: chunks queue back-to-back
// with no gap between sentences, and we know to the sample WHEN the last one
// finishes — which is exactly the number the echo guard needs to stop Deepgram
// transcribing our own reply and feeding it back to the agent.

const CARTESIA_WS = 'wss://api.cartesia.ai/tts/websocket';
// Re-mint with this much of the token's life left. Only the handshake needs a
// valid token, but a reconnect at minute 20 must not fail on an expired one.
const TOKEN_REFRESH_MARGIN_MS = 20_000;
// Cartesia should answer in ~110ms. A sentence that has produced nothing after
// this long is not coming, and must not hold the queue (or the echo guard).
const CHUNK_TIMEOUT_MS = 8000;
// After an unexpected close, re-open in the background rather than waiting for
// the next reply to pay for a cold connect (see `prewarm`). Bounded, because a
// service that is refusing connections must not be retried forever — three
// attempts and the next speak() reconnects on demand and reports the failure.
const REWARM_DELAY_MS = 1000;
const MAX_CONSECUTIVE_REWARMS = 3;
// A socket that stayed up this long was working; its close is an idle timeout,
// not a rejection, so re-warming may start over. Below it, the close looks like
// the service turning us away — and an open-then-immediately-close cycle is
// exactly how a reconnect loop runs for the length of a call.
const REWARM_HEALTHY_MS = 10_000;
// Shortest gap between two pre-warms, across every speaker in the page.
//
// A speaker is created and destroyed each time output mute is toggled, and each
// pre-warm spends one of the 20-per-minute token mints the backend allows a user
// per workspace. Before pre-warming, a toggle with no reply in between cost
// nothing; now it would cost a mint, so a jittery toggle (or a remount loop)
// could exhaust the budget and the NEXT genuine reply would be refused a token.
// One warm socket every couple of seconds is all the feature needs.
const PREWARM_COOLDOWN_MS = 2500;
let lastPrewarmAtMs = 0;

/**
 * Test seam: forget the shared pre-warm cooldown.
 *
 * The cooldown is deliberately module-wide (the mint budget it protects is
 * per-user, not per-speaker), which makes it state that leaks between tests in
 * one file — a second test's pre-warm gets skipped because the first one's ran in
 * the same millisecond. Not used by application code.
 */
export function resetPrewarmCooldown(): void {
  lastPrewarmAtMs = 0;
}

interface TtsCredentials {
  token: string;
  expiresAtMs: number;
  model: string;
  version: string;
  defaultVoiceId: string;
}

export interface SpeakerEvents {
  /** Who is being spoken right now, or '' when silent. */
  onSpeakingChange: (speakerName: string) => void;
  /**
   * When the currently-queued audio will have finished, as a Date.now()
   * timestamp — 0 when nothing is queued. Feeds playbackEchoGuardUntil.
   */
  onPlaybackEnd: (endsAtMs: number) => void;
  /** A sentence for the user. Never fails silently. */
  onError: (reason: string) => void;
}

interface QueuedSpeech {
  text: string;
  speaker: string;
  voiceId: string;
}

/**
 * One Cartesia connection for one huddle.
 *
 * Holds the socket open for the length of the call: a warm socket answers in
 * ~110ms where a cold one spent over a second on the first sentence (measured
 * against the live API on 2026-07-26), and a huddle is exactly the situation
 * where the first sentence is the one people judge.
 */
/**
 * When to start the next audio chunk.
 *
 * `head` is the playback timeline's write head — the moment the audio scheduled
 * so far runs out. Chunks are scheduled AHEAD of it so a reply plays as one
 * continuous voice, and the head is carried ACROSS sentences: Cartesia reports
 * `done` when it has finished generating, long before the audio it generated has
 * played, so a new sentence arriving is no evidence that the previous one has
 * been heard. Zeroing the head per sentence made two sentences play at once.
 *
 * The floor keeps a chunk out of the past: after a gap in generation the head
 * can lag `currentTime`, and scheduling at exactly `currentTime` races the audio
 * thread and clips the opening syllable, so a small lead is always applied.
 */
export function nextChunkStart(head: number, currentTime: number, lead = 0.05): number {
  return Math.max(head, currentTime + lead);
}

export class CartesiaSpeaker {
  private socket: WebSocket | null = null;
  private context: AudioContext | null = null;
  private credentials: TtsCredentials | null = null;
  private queue: QueuedSpeech[] = [];
  private current: QueuedSpeech | null = null;
  private contextId = '';
  private sampleRate = 24000;
  /** AudioContext time at which the next chunk should begin. */
  private nextStartAt = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private chunkTimer: number | null = null;
  private connecting: Promise<void> | null = null;
  private stopped = false;
  private rewarmTimer: number | null = null;
  private rewarms = 0;
  private openedAt = 0;

  constructor(
    private readonly workspaceId: string,
    private readonly events: SpeakerEvents,
  ) {}

  /**
   * Mint the token, open the socket and start the AudioContext BEFORE anything
   * needs saying.
   *
   * This is the single biggest cost in time-to-first-spoken-word, and it used to
   * be paid on the first sentence of every call. Measured against the live API
   * on 2026-07-26, from a laptop: a cold first word cost 395-626ms
   * (mint 132-336ms + socket 153-182ms + first chunk 107-112ms) where a warm one
   * costs 107-120ms. In the app the mint is worse still — it goes through our
   * own backend rather than straight to Cartesia. Called when the huddle opens,
   * which is also a user gesture, so the AudioContext starts running rather than
   * suspended.
   *
   * Failure is deliberately silent. Nothing has been asked for yet, so there is
   * nothing to apologise for; the first real speak() reconnects and reports it
   * with the sentence the user needs.
   */
  async prewarm(): Promise<void> {
    if (this.stopped) return;
    // Already warm: nothing to do, and no mint to spend.
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const now = Date.now();
    if (now - lastPrewarmAtMs < PREWARM_COOLDOWN_MS) return;
    lastPrewarmAtMs = now;
    await this.warm();
  }

  /**
   * The connect itself, without the mount-churn cooldown.
   *
   * The cooldown on `prewarm` exists to stop a toggled mount from spending token
   * mints; a socket that Cartesia has just closed is a different event with its
   * own budget (MAX_CONSECUTIVE_REWARMS), so re-warming must not be silenced by a
   * cooldown meant for something else.
   */
  private async warm(): Promise<void> {
    try {
      await this.ensureSocket();
    } catch {
      // Reported by the first speak() instead — see prewarm.
    }
  }

  /** Queue one already-chunked utterance. Playback starts as soon as audio arrives. */
  speak(text: string, speaker: string, voiceId: string) {
    if (this.stopped) return;
    const body = String(text || '').trim();
    if (!body) return;
    this.queue.push({ text: body, speaker, voiceId });
    void this.pump();
  }

  /**
   * Cut the voice off mid-word and forget everything queued.
   *
   * This is what leaving a call, muting output, and unmounting all need: an
   * agent that keeps talking into a huddle the human has left is the single
   * worst failure this component can have.
   */
  stop() {
    this.queue = [];
    this.current = null;
    this.clearChunkTimer();
    for (const source of this.sources) {
      try { source.onended = null; source.stop(); } catch { /* already finished */ }
    }
    this.sources.clear();
    this.nextStartAt = 0;
    // Tell Cartesia to abandon the context too, or it keeps generating (and
    // billing) audio for a sentence nobody will hear.
    if (this.contextId && this.socket?.readyState === WebSocket.OPEN) {
      try { this.socket.send(JSON.stringify({ context_id: this.contextId, cancel: true })); } catch { /* gone */ }
    }
    this.contextId = '';
    this.events.onSpeakingChange('');
    this.events.onPlaybackEnd(0);
  }

  /** Tear the whole thing down. Not reusable afterwards. */
  async close() {
    this.stopped = true;
    this.clearRewarmTimer();
    this.stop();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { socket.close(); } catch { /* already closing */ }
    }
    const context = this.context;
    this.context = null;
    if (context) await context.close().catch(() => { /* already closed */ });
  }

  // -- internals ----------------------------------------------------------

  private async pump() {
    if (this.stopped || this.current || this.queue.length === 0) return;
    try {
      await this.ensureSocket();
    } catch (error) {
      // Report once and drop the backlog: retrying a queue of stale sentences
      // into a call that has moved on is worse than silence.
      this.queue = [];
      this.events.onError(error instanceof Error ? error.message : 'The voice service is unavailable.');
      return;
    }
    if (this.stopped || this.current) return;
    const next = this.queue.shift();
    if (!next) return;

    this.current = next;
    this.contextId = `agensis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // DO NOT reset nextStartAt here. It is the playback timeline's write head,
    // and the previous sentence's audio is almost certainly still scheduled
    // ahead of `context.currentTime`: Cartesia's `done` means it finished
    // GENERATING, not that anything finished playing, and finishCurrent pumps
    // the next sentence the moment it arrives. Zeroing the head made the next
    // sentence schedule at "now", so two sentences played SIMULTANEOUSLY —
    // which is what the double voice actually was. Carrying the head forward is
    // what makes a multi-sentence reply one continuous voice.
    //
    // stop() still zeroes it, because there the scheduled audio is being
    // cancelled and the timeline genuinely restarts.
    try {
      this.socket?.send(JSON.stringify({
        model_id: this.credentials?.model || 'sonic-3.5',
        transcript: next.text,
        voice: { mode: 'id', id: next.voiceId || this.credentials?.defaultVoiceId },
        output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: this.sampleRate },
        language: 'en',
        context_id: this.contextId,
        continue: false,
      }));
    } catch {
      this.current = null;
      this.events.onError('The voice service dropped the connection.');
      return;
    }
    this.events.onSpeakingChange(next.speaker);
    this.armChunkTimer();
  }

  private async ensureSocket() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async connect() {
    const credentials = await this.freshCredentials();
    this.credentials = credentials;
    if (!this.context) this.context = new AudioContext();
    // Chrome suspends an AudioContext created outside a gesture; a huddle join
    // IS a gesture, but a reconnect ten minutes later is not.
    if (this.context.state === 'suspended') await this.context.resume().catch(() => { /* stays suspended */ });

    const url = `${CARTESIA_WS}?cartesia_version=${encodeURIComponent(credentials.version)}&access_token=${encodeURIComponent(credentials.token)}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('The voice service did not answer.')), 8000);
      socket.onopen = () => { window.clearTimeout(timer); resolve(); };
      socket.onerror = () => { window.clearTimeout(timer); reject(new Error('Could not reach the voice service.')); };
    });

    socket.onmessage = (event) => this.handleMessage(event);
    socket.onerror = () => { this.events.onError('The voice service dropped the connection.'); };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      // A mid-sentence close leaves `current` set, which would wedge the queue
      // (and latch the echo guard) forever. Release it and let the next speak()
      // reconnect.
      if (this.current) this.finishCurrent();
      // Cartesia closes a socket that has been idle, and a huddle is mostly
      // silence. Re-opening in the background is what keeps `prewarm`'s saving
      // alive for the whole call instead of only its first sentence.
      //
      // Whether this close refunds the re-warm budget is the difference between
      // a keepalive and a spin. A socket that was up for a while was working, so
      // its close is an idle timeout and re-warming starts fresh. One that closed
      // the moment it opened is the service refusing us, and refunding THAT would
      // make the ceiling below unreachable — open, close, re-warm, forever.
      if (this.openedAt && Date.now() - this.openedAt >= REWARM_HEALTHY_MS) this.rewarms = 0;
      this.openedAt = 0;
      this.scheduleRewarm();
    };
    this.openedAt = Date.now();
  }

  /**
   * Re-open the socket shortly after it closed on its own, so the next reply is
   * still warm.
   *
   * Never while something is queued (pump() reconnects on demand and reports
   * errors), and never more than MAX_CONSECUTIVE_REWARMS times without a
   * successful connect in between — otherwise a service that is refusing us
   * turns a silent call into an endless reconnect loop.
   */
  private scheduleRewarm() {
    if (this.stopped || this.rewarmTimer !== null) return;
    if (this.queue.length > 0 || this.current) return;
    if (this.rewarms >= MAX_CONSECUTIVE_REWARMS) return;
    this.rewarms += 1;
    this.rewarmTimer = window.setTimeout(() => {
      this.rewarmTimer = null;
      // `socket` can hold a socket that never opened (connect assigns it before
      // awaiting the handshake), so ask readyState rather than truthiness —
      // otherwise one refused connect would disable re-warming for the call.
      if (this.stopped || this.queue.length > 0 || this.current) return;
      if (this.socket?.readyState === WebSocket.OPEN) return;
      void this.warm();
    }, REWARM_DELAY_MS);
  }

  private clearRewarmTimer() {
    if (this.rewarmTimer !== null) {
      window.clearTimeout(this.rewarmTimer);
      this.rewarmTimer = null;
    }
  }

  private async freshCredentials(): Promise<TtsCredentials> {
    const held = this.credentials;
    if (held && held.expiresAtMs - Date.now() > TOKEN_REFRESH_MARGIN_MS) return held;

    const response = await fetch(apiUrl(`/backend/workspaces/${this.workspaceId}/voice/tts-token`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
      body: '{}',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(payload?.error?.message || 'The voice service is not configured.'));
    }
    const data = payload?.data || {};
    if (!data.token) throw new Error('The voice service returned no credentials.');
    const ttlMs = (Number(data.expiresInSeconds) || 120) * 1000;
    if (Number(data.output?.sample_rate)) this.sampleRate = Number(data.output.sample_rate);
    return {
      token: String(data.token),
      expiresAtMs: Date.now() + ttlMs,
      model: String(data.model || 'sonic-3.5'),
      version: String(data.version || '2026-03-01'),
      defaultVoiceId: String(data.defaultVoiceId || ''),
    };
  }

  private handleMessage(event: MessageEvent) {
    let message: { type?: string; data?: string; context_id?: string; error?: string };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    // A late chunk from a context we cancelled must not be played over whatever
    // is speaking now.
    if (message.context_id && message.context_id !== this.contextId) return;

    if (message.type === 'chunk' && message.data) {
      this.armChunkTimer();
      this.enqueueAudio(message.data);
      return;
    }
    if (message.type === 'done') {
      this.finishCurrent();
      return;
    }
    if (message.type === 'error') {
      this.events.onError('The voice service could not read that reply.');
      console.warn('[voice] cartesia error:', message.error);
      this.finishCurrent();
    }
  }

  private enqueueAudio(base64: string) {
    const context = this.context;
    if (!context) return;
    const bytes = decodeBase64(base64);
    if (!bytes.length) return;
    const samples = pcm16ToFloat32(bytes);
    if (!samples.length) return;

    const buffer = context.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    // A small lead on the first chunk: scheduling at exactly currentTime races
    // the audio thread and drops the opening syllable.
    const startAt = nextChunkStart(this.nextStartAt, context.currentTime);
    source.start(startAt);
    this.nextStartAt = startAt + buffer.duration;
    this.sources.add(source);
    source.onended = () => { this.sources.delete(source); };

    // Wall-clock, because that is the unit the echo guard compares against.
    this.events.onPlaybackEnd(Date.now() + Math.max(0, this.nextStartAt - context.currentTime) * 1000);
  }

  private finishCurrent() {
    this.clearChunkTimer();
    this.current = null;
    this.contextId = '';
    if (this.queue.length > 0) {
      void this.pump();
      return;
    }
    // Hold "speaking" until the queued audio has actually played out, or the
    // caption clears while the agent is still mid-word.
    const context = this.context;
    const remainingMs = context ? Math.max(0, this.nextStartAt - context.currentTime) * 1000 : 0;
    window.setTimeout(() => {
      if (this.stopped || this.current || this.queue.length > 0) return;
      this.events.onSpeakingChange('');
    }, remainingMs);
  }

  private armChunkTimer() {
    this.clearChunkTimer();
    this.chunkTimer = window.setTimeout(() => {
      this.chunkTimer = null;
      if (!this.current) return;
      console.warn('[voice] cartesia produced no audio — skipping this reply');
      this.events.onError('A reply could not be read aloud.');
      this.finishCurrent();
    }, CHUNK_TIMEOUT_MS);
  }

  private clearChunkTimer() {
    if (this.chunkTimer !== null) {
      window.clearTimeout(this.chunkTimer);
      this.chunkTimer = null;
    }
  }
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}
