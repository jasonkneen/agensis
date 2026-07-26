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

  constructor(
    private readonly workspaceId: string,
    private readonly events: SpeakerEvents,
  ) {}

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
    this.nextStartAt = 0;
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
    };
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
    const startAt = Math.max(this.nextStartAt, context.currentTime + 0.05);
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
