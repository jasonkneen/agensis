import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nextSpeechChunk, normalizeTranscript, speechItemFor, voiceIdForSpeechItem, type SpeechItem, type VoiceMessage, type VoiceRosterEntry, pickSpeechVoice } from '../lib/huddleVoice';
import { claimSpeaker, releaseSpeaker, subscribeSpeakerReleases } from '@/lib/speakerClaim';
import {
  chooseEngines,
  flushRemainder,
  IDLE_TURN,
  readFluxEvent,
  reduceTurn,
  sentenceChunks,
  type EngineChoice,
  type SttEngine,
  type TtsEngine,
  type TurnState,
  type VoiceCapabilities,
} from '../lib/voiceStream';
import { CartesiaSpeaker } from '../lib/cartesiaSpeaker';
import { DeepgramMic, micUnavailableReason } from '../lib/deepgramMic';
import { apiAuthHeaders, apiUrl, backendClient, voiceRealtime } from '../lib/backendClient';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import {
  acceptHuddleVoiceSentence,
  huddleVoiceChannel,
  HUDDLE_VOICE_EVENT,
  type HuddleVoiceSentencePayload,
} from '../lib/huddleVoiceText';

// Voice for a huddle, WITHOUT putting the agent anywhere near audio.
//
// Speech becomes text and is posted as an ordinary chat message; text becomes
// speech when an agent message lands. The agent, the daemon, the dispatch path
// and the server's chat routes are all completely unaware that a microphone
// exists — which is why this works identically for daemon, builtin and MCP
// agents and needed no media-plane work at all.
//
// TWO ENGINE PAIRS live behind that plumbing, chosen at runtime by
// chooseEngines:
//
//   Deepgram Flux + Cartesia sonic-3.5 — the real pipeline. Flux decides when a
//   turn has ENDED rather than guessing from silence, and Cartesia's voices are
//   server-side, so an agent sounds the same on every machine.
//
//   SpeechRecognition + speechSynthesis — the fallback, unchanged and still
//   here. Verified in Chrome on macOS: 204 voices and not one Microsoft
//   Natural, because those exist only inside Edge. So the browser can never
//   give an agent a consistent voice; it can only avoid a dead microphone when
//   a key is missing, which is worth keeping it for.
//
// CLEANUP IS THE WHOLE GAME. An orphaned recogniser keeps posting messages into
// a channel after the human has left the call, and an orphaned utterance keeps
// talking over whatever they do next. Every listener, timer, recogniser,
// socket, AudioContext and utterance below is torn down on unmount AND when
// `enabled` goes false, and handlers are detached BEFORE abort/cancel/close so
// a late event from the dying object cannot re-enter.

// ---------------------------------------------------------------------------
// Minimal Web Speech typings (TypeScript 5.6's lib.dom has no SpeechRecognition)
// ---------------------------------------------------------------------------

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionConstructor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition || scope.webkitSpeechRecognition || null;
}

/**
 * Why voice input cannot run here, or '' when it can. Returned as a sentence
 * because the bar shows it verbatim — "not supported" with no reason sends
 * people hunting for a setting that does not exist.
 */
export function voiceInputUnavailableReason(): string {
  if (typeof window === 'undefined') return 'Voice input needs a browser.';
  if (window.isSecureContext === false) return 'Voice input needs a secure (https) connection.';
  if (!recognitionConstructor()) return 'Voice input is not supported in this browser — try Chrome or Edge.';
  return '';
}

// Chrome ends a continuous recognition session on its own every ~60s (and
// immediately when it cannot reach its speech service). Restarting is normal;
// restarting instantly, forever, is a spin. Back off, then give up out loud.
const RESTART_BACKOFF_MS = 800;
const MAX_RAPID_RESTARTS = 5;
const RAPID_RESTART_WINDOW_MS = 1500;

export interface SpeechInputState {
  /** '' when voice input can run; otherwise the reason it cannot. */
  unavailable: string;
  /** The recogniser is running right now. */
  listening: boolean;
  /** Words heard but not yet committed — shown live so a mishear is visible. */
  interim: string;
  error: string;
}

/**
 * Microphone -> text via the browser's own recogniser, while `enabled`.
 *
 * The fallback engine. `onUtterance` fires once per FINAL result (a natural
 * pause), never per interim word: posting every partial would flood the channel
 * and dispatch the agent on half a sentence.
 */
