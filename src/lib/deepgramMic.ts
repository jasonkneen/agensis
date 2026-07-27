import { floatToPcm16 } from './voiceStream';
import { voiceRealtime } from './backendClient';
// `?url` so Vite emits the worklet as a same-origin asset rather than inlining
// it. A Blob URL also works today, but worklet scripts are governed by
// `script-src`, and netlify.toml's policy is `'self' 'unsafe-inline'` with no
// `blob:` — the microphone would die the day that policy is enforced.
import pcmTapUrl from './pcmTap.worklet.js?url';

// Microphone capture for the Deepgram relay. Everything with a side effect
// lives here; every decision lives in voiceStream.ts.
//
// The audio goes to OUR server, not to Deepgram: the key stays on Fly (see
// shared/voice-core.cjs for why the usual short-lived-token route is closed to
// us on this account), so the browser never holds a transcription credential
// at all. The frames ride the realtime socket the app already keeps open.

export interface MicEvents {
  /** The relay is live and audio is flowing. */
  onReady: (sampleRate: number) => void;
  /** A sentence for the user. The mic is not working; say why. */
  onError: (reason: string) => void;
}

/**
 * Why capture cannot start, or '' when it can. A sentence, because the caption
 * row prints it verbatim.
 */
export function micUnavailableReason(): string {
  if (typeof window === 'undefined') return 'Voice input needs a browser.';
  if (window.isSecureContext === false) return 'Voice input needs a secure (https) connection.';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser will not give the page a microphone.';
  if (typeof AudioContext === 'undefined') return 'This browser has no Web Audio support.';
  return '';
}

/**
 * One microphone capture, feeding one server-side Deepgram stream.
 *
 * Single-use: call `start` once and `stop` once. `stop` is idempotent and safe
 * to call before `start` has finished, which is the normal case when someone
 * joins and immediately leaves a huddle — an orphaned capture keeps the browser
 * mic indicator lit and keeps billing a transcription for a call nobody is in.
 */
export class DeepgramMic {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stopped = false;
  private muted = false;

  constructor(private readonly events: MicEvents) {}

  /** Drop audio on the floor without tearing the stream down (echo guard). */
  setMuted(muted: boolean) {
    this.muted = muted;
  }

  async start(): Promise<void> {
    const unavailable = micUnavailableReason();
    if (unavailable) {
      this.events.onError(unavailable);
      return;
    }
    if (!voiceRealtime.isOpen()) {
      this.events.onError('Not connected to the server — voice will retry.');
      return;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // The FIRST line of echo defence, and the cheapest. The guard window
          // in voiceStream.ts is the second: this cancels our own speaker
          // output before it is ever digitised, and the guard catches whatever
          // survives (an external speaker, a browser that ignores the hint).
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (error) {
      this.events.onError(microphoneErrorMessage(error));
      return;
    }
    if (this.stopped) return this.releaseStream();

    // Ask for 16kHz — what Flux wants, and a sixth of the bytes of the 48kHz
    // default. Browsers that refuse simply give us their own rate, which is
    // then what we declare to Deepgram: no resampling anywhere, so nothing can
    // quietly degrade the audio the model sees.
    this.context = new AudioContext({ sampleRate: 16000 });
    const sampleRate = this.context.sampleRate;

    try {
      await this.context.audioWorklet.addModule(pcmTapUrl);
    } catch (error) {
      this.events.onError('This browser could not start audio capture.');
      console.warn('[voice] audio worklet failed:', error);
      void this.stop();
      return;
    }
    if (this.stopped) return void this.stop();

    this.source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'agensis-pcm-tap');
    this.node.port.onmessage = (event) => {
      if (this.stopped || this.muted) return;
      const samples = event.data as Float32Array;
      if (!samples?.length) return;
      voiceRealtime.sendAudio(floatToPcm16(samples).buffer);
    };
    this.source.connect(this.node);
    // NOT connected to the destination: routing the microphone to the speakers
    // is a feedback loop, and the worklet runs whether or not its output goes
    // anywhere.

    voiceRealtime.start(sampleRate);
    this.events.onReady(sampleRate);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // Detach first so a frame already in the worklet's port queue cannot be
    // sent into a stream the server is about to close.
    if (this.node) {
      this.node.port.onmessage = null;
      try { this.node.disconnect(); } catch { /* already detached */ }
      this.node = null;
    }
    if (this.source) {
      try { this.source.disconnect(); } catch { /* already detached */ }
      this.source = null;
    }
    voiceRealtime.stop();
    this.releaseStream();
    const context = this.context;
    this.context = null;
    if (context) await context.close().catch(() => { /* already closed */ });
  }

  private releaseStream() {
    for (const track of this.stream?.getTracks() || []) {
      try { track.stop(); } catch { /* already stopped */ }
    }
    this.stream = null;
  }
}

function microphoneErrorMessage(error: unknown): string {
  const name = (error as { name?: string })?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access is blocked — allow it in the browser to talk.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found.';
  }
  if (name === 'NotReadableError') {
    return 'The microphone is in use by another application.';
  }
  return 'The microphone could not be opened.';
}
