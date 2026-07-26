import { useCallback, useEffect, useRef, useState } from 'react';
import { nextSpeechChunk, normalizeTranscript, speechItemFor, type SpeechItem, type VoiceMessage, pickSpeechVoice } from '../lib/huddleVoice';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';

// Voice for a huddle, WITHOUT putting the agent anywhere near audio.
//
// Speech becomes text in this browser (SpeechRecognition) and is posted as an
// ordinary chat message; text becomes speech in this browser (speechSynthesis)
// when an agent message lands. The agent, the daemon, the dispatch path and the
// server are all completely unaware that a microphone exists — which is why
// this works identically for daemon, builtin and MCP agents and needed no
// media-plane work at all.
//
// CLEANUP IS THE WHOLE GAME. An orphaned recogniser keeps posting messages into
// a channel after the human has left the call, and an orphaned utterance keeps
// talking over whatever they do next. Every listener, timer, recogniser and
// utterance below is torn down on unmount AND when `enabled` goes false, and
// handlers are detached BEFORE abort/cancel so a late event from the dying
// object cannot re-enter.

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
 * Microphone -> text, while `enabled`.
 *
 * `onUtterance` fires once per FINAL result (a natural pause), never per
 * interim word: posting every partial would flood the channel and dispatch the
 * agent on half a sentence.
 */
export function useSpeechInput(
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
}

interface PendingSpeech {
  item: SpeechItem;
  createdMs: number;
  changedAt: number;
}

/**
 * New AGENT messages in this session -> spoken aloud, while `enabled`.
 *
 * Subscribes to the session's messages under the SAME channel name the chat
 * window uses, so the realtime manager reference-counts one underlying channel
 * rather than opening a second. Nothing is fetched: the backlog is exactly what
 * must NOT be read aloud, so "arrived after we joined" and "we saw the insert"
 * are the same condition.
 */
export function useSpeechOutput(
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

  return { unavailable, speakingName };
}