export function useBrowserSpeechInput(
  enabled: boolean,
  onUtterance: (text: string) => void,
): SpeechInputState {
  const [unavailable] = useState(() => voiceInputUnavailableReason());
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');

  // Held in a ref so a new callback identity never restarts the recogniser
  // (restarting drops whatever is mid-sentence).
  const utteranceRef = useRef(onUtterance);
  utteranceRef.current = onUtterance;

  useEffect(() => {
    if (!enabled || unavailable) {
      setListening(false);
      setInterim('');
      return;
    }
    const Recognition = recognitionConstructor();
    if (!Recognition) return;

    let stopped = false;
    let restartTimer: number | null = null;
    let rapidRestarts = 0;
    let lastStart = 0;
    const recognition = new Recognition();
    recognition.lang = navigator.language || 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    const start = () => {
      if (stopped) return;
      lastStart = Date.now();
      try {
        recognition.start();
      } catch {
        // "already started" — the previous session had not finished ending yet.
        // onend will call us again; nothing to do.
      }
    };

    recognition.onstart = () => {
      if (stopped) return;
      setListening(true);
      setError('');
    };

    recognition.onresult = (event) => {
      if (stopped) return;
      let pending = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result?.[0]?.transcript ?? '';
        if (result?.isFinal) {
          const text = normalizeTranscript(transcript);
          // Empty finals are routine (a clipped mic, a cough) and must never be
          // posted as a message.
          if (text) utteranceRef.current(text);
        } else {
          pending += transcript;
        }
      }
      setInterim(normalizeTranscript(pending));
    };

    recognition.onerror = (event) => {
      if (stopped) return;
      const kind = String(event?.error || '');
      // 'no-speech' and 'aborted' are the engine idling, not failures.
      if (kind === 'no-speech' || kind === 'aborted') return;
      if (kind === 'not-allowed' || kind === 'service-not-allowed') {
        stopped = true;
        setError('Microphone access is blocked — allow it in the browser to talk.');
        setListening(false);
        return;
      }
      setError(kind === 'network' ? 'Speech recognition lost its connection.' : `Speech recognition error: ${kind}`);
    };

    recognition.onend = () => {
      setListening(false);
      setInterim('');
      if (stopped) return;
      // A session that ended almost immediately means it is failing, not cycling.
      rapidRestarts = Date.now() - lastStart < RAPID_RESTART_WINDOW_MS ? rapidRestarts + 1 : 0;
      if (rapidRestarts >= MAX_RAPID_RESTARTS) {
        stopped = true;
        setError('Voice input stopped — the browser kept ending the session.');
        return;
      }
      restartTimer = window.setTimeout(start, RESTART_BACKOFF_MS);
    };

    start();

    return () => {
      // Order matters: latch the flag, kill the pending restart, DETACH every
      // handler, and only then abort. abort() can synchronously emit onend (and
      // on some builds a final onresult); with the handlers already gone there
      // is nothing left that could post a message after we have left the call.
      stopped = true;
      if (restartTimer !== null) window.clearTimeout(restartTimer);
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        // Already dead; nothing to abort.
      }
      setListening(false);
      setInterim('');
    };
  }, [enabled, unavailable]);

  return { unavailable, listening, interim, error };
}

// ---------------------------------------------------------------------------
// Speech out
// ---------------------------------------------------------------------------

// An agent message is written to the DB as a "Thinking 0s" placeholder and then
// UPDATEd as it streams, so "the row changed" is not "the agent finished
// talking". Two signals say a block is done:
//   1. a NEWER message row exists for this session (the daemon finalises a text
//      block and inserts the next placeholder in the same breath) — instant, and
//      this is what makes segmented turns feel fast;
//   2. otherwise, the content stopped changing for SETTLE_MS — the tail of a
//      turn, where no successor row is ever written.
const SETTLE_MS = 700;
const SPEECH_RATE = 1.05;
// How long to wait for speechSynthesis to actually START before giving up on an
// utterance. speechSynthesis fails silently in several real cases, and without a
// ceiling a dropped utterance blocks the queue and latches the echo guard, which
// mutes the microphone with "Paused while the reply plays" forever.
const SPEECH_START_TIMEOUT_MS = 1500;


export interface SpeechOutputState {
  /** '' when speech output can run; otherwise the reason it cannot. */
  unavailable: string;
  /** Display name of whoever is being spoken right now, or ''. */
  speakingName: string;
  /**
   * Date.now() timestamp at which the queued reply will have finished playing,
   * or 0 when nothing is queued.
   *
   * Only the Cartesia engine can know this — its audio is scheduled on an
   * AudioContext, so the end of the last sample is a number rather than an
   * event that arrives late. The echo guard uses it to stop Deepgram
   * transcribing our own reply back into the channel. The browser engine
   * reports 0 and falls back to guarding on `speakingName`, exactly as before.
   */
  playbackEndsAtMs: number;
}

interface PendingSpeech {
  item: SpeechItem;
  createdMs: number;
  changedAt: number;
}

/**
 * New AGENT messages in this session -> spoken aloud by the browser, while
 * `enabled`. The fallback engine.
 *
 * Subscribes to the session's messages under the SAME channel name the chat
 * window uses, so the realtime manager reference-counts one underlying channel
 * rather than opening a second. Nothing is fetched: the backlog is exactly what
 * must NOT be read aloud, so "arrived after we joined" and "we saw the insert"
 * are the same condition.
 */
export function useBrowserSpeechOutput(
  sessionId: string | null,
  enabled: boolean,
  joinedAtMs: number,
): SpeechOutputState {
  const [unavailable] = useState(() => (
    typeof window === 'undefined' || !('speechSynthesis' in window)
      ? 'This browser cannot read replies aloud.'
      : ''
  ));
  const [speakingName, setSpeakingName] = useState('');

  const queueRef = useRef<SpeechItem[]>([]);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const pendingRef = useRef(new Map<string, PendingSpeech>());
  // id -> the text we have already committed to saying for that message. A
  // message that keeps growing is spoken in pieces; one that is rewritten is
  // not repeated. See nextSpeechChunk.
  const spokenTextRef = useRef(new Map<string, string>());
  const settleTimerRef = useRef<number | null>(null);
  const watchdogRef = useRef<number | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Declared as a function statement so an utterance's own `onend` can call it
  // by name. Everything it touches is a ref or a stable setState, so the stale
  // closure an old utterance holds behaves identically to a fresh one.
  function pump() {
    const synth = typeof window === 'undefined' ? null : window.speechSynthesis;
    if (!synth) return;
    if (utteranceRef.current) return; // one voice at a time
    const next = queueRef.current.shift();
    if (!next) {
      setSpeakingName('');
      return;
    }
    const utterance = new SpeechSynthesisUtterance(next.text);
    utterance.rate = SPEECH_RATE;
    // INTERIM: one browser voice for every agent. Per-agent voices are Cartesia
    // now (each agent's id is on `next.agentId`, its voice on
    // identity.voice.cartesia_voice_id), and the playback pipeline that uses
    // them is owned elsewhere. This stays until that lands — removing the only
    // working audio path first would leave every huddle silent.
    const voice = pickSpeechVoice(synth.getVoices());
    if (voice) utterance.voice = voice;

    // A silent speak() must never wedge the pipeline. onend/onerror used to be
    // the ONLY things that cleared utteranceRef, and speechSynthesis fails
    // QUIETLY in several real cases (voice list not yet populated, the tab's
    // synth left in a paused state, an utterance dropped on a background tab).
    // When that happened the queue stalled forever AND — because the echo guard
    // keys off speakingName — the microphone stayed paused with
    // "Paused while the reply plays", so the whole huddle went dead. Shipped
    // that; this is the fix.
    let settled = false;
    const clearWatchdog = () => {
      if (watchdogRef.current !== null) {
        window.clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      if (utteranceRef.current !== utterance) return; // superseded by a stop()
      utteranceRef.current = null;
      setSpeakingName('');
      pump();
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    // The guard engages only once speech ACTUALLY starts, so an utterance that
    // never plays cannot mute the mic.
    utterance.onstart = () => {
      clearWatchdog();
      if (utteranceRef.current === utterance) setSpeakingName(next.speaker);
    };
    utteranceRef.current = utterance;

    // Chrome parks speechSynthesis in a paused state after periods of inactivity;
    // speak() then queues silently and no event ever fires.
    try { synth.resume(); } catch { /* not all engines implement resume */ }
    synth.speak(utterance);

    // If onstart has not fired by now the utterance is never going to play.
    // Drop it and move on rather than blocking the queue and the microphone.
    watchdogRef.current = window.setTimeout(() => {
      watchdogRef.current = null;
      if (settled || utteranceRef.current !== utterance) return;
      console.warn('[huddle] speech never started — skipping this reply');
      try { synth.cancel(); } catch { /* best effort */ }
      finish();
    }, SPEECH_START_TIMEOUT_MS);
  }

  const stopSpeaking = useCallback(() => {
    queueRef.current = [];
    pendingRef.current.clear();
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    const current = utteranceRef.current;
    utteranceRef.current = null;
    // Detach first: cancel() synchronously fires onend in Chrome, and a live
    // handler would immediately pump the queue we are trying to empty.
    if (current) {
      current.onend = null;
      current.onerror = null;
    }
    if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
    setSpeakingName('');
  }, []);

  const flush = useCallback((id: string) => {
    const entry = pendingRef.current.get(id);
    if (!entry) return;
    pendingRef.current.delete(id);
    const chunk = nextSpeechChunk(entry.item.text, spokenTextRef.current.get(id) || '');
    spokenTextRef.current.set(id, entry.item.text);
    if (!chunk) return;
    queueRef.current.push({ ...entry.item, text: chunk });
    pump();
    // `pump` is a per-render function statement over refs — intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleSettle = useCallback(() => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      const cutoff = Date.now() - SETTLE_MS;
      for (const [id, entry] of [...pendingRef.current.entries()]) {
        if (entry.changedAt <= cutoff) flush(id);
      }
      if (pendingRef.current.size > 0) scheduleSettle();
    }, SETTLE_MS);
    // Self-recursive by design; every path clears the previous timer first.
  }, [flush]);

  const deduper = useRealtimeDeduper();

  useTableSubscription<VoiceMessage>(
    {
      enabled: enabled && !unavailable && !!sessionId,
      // Same name the chat window uses: the realtime manager fans one channel
      // out to both listeners instead of opening a second subscription.
      channelName: `messages:${sessionId}`,
      table: 'messages',
      event: '*',
      schema: 'public',
      filter: `session_id=eq.${sessionId}`,
    },
    (payload) => {
      if (!deduper.shouldProcess(payload)) return;
      if (!enabledRef.current) return;
      if (payload.eventType === 'DELETE') {
        const id = payload.old?.id;
        if (id) pendingRef.current.delete(String(id));
        return;
      }
      const row = payload.new;
      if (!row?.id) return;
      const id = String(row.id);
      const createdMs = Date.parse(String(row.created_at ?? ''));

      // Any newer row proves every older pending block is finished — the daemon
      // finalises a text block and writes the next placeholder together. This is
      // what makes a segmented turn speak per block instead of per turn.
      if (Number.isFinite(createdMs)) {
        for (const [pendingId, entry] of [...pendingRef.current.entries()]) {
          if (entry.createdMs < createdMs) flush(pendingId);
        }
      }

      const item = speechItemFor(row, joinedAtMs);
      if (!item) {
        // A placeholder ("Thinking 0s") or a tool chip. It may still grow into a
        // real message, so drop it from pending and wait for the next update.
        pendingRef.current.delete(id);
        return;
      }
      // Nothing new to say for this row (a re-delivery, or an UPDATE that only
      // touched a column we don't read).
      if (spokenTextRef.current.get(id) === item.text) return;
      const existing = pendingRef.current.get(id);
      if (existing && existing.item.text === item.text) return; // no change, no re-arm
      pendingRef.current.set(id, {
        item,
        createdMs: Number.isFinite(createdMs) ? createdMs : Date.now(),
        changedAt: Date.now(),
      });
      scheduleSettle();
    },
  );

  // Leaving, muting output, or unmounting stops the voice mid-word. Anything
  // less means the agent keeps talking into a call the human has left.
  useEffect(() => {
    if (!enabled) stopSpeaking();
    return stopSpeaking;
  }, [enabled, stopSpeaking]);

  // A full page navigation tears React down without running effects in some
  // browsers, and speechSynthesis outlives the document long enough to be heard.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('pagehide', stopSpeaking);
    return () => window.removeEventListener('pagehide', stopSpeaking);
  }, [stopSpeaking]);

  return { unavailable, speakingName, playbackEndsAtMs: 0 };
}

// ---------------------------------------------------------------------------
// Hosted engines: Deepgram Flux in, Cartesia sonic-3.5 out
// ---------------------------------------------------------------------------

// Which engines a workspace can use rarely changes mid-session (it follows
// which provider keys are configured, not anything per-huddle) — so the first
// fetch is cached in memory and every later join in this tab reuses it
// instantly instead of paying a round trip before the mic can open. A failed
// fetch is deliberately NOT cached: the backend may just be warming up, and
// the next join should try again rather than being stuck degraded all tab.
const capabilitiesCache = new Map<string, VoiceCapabilities>();
const capabilitiesInflight = new Map<string, Promise<VoiceCapabilities>>();

async function fetchVoiceCapabilities(workspaceId: string): Promise<VoiceCapabilities> {
  const response = await fetch(apiUrl(`/backend/workspaces/${workspaceId}/voice/capabilities`), {
    headers: apiAuthHeaders(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('voice capabilities request failed');
  return payload?.data ?? { stt: null, tts: null };
}

/**
 * What the server can actually do, asked once per huddle — or once per tab,
 * after which it is served from the cache above.
 *
 * Fetched BEFORE a microphone is opened, so a missing key is a sentence on
 * screen and a fallback to the browser engine rather than a mic that lights up
 * and transcribes nothing. A failed fetch is treated as "no hosted engines",
 * which is the same graceful path.
 */
export function useVoiceCapabilities(workspaceId: string | null, enabled: boolean): VoiceCapabilities | null {
  const [capabilities, setCapabilities] = useState<VoiceCapabilities | null>(
    () => (workspaceId && capabilitiesCache.has(workspaceId)) ? capabilitiesCache.get(workspaceId)! : null,
  );

  useEffect(() => {
    if (!enabled || !workspaceId) {
      setCapabilities(null);
      return;
    }
    const cached = capabilitiesCache.get(workspaceId);
    if (cached) {
      setCapabilities(cached);
      return;
    }
    let cancelled = false;
    let inflight = capabilitiesInflight.get(workspaceId);
    if (!inflight) {
      inflight = fetchVoiceCapabilities(workspaceId);
      capabilitiesInflight.set(workspaceId, inflight);
      inflight
        .then((result) => capabilitiesCache.set(workspaceId, result))
        .catch(() => { /* not cached — next join retries */ })
        .finally(() => capabilitiesInflight.delete(workspaceId));
    }
    inflight
      .then((result) => { if (!cancelled) setCapabilities(result); })
      .catch(() => {
        // The backend is unreachable, which the rest of the app is already
        // shouting about. Voice just degrades, and nothing is cached so the
        // next join tries fresh.
        if (!cancelled) setCapabilities({ stt: null, tts: null });
      });
    return () => { cancelled = true; };
  }, [workspaceId, enabled]);

  return capabilities;
}

/**
 * Microphone -> Deepgram Flux -> text, while `enabled`.
 *
 * The audio goes to OUR server, which holds the key and relays to Deepgram (see
 * shared/voice-core.cjs). `onUtterance` fires once per EndOfTurn — Flux's own
 * judgement that the speaker has finished, rather than a silence timer's guess,
 * which is most of the reason for this engine existing.
 *
 * `suppressed` stops audio LEAVING the browser while a reply is playing. The
 * caller's echo guard is the second line; this is the first, and it also means
 * we are not paying to transcribe our own voice.
 */
export function useDeepgramSpeechInput(
  enabled: boolean,
  onUtterance: (text: string) => void,
  suppressed: boolean,
): SpeechInputState {
  const [unavailable] = useState(() => micUnavailableReason());
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');

  const utteranceRef = useRef(onUtterance);
  utteranceRef.current = onUtterance;
  const micRef = useRef<DeepgramMic | null>(null);
  // Suppression is applied through refs so muting never re-runs the effect that
  // owns the capture — restarting a capture to mute it would drop the turn the
  // human is halfway through.
  const suppressedRef = useRef(suppressed);
  suppressedRef.current = suppressed;

  useEffect(() => {
    micRef.current?.setMuted(suppressed);
  }, [suppressed]);

  useEffect(() => {
    if (!enabled || unavailable) {
      setListening(false);
      setInterim('');
      return;
    }

    let disposed = false;
    let turn: TurnState = IDLE_TURN;

    const unsubscribe = voiceRealtime.onEvent((payload) => {
      if (disposed) return;
      const frame = (payload ?? {}) as { event?: string; reason?: string; message?: unknown };
      if (frame.event === 'ready') {
        setListening(true);
        setError('');
        return;
      }
      if (frame.event === 'unavailable') {
        setListening(false);
        setInterim('');
        setError(frame.reason || 'Transcription is unavailable.');
        return;
      }
      if (frame.event === 'closed') {
        setListening(false);
        setInterim('');
        if (frame.reason) setError(frame.reason);
        return;
      }
      if (frame.event !== 'flux') return;

      turn = reduceTurn(turn, readFluxEvent(frame.message));
      setInterim(turn.interim);
      if (turn.error) setError(turn.error);
      // A turn that ended on silence has an empty transcript. Posting it would
      // dispatch an agent against nothing.
      if (turn.utterance) {
        const text = normalizeTranscript(turn.utterance);
        if (text) utteranceRef.current(text);
      }
    });

    const mic = new DeepgramMic({
      onReady: () => { if (!disposed) setError(''); },
      onError: (reason) => {
        if (disposed) return;
        setListening(false);
        setInterim('');
        setError(reason);
      },
    });
    micRef.current = mic;
    mic.setMuted(suppressedRef.current);
    void mic.start();

    return () => {
      // Order matters, same as the browser path: latch, detach, then close.
      // A flux frame arriving during teardown must not post a message into a
      // call the human has already left.
      disposed = true;
      unsubscribe();
      micRef.current = null;
      void mic.stop();
      setListening(false);
      setInterim('');
    };
    // `suppressed` is deliberately absent: it reaches the mic through
    // suppressedRef, because including it here would tear the capture down and
    // back up on every reply.
  }, [enabled, unavailable]);

  return { unavailable, listening, interim, error };
}

interface PendingCartesia {
  item: SpeechItem;
  createdMs: number;
  changedAt: number;
}

/**
 * New AGENT messages in this session -> Cartesia sonic-3.5, while `enabled`.
 *
 * The difference that matters versus the browser path is WHEN it starts
 * talking. That one waits for a message to stop changing for 700ms and then
 * says the block; this hands each sentence over the instant its full stop
 * arrives, and Cartesia answers in about 110ms — so a streaming reply is being
 * read aloud while the rest of it is still being written. The 700ms settle
 * survives for one job only: flushing the trailing fragment of a message that
 * never ends in punctuation.
 *
 * `roster` is the huddle's agents with their stored voices — NOT a single
 * "current speaker" voice. Each message picks its own voice off `roster` by
 * `item.agentId` (see voiceIdForSpeechItem), because the speaker in a huddle
 * is whoever POSTED the message, not whoever was last active in the strip: an
 * agent that interrupts must sound like itself, not like the agent it cut off.
 */
export function useCartesiaSpeechOutput(
  workspaceId: string | null,
  sessionId: string | null,
  enabled: boolean,
  joinedAtMs: number,
  roster: readonly VoiceRosterEntry[],
): SpeechOutputState {
  const [speakingName, setSpeakingName] = useState('');
  const [playbackEndsAtMs, setPlaybackEndsAtMs] = useState(0);
  const [unavailable, setUnavailable] = useState('');

  const speakerRef = useRef<CartesiaSpeaker | null>(null);
  const pendingRef = useRef(new Map<string, PendingCartesia>());
  const spokenTextRef = useRef(new Map<string, string>());
  const settleTimerRef = useRef<number | null>(null);
  const rosterRef = useRef(roster);
  rosterRef.current = roster;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const active = enabled && !!workspaceId && !!sessionId;

  useEffect(() => {
    if (!active || !workspaceId) return;
    const speaker = new CartesiaSpeaker(workspaceId, {
      onSpeakingChange: setSpeakingName,
      onPlaybackEnd: setPlaybackEndsAtMs,
      onError: setUnavailable,
    });
    speakerRef.current = speaker;
    setUnavailable('');
    // Open the socket NOW, not on the first sentence. Cold, the first spoken word
    // of a call cost 395-626ms of pure connect (token mint + websocket + first
    // chunk, measured 2026-07-26); warm, the same sentence starts in 107-120ms.
    // Nothing is queued yet, so a failure here is silent and the first real
    // speak() reports it — see CartesiaSpeaker.prewarm.
    void speaker.prewarm();
    // Captured now rather than read in the cleanup: these are the same Map
    // objects for the life of the hook, and reading `.current` at teardown is
    // what the lint rule (correctly) warns about.
    const pending = pendingRef.current;
    const spoken = spokenTextRef.current;
    return () => {
      speakerRef.current = null;
      pending.clear();
      spoken.clear();
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
      setSpeakingName('');
      setPlaybackEndsAtMs(0);
      void speaker.close();
    };
  }, [active, workspaceId]);

  // Emit whatever `split` decided is sayable, and remember it as said.
  const emit = useCallback((id: string, item: SpeechItem, split: { speak: string[]; spoken: string }) => {
    spokenTextRef.current.set(id, split.spoken);
    // Resolved per MESSAGE, not once per hook — the whole point of the fix.
    const voiceId = voiceIdForSpeechItem(item, rosterRef.current);
    for (const line of split.speak) speakerRef.current?.speak(line, item.speaker, voiceId);
  }, []);

  const flush = useCallback((id: string) => {
    const entry = pendingRef.current.get(id);
    if (!entry) return;
    pendingRef.current.delete(id);
    emit(id, entry.item, flushRemainder(entry.item.text, spokenTextRef.current.get(id) || ''));
  }, [emit]);

  const scheduleSettle = useCallback(() => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      const cutoff = Date.now() - SETTLE_MS;
      for (const [id, entry] of [...pendingRef.current.entries()]) {
        if (entry.changedAt <= cutoff) flush(id);
      }
      if (pendingRef.current.size > 0) scheduleSettle();
    }, SETTLE_MS);
  }, [flush]);

  const deduper = useRealtimeDeduper();

  // Ephemeral speakable sentences (server → Cartesia without waiting on the
  // durable messages fanout). Channel is workspace-scoped; payload is
  // session-scoped and re-checked here.
  useEffect(() => {
    if (!active || !workspaceId || !sessionId) return;
    const channelName = huddleVoiceChannel(workspaceId);
    if (!channelName) return;
    const channel = backendClient.channel(channelName);
    channel.on(
      'broadcast',
      { event: HUDDLE_VOICE_EVENT },
      (message: { payload?: HuddleVoiceSentencePayload }) => {
        if (!enabledRef.current) return;
        const id = String(message?.payload?.messageId || '');
        const already = spokenTextRef.current.get(id) || '';
        const accepted = acceptHuddleVoiceSentence(message?.payload, sessionId, already);
        if (!accepted) return;
        spokenTextRef.current.set(accepted.messageId, accepted.spokenAfter);
        const voiceId = voiceIdForSpeechItem(
          { agentId: accepted.agentId },
          rosterRef.current,
        );
        if (typeof performance !== 'undefined' && performance.mark) {
          try {
            performance.mark(`huddle-voice-ephemeral:${accepted.messageId}:${accepted.offset}`);
          } catch { /* ignore */ }
        }
        speakerRef.current?.speak(accepted.sentence, accepted.agentName, voiceId);
      },
    );
    channel.subscribe();
    return () => {
      void channel.unsubscribe();
    };
  }, [active, workspaceId, sessionId]);

  useTableSubscription<VoiceMessage>(
    {
      enabled: active,
      channelName: `messages:${sessionId}`,
      table: 'messages',
      event: '*',
      schema: 'public',
      filter: `session_id=eq.${sessionId}`,
    },
    (payload) => {
      if (!deduper.shouldProcess(payload)) return;
      if (!enabledRef.current) return;
      if (payload.eventType === 'DELETE') {
        const id = payload.old?.id;
        if (id) pendingRef.current.delete(String(id));
        return;
      }
      const row = payload.new;
      if (!row?.id) return;
      const id = String(row.id);
      const createdMs = Date.parse(String(row.created_at ?? ''));

      // A newer row proves every older block is finished — the daemon finalises
      // one text block and writes the next placeholder together.
      if (Number.isFinite(createdMs)) {
        for (const [pendingId, entry] of [...pendingRef.current.entries()]) {
          if (entry.createdMs < createdMs) flush(pendingId);
        }
      }

      const item = speechItemFor(row, joinedAtMs);
      if (!item) {
        pendingRef.current.delete(id);
        return;
      }
      const alreadySpoken = spokenTextRef.current.get(id) || '';
      if (alreadySpoken === item.text) return;

      // Durable fallback / catch-up: sentenceChunks skips anything already in
      // alreadySpoken (including prefixes advanced by the ephemeral lane).
      emit(id, item, sentenceChunks(item.text, alreadySpoken));
      pendingRef.current.set(id, {
        item,
        createdMs: Number.isFinite(createdMs) ? createdMs : Date.now(),
        changedAt: Date.now(),
      });
      scheduleSettle();
    },
  );

  // Leaving, muting output, or unmounting stops the voice mid-word.
  useEffect(() => {
    if (!enabled) speakerRef.current?.stop();
  }, [enabled]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stop = () => speakerRef.current?.stop();
    window.addEventListener('pagehide', stop);
    return () => window.removeEventListener('pagehide', stop);
  }, []);

  return { unavailable, speakingName, playbackEndsAtMs };
}

// ---------------------------------------------------------------------------
// Engine dispatch
// ---------------------------------------------------------------------------

const NO_INPUT: SpeechInputState = { unavailable: 'Voice input is not available here.', listening: false, interim: '', error: '' };
const NO_OUTPUT: SpeechOutputState = { unavailable: 'Replies cannot be read aloud here.', speakingName: '', playbackEndsAtMs: 0 };

/** Which engines this huddle will use, and what to say when they are not the good ones. */
export function useVoiceEngines(workspaceId: string | null, enabled: boolean): EngineChoice {
  const capabilities = useVoiceCapabilities(workspaceId, enabled);
  // Support is a property of the browser, not of the render, so it is read once.
  const [support] = useState(() => ({
    sttAvailable: !voiceInputUnavailableReason(),
    ttsAvailable: typeof window !== 'undefined' && 'speechSynthesis' in window,
  }));
  return useMemo(() => chooseEngines(capabilities, support), [capabilities, support]);
}

/**
 * Microphone -> text, on whichever engine is available.
 *
 * Both engines are instantiated and one is enabled: hooks cannot be called
 * conditionally, and each is completely inert while `enabled` is false (no
 * socket, no AudioContext, no recogniser).
 */
export function useSpeechInput(
  enabled: boolean,
  onUtterance: (text: string) => void,
  options: { engine?: SttEngine; suppressed?: boolean } = {},
): SpeechInputState {
  const { engine = 'browser', suppressed = false } = options;
  const browser = useBrowserSpeechInput(enabled && engine === 'browser', onUtterance);
  const hosted = useDeepgramSpeechInput(enabled && engine === 'deepgram', onUtterance, suppressed);
  if (engine === 'deepgram') return hosted;
  if (engine === 'browser') return browser;
  return NO_INPUT;
}

const NO_ROSTER: VoiceRosterEntry[] = [];

/** Agent replies -> speech, on whichever engine is available. */
export function useSpeechOutput(
  sessionId: string | null,
  enabled: boolean,
  joinedAtMs: number,
  options: { engine?: TtsEngine; workspaceId?: string | null; roster?: readonly VoiceRosterEntry[] } = {},
): SpeechOutputState {
  const { engine = 'browser', workspaceId = null, roster = NO_ROSTER } = options;

  // ONE speaker per session, app-wide. agensis is a single page of in-page
  // windows, so the same DM can be mounted twice at once; each mount polls the
  // same transcript and speaks every new reply, so two mounts read every reply
  // twice a beat apart — heard as two voices talking over each other, and
  // invisible to any per-component fix because each speaker is correct alone.
  // The claim decides which mount is audible; the others render normally and
  // stay silent until it releases.
  const tokenRef = useRef<symbol | null>(null);
  if (tokenRef.current === null) tokenRef.current = Symbol('huddle-speaker');
  const token = tokenRef.current;
  const [audible, setAudible] = useState(false);

  useEffect(() => {
    if (!enabled || !sessionId) { setAudible(false); return; }
    const attempt = () => setAudible(claimSpeaker(sessionId, token));
    attempt();
    // A silent mount retries when the holder goes away — closing the window
    // that held the claim must hand the voice to the one still open, not
    // leave the huddle mute.
    const unsubscribe = subscribeSpeakerReleases(attempt);
    return () => {
      unsubscribe();
      releaseSpeaker(sessionId, token);
      setAudible(false);
    };
  }, [enabled, sessionId, token]);

  const browser = useBrowserSpeechOutput(sessionId, audible && enabled && engine === 'browser', joinedAtMs);
  const hosted = useCartesiaSpeechOutput(workspaceId, sessionId, audible && enabled && engine === 'cartesia', joinedAtMs, roster);
  if (engine === 'cartesia') return hosted;
  if (engine === 'browser') return browser;
  return NO_OUTPUT;
}
